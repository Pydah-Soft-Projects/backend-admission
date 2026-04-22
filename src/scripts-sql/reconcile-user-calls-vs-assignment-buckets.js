/**
 * Reconciles “Calls / Visits Done” (API `calls.total`) vs expanded assignment buckets
 * (`callStatusCounts` summed from activity_logs × current `leads.call_status`).
 *
 * Mirrors backend logic in leadAssignment.controller.js → getUserAnalytics:
 * - calls.total = COUNT(DISTINCT lead_id) for type=call with non-empty call_outcome, sent_at in range
 * - assignments = rows from activity_logs (status_change, target_user_id) with created_at in range;
 *   each row adds 1 to bucket leads.call_status (trimmed, or 'Not set')
 * - callsOnCurrentPortfolio = outcome calls restricted to leads still assigned to the user (counselor or pro)
 *
 * Usage:
 *   node src/scripts-sql/reconcile-user-calls-vs-assignment-buckets.js --user-name="MIDDI GANGA DURGA BHAVANI" --startDate=2026-01-01 --endDate=2026-04-22
 *   node src/scripts-sql/reconcile-user-calls-vs-assignment-buckets.js --user-id=<uuid> --startDate=2026-01-01 --endDate=2026-04-22
 *
 * Optional:
 *   --academic-year=2026   (filters communications + assignments via leads.academic_year)
 *   --verbose              (print sample lead IDs per section)
 *   --sample-limit=25      (max IDs to print per bucket when verbose)
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

function parseArgs() {
  const out = {
    userName: '',
    userId: '',
    startDate: '',
    endDate: '',
    academicYear: null,
    verbose: false,
    sampleLimit: 25,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--user-name=')) out.userName = arg.slice('--user-name='.length).trim();
    if (arg.startsWith('--user-id=')) out.userId = arg.slice('--user-id='.length).trim();
    if (arg.startsWith('--startDate=')) out.startDate = arg.slice('--startDate='.length).trim();
    if (arg.startsWith('--endDate=')) out.endDate = arg.slice('--endDate='.length).trim();
    if (arg.startsWith('--academic-year=')) {
      const y = parseInt(arg.slice('--academic-year='.length).trim(), 10);
      out.academicYear = Number.isFinite(y) ? y : null;
    }
    if (arg === '--verbose') out.verbose = true;
    if (arg.startsWith('--sample-limit=')) {
      const n = Number(arg.slice('--sample-limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.sampleLimit = Math.floor(n);
    }
  }
  return out;
}

function buildActivityRange(startDateStr, endDateStr) {
  const activityDateConditions = [];
  const activityDateParams = [];
  if (startDateStr) {
    const start = new Date(startDateStr);
    start.setHours(0, 0, 0, 0);
    activityDateConditions.push('>= ?');
    activityDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
  }
  if (endDateStr) {
    const end = new Date(endDateStr);
    end.setHours(23, 59, 59, 999);
    activityDateConditions.push('<= ?');
    activityDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
  }
  const activityDateClause =
    activityDateConditions.length > 0
      ? `AND ${activityDateConditions.map((c) => `sent_at ${c}`).join(' AND ')}`
      : '';
  return { activityDateClause, activityDateParams };
}

function buildAssignmentRange(startDateStr, endDateStr, useAcademicYear, yearNum) {
  const assignmentDateConditions = [];
  const assignmentDateParams = [];
  if (startDateStr) {
    const start = new Date(startDateStr);
    start.setHours(0, 0, 0, 0);
    assignmentDateConditions.push('a.created_at >= ?');
    assignmentDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
  }
  if (endDateStr) {
    const end = new Date(endDateStr);
    end.setHours(23, 59, 59, 999);
    assignmentDateConditions.push('a.created_at <= ?');
    assignmentDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
  }
  if (useAcademicYear) {
    assignmentDateConditions.push('l.academic_year = ?');
    assignmentDateParams.push(yearNum);
  }
  const assignmentDateWhere =
    assignmentDateConditions.length > 0 ? `AND ${assignmentDateConditions.join(' AND ')}` : '';
  return { assignmentDateWhere, assignmentDateParams };
}

async function resolveUser(pool, { userName, userId }) {
  if (userId) {
    const [rows] = await pool.execute(
      `SELECT id, name, email, role_name FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    return rows?.[0] || null;
  }
  if (userName) {
    const [rows] = await pool.execute(
      `SELECT id, name, email, role_name FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
      [userName]
    );
    return rows?.[0] || null;
  }
  return null;
}

function bigIntNumber(v) {
  if (typeof v === 'bigint') return Number(v);
  return Number(v || 0);
}

async function main() {
  const args = parseArgs();
  if ((!args.userName && !args.userId) || !args.startDate || !args.endDate) {
    console.error(
      'Usage: node ... --user-name="..." OR --user-id=... --startDate=YYYY-MM-DD --endDate=YYYY-MM-DD [--academic-year=N] [--verbose]'
    );
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  const user = await resolveUser(pool, args);
  if (!user) {
    console.error('User not found.');
    process.exitCode = 1;
    await closeDB();
    return;
  }

  const uid = user.id;
  const yearNum = args.academicYear != null ? args.academicYear : null;
  const useAcademicYear = yearNum != null && !Number.isNaN(yearNum);

  const { activityDateClause, activityDateParams } = buildActivityRange(args.startDate, args.endDate);
  const { assignmentDateWhere, assignmentDateParams } = buildAssignmentRange(
    args.startDate,
    args.endDate,
    useAcademicYear,
    yearNum
  );

  const commParamsBase = useAcademicYear
    ? [uid, ...activityDateParams, yearNum]
    : [uid, ...activityDateParams];

  console.log('\n=== User ===');
  console.log(JSON.stringify(user, null, 2));
  console.log('\n=== Report window (matches getUserAnalytics) ===');
  console.log({
    startDate: args.startDate,
    endDate: args.endDate,
    academicYear: useAcademicYear ? yearNum : '(not filtered)',
  });

  // 1) calls.total — distinct leads with outcome calls (same as API)
  const [[callsTotalRow]] = await pool.execute(
    `
    SELECT COUNT(DISTINCT c.lead_id) AS distinct_leads_with_outcome_calls
    FROM communications c
    ${useAcademicYear ? 'INNER JOIN leads l ON l.id = c.lead_id' : ''}
    WHERE c.sent_by = ?
      AND c.type = 'call'
      AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
      ${activityDateClause}
      ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
    `,
    commParamsBase
  );

  // 2) callsOnCurrentPortfolio
  const [[portfolioRow]] = await pool.execute(
    `
    SELECT COUNT(DISTINCT c.lead_id) AS distinct_leads_outcome_calls_current_portfolio
    FROM communications c
    INNER JOIN leads l ON l.id = c.lead_id
    WHERE c.type = 'call'
      AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
      AND c.sent_by = ?
      ${activityDateClause}
      AND (l.assigned_to = c.sent_by OR l.assigned_to_pro = c.sent_by)
      ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
    `,
    commParamsBase
  );

  // 3) Assignment expansion: row counts by current call_status (same buckets as UI)
  const [callStatusBuckets] = await pool.execute(
    `
    SELECT
      CASE
        WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set'
        ELSE TRIM(l.call_status)
      END AS call_status_bucket,
      COUNT(*) AS assignment_rows
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND a.target_user_id = ?
      ${assignmentDateWhere}
    GROUP BY call_status_bucket
    ORDER BY assignment_rows DESC
    `,
    [uid, ...assignmentDateParams]
  );

  let totalAssignmentRows = 0;
  let sumNonAssigned = 0;
  for (const r of callStatusBuckets) {
    totalAssignmentRows += bigIntNumber(r.assignment_rows);
    const b = String(r.call_status_bucket || '');
    if (b !== 'Assigned' && b !== 'Not set') {
      sumNonAssigned += bigIntNumber(r.assignment_rows);
    }
    // "Not set" often still waiting — user may or may not include in "done"; show both sums
  }

  const [[distinctLeadsAssignedInRange]] = await pool.execute(
    `
    SELECT COUNT(DISTINCT a.lead_id) AS distinct_leads_in_assignment_logs
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND a.target_user_id = ?
      ${assignmentDateWhere}
    `,
    [uid, ...assignmentDateParams]
  );

  // 4) Among distinct outcome-call leads: current call_status distribution (one row per lead)
  const [outcomeLeadStatusDist] = await pool.execute(
    `
    SELECT
      CASE
        WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set'
        ELSE TRIM(l.call_status)
      END AS call_status_bucket,
      COUNT(*) AS distinct_leads
    FROM (
      SELECT DISTINCT c.lead_id
      FROM communications c
      ${useAcademicYear ? 'INNER JOIN leads l2 ON l2.id = c.lead_id' : ''}
      WHERE c.sent_by = ?
        AND c.type = 'call'
        AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
        ${activityDateClause}
        ${useAcademicYear ? 'AND l2.academic_year = ?' : ''}
    ) x
    INNER JOIN leads l ON l.id = x.lead_id
    GROUP BY call_status_bucket
    ORDER BY distinct_leads DESC
    `,
    commParamsBase
  );

  // 5) Where outcome-call leads sit today (SQL `=` misses leads with both assignees NULL — use <=> for diagnostics)
  const [[portfolioBreakdown]] = await pool.execute(
    `
    SELECT
      COUNT(DISTINCT c.lead_id) AS distinct_leads_joined_to_leads_row,
      COUNT(DISTINCT CASE
        WHEN (l.assigned_to <=> c.sent_by) OR (l.assigned_to_pro <=> c.sent_by) THEN c.lead_id
      END) AS held_by_counselor_now_nullsafe,
      COUNT(DISTINCT CASE
        WHEN NOT ((l.assigned_to <=> c.sent_by) OR (l.assigned_to_pro <=> c.sent_by)) THEN c.lead_id
      END) AS not_held_by_counselor_now_nullsafe,
      COUNT(DISTINCT CASE
        WHEN l.assigned_to IS NULL AND l.assigned_to_pro IS NULL THEN c.lead_id
      END) AS both_assignees_null_on_lead,
      COUNT(DISTINCT CASE
        WHEN NOT ((l.assigned_to <=> c.sent_by) OR (l.assigned_to_pro <=> c.sent_by))
          AND NOT (l.assigned_to IS NULL AND l.assigned_to_pro IS NULL)
        THEN c.lead_id
      END) AS assigned_to_someone_else_now
    FROM communications c
    INNER JOIN leads l ON l.id = c.lead_id
    WHERE c.sent_by = ?
      AND c.type = 'call'
      AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
      ${activityDateClause}
      ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
    `,
    commParamsBase
  );

  console.log('\n=== Headline counts (same definitions as GET /api/leads/analytics/users) ===');
  console.log({
    calls_total__distinct_leads_with_outcome_calls_in_period: bigIntNumber(callsTotalRow.distinct_leads_with_outcome_calls),
    callsOnCurrentPortfolio__distinct_leads_outcome_calls_API_uses_plain_equality:
      bigIntNumber(portfolioRow.distinct_leads_outcome_calls_current_portfolio),
    pendingBalance_style_gap:
      bigIntNumber(callsTotalRow.distinct_leads_with_outcome_calls) -
      bigIntNumber(portfolioRow.distinct_leads_outcome_calls_current_portfolio),
  });
  console.log('\n=== Same outcome-call distinct leads — where the lead sits NOW (diagnostic; NULL-safe) ===');
  console.log(
    'Why a plain SQL `=` portfolio count can look “too low”: rows with both assignees NULL do not satisfy (assigned_to = user OR assigned_to_pro = user).'
  );
  console.log({
    distinct_leads_with_lead_row: bigIntNumber(portfolioBreakdown.distinct_leads_joined_to_leads_row),
    held_by_this_counselor_now__null_safe: bigIntNumber(portfolioBreakdown.held_by_counselor_now_nullsafe),
    not_held_by_this_counselor_now__null_safe: bigIntNumber(portfolioBreakdown.not_held_by_counselor_now_nullsafe),
    those_with_both_assignees_NULL: bigIntNumber(portfolioBreakdown.both_assignees_null_on_lead),
    those_assigned_to_someone_else_not_unassigned: bigIntNumber(portfolioBreakdown.assigned_to_someone_else_now),
  });

  console.log('\n=== Expanded table style: assignment LOG rows in period, grouped by CURRENT leads.call_status ===');
  console.log(
    '(Each reassignment / log line is counted separately; buckets use live call_status on the lead.)'
  );
  console.table(callStatusBuckets.map((r) => ({
    call_status_bucket: r.call_status_bucket,
    assignment_rows: bigIntNumber(r.assignment_rows),
  })));
  console.log({
    total_assignment_rows_in_period: totalAssignmentRows,
    distinct_leads_touched_by_those_assignment_logs: bigIntNumber(
      distinctLeadsAssignedInRange.distinct_leads_in_assignment_logs
    ),
    sum_of_rows_where_bucket_not_Assigned: sumNonAssigned,
  });

  console.log('\n=== Same counselor’s distinct outcome-call leads: CURRENT call_status distribution ===');
  console.log(
    '(Explains why “Calls done” can exceed sums of non-Assigned buckets: many leads stay “Assigned” until follow-up updates.)'
  );
  console.table(
    outcomeLeadStatusDist.map((r) => ({
      call_status_bucket: r.call_status_bucket,
      distinct_leads_with_outcome_call_in_period: bigIntNumber(r.distinct_leads),
    }))
  );

  if (args.verbose) {
    const lim = args.sampleLimit;
    const [idsNotHeld] = await pool.execute(
      `
      SELECT DISTINCT c.lead_id
      FROM communications c
      INNER JOIN leads l ON l.id = c.lead_id
      WHERE c.sent_by = ?
        AND c.type = 'call'
        AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
        ${activityDateClause}
        AND NOT ((l.assigned_to <=> c.sent_by) OR (l.assigned_to_pro <=> c.sent_by))
        ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
      LIMIT ${lim}
      `,
      commParamsBase
    );
    console.log(
      `\n=== Sample lead_ids: outcome call in period, lead NOT held by this counselor now (NULL-safe; max ${lim}) ===`
    );
    console.log(idsNotHeld.map((x) => x.lead_id));
  }

  console.log('\n--- Interpretation ---');
  console.log([
    '`calls.total` counts DISTINCT leads where this user logged a call WITH an outcome in the date range.',
    'Expanded rows count EVERY assignment activity row in the range, labeled with the lead’s CURRENT `call_status`.',
    'Those are different shapes (distinct leads vs. log lines × current bucket), so totals rarely match.',
    'If many buckets show "Assigned", summed "work done" style counts will be lower than distinct outcome calls.',
  ].join('\n'));

  await closeDB();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closeDB();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
