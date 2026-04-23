/**
 * Set leads.call_status from "Not Answered" → "Call Back" and set next_scheduled_call.
 *
 * Modes:
 *   --all              Every matching lead in the table (no assignee filter unless --assigned-only).
 *   --user-id / --user-name   Only leads currently assigned to that user (PRO: assigned_to_pro OR assigned_to).
 *
 * Separate from normalizeLeadCallStatus.js (canonical spelling only, whole table, no status migration).
 *
 * Usage (from backend-admission, .env must have DB_*):
 *
 *   Global (dry-run first — shows count + sample):
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --all --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --all --assigned-only --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --all --apply
 *
 *   One user (same as before):
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --user-name="ADAPA JAHNAVI" --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --user-id=<uuid> --apply
 *
 * Optional:
 *   --callback-date=2026-04-24   (default 2026-04-24; stored as YYYY-MM-DD 12:00:00)
 *   --academic-year=2026         (only leads with this academic_year)
 *   --assigned-only              With --all: only rows where assigned_to OR assigned_to_pro is set
 *   --sample-limit=50
 *
 * "Not Answered" match (MySQL 8+): normalize spaces then compare:
 *   LOWER(REGEXP_REPLACE(TRIM(call_status), '[[:space:]]+', ' ')) = 'not answered'
 *   Catches odd Unicode spaces / double spaces that plain TRIM would miss.
 *
 * After --apply: the running API process keeps an in-memory cache for GET /api/leads/analytics/users.
 * Clear it by: Super Admin → Call Reports → User Performance → "Refresh from DB", or
 *   curl -X POST -H "Authorization: Bearer <token>" https://<host>/api/leads/analytics/users/cache
 * (running this script in Node does not clear the API server’s memory).
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

function parseArgs() {
  const out = {
    all: false,
    assignedOnly: false,
    userName: '',
    userId: '',
    callbackDate: '2026-04-24',
    academicYear: null,
    dryRun: false,
    apply: false,
    sampleLimit: 50,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--all') out.all = true;
    if (arg === '--assigned-only') out.assignedOnly = true;
    if (arg.startsWith('--user-name=')) out.userName = arg.slice('--user-name='.length).trim();
    if (arg.startsWith('--user-id=')) out.userId = arg.slice('--user-id='.length).trim();
    if (arg.startsWith('--callback-date=')) out.callbackDate = arg.slice('--callback-date='.length).trim();
    if (arg.startsWith('--academic-year=')) {
      const y = parseInt(arg.slice('--academic-year='.length).trim(), 10);
      out.academicYear = Number.isFinite(y) ? y : null;
    }
    if (arg.startsWith('--sample-limit=')) {
      const n = Number(arg.slice('--sample-limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.sampleLimit = Math.floor(n);
    }
    if (arg === '--dry-run') out.dryRun = true;
    if (arg === '--apply') out.apply = true;
  }
  return out;
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

function assignmentPredicateForRole(roleName) {
  const r = String(roleName || '').trim();
  if (r.toUpperCase() === 'PRO') {
    return {
      sql: '(l.assigned_to_pro = ? OR l.assigned_to = ?)',
      params: (uid) => [uid, uid],
    };
  }
  return {
    sql: 'l.assigned_to = ?',
    params: (uid) => [uid],
  };
}

/** YYYY-MM-DD → MySQL DATETIME string */
function callbackDateTime(dateStr) {
  const s = String(dateStr || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid --callback-date (use YYYY-MM-DD): ${dateStr}`);
  }
  return `${s} 12:00:00`;
}

async function main() {
  const args = parseArgs();

  const modeOk = args.dryRun !== args.apply;
  const scopeOk = args.all || args.userName || args.userId;
  if (!modeOk || !scopeOk) {
    console.error(
      [
        'Usage:',
        '  Global:  node ... --all (--dry-run | --apply) [--assigned-only] [--callback-date=2026-04-24] [--academic-year=N]',
        '  One user: node ... --user-name="..." OR --user-id=... (--dry-run | --apply) [same options]',
        'Do not pass both --dry-run and --apply. Use either --all OR a user, not both.',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  if (args.all && (args.userName || args.userId)) {
    console.error('Use either --all OR --user-id/--user-name, not both.');
    process.exitCode = 1;
    return;
  }

  const pool = getPool();

  let user = null;
  let assignParams = [];
  let assignSql = '';

  if (!args.all) {
    user = await resolveUser(pool, args);
    if (!user) {
      console.error('User not found.');
      process.exitCode = 1;
      await closeDB();
      return;
    }
    const pred = assignmentPredicateForRole(user.role_name);
    assignSql = pred.sql;
    assignParams = pred.params(user.id);
  }

  let academicClause = '';
  const academicParams = [];
  if (args.academicYear != null && !Number.isNaN(args.academicYear)) {
    academicClause = ' AND l.academic_year = ?';
    academicParams.push(args.academicYear);
  }

  let assigneeClause = '';
  if (args.all && args.assignedOnly) {
    assigneeClause = ' AND (l.assigned_to IS NOT NULL OR l.assigned_to_pro IS NOT NULL)';
  }

  const statusClause = `LOWER(REGEXP_REPLACE(TRIM(COALESCE(l.call_status, '')), '[[:space:]]+', ' ')) = 'not answered'`;
  const nextCall = callbackDateTime(args.callbackDate);

  let baseWhere;
  let countParams;
  if (args.all) {
    baseWhere = `WHERE ${statusClause}${academicClause}${assigneeClause}`;
    countParams = [...academicParams];
  } else {
    baseWhere = `WHERE ${assignSql} AND ${statusClause}${academicClause}`;
    countParams = [...assignParams, ...academicParams];
  }

  const countSql = `SELECT COUNT(*) AS c FROM leads l ${baseWhere}`;
  const sampleSql = `SELECT l.id, l.name, l.call_status, l.next_scheduled_call, l.academic_year, l.assigned_to, l.assigned_to_pro
    FROM leads l ${baseWhere} LIMIT ${args.sampleLimit}`;

  console.log('\n=== Scope ===');
  if (args.all) {
    console.log({
      mode: 'ALL leads (entire table)',
      assignedOnly: args.assignedOnly,
      warning: args.assignedOnly
        ? undefined
        : 'No assignee filter: includes unassigned leads with Not Answered. Add --assigned-only to limit to assigned rows.',
    });
  } else {
    console.log('Target user:', JSON.stringify(user, null, 2));
  }

  console.log('\n=== Change ===');
  console.log({
    fromCallStatus: 'Not Answered (trim + collapse spaces + lower)',
    toCallStatus: 'Call Back',
    next_scheduled_call: nextCall,
    callbackDateInput: args.callbackDate,
    academicYearFilter: args.academicYear ?? '(none)',
    runMode: args.apply ? 'APPLY' : 'DRY-RUN',
  });

  const [[countRow]] = await pool.execute(countSql, countParams);
  const n = typeof countRow.c === 'bigint' ? Number(countRow.c) : Number(countRow.c || 0);
  console.log(`\nMatching leads: ${n}`);

  const [samples] = await pool.execute(sampleSql, countParams);
  if (samples.length > 0) {
    console.log(`\nSample (up to ${args.sampleLimit}):`);
    console.table(samples);
  }

  if (args.dryRun) {
    console.log('\nDry-run only. Re-run with --apply to execute UPDATE.');
    await closeDB();
    return;
  }

  const updateSql = `
    UPDATE leads l
    SET
      l.call_status = 'Call Back',
      l.next_scheduled_call = ?,
      l.updated_at = NOW()
    ${baseWhere}
  `;
  const updateParams = [nextCall, ...countParams];
  const [result] = await pool.execute(updateSql, updateParams);
  console.log('\nUPDATE done:', {
    affectedRows: result.affectedRows,
    changedRows: result.changedRows,
    warningStatus: result.warningStatus,
  });

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
