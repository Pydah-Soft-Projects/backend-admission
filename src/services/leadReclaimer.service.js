import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';
import { notifyLeadReclamationSummary } from './notification.service.js';

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
 * Reclaims leads that have reached their target date and are still assigned.
 *
 * Rules:
 * - Not Interested / Wrong Data -> reclaim and increment cycle
 * - Assigned -> reclaim but keep same cycle
 *
 * @param {string} [asOfDateYmd] - `YYYY-MM-DD` in Asia/Kolkata; leads with target_date on or before this date are considered due. Defaults to IST "today" when omitted.
 */
export const reclaimExpiredLeads = async (asOfDateYmd) => {
  let pool;
  try {
    pool = getPool();
    const cutoff =
      typeof asOfDateYmd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOfDateYmd)
        ? asOfDateYmd
        : formatDateIST(new Date());
    console.log(
      `[LeadReclaimer] Starting automated lead reclamation (cutoff target_date <= ${cutoff} IST calendar)...`
    );

    // 1. Find leads to reclaim:
    // - status is 'Not Interested' OR 'Wrong Data' OR still 'Assigned'
    // - target_date is on or before the IST cutoff date
    // - currently assigned to someone
    const [leadsToReclaim] = await pool.execute(
      `
      SELECT id, lead_status, assigned_to, assigned_to_pro, cycle_number 
      FROM leads 
      WHERE (target_date <= ?) 
        AND (lead_status IN ('Not Interested', 'Wrong Data', 'Assigned'))
        AND (assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL)
    `,
      [cutoff]
    );

    if (leadsToReclaim.length === 0) {
      console.log('[LeadReclaimer] No leads found for reclamation.');
      return 0;
    }

    console.log(`[LeadReclaimer] Found ${leadsToReclaim.length} leads to reclaim.`);

    let reclaimedCount = 0;
    const reclaimedByPreviousAssignee = new Map();

    for (const lead of leadsToReclaim) {
      const currentCycle = lead.cycle_number || 1;
      const oldStatus = String(lead.lead_status || '').trim();
      const shouldIncrementCycle = oldStatus === 'Not Interested' || oldStatus === 'Wrong Data';
      const newCycle = shouldIncrementCycle ? currentCycle + 1 : currentCycle;
      const previousAssignee = lead.assigned_to || lead.assigned_to_pro || null;
      
      // Update the lead record
      await pool.execute(`
        UPDATE leads 
        SET 
          assigned_to = NULL, 
          assigned_at = NULL, 
          assigned_by = NULL,
          assigned_to_pro = NULL,
          pro_assigned_at = NULL,
          pro_assigned_by = NULL,
          lead_status = 'New',
          target_date = NULL,
          cycle_number = ?,
          updated_at = NOW()
        WHERE id = ?
      `, [newCycle, lead.id]);

      // Create activity log
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'status_change',
          oldStatus,
          'New',
          shouldIncrementCycle
            ? `Automated Reassignment: Cycle ${newCycle}. Reclaimed due to '${oldStatus}' status and target date reached.`
            : `Automated Reassignment: Cycle ${newCycle} unchanged. Reclaimed due to 'Assigned' status at target date.`,
          '00000000-0000-0000-0000-000000000000', // Special identifier for automated tasks
          JSON.stringify({
            reclamation: {
              previousCycle: currentCycle,
              newCycle: newCycle,
              previousAssignee,
              oldStatus,
              cycleIncremented: shouldIncrementCycle,
            },
          }),
        ]
      );

      reclaimedCount++;
      if (previousAssignee) {
        reclaimedByPreviousAssignee.set(
          previousAssignee,
          (reclaimedByPreviousAssignee.get(previousAssignee) || 0) + 1
        );
      }
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
      console.error('[LeadReclaimer] Error sending reclamation summary notification:', notificationError);
    }

    console.log(`[LeadReclaimer] Successfully reclaimed ${reclaimedCount} leads.`);
    return reclaimedCount;
  } catch (error) {
    console.error('[LeadReclaimer] Error during lead reclamation:', error);
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
      console.error('[LeadReclaimer] Scheduled run failed:', e);
    }
    scheduleNextISTDailyReclaim();
  }, delay);

  const nextRun = new Date(Date.now() + delay);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  console.log(
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
    console.log('[LeadReclaimer] Disabled (LEAD_RECLAIMER_ENABLED).');
    return;
  }

  if (reclaimerTimeoutId) {
    clearTimeout(reclaimerTimeoutId);
    reclaimerTimeoutId = null;
  }

  reclaimSchedule = parseReclaimScheduleIST();
  const { hour, minute } = reclaimSchedule;
  console.log(
    `[LeadReclaimer] Daily schedule: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} Asia/Kolkata`
  );

  scheduleNextISTDailyReclaim();
};
