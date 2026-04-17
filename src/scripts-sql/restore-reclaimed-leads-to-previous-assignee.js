/**
 * Restore auto-reclaimed leads back to previous assignee/status/cycle.
 *
 * Default mode is DRY RUN (no DB updates).
 *
 * Usage:
 *   node src/scripts-sql/restore-reclaimed-leads-to-previous-assignee.js --user-name="ADABALA SAI SATYA" --from=2026-04-07 --to=2026-04-18
 *
 * Apply mode:
 *   node src/scripts-sql/restore-reclaimed-leads-to-previous-assignee.js --user-name="ADABALA SAI SATYA" --from=2026-04-07 --to=2026-04-18 --apply
 *
 * Optional:
 *   --target-date=2026-04-20   (set this target_date while restoring)
 *   --limit=500                (max leads to restore in one run; default 1000)
 *
 * Notes:
 * - Restores only events created by automation user id:
 *   00000000-0000-0000-0000-000000000000
 * - Picks latest reclaim event per lead in range.
 * - Skips leads currently assigned (safety).
 */

import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const AUTOMATION_USER_ID = '00000000-0000-0000-0000-000000000000';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs() {
  const out = {
    userName: '',
    from: null,
    to: null,
    apply: false,
    targetDate: null,
    limit: 1000,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--user-name=')) out.userName = arg.slice('--user-name='.length).trim();
    if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length).trim() || null;
    if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length).trim() || null;
    if (arg === '--apply') out.apply = true;
    if (arg.startsWith('--target-date=')) out.targetDate = arg.slice('--target-date='.length).trim() || null;
    if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
    }
  }

  return out;
}

function validateArgs(args) {
  if (!args.userName) throw new Error('Missing required --user-name');
  if (!args.from || !YMD.test(args.from)) throw new Error('Missing/invalid --from (YYYY-MM-DD)');
  if (!args.to || !YMD.test(args.to)) throw new Error('Missing/invalid --to (YYYY-MM-DD, exclusive)');
  if (args.targetDate && !YMD.test(args.targetDate)) throw new Error('Invalid --target-date (YYYY-MM-DD)');
}

async function getUser(pool, userName) {
  const [rows] = await pool.execute(
    `
    SELECT id, name, is_active
    FROM users
    WHERE LOWER(name) = LOWER(?)
    LIMIT 1
    `,
    [userName]
  );
  return rows?.[0] || null;
}

async function fetchCandidateRows(pool, userId, from, to, limit) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : 1000;
  const [rows] = await pool.execute(
    `
    WITH ranked_reclaims AS (
      SELECT
        a.id AS reclaim_activity_id,
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status,
        a.new_status,
        a.comment,
        a.performed_by,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) AS previous_assignee,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousCycle')) AS previous_cycle,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.oldStatus')) AS old_status_meta,
        ROW_NUMBER() OVER (
          PARTITION BY a.lead_id
          ORDER BY a.created_at DESC
        ) AS rn
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND a.performed_by = ?
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) = ?
        AND DATE(a.created_at) >= ?
        AND DATE(a.created_at) < ?
    )
    SELECT
      rr.reclaim_activity_id,
      rr.lead_id,
      rr.reclaimed_at,
      rr.previous_assignee,
      rr.previous_cycle,
      COALESCE(NULLIF(rr.old_status_meta, ''), NULLIF(rr.old_status, ''), 'Assigned') AS restore_status,
      l.enquiry_number,
      l.name AS lead_name,
      l.lead_status AS current_status,
      l.cycle_number AS current_cycle,
      l.assigned_to,
      l.assigned_to_pro,
      l.target_date
    FROM ranked_reclaims rr
    JOIN leads l ON l.id = rr.lead_id
    WHERE rr.rn = 1
    ORDER BY rr.reclaimed_at DESC
    LIMIT ${safeLimit}
    `,
    [AUTOMATION_USER_ID, userId, from, to]
  );
  return rows || [];
}

function buildRestoreSet(candidates) {
  const skippedAssigned = [];
  const restorable = [];

  for (const row of candidates) {
    const isCurrentlyAssigned = Boolean(row.assigned_to || row.assigned_to_pro);
    if (isCurrentlyAssigned) {
      skippedAssigned.push(row);
      continue;
    }
    restorable.push(row);
  }

  return { restorable, skippedAssigned };
}

function buildStatusCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.restore_status || 'Assigned');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([restoreStatus, count]) => ({ restoreStatus, count }))
    .sort((a, b) => b.count - a.count || a.restoreStatus.localeCompare(b.restoreStatus));
}

async function applyRestore(pool, rows, targetDate) {
  let restored = 0;
  const restoreLogRows = [];

  for (const row of rows) {
    const previousCycleNum = Number(row.previous_cycle);
    const cycleToSet = Number.isFinite(previousCycleNum) && previousCycleNum > 0
      ? previousCycleNum
      : (Number(row.current_cycle) || 1);

    await pool.execute(
      `
      UPDATE leads
      SET
        assigned_to = ?,
        assigned_at = NOW(),
        assigned_by = ?,
        assigned_to_pro = NULL,
        pro_assigned_at = NULL,
        pro_assigned_by = NULL,
        lead_status = ?,
        target_date = ?,
        cycle_number = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        row.previous_assignee,
        AUTOMATION_USER_ID,
        row.restore_status,
        targetDate || null,
        cycleToSet,
        row.lead_id,
      ]
    );

    const activityId = uuidv4();
    await pool.execute(
      `
      INSERT INTO activity_logs (
        id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        activityId,
        row.lead_id,
        'status_change',
        String(row.current_status || 'New'),
        row.restore_status,
        `Restored from auto-reclaim to previous assignee ${row.previous_assignee} (from reclaim event ${row.reclaim_activity_id}).`,
        AUTOMATION_USER_ID,
        JSON.stringify({
          restoreFromReclaim: {
            reclaimActivityId: row.reclaim_activity_id,
            restoredAssignee: row.previous_assignee,
            restoredStatus: row.restore_status,
            restoredCycle: cycleToSet,
            restoredTargetDate: targetDate || null,
          },
        }),
      ]
    );

    restored += 1;
    restoreLogRows.push({
      leadId: row.lead_id,
      enquiryNumber: row.enquiry_number || '',
      leadName: row.lead_name || '',
      restoredStatus: row.restore_status,
      restoredCycle: cycleToSet,
      restoredTargetDate: targetDate || null,
    });
  }

  return { restored, restoreLogRows };
}

async function main() {
  const args = parseArgs();
  validateArgs(args);

  const pool = getPool();
  const user = await getUser(pool, args.userName);
  if (!user) throw new Error(`User not found by exact name: "${args.userName}"`);

  const candidates = await fetchCandidateRows(pool, user.id, args.from, args.to, args.limit);
  const { restorable, skippedAssigned } = buildRestoreSet(candidates);
  const restoreStatusCounts = buildStatusCounts(restorable);

  console.log('\n=== Restore From Auto-Reclaim ===');
  console.table([{
    userId: user.id,
    userName: user.name,
    from: args.from,
    toExclusive: args.to,
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    forcedTargetDate: args.targetDate || '(keep null)',
    fetchedCandidates: candidates.length,
    restorableNow: restorable.length,
    skippedCurrentlyAssigned: skippedAssigned.length,
    limit: args.limit,
  }]);

  if (skippedAssigned.length > 0) {
    console.log(`\n=== Skipped (currently assigned) sample: ${Math.min(20, skippedAssigned.length)} ===`);
    console.table(
      skippedAssigned.slice(0, 20).map((r) => ({
        leadId: r.lead_id,
        enquiryNumber: r.enquiry_number || '',
        leadName: r.lead_name || '',
        currentStatus: r.current_status || '',
        assignedTo: r.assigned_to || '',
        assignedToPro: r.assigned_to_pro || '',
      }))
    );
  }

  if (!args.apply) {
    console.log('\nDry run complete. No updates were made.');
    console.log('\n=== Restore Status Unique Counts ===');
    console.table(restoreStatusCounts);
    if (restorable.length > 0) {
      console.log(`\n=== Would restore sample: ${Math.min(30, restorable.length)} ===`);
      console.table(
        restorable.slice(0, 30).map((r) => ({
          leadId: r.lead_id,
          enquiryNumber: r.enquiry_number || '',
          leadName: r.lead_name || '',
          restoreStatus: r.restore_status,
          restoreCycle: r.previous_cycle,
          restoreAssignee: r.previous_assignee,
          restoreTargetDate: args.targetDate || null,
          reclaimedAt: r.reclaimed_at,
        }))
      );
    }
    await closeDB();
    return;
  }

  if (restorable.length === 0) {
    console.log('\nNothing to restore in apply mode.');
    await closeDB();
    return;
  }

  const { restored, restoreLogRows } = await applyRestore(pool, restorable, args.targetDate);

  console.log('\n=== Restore applied ===');
  console.table([{ restored }]);
  console.log('\n=== Restored Status Unique Counts ===');
  console.table(restoreStatusCounts);
  console.table(restoreLogRows.slice(0, 30));

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
