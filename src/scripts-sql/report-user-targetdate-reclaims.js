/**
 * User assignment summary focused on target-date + reclaim counts.
 *
 * Usage:
 *   node src/scripts-sql/report-user-targetdate-reclaims.js --user-name="ADABALA SAI SATYA" --from=2026-04-07 --to=2026-04-08
 *
 * Notes:
 * - `--from` inclusive, `--to` exclusive (YYYY-MM-DD).
 * - Reads assignment events from activity_logs metadata.assignment.assignedTo.
 * - Reclaims are counted from activity_logs metadata.reclamation.previousAssignee.
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

function parseArgs() {
  const out = {
    userName: '',
    from: null,
    to: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--user-name=')) out.userName = arg.slice('--user-name='.length).trim();
    if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length).trim() || null;
    if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length).trim() || null;
  }

  return out;
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
  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
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

async function main() {
  const args = parseArgs();
  if (!args.userName) {
    throw new Error('Missing required --user-name');
  }

  const pool = getPool();
  const user = await getUser(pool, args.userName);
  if (!user) {
    throw new Error(`User not found by exact name: "${args.userName}"`);
  }

  const assignmentDate = buildDateClause('a.created_at', args.from, args.to);
  const reclaimDate = buildDateClause('a.created_at', args.from, args.to);

  const [assignedSummaryRows] = await pool.execute(
    `
    SELECT
      COUNT(*) AS assignment_events,
      COUNT(DISTINCT a.lead_id) AS distinct_leads_assigned,
      COUNT(DISTINCT CASE WHEN l.target_date IS NOT NULL THEN a.lead_id END) AS distinct_leads_with_target_date,
      COUNT(DISTINCT CASE WHEN l.target_date IS NULL THEN a.lead_id END) AS distinct_leads_without_target_date
    FROM activity_logs a
    LEFT JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo')) = ?
      ${assignmentDate.sql}
    `,
    [user.id, ...assignmentDate.params]
  );

  const [targetDateBreakdownRows] = await pool.execute(
    `
    SELECT
      DATE(l.target_date) AS target_date,
      COUNT(DISTINCT a.lead_id) AS distinct_assigned_leads
    FROM activity_logs a
    LEFT JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo')) = ?
      AND l.target_date IS NOT NULL
      ${assignmentDate.sql}
    GROUP BY DATE(l.target_date)
    ORDER BY target_date
    `,
    [user.id, ...assignmentDate.params]
  );

  const [reclaimSummaryRows] = await pool.execute(
    `
    SELECT
      COUNT(*) AS reclaim_events,
      COUNT(DISTINCT a.lead_id) AS distinct_reclaimed_leads,
      SUM(CASE WHEN a.performed_by = '00000000-0000-0000-0000-000000000000' THEN 1 ELSE 0 END) AS automated_reclaims,
      SUM(CASE WHEN a.performed_by <> '00000000-0000-0000-0000-000000000000' THEN 1 ELSE 0 END) AS manual_reclaims
    FROM activity_logs a
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) = ?
      ${reclaimDate.sql}
    `,
    [user.id, ...reclaimDate.params]
  );

  console.log('\n=== User ===');
  console.table([{
    id: user.id,
    name: user.name,
    active: user.is_active ? 'Yes' : 'No',
    from: args.from || '(all)',
    toExclusive: args.to || '(all)',
  }]);

  console.log('\n=== Assigned + Target Date Summary ===');
  console.table(assignedSummaryRows);

  console.log('\n=== Target Date Breakdown (distinct assigned leads) ===');
  console.table(targetDateBreakdownRows);

  console.log('\n=== Reclaim Summary ===');
  console.table(reclaimSummaryRows);

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
