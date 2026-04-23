/**
 * Explains differences between:
 *  - User dashboard call-status cards (GET /api/leads/analytics/:userId → getUserLeadAnalytics):
 *      COUNT(*) of leads currently assigned_to the user, grouped by current leads.call_status,
 *      optional academic_year / student_group / mandal filters (same as dashboard dropdowns).
 *  - Super Admin reports → User Performance Summary “Interested Leads” + expanded footer
 *      (GET /api/leads/analytics/users → getUserAnalytics for Student Counselor):
 *      DISTINCT lead_id that had assignment activity (status_change, target_user_id) in the
 *      selected date window, grouped by CURRENT leads.call_status (Interested + CET Applied
 *      in the main column matches footer Interested + CET Applied).
 *
 * Typical reasons counts differ:
 *  1) Dashboard has no date filter — it is a snapshot of today’s portfolio; reports use a window.
 *  2) Many leads can be CET on the dashboard but were never (re)assigned to you in the report window.
 *  3) Report window counts leads that had an assignment log in-range; some may no longer be assigned_to you.
 *  4) Academic year / student group on the dashboard must match the report filters or numbers diverge.
 *
 * Usage (from backend-admission):
 *   node src/scripts-sql/dashboard-vs-reports-interested-cet.js --user-name="ADAPA JAHNAVI" --startDate=2026-04-01 --endDate=2026-04-23 --academic-year=2026
 *   node src/scripts-sql/dashboard-vs-reports-interested-cet.js --user-id=<uuid> --startDate=2026-04-01 --endDate=2026-04-23 --academic-year=2026
 *
 * Optional:
 *   --student-group=10th     (same as dashboard filter; omit = all groups)
 *   --mandal=Kakinada        (optional)
 *   --verbose                (print sample lead IDs for each diagnostic bucket)
 *   --sample-limit=30
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const COUNSELLOR_CALL_STATUS_CANONICAL = [
  'Assigned',
  'Interested',
  'Not Interested',
  'Not Answered',
  'Wrong Data',
  'Call Back',
  'Confirmed',
  'CET Applied',
];

function canonicalCallStatus(label) {
  const t = String(label ?? '').trim();
  if (!t || /^not\s*set$/i.test(t)) return 'Not set';
  const lower = t.toLowerCase();
  const hit = COUNSELLOR_CALL_STATUS_CANONICAL.find((s) => s.toLowerCase() === lower);
  return hit || t;
}

function parseArgs() {
  const out = {
    userName: '',
    userId: '',
    startDate: '',
    endDate: '',
    academicYear: null,
    studentGroup: '',
    mandal: '',
    verbose: false,
    sampleLimit: 30,
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
    if (arg.startsWith('--student-group=')) out.studentGroup = arg.slice('--student-group='.length).trim();
    if (arg.startsWith('--mandal=')) out.mandal = arg.slice('--mandal='.length).trim();
    if (arg === '--verbose') out.verbose = true;
    if (arg.startsWith('--sample-limit=')) {
      const n = Number(arg.slice('--sample-limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.sampleLimit = Math.floor(n);
    }
  }
  return out;
}

function bigIntNumber(v) {
  if (typeof v === 'bigint') return Number(v);
  return Number(v || 0);
}

function buildAssignmentDateWhere(startDateStr, endDateStr, useAcademicYear, yearNum) {
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

function buildDashboardWhere(userId, isPro, useAcademicYear, yearNum, studentGroup, mandal) {
  const assignmentCondition = isPro ? '(assigned_to_pro = ? OR assigned_to = ?)' : 'assigned_to = ?';
  const conditions = [assignmentCondition];
  const params = isPro ? [userId, userId] : [userId];
  if (useAcademicYear) {
    conditions.push('academic_year = ?');
    params.push(yearNum);
  }
  if (studentGroup) {
    if (studentGroup === 'Inter') {
      conditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
    } else {
      conditions.push('student_group = ?');
      params.push(studentGroup);
    }
  }
  if (mandal) {
    conditions.push('mandal = ?');
    params.push(mandal);
  }
  return { whereClause: conditions.join(' AND '), params };
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

function bucketMapFromRows(rows, keyField = 'bucket') {
  const m = {};
  for (const r of rows) {
    const raw = r[keyField];
    const key = canonicalCallStatus(raw);
    m[key] = (m[key] || 0) + bigIntNumber(r.cnt ?? r.count);
  }
  return m;
}

async function main() {
  const args = parseArgs();
  if ((!args.userName && !args.userId) || !args.startDate || !args.endDate) {
    console.error(
      'Usage: node src/scripts-sql/dashboard-vs-reports-interested-cet.js --user-name="..." OR --user-id=... --startDate=YYYY-MM-DD --endDate=YYYY-MM-DD [--academic-year=N] [--student-group=10th] [--mandal=...] [--verbose]'
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
  const isPro = String(user.role_name || '').trim().toUpperCase() === 'PRO';
  const isStudentCounselor = user.role_name === 'Student Counselor';

  const yearNum = args.academicYear != null ? args.academicYear : null;
  const useAcademicYear = yearNum != null && !Number.isNaN(yearNum);

  const { assignmentDateWhere, assignmentDateParams } = buildAssignmentDateWhere(
    args.startDate,
    args.endDate,
    useAcademicYear,
    yearNum
  );

  const { whereClause: dashWhere, params: dashParams } = buildDashboardWhere(
    uid,
    isPro,
    useAcademicYear,
    yearNum,
    args.studentGroup,
    args.mandal
  );

  console.log('\n=== User ===');
  console.log(JSON.stringify(user, null, 2));
  if (!isStudentCounselor && !isPro) {
    console.warn(
      '\nNote: This script compares call_status cohort (Student Counselor) vs dashboard.\nFor non–Student Counselor roles the dashboard uses lead_status, not call_status.\n'
    );
  }

  console.log('\n=== Filters (align these with UI when comparing) ===');
  console.log({
    reportWindow: { startDate: args.startDate, endDate: args.endDate },
    academicYear: useAcademicYear ? yearNum : '(not passed — dashboard “All years” if empty)',
    dashboardStudentGroup: args.studentGroup || '(none — all groups on dashboard)',
    dashboardMandal: args.mandal || '(none)',
  });

  // --- Dashboard: getUserLeadAnalytics (Student Counselor → call_status) ---
  const statusGroupExpr = isPro
    ? `COALESCE(NULLIF(TRIM(visit_status), ''), 'Not set')`
    : isStudentCounselor
      ? `COALESCE(NULLIF(TRIM(call_status), ''), 'Not set')`
      : 'lead_status';

  const [dashRows] = await pool.execute(
    `SELECT ${statusGroupExpr} AS bucket, COUNT(*) AS cnt
     FROM leads
     WHERE ${dashWhere}
     GROUP BY ${statusGroupExpr}`,
    dashParams
  );
  const dashMap = bucketMapFromRows(dashRows, 'bucket');

  // --- Reports footer: distinct lead in assignment window, bucket = current call_status (Student Counselor path) ---
  const cohortSql = `
    SELECT
      CASE WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set' ELSE TRIM(l.call_status) END AS bucket,
      COUNT(DISTINCT a.lead_id) AS cnt
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND a.target_user_id = ?
      ${assignmentDateWhere}
    GROUP BY CASE WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set' ELSE TRIM(l.call_status) END
  `;
  const [cohortRows] = await pool.execute(cohortSql, [uid, ...assignmentDateParams]);
  const cohortMap = bucketMapFromRows(cohortRows, 'bucket');

  const dashInterested = dashMap['Interested'] || 0;
  const dashCet = dashMap['CET Applied'] || 0;
  const cohortInterested = cohortMap['Interested'] || 0;
  const cohortCet = cohortMap['CET Applied'] || 0;

  console.log('\n=== Dashboard (GET /leads/analytics/:userId) — snapshot of leads row ===');
  console.log('Definition: leads currently assigned to user; bucket = current call_status (or visit_status for PRO).');
  console.log({
    Interested: dashInterested,
    'CET Applied': dashCet,
    'Interested + CET Applied (sum)': dashInterested + dashCet,
    total_leads_matching_dashboard_where: bigIntNumber(
      (await pool.execute(`SELECT COUNT(*) AS c FROM leads WHERE ${dashWhere}`, dashParams))[0][0].c
    ),
  });

  console.log('\n=== Reports performance (GET /leads/analytics/users) — period cohort footer ===');
  console.log(
    'Definition: DISTINCT lead_id with assignment activity (type=status_change, target_user_id) in [startDate..endDate]; bucket = CURRENT call_status on leads row.'
  );
  console.log({
    Interested: cohortInterested,
    'CET Applied': cohortCet,
    'Interested + CET Applied (matches main “Interested Leads” column for Student Counselor)':
      cohortInterested + cohortCet,
  });

  console.log('\n=== Deltas (reports cohort − dashboard snapshot) ===');
  console.log({
    Interested_delta: cohortInterested - dashInterested,
    CET_Applied_delta: cohortCet - dashCet,
    combined_delta: cohortInterested + cohortCet - (dashInterested + dashCet),
  });

  // Diagnostics: portfolio CET not in period cohort (same log window as reports; inner lead alias lx avoids clash with outer l)
  const assignmentWhereForExists = assignmentDateWhere.replace(/\bl\./g, 'lx.');
  const cohortExistsSql = `
    SELECT 1 FROM activity_logs a
    INNER JOIN leads lx ON lx.id = a.lead_id
    WHERE a.lead_id = l.id
      AND a.type = 'status_change'
      AND a.target_user_id = ?
      ${assignmentWhereForExists}
  `;
  const [[dashCetNotInCohort]] = await pool.execute(
    `
    SELECT COUNT(*) AS cnt
    FROM leads l
    WHERE ${dashWhere}
      AND TRIM(COALESCE(l.call_status, '')) = 'CET Applied'
      AND NOT EXISTS (${cohortExistsSql})
    `,
    [...dashParams, uid, ...assignmentDateParams]
  );

  const [[cohortCetNotAssignedNow]] = await pool.execute(
    `
    SELECT COUNT(DISTINCT a.lead_id) AS cnt
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND a.target_user_id = ?
      ${assignmentDateWhere}
      AND TRIM(COALESCE(l.call_status, '')) = 'CET Applied'
      AND NOT (l.assigned_to <=> ?)
    `,
    [uid, ...assignmentDateParams, uid]
  );

  const [[cohortInterestedNotAssignedNow]] = await pool.execute(
    `
    SELECT COUNT(DISTINCT a.lead_id) AS cnt
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND a.target_user_id = ?
      ${assignmentDateWhere}
      AND TRIM(COALESCE(l.call_status, '')) = 'Interested'
      AND NOT (l.assigned_to <=> ?)
    `,
    [uid, ...assignmentDateParams, uid]
  );

  console.log('\n=== Why numbers diverge (counts) ===');
  console.log({
    dashboard_CET_leads_NOT_having_assignment_log_to_you_in_this_window: bigIntNumber(dashCetNotInCohort.cnt),
    explanation_A:
      'These are usually older allotments or leads moved to CET without a new assignment log in the selected report dates — they still show on the dashboard.',
    report_cohort_CET_but_lead_not_assigned_to_you_now: bigIntNumber(cohortCetNotAssignedNow.cnt),
    report_cohort_Interested_but_lead_not_assigned_to_you_now: bigIntNumber(cohortInterestedNotAssignedNow.cnt),
    explanation_B:
      'Cohort is “touched in window”; assignment may have moved to another counsellor while call_status on the row still reads Interested/CET.',
  });

  console.log('\n=== Full bucket maps (canonical labels) ===');
  console.log('Dashboard:');
  console.table(Object.entries(dashMap).sort((a, b) => b[1] - a[1]));
  console.log('Report cohort (footer):');
  console.table(Object.entries(cohortMap).sort((a, b) => b[1] - a[1]));

  if (args.verbose) {
    const lim = args.sampleLimit;
    const [idsA] = await pool.execute(
      `
      SELECT l.id AS lead_id
      FROM leads l
      WHERE ${dashWhere}
        AND TRIM(COALESCE(l.call_status, '')) = 'CET Applied'
        AND NOT EXISTS (${cohortExistsSql})
      LIMIT ${lim}
      `,
      [...dashParams, uid, ...assignmentDateParams]
    );
    const [idsB] = await pool.execute(
      `
      SELECT DISTINCT a.lead_id
      FROM activity_logs a
      INNER JOIN leads l ON l.id = a.lead_id
      WHERE a.type = 'status_change'
        AND a.target_user_id = ?
        ${assignmentDateWhere}
        AND TRIM(COALESCE(l.call_status, '')) = 'CET Applied'
        AND NOT (l.assigned_to <=> ?)
      LIMIT ${lim}
      `,
      [uid, ...assignmentDateParams, uid]
    );
    console.log(`\nSample lead_ids: dashboard CET but no assignment log in window (max ${lim}):`);
    console.log(idsA.map((r) => r.lead_id));
    console.log(`\nSample lead_ids: report cohort CET but assigned_to is not you now (max ${lim}):`);
    console.log(idsB.map((r) => r.lead_id));
  }

  console.log('\n--- Summary ---');
  console.log([
    'Dashboard = “what is on my plate now” (leads table, assigned_to me).',
    'Reports Interested/CET in period = “distinct students who had an assignment to me logged in the date range”, labeled by their current call_status.',
    'Use the same academic year on both screens; if the dashboard has a student group filter, pass --student-group=… to this script.',
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
