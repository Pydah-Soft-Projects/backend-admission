/**
 * Restore leads wrongly auto-reclaimed while call/visit channel was Interested (or CET Applied).
 * Puts them back on the previous counsellor with call_status + lead_status restored.
 *
 * Default: DRY RUN (no updates).
 *
 * Usage:
 *   node src/scripts-sql/restore-reclaimed-interested-leads.js
 *   node src/scripts-sql/restore-reclaimed-interested-leads.js --from=2026-04-01 --to=2026-05-17
 *   node src/scripts-sql/restore-reclaimed-interested-leads.js --previous-user-name="ANGADI SARITHA"
 *   node src/scripts-sql/restore-reclaimed-interested-leads.js --from=2026-04-01 --to=2026-05-17 --apply
 *
 * Options:
 *   --from / --to          reclaim date window (recommended; all-time is slow)
 *   --previous-user-name=  only restores for this previous counsellor
 *   --limit=N              max leads (default 2000)
 *   --chunk-days=N         split date range into N-day SQL chunks (default 7 for wide ranges)
 *   --apply                write changes
 *   --skip-reassigned      skip leads currently on a different counsellor (default: restore them too)
 *   --force                same as default (restore even if on another counsellor)
 *   --keep-pro             do not clear assigned_to_pro (default: true)
 *   --target-date=YYYY-MM-DD  optional counsellor_target_date
 */

import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closeDB } from '../config-sql/database.js';
import { resolveLeadStatus } from '../utils/leadChannelStatus.util.js';

dotenv.config();

const AUTOMATION_USER_ID = '00000000-0000-0000-0000-000000000000';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const INTERESTED_SET = new Set(['interested', 'cet applied', 'cet_applied']);

function parseArgs() {
  const out = {
    from: null,
    to: null,
    previousUserName: '',
    apply: false,
    force: true,
    keepPro: true,
    targetDate: null,
    limit: 2000,
    chunkDays: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length).trim() || null;
    if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length).trim() || null;
    if (arg.startsWith('--previous-user-name=')) {
      out.previousUserName = arg.slice('--previous-user-name='.length).trim();
    }
    if (arg === '--apply') out.apply = true;
    if (arg === '--force') out.force = true;
    if (arg === '--skip-reassigned') out.force = false;
    if (arg === '--no-keep-pro') out.keepPro = false;
    if (arg.startsWith('--target-date=')) out.targetDate = arg.slice('--target-date='.length).trim() || null;
    if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
    }
    if (arg.startsWith('--chunk-days=')) {
      const n = Number(arg.slice('--chunk-days='.length).trim());
      if (Number.isFinite(n) && n > 0) out.chunkDays = Math.floor(n);
    }
  }

  return out;
}

function validateArgs(args) {
  if (!args.from || !YMD.test(args.from)) {
    throw new Error('Required --from=YYYY-MM-DD (avoids heavy all-time scan)');
  }
  if (!args.to || !YMD.test(args.to)) {
    throw new Error('Required --to=YYYY-MM-DD exclusive end date');
  }
  if (args.targetDate && !YMD.test(args.targetDate)) throw new Error('Invalid --target-date');
}

function daysBetween(fromYmd, toYmd) {
  const from = new Date(`${fromYmd}T00:00:00Z`);
  const to = new Date(`${toYmd}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86400000));
}

function splitDateRange(fromYmd, toExclusiveYmd, chunkDays) {
  const chunks = [];
  let cur = new Date(`${fromYmd}T00:00:00Z`);
  const end = new Date(`${toExclusiveYmd}T00:00:00Z`);
  while (cur < end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: cur.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    cur = chunkEnd;
  }
  return chunks;
}

function resolveChunkDays(args) {
  if (args.chunkDays) return args.chunkDays;
  if (args.previousUserName) return 0;
  return daysBetween(args.from, args.to) > 7 ? 7 : 0;
}

async function resolveUserIdByName(pool, userName) {
  const [rows] = await pool.execute(
    `SELECT id, name, role_name FROM users WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    [userName]
  );
  return rows?.[0] || null;
}

async function fetchInterestedReclaimChunkSql(pool, chunkArgs) {
  const reclaimDate = buildDateClause('a.created_at', chunkArgs.from, chunkArgs.to);
  const assigneeFilter = chunkArgs.previousUserId
    ? ` AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) = ?`
    : '';
  const previousUserFilter = chunkArgs.previousUserName
    ? ` AND LOWER(prev_u.name) = LOWER(?)`
    : '';
  const sqlLimit = Math.min(Math.max(chunkArgs.limit * 2, 500), 5000);

  const params = [
    AUTOMATION_USER_ID,
    ...reclaimDate.params,
    ...(chunkArgs.previousUserId ? [chunkArgs.previousUserId] : []),
    AUTOMATION_USER_ID,
    AUTOMATION_USER_ID,
  ];
  if (chunkArgs.previousUserName) params.push(chunkArgs.previousUserName);

  const [rows] = await pool.execute(
    `
    WITH reclaim_raw AS (
      SELECT
        a.id AS reclaim_activity_id,
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status AS reclaim_old_status_col,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) AS previous_assignee_id,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousCycle')) AS previous_cycle,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.oldStatus')) AS pipeline_status_meta
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND a.performed_by = ?
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        ${reclaimDate.sql}
        AND (
          LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole')), '')) = 'counsellor'
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole')), '') = ''
        )
        ${assigneeFilter}
    ),
    reclaim_events AS (
      SELECT rr.*
      FROM reclaim_raw rr
      INNER JOIN (
        SELECT lead_id, MAX(reclaimed_at) AS max_reclaimed_at
        FROM reclaim_raw
        GROUP BY lead_id
      ) latest
        ON rr.lead_id = latest.lead_id
        AND rr.reclaimed_at = latest.max_reclaimed_at
    ),
    reclaim_with_last_status AS (
      SELECT
        re.*,
        (
          SELECT COALESCE(
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.callStatus')), ''),
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.visitStatus')), ''),
            NULLIF(al2.new_status, '')
          )
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_channel_status,
        (
          SELECT al2.new_status
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
            AND al2.new_status IS NOT NULL
            AND TRIM(al2.new_status) <> ''
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_lead_status_logged
      FROM reclaim_events re
    )
    SELECT
      re.reclaim_activity_id,
      re.lead_id,
      l.enquiry_number,
      l.name AS lead_name,
      l.lead_status AS current_lead_status,
      l.call_status AS current_call_status,
      l.visit_status AS current_visit_status,
      l.cycle_number AS current_cycle,
      l.assigned_to AS current_assigned_to,
      l.assigned_to_pro AS current_assigned_to_pro,
      re.reclaimed_at,
      re.previous_assignee_id,
      prev_u.name AS previous_assignee_name,
      prev_u.role_name AS previous_assignee_role,
      re.previous_cycle,
      COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.reclaim_old_status_col, '')) AS pipeline_at_reclaim,
      re.last_channel_status,
      re.last_lead_status_logged
    FROM reclaim_with_last_status re
    JOIN leads l ON l.id = re.lead_id
    LEFT JOIN users prev_u ON prev_u.id = re.previous_assignee_id
    WHERE LOWER(COALESCE(prev_u.role_name, '')) LIKE '%counselor%'
      ${previousUserFilter}
      AND (
        LOWER(TRIM(COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.reclaim_old_status_col, ''), '')))
          IN ('interested', 'cet applied', 'cet_applied')
        OR LOWER(TRIM(COALESCE(re.last_channel_status, ''))) IN ('interested', 'cet applied', 'cet_applied')
        OR LOWER(TRIM(COALESCE(re.last_lead_status_logged, ''))) IN ('interested', 'cet applied', 'cet_applied')
      )
    ORDER BY re.reclaimed_at DESC
    LIMIT ${sqlLimit}
    `,
    params
  );

  return rows || [];
}

function mergeCandidatesByLead(map, rows) {
  for (const row of rows) {
    const existing = map.get(row.lead_id);
    if (!existing || new Date(row.reclaimed_at) > new Date(existing.reclaimed_at)) {
      map.set(row.lead_id, row);
    }
  }
}

function buildDateClause(column, from, to) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push(`DATE(${column}) >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`DATE(${column}) < ?`);
    params.push(to);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

function isInterestedChannelStatus(s) {
  return INTERESTED_SET.has(norm(s));
}

function pickRestoreStatuses(row) {
  const pipeline = String(row.pipeline_at_reclaim || '').trim();
  const lastChannel = String(row.last_channel_status || '').trim();
  const preferred = isInterestedChannelStatus(lastChannel)
    ? lastChannel
    : isInterestedChannelStatus(pipeline)
      ? pipeline
      : 'Interested';
  const callStatus = preferred;
  const visitStatus = row.current_visit_status || null;
  const leadStatus = resolveLeadStatus('Interested', callStatus, visitStatus);
  return { callStatus, visitStatus, leadStatus };
}

async function fetchInterestedReclaimCandidates(pool, args) {
  let previousUserId = null;
  if (args.previousUserName) {
    const u = await resolveUserIdByName(pool, args.previousUserName);
    if (!u) throw new Error(`User not found: "${args.previousUserName}"`);
    previousUserId = u.id;
    console.log(`Filtering to previous assignee: ${u.name} (${u.role_name})`);
  }

  const chunkDays = resolveChunkDays(args);
  const dateChunks =
    chunkDays > 0
      ? splitDateRange(args.from, args.to, chunkDays)
      : [{ from: args.from, to: args.to }];

  if (chunkDays > 0) {
    console.log(
      `Finding Interested wrongful reclaims in ${dateChunks.length} date chunk(s) (${chunkDays} days each)...`
    );
  } else {
    console.log('Finding Interested wrongful reclaims (single SQL query)...');
  }

  const byLead = new Map();
  for (let i = 0; i < dateChunks.length; i += 1) {
    const chunk = dateChunks[i];
    if (dateChunks.length > 1) {
      console.log(`  Chunk ${i + 1}/${dateChunks.length}: ${chunk.from} → ${chunk.to}...`);
    }

    const rows = await fetchInterestedReclaimChunkSql(pool, {
      from: chunk.from,
      to: chunk.to,
      limit: args.limit,
      previousUserId,
      previousUserName: args.previousUserName,
    });
    mergeCandidatesByLead(byLead, rows);
    console.log(`    Found ${rows.length} in chunk; ${byLead.size} unique lead(s) so far.`);

    if (byLead.size >= args.limit) break;
  }

  const candidates = [...byLead.values()]
    .sort((a, b) => new Date(b.reclaimed_at) - new Date(a.reclaimed_at))
    .slice(0, args.limit);

  console.log(`  ${candidates.length} lead(s) with Interested/CET Applied before counsellor reclaim.`);
  return candidates;
}

function classifyCandidates(rows, args) {
  const restorable = [];
  const skipped = [];

  for (const row of rows) {
    const statuses = pickRestoreStatuses(row);
    const previousId = String(row.previous_assignee_id || '').trim();
    const currentAssignee = String(row.current_assigned_to || '').trim();
    const hasOtherAssignee = currentAssignee && currentAssignee !== previousId;

    if (hasOtherAssignee && !args.force) {
      skipped.push({
        ...row,
        ...statuses,
        skipReason: 'assigned_to_other_counsellor',
      });
      continue;
    }

    if (!previousId) {
      skipped.push({ ...row, ...statuses, skipReason: 'missing_previous_assignee' });
      continue;
    }

    restorable.push({
      ...row,
      ...statuses,
      overridesOtherCounsellor: hasOtherAssignee,
      previousCurrentAssigneeId: hasOtherAssignee ? currentAssignee : null,
    });
  }

  return { restorable, skipped };
}

async function applyRestore(pool, rows, args) {
  let restored = 0;
  const logRows = [];

  for (const row of rows) {
    const previousCycleNum = Number(row.previous_cycle);
    const cycleToSet =
      Number.isFinite(previousCycleNum) && previousCycleNum > 0
        ? previousCycleNum
        : Number(row.current_cycle) || 1;

    const setParts = [
      'assigned_to = ?',
      'assigned_at = NOW()',
      'assigned_by = ?',
      'call_status = ?',
      'lead_status = ?',
      'cycle_number = ?',
      'updated_at = NOW()',
    ];
    const params = [
      row.previous_assignee_id,
      AUTOMATION_USER_ID,
      row.callStatus,
      row.leadStatus,
      cycleToSet,
    ];

    if (args.targetDate) {
      setParts.push('counsellor_target_date = ?');
      params.push(args.targetDate);
    }

    if (!args.keepPro) {
      setParts.push(
        'assigned_to_pro = NULL',
        'pro_assigned_at = NULL',
        'pro_assigned_by = NULL',
        'pro_target_date = NULL'
      );
    }

    params.push(row.lead_id);

    await pool.execute(`UPDATE leads SET ${setParts.join(', ')} WHERE id = ?`, params);

    const activityId = uuidv4();
    await pool.execute(
      `INSERT INTO activity_logs (
        id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        activityId,
        row.lead_id,
        'status_change',
        String(row.current_lead_status || 'New'),
        row.leadStatus,
        row.overridesOtherCounsellor
          ? `Restored Interested lead to counsellor ${row.previous_assignee_name || row.previous_assignee_id} (was on another counsellor ${row.previousCurrentAssigneeId}) after wrongful reclaim (${row.reclaim_activity_id}).`
          : `Restored Interested lead to counsellor ${row.previous_assignee_name || row.previous_assignee_id} after wrongful reclaim (${row.reclaim_activity_id}).`,
        AUTOMATION_USER_ID,
        JSON.stringify({
          restoreInterestedReclaim: {
            reclaimActivityId: row.reclaim_activity_id,
            restoredAssignee: row.previous_assignee_id,
            restoredCallStatus: row.callStatus,
            restoredLeadStatus: row.leadStatus,
            restoredCycle: cycleToSet,
            lastChannelBeforeReclaim: row.last_channel_status,
            keepProSlot: args.keepPro,
            overridesOtherCounsellor: Boolean(row.overridesOtherCounsellor),
            previousCurrentAssigneeId: row.previousCurrentAssigneeId || null,
          },
        }),
      ]
    );

    restored += 1;
    logRows.push({
      leadId: row.lead_id,
      enquiryNumber: row.enquiry_number || '',
      leadName: row.lead_name || '',
      counsellor: row.previous_assignee_name || '',
      callStatus: row.callStatus,
      leadStatus: row.leadStatus,
      cycle: cycleToSet,
    });
  }

  return { restored, logRows };
}

async function main() {
  const args = parseArgs();
  validateArgs(args);

  const pool = getPool();

  console.log('\n=== Restore Interested leads (wrongful reclaim) ===');
  console.table([
    {
      mode: args.apply ? 'APPLY' : 'DRY_RUN',
      from: args.from,
      toExclusive: args.to,
      previousUser: args.previousUserName || '(all counsellors)',
      restoreReassigned: args.force,
      keepPro: args.keepPro,
      targetDate: args.targetDate || '(unchanged)',
      limit: args.limit,
    },
  ]);

  const candidates = await fetchInterestedReclaimCandidates(pool, args);
  console.log(`Fetched ${candidates.length} unique lead(s) with Interested channel before counsellor reclaim.`);

  const { restorable, skipped } = classifyCandidates(candidates, args);
  const reassignedOverrides = restorable.filter((r) => r.overridesOtherCounsellor).length;

  console.log('\n=== Plan ===');
  console.table([
    {
      candidates: candidates.length,
      willRestore: restorable.length,
      includingFromOtherCounsellor: reassignedOverrides,
      skipped: skipped.length,
    },
  ]);

  if (skipped.length > 0) {
    const byReason = new Map();
    for (const s of skipped) {
      const k = s.skipReason || 'other';
      byReason.set(k, (byReason.get(k) || 0) + 1);
    }
    console.log('\n=== Skipped breakdown ===');
    console.table(
      [...byReason.entries()].map(([reason, count]) => ({ reason, count }))
    );
    console.log(`\nSkipped sample (max 15):`);
    console.table(
      skipped.slice(0, 15).map((r) => ({
        enquiry: r.enquiry_number,
        leadName: r.lead_name,
        reason: r.skipReason,
        currentAssignedTo: r.current_assigned_to || '',
        previousCounsellor: r.previous_assignee_name,
      }))
    );
  }

  if (restorable.length > 0) {
    console.log(`\nWould restore sample (max 25):`);
    console.table(
      restorable.slice(0, 25).map((r) => ({
        enquiry: r.enquiry_number,
        leadName: r.lead_name,
        restoreTo: r.previous_assignee_name,
        fromOtherCounsellor: r.overridesOtherCounsellor ? 'yes' : 'no',
        restoreCallStatus: r.callStatus,
        restoreLeadStatus: r.leadStatus,
        channelBeforeReclaim: r.last_channel_status,
        currentAssignedTo: r.current_assigned_to || '(none)',
      }))
    );
  }

  if (!args.apply) {
    console.log('\nDry run complete. Re-run with --apply to write changes.');
    await closeDB();
    return;
  }

  if (restorable.length === 0) {
    console.log('\nNothing to restore.');
    await closeDB();
    return;
  }

  console.log(`\nApplying restore for ${restorable.length} lead(s)...`);
  const { restored, logRows } = await applyRestore(pool, restorable, args);

  console.log('\n=== Restore complete ===');
  console.table([{ restored }]);
  console.table(logRows.slice(0, 30));

  await closeDB();
}

main().catch(async (err) => {
  console.error('\nScript failed:', err?.message || err);
  try {
    await closeDB();
  } catch {
    // noop
  }
  process.exit(1);
});
