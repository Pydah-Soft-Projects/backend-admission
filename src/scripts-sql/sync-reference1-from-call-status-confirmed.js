/**
 * Reference 1 rule (live app — joiningReference.util.js):
 *   When call_status is marked "Confirmed", the acting user becomes reference1
 *   (only if dynamic_fields.reference1 was not already set).
 *
 * This script finds the LAST staff member who marked call_status Confirmed in
 * activity_logs (metadata.callStatus) and compares that to stored reference1 on
 * leads / joinings / admissions.
 *
 * Usage:
 *   node src/scripts-sql/sync-reference1-from-call-status-confirmed.js
 *   node src/scripts-sql/sync-reference1-from-call-status-confirmed.js --limit=50
 *   node src/scripts-sql/sync-reference1-from-call-status-confirmed.js --apply
 *   node src/scripts-sql/sync-reference1-from-call-status-confirmed.js --apply --only-missing
 *   node src/scripts-sql/sync-reference1-from-call-status-confirmed.js --apply --force
 *
 * Flags:
 *   --apply         Write reference1 = last confirmer (default: report only)
 *   --only-missing  Only update rows where reference1 is empty
 *   --force         Also overwrite stored reference when it differs from confirmer
 *   --limit=N       Cap report rows (default 100)
 */
import { getPool } from '../config-sql/database.js';
import {
  fetchLastCallStatusConfirmedByUserName,
  persistLeadReference1,
  readReference1FromDynamicFields,
} from '../utils/joiningReference.util.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyMissing = args.includes('--only-missing');
const force = args.includes('--force');
const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || 100);

const CALL_STATUS_CONFIRMED_LOG = `
  LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.callStatus')), ''))) = 'confirmed'
`;

const LATEST_CONFIRMER_SUBQUERY = `
  SELECT c.lead_id, c.confirmer_name, c.confirmed_at, c.performed_by
  FROM (
    SELECT a.lead_id, u.name AS confirmer_name, a.created_at AS confirmed_at, a.performed_by
    FROM activity_logs a
    INNER JOIN users u ON u.id = a.performed_by
    WHERE a.type = 'status_change'
      AND (${CALL_STATUS_CONFIRMED_LOG})
  ) c
  INNER JOIN (
    SELECT lead_id, MAX(created_at) AS max_at
    FROM activity_logs a
    WHERE a.type = 'status_change'
      AND (${CALL_STATUS_CONFIRMED_LOG})
    GROUP BY lead_id
  ) latest ON latest.lead_id = c.lead_id AND latest.max_at = c.confirmed_at
`;

const SQL_LEAD_DYN = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_LEAD_REF = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_LEAD_DYN}, '$.reference1'))), '')`;

const norm = (s) => String(s ?? '').trim().toLowerCase();

function classifyRow(row) {
  const confirmer = String(row.confirmer_name ?? '').trim();
  const stored = String(row.stored_reference1 ?? '').trim();
  const callStatus = String(row.call_status ?? '').trim();

  if (!confirmer) {
    if (norm(callStatus) === 'confirmed') {
      return stored ? 'confirmed_no_log_has_ref' : 'confirmed_no_log';
    }
    return stored ? 'has_ref_no_confirm_log' : 'skip';
  }

  if (!stored) return 'missing_ref';
  if (norm(stored) === norm(confirmer)) return 'ok';
  return 'mismatch';
}

function shouldUpdate(status, storedRef, confirmer) {
  if (!confirmer) return false;
  if (status === 'ok' || status === 'skip' || status === 'has_ref_no_confirm_log') return false;
  if (onlyMissing) return status === 'missing_ref' || status === 'confirmed_no_log';
  if (force) {
    return (
      status === 'missing_ref' ||
      status === 'mismatch' ||
      status === 'confirmed_no_log' ||
      status === 'confirmed_no_log_has_ref'
    );
  }
  // Default apply: fill missing; fix mismatch only when stored ref equals assignee (stale auto-assign)
  if (status === 'missing_ref' || status === 'confirmed_no_log') return true;
  if (status === 'mismatch') {
    const assignee = String(storedRef.assignee_name ?? '').trim();
    const stored = String(storedRef.stored ?? '').trim();
    return assignee && norm(stored) === norm(assignee);
  }
  return false;
}

async function main() {
  const pool = getPool();

  console.log('\n=== Reference 1 vs call_status Confirmed (activity_logs) ===\n');
  console.log(
    'Rule in app: marking call_status as Confirmed sets reference1 to the acting user',
    '(skipped if reference1 was already set on that update).\n'
  );
  console.log(
    `Mode: ${apply ? 'APPLY (will update DB)' : 'DRY RUN (report only)'}` +
      `${onlyMissing ? ' | only-missing' : ''}${force ? ' | force' : ''}\n`
  );

  const [summary] = await pool.execute(
    `SELECT
       SUM(CASE WHEN LOWER(TRIM(l.call_status)) = 'confirmed' THEN 1 ELSE 0 END) AS leads_call_status_confirmed,
       SUM(CASE WHEN conf.lead_id IS NOT NULL THEN 1 ELSE 0 END) AS leads_with_confirmer_log,
       SUM(CASE WHEN LOWER(TRIM(l.call_status)) = 'confirmed' AND conf.lead_id IS NOT NULL THEN 1 ELSE 0 END) AS confirmed_with_log,
       SUM(CASE WHEN LOWER(TRIM(l.call_status)) = 'confirmed' AND conf.lead_id IS NULL THEN 1 ELSE 0 END) AS confirmed_without_log,
       SUM(CASE WHEN ${SQL_LEAD_REF} IS NOT NULL THEN 1 ELSE 0 END) AS leads_with_stored_ref,
       SUM(CASE WHEN conf.lead_id IS NOT NULL AND ${SQL_LEAD_REF} IS NULL THEN 1 ELSE 0 END) AS confirmer_but_missing_ref,
       SUM(CASE WHEN conf.lead_id IS NOT NULL AND ${SQL_LEAD_REF} IS NOT NULL
                AND LOWER(TRIM(${SQL_LEAD_REF})) = LOWER(TRIM(conf.confirmer_name)) THEN 1 ELSE 0 END) AS ref_matches_confirmer,
       SUM(CASE WHEN conf.lead_id IS NOT NULL AND ${SQL_LEAD_REF} IS NOT NULL
                AND LOWER(TRIM(${SQL_LEAD_REF})) <> LOWER(TRIM(conf.confirmer_name)) THEN 1 ELSE 0 END) AS ref_differs_confirmer
     FROM leads l
     LEFT JOIN (${LATEST_CONFIRMER_SUBQUERY}) conf ON conf.lead_id = l.id`
  );
  console.table(summary);

  const [rows] = await pool.execute(
    `SELECT
       l.id AS lead_id,
       l.enquiry_number,
       l.name AS student_name,
       l.call_status,
       u.name AS assigned_counsellor,
       conf.confirmer_name,
       conf.confirmed_at,
       ${SQL_LEAD_REF} AS stored_reference1
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     INNER JOIN (${LATEST_CONFIRMER_SUBQUERY}) conf ON conf.lead_id = l.id
     ORDER BY conf.confirmed_at DESC
     LIMIT ${Number(limit)}`
  );

  const report = [];
  const toUpdate = [];

  for (const row of rows) {
    const status = classifyRow(row);
    const entry = {
      enquiry: row.enquiry_number,
      student: row.student_name,
      call_status: row.call_status,
      confirmer: row.confirmer_name,
      stored_ref: row.stored_reference1 || '(empty)',
      assigned: row.assigned_counsellor || '—',
      status,
      will_update: false,
    };

    if (shouldUpdate(status, { stored: row.stored_reference1, assignee_name: row.assigned_counsellor }, row.confirmer_name)) {
      entry.will_update = true;
      toUpdate.push(row);
    }
    report.push(entry);
  }

  console.log(`\nLeads with call_status Confirmed log (showing up to ${rows.length}):\n`);
  console.table(report);

  const [mismatchSample] = await pool.execute(
    `SELECT
       l.enquiry_number,
       conf.confirmer_name AS should_be_reference,
       ${SQL_LEAD_REF} AS stored_reference1,
       u.name AS assigned_counsellor
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     INNER JOIN (${LATEST_CONFIRMER_SUBQUERY}) conf ON conf.lead_id = l.id
     WHERE ${SQL_LEAD_REF} IS NOT NULL
       AND LOWER(TRIM(${SQL_LEAD_REF})) <> LOWER(TRIM(conf.confirmer_name))
     ORDER BY l.enquiry_number DESC
     LIMIT 25`
  );

  if (mismatchSample.length) {
    console.log('\nSample: stored reference1 differs from last Confirmed-by user:\n');
    console.table(mismatchSample);
    console.log(
      'These may be manual overrides or assigned-counsellor auto-fill. Use --force on --apply to overwrite.\n'
    );
  }

  if (!apply) {
    const [countWould] = await pool.execute(
      `SELECT COUNT(*) AS cnt
       FROM leads l
       INNER JOIN (${LATEST_CONFIRMER_SUBQUERY}) conf ON conf.lead_id = l.id`
    );
    console.log(
      `Would consider ${countWould[0]?.cnt ?? 0} lead(s) with a Confirmed-by log;`,
      `${toUpdate.length} would be updated with current flags (from report sample of ${rows.length}).`,
      'Re-run with --apply to persist.\n'
    );
    await pool.end();
    return;
  }

  const [allConfirmerLeads] = await pool.execute(
    `SELECT
       l.id AS lead_id,
       l.enquiry_number,
       l.name AS student_name,
       l.call_status,
       u.name AS assigned_counsellor,
       conf.confirmer_name,
       ${SQL_LEAD_REF} AS stored_reference1
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     INNER JOIN (${LATEST_CONFIRMER_SUBQUERY}) conf ON conf.lead_id = l.id`
  );

  const applyRows = allConfirmerLeads.filter((row) =>
    shouldUpdate(
      classifyRow(row),
      { stored: row.stored_reference1, assignee_name: row.assigned_counsellor },
      row.confirmer_name
    )
  );

  console.log(`\nApplying reference1 for ${applyRows.length} lead(s)...\n`);

  let leadsUpdated = 0;
  let joiningsTouched = 0;
  let admissionsTouched = 0;
  let skipped = 0;

  for (const row of applyRows) {
    const confirmer = String(row.confirmer_name ?? '').trim();
    if (!confirmer) {
      skipped += 1;
      continue;
    }

    const verify = await fetchLastCallStatusConfirmedByUserName(pool, row.lead_id);
    const refToWrite = verify || confirmer;

    const result = await persistLeadReference1(pool, row.lead_id, refToWrite);
    if (result.leadUpdated) leadsUpdated += 1;
    joiningsTouched += result.joiningsUpdated;
    admissionsTouched += result.admissionsUpdated;
  }

  // Also handle call_status=Confirmed but no log: try per-lead confirmer fetch (edge cases)
  if (onlyMissing || force) {
    const [noLogRows] = await pool.execute(
      `SELECT l.id AS lead_id, l.enquiry_number, ${SQL_LEAD_REF} AS stored_reference1
       FROM leads l
       LEFT JOIN (${LATEST_CONFIRMER_SUBQUERY}) conf ON conf.lead_id = l.id
       WHERE LOWER(TRIM(l.call_status)) = 'confirmed'
         AND conf.lead_id IS NULL
         AND ${SQL_LEAD_REF} IS NULL
       LIMIT 500`
    );

    for (const row of noLogRows) {
      const [dynRows] = await pool.execute(
        'SELECT dynamic_fields FROM leads WHERE id = ? LIMIT 1',
        [row.lead_id]
      );
      const rawDyn = dynRows[0]?.dynamic_fields;
      const dyn =
        typeof rawDyn === 'string' ? JSON.parse(rawDyn || '{}') : rawDyn && typeof rawDyn === 'object' ? rawDyn : {};
      if (readReference1FromDynamicFields(dyn)) continue;

      const confirmer = await fetchLastCallStatusConfirmedByUserName(pool, row.lead_id);
      if (!confirmer) continue;

      const result = await persistLeadReference1(pool, row.lead_id, confirmer);
      if (result.leadUpdated) leadsUpdated += 1;
      joiningsTouched += result.joiningsUpdated;
      admissionsTouched += result.admissionsUpdated;
    }
  }

  console.log('\n=== Apply complete ===\n');
  console.table({
    leads_updated: leadsUpdated,
    joinings_rows_updated: joiningsTouched,
    admissions_rows_updated: admissionsTouched,
    skipped_no_confirmer: skipped,
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
