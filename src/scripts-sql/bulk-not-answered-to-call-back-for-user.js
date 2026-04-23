/**
 * Maintenance script — full run (default) or PRO visit only:
 *
 * Default (--all or --user-*): two passes in one --apply:
 *   1) call_status: "Not Answered" → "Call Back" and set next_scheduled_call.
 *   2) visit_status: for every lead with assigned_to_pro set, normalize blank / "not set" / non‑standard
 *      values to "Assigned".
 *
 * --pro-visit-only: run pass (2) only (no call_status / next_scheduled_call changes).
 *
 * Modes (call_status pass — omit when using --pro-visit-only):
 *   --all              Every matching lead in the table (no assignee filter unless --assigned-only).
 *   --user-id / --user-name   Only leads currently assigned to that user (PRO: assigned_to_pro OR assigned_to).
 *
 * PRO visit_status only (no Not Answered / call_status changes):
 *   --pro-visit-only   Only pass 2: rows with assigned_to_pro set → normalize visit_status to Assigned where needed.
 *   Do not combine with --all, --user-id, or --user-name.
 *
 * Separate from normalizeLeadCallStatus.js (canonical spelling only, whole table, no status migration).
 *
 * Usage (from backend-admission, .env must have DB_*):
 *
 *   Global (dry-run first — shows counts + samples):
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --all --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --all --assigned-only --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --all --apply
 *
 *   One user (call_status scope only):
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --user-name="ADAPA JAHNAVI" --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --user-id=<uuid> --apply
 *
 *   PRO visit_status only (pass 2 only):
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --pro-visit-only --dry-run
 *     node src/scripts-sql/bulk-not-answered-to-call-back-for-user.js --pro-visit-only --apply
 *
 * Optional:
 *   --callback-date=2026-04-24   (default 2026-04-24; stored as YYYY-MM-DD 12:00:00)
 *   --academic-year=2026         (only leads with this academic_year; applies to call_status pass only)
 *   --assigned-only              With --all: only rows where assigned_to OR assigned_to_pro is set
 *   --sample-limit=50
 *
 * "Not Answered" match (MySQL 8+): normalize spaces then compare:
 *   LOWER(REGEXP_REPLACE(TRIM(call_status), '[[:space:]]+', ' ')) = 'not answered'
 *
 * visit_status pass: rows where assigned_to_pro IS NOT NULL and normalized visit_status is not one of
 *   assigned, interested, not interested, not available, scheduled revisit, confirmed
 *   (empty / not set / typos → set to Assigned).
 *
 * After --apply: restart API or clear GET /api/leads/analytics/users in-memory cache if counts look stale.
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
    proVisitOnly: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--pro-visit-only') out.proVisitOnly = true;
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

function proVisitNormalizeWhereClause() {
  const norm = `LOWER(REGEXP_REPLACE(TRIM(COALESCE(l.visit_status, '')), '[[:space:]]+', ' '))`;
  return `
    l.assigned_to_pro IS NOT NULL
    AND (
      TRIM(COALESCE(l.visit_status, '')) = ''
      OR ${norm} = 'not set'
      OR ${norm} NOT IN (
        'assigned',
        'interested',
        'not interested',
        'not available',
        'scheduled revisit',
        'confirmed'
      )
    )
  `.replace(/\s+/g, ' ');
}

async function main() {
  const args = parseArgs();

  const modeOk = args.dryRun !== args.apply;
  if (!modeOk) {
    console.error('Pass exactly one of: --dry-run OR --apply');
    process.exitCode = 1;
    return;
  }

  if (args.proVisitOnly) {
    if (args.all || args.userName || args.userId) {
      console.error('--pro-visit-only cannot be used with --all, --user-id, or --user-name.');
      process.exitCode = 1;
      return;
    }
    if (args.assignedOnly) {
      console.error('--assigned-only applies only to the call_status pass; omit it with --pro-visit-only.');
      process.exitCode = 1;
      return;
    }
  } else {
    const scopeOk = args.all || args.userName || args.userId;
    if (!scopeOk) {
      console.error(
        [
          'Usage:',
          '  Call status + PRO visit: node ... --all (--dry-run | --apply) [options]',
          '  or: node ... --user-name="..." | --user-id=... (--dry-run | --apply)',
          '  PRO visit only:        node ... --pro-visit-only (--dry-run | --apply)',
          'Do not pass both --dry-run and --apply.',
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
  }

  const pool = getPool();

  const proVisitWhere = proVisitNormalizeWhereClause();
  const proVisitCountSql = `SELECT COUNT(*) AS c FROM leads l WHERE ${proVisitWhere}`;
  const proVisitSampleSql = `SELECT l.id, l.name, l.visit_status, l.assigned_to_pro
    FROM leads l WHERE ${proVisitWhere} LIMIT ${args.sampleLimit}`;
  const proVisitUpdateSql = `
    UPDATE leads l
    SET l.visit_status = 'Assigned', l.updated_at = NOW()
    WHERE ${proVisitWhere}
  `;

  if (args.proVisitOnly) {
    console.log('\n=== PRO visit_status only (--pro-visit-only) ===');
    console.log({
      action: 'SET visit_status = Assigned',
      condition: 'assigned_to_pro IS NOT NULL AND (empty / not set / not in standard PRO list)',
      runMode: args.apply ? 'APPLY' : 'DRY-RUN',
    });

    const [[proVisitCountRow]] = await pool.execute(proVisitCountSql);
    const nProVisit =
      typeof proVisitCountRow.c === 'bigint' ? Number(proVisitCountRow.c) : Number(proVisitCountRow.c || 0);
    console.log(`\nMatching leads: ${nProVisit}`);

    const [proSamples] = await pool.execute(proVisitSampleSql);
    if (proSamples.length > 0) {
      console.log(`\nSample (up to ${args.sampleLimit}):`);
      console.table(proSamples);
    }

    if (args.dryRun) {
      console.log('\nDry-run only. Re-run with --pro-visit-only --apply to execute UPDATE.');
      await closeDB();
      return;
    }

    const [proResult] = await pool.execute(proVisitUpdateSql);
    console.log('\nUPDATE (PRO visit_status → Assigned) done:', {
      affectedRows: proResult.affectedRows,
      changedRows: proResult.changedRows,
      warningStatus: proResult.warningStatus,
    });
    await closeDB();
    return;
  }

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

  console.log('\n=== Scope (call_status pass) ===');
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

  console.log('\n=== Change (call_status pass) ===');
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
  console.log(`\nMatching leads (Not Answered → Call Back): ${n}`);

  const [samples] = await pool.execute(sampleSql, countParams);
  if (samples.length > 0) {
    console.log(`\nSample call_status (up to ${args.sampleLimit}):`);
    console.table(samples);
  }

  const [[proVisitCountRow]] = await pool.execute(proVisitCountSql);
  const nProVisit =
    typeof proVisitCountRow.c === 'bigint' ? Number(proVisitCountRow.c) : Number(proVisitCountRow.c || 0);
  console.log(`\n=== PRO visit_status pass (all leads with assigned_to_pro) ===`);
  console.log({
    action: 'SET visit_status = Assigned',
    condition: 'assigned_to_pro IS NOT NULL AND (empty / not set / not in standard PRO list)',
    matchingLeads: nProVisit,
    runMode: args.apply ? 'APPLY' : 'DRY-RUN',
  });
  const [proSamples] = await pool.execute(proVisitSampleSql);
  if (proSamples.length > 0) {
    console.log(`\nSample visit_status (up to ${args.sampleLimit}):`);
    console.table(proSamples);
  }

  if (args.dryRun) {
    console.log('\nDry-run only. Re-run with --apply to execute UPDATEs (call_status + PRO visit).');
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
  console.log('\nUPDATE (call_status) done:', {
    affectedRows: result.affectedRows,
    changedRows: result.changedRows,
    warningStatus: result.warningStatus,
  });

  const [proResult] = await pool.execute(proVisitUpdateSql);
  console.log('\nUPDATE (PRO visit_status → Assigned) done:', {
    affectedRows: proResult.affectedRows,
    changedRows: proResult.changedRows,
    warningStatus: proResult.warningStatus,
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
