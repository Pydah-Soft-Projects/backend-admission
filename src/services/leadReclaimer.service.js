import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';
import { notifyLeadReclamationSummary } from './notification.service.js';
import { updatePerformanceMetric } from './userPerformance.service.js';

/**
 * Under PM2, stdout can be closed during reload/restart; console.log may throw EPIPE and
 * crash the process if unhandled — PM2 then restarts in a loop. Swallow EPIPE only.
 */
function safeConsoleLog(...args) {
  try {
    console.log(...args);
  } catch (err) {
    if (err && err.code === 'EPIPE') return;
    try {
      console.error('[LeadReclaimer] safeConsoleLog failed:', err);
    } catch {
      /* ignore */
    }
  }
}

function safeConsoleError(...args) {
  try {
    console.error(...args);
  } catch (err) {
    if (err && err.code === 'EPIPE') return;
  }
}

const TZ_IST = 'Asia/Kolkata';

/** Calendar date YYYY-MM-DD in Asia/Kolkata for the given instant. */
const formatDateIST = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

function istHms(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_IST,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const n = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { h: n('hour'), m: n('minute'), s: n('second') };
}

function istMatchesWallTime(d, hour, minute) {
  const { h, m, s } = istHms(d);
  return h === hour && m === minute && s === 0;
}

/** Next run at `hour`:`minute`:00 Asia/Kolkata (strictly after `from`). */
function msUntilNextWallTimeIST(from, hour, minute) {
  const start = from.getTime();
  let t = Math.floor(start / 1000) * 1000 + 1000;
  const limit = t + 2 * 24 * 60 * 60 * 1000;
  while (t <= limit) {
    const d = new Date(t);
    if (istMatchesWallTime(d, hour, minute) && d.getTime() > start) {
      return Math.max(d.getTime() - start, 1000);
    }
    t += 1000;
  }
  return 24 * 60 * 60 * 1000;
}

/** Daily IST wall clock for reclamation (24h). Env: LEAD_RECLAIM_IST_TIME=23:00 or LEAD_RECLAIM_IST_HOUR / LEAD_RECLAIM_IST_MINUTE. Default 23:11 (11:11 PM). */
function parseReclaimScheduleIST() {
  const raw = process.env.LEAD_RECLAIM_IST_TIME?.trim();
  if (raw && /^(\d{1,2}):(\d{2})$/.test(raw)) {
    const [, hs, ms] = raw.match(/^(\d{1,2}):(\d{2})$/);
    const h = Number(hs);
    const m = Number(ms);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { hour: h, minute: m };
    }
  }
  const hEnv = Number(process.env.LEAD_RECLAIM_IST_HOUR);
  const mEnv = Number(process.env.LEAD_RECLAIM_IST_MINUTE);
  if (
    Number.isFinite(hEnv) &&
    Number.isFinite(mEnv) &&
    hEnv >= 0 &&
    hEnv <= 23 &&
    mEnv >= 0 &&
    mEnv <= 59
  ) {
    return { hour: hEnv, minute: mEnv };
  }
  return { hour: 23, minute: 11 };
}

let reclaimerTimeoutId = null;
let reclaimSchedule = { hour: 23, minute: 11 };

/**
 * Reclaims **per slot** when that slot’s target date is due (counsellor vs PRO).
 * Uses `counsellor_target_date` / `pro_target_date`; legacy `target_date` is cleared when a slot is reclaimed.
 *
 * Rules (unchanged intent):
 * - Pipeline `lead_status` must be `Not Interested`, `Wrong Data`, or `Assigned`
 * - Only slots whose date is `<=` cutoff AND non-null are cleared
 * - When **no** assignees remain: `lead_status` → `New`; cycle increments only for NI/Wrong Data
 * - When one assignee remains: keep `lead_status`; no cycle increment
 *
 * @param {string} [asOfDateYmd] - `YYYY-MM-DD` in Asia/Kolkata; defaults to IST "today" when omitted.
 */
export const reclaimExpiredLeads = async (asOfDateYmd) => {
  let pool;
  try {
    pool = getPool();
    const cutoff =
      typeof asOfDateYmd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOfDateYmd)
        ? asOfDateYmd
        : formatDateIST(new Date());
    safeConsoleLog(
      `[LeadReclaimer] Starting automated lead reclamation (cutoff slot target dates <= ${cutoff} IST calendar)...`
    );

    const [leadsToReclaim] = await pool.execute(
      `
      SELECT id, lead_status, cycle_number,
        assigned_to, assigned_to_pro,
        counsellor_target_date, target_date,
        academic_year, student_group
      FROM leads
      WHERE lead_status IN ('Not Interested', 'Wrong Data', 'Assigned')
        AND (assigned_to IS NOT NULL AND counsellor_target_date IS NOT NULL AND counsellor_target_date <= ?)
    `,
      [cutoff]
    );

    if (leadsToReclaim.length === 0) {
      safeConsoleLog('[LeadReclaimer] No leads found for reclamation.');
      return 0;
    }

    safeConsoleLog(`[LeadReclaimer] Found ${leadsToReclaim.length} lead row(s) with at least one due slot.`);

    let reclaimedCount = 0;
    const reclaimedByPreviousAssignee = new Map();

    const bumpReclaimedCount = (userId) => {
      if (!userId) return;
      reclaimedByPreviousAssignee.set(userId, (reclaimedByPreviousAssignee.get(userId) || 0) + 1);
    };

    const insertReclaimLog = async ({
      leadId,
      oldStatus,
      newStatus,
      comment,
      previousAssignee,
      currentCycle,
      newCycle,
      cycleIncremented,
      reclaimedRole,
      academicYear,
      studentGroup
    }) => {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          leadId,
          'status_change',
          oldStatus,
          newStatus,
          comment,
          '00000000-0000-0000-0000-000000000000',
          JSON.stringify({
            reclamation: {
              previousCycle: currentCycle,
              newCycle,
              previousAssignee,
              oldStatus,
              cycleIncremented,
              reclaimedRole,
            },
          }),
        ]
      );

      // Update performance summary
      if (previousAssignee) {
        await updatePerformanceMetric({
          userId: previousAssignee,
          academicYear: academicYear,
          studentGroup: studentGroup,
          roleName: reclaimedRole === 'counsellor' ? 'Student Counselor' : 'PRO',
          metric: 'reclaimed_count',
          value: 1
        });
      }
    };

    for (const lead of leadsToReclaim) {
      const currentCycle = lead.cycle_number || 1;
      const oldStatus = String(lead.lead_status || '').trim();
      const slotYmd = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const s = String(v).trim();
        return s.length >= 10 ? s.slice(0, 10) : s;
      };
      const hadSc = lead.assigned_to != null && String(lead.assigned_to).trim() !== '';
      const scYmd = slotYmd(lead.counsellor_target_date);
      const scDue = hadSc && scYmd != null && scYmd <= cutoff;

      if (!scDue) continue;

      const stillScAfter = false; // By definition scDue means we clear it
      const hadPro = lead.assigned_to_pro != null && String(lead.assigned_to_pro).trim() !== '';
      const fullyUnassigned = !stillScAfter && !hadPro;
      const shouldIncrementCycle =
        fullyUnassigned && (oldStatus === 'Not Interested' || oldStatus === 'Wrong Data');
      const newCycle = shouldIncrementCycle ? currentCycle + 1 : currentCycle;
      const newLeadStatus = fullyUnassigned ? 'New' : oldStatus;

      const setParts = [
        'assigned_to = NULL',
        'assigned_at = NULL',
        'assigned_by = NULL',
        'counsellor_target_date = NULL',
        'lead_status = ?',
        'cycle_number = ?',
        'target_date = NULL',
        'updated_at = NOW()'
      ];
      const params = [newLeadStatus, newCycle, lead.id];

      await pool.execute(`UPDATE leads SET ${setParts.join(', ')} WHERE id = ?`, params);

      const baseCommentPartial = shouldIncrementCycle
        ? `Automated slot reclaim; cycle ${newCycle}. Pipeline was '${oldStatus}'.`
        : `Automated slot reclaim; cycle ${newCycle} unchanged. Pipeline was '${oldStatus}'.`;

      await insertReclaimLog({
        leadId: lead.id,
        oldStatus,
        newStatus: newLeadStatus,
        comment: `${baseCommentPartial} Counsellor slot cleared (target date reached).`,
        previousAssignee: lead.assigned_to,
        currentCycle,
        newCycle,
        cycleIncremented: shouldIncrementCycle,
        reclaimedRole: 'counsellor',
        academicYear: lead.academic_year,
        studentGroup: lead.student_group
      });
      bumpReclaimedCount(lead.assigned_to);
      reclaimedCount += 1;
    }

    try {
      const previousAssigneeIds = [...reclaimedByPreviousAssignee.keys()];
      let userNameById = new Map();

      if (previousAssigneeIds.length > 0) {
        const placeholders = previousAssigneeIds.map(() => '?').join(',');
        const [users] = await pool.execute(
          `SELECT id, name, role_name FROM users WHERE id IN (${placeholders})`,
          previousAssigneeIds
        );
        userNameById = new Map(
          (users || []).map((u) => [u.id, { name: u.name, roleName: u.role_name }])
        );
      }

      const reclaimedByUser = previousAssigneeIds.map((userId) => {
        const meta = userNameById.get(userId);
        return {
          userId,
          userName: meta?.name || 'Unknown User',
          roleName: meta?.roleName || '',
          count: reclaimedByPreviousAssignee.get(userId) || 0,
        };
      });

      await notifyLeadReclamationSummary({
        reclaimedByUser,
        totalReclaimed: reclaimedCount,
      });
    } catch (notificationError) {
      safeConsoleError('[LeadReclaimer] Error sending reclamation summary notification:', notificationError);
    }

    safeConsoleLog(`[LeadReclaimer] Successfully reclaimed ${reclaimedCount} leads.`);
    return reclaimedCount;
  } catch (error) {
    safeConsoleError('[LeadReclaimer] Error during lead reclamation:', error);
    throw error;
  }
};

function scheduleNextISTDailyReclaim() {
  const { hour, minute } = reclaimSchedule;
  const delay = msUntilNextWallTimeIST(new Date(), hour, minute);
  reclaimerTimeoutId = setTimeout(async () => {
    reclaimerTimeoutId = null;
    const asOf = formatDateIST(new Date());
    try {
      await reclaimExpiredLeads(asOf);
    } catch (e) {
      safeConsoleError('[LeadReclaimer] Scheduled run failed:', e);
    }
    scheduleNextISTDailyReclaim();
  }, delay);

  const nextRun = new Date(Date.now() + delay);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  safeConsoleLog(
    `[LeadReclaimer] Next run ${hh}:${mm} IST (~${Math.round(delay / 1000 / 60)} min; UTC ${nextRun.toISOString()})`
  );
}

/**
 * Schedules reclamation once per calendar day at a fixed Asia/Kolkata wall time (default 23:11 / 11:11 PM).
 * Not tied to server start time beyond computing the next occurrence.
 *
 * Env: LEAD_RECLAIMER_ENABLED=false to disable.
 *      LEAD_RECLAIM_IST_TIME=23:11 (optional; overrides hour/minute defaults)
 *      or LEAD_RECLAIM_IST_HOUR and LEAD_RECLAIM_IST_MINUTE (0–23, 0–59).
 */
export const initLeadReclaimer = () => {
  const enabled = String(process.env.LEAD_RECLAIMER_ENABLED ?? 'true').toLowerCase();
  if (enabled === 'false' || enabled === '0') {
    safeConsoleLog('[LeadReclaimer] Disabled (LEAD_RECLAIMER_ENABLED).');
    return;
  }

  if (reclaimerTimeoutId) {
    clearTimeout(reclaimerTimeoutId);
    reclaimerTimeoutId = null;
  }

  reclaimSchedule = parseReclaimScheduleIST();
  const { hour, minute } = reclaimSchedule;
  safeConsoleLog(
    `[LeadReclaimer] Daily schedule: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} Asia/Kolkata`
  );

  scheduleNextISTDailyReclaim();
};
