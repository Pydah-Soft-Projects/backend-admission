/**
 * Audit reference-name enrichment coverage via HRMS (read-only).
 *
 * Usage:
 *   node src/scripts-sql/audit-reference-hrms-meta.js
 *   node src/scripts-sql/audit-reference-hrms-meta.js --simulate
 */
import mongoose from 'mongoose';
import { getPool } from '../config-sql/database.js';
import { buildHrmsEmployeeMetaByReferenceKeys } from '../controllers/user.controller.js';

const simulate = process.argv.includes('--simulate');

const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_J_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_L_DYNAMIC_JSON = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYNAMIC_JSON}, '$.reference1'))), '')`;
const SQL_A_EFFECTIVE_REFERENCE1 = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_J_REFERENCE1}, ${SQL_L_REFERENCE1})`;

const normalizeReferenceNameKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

async function enrichRows(rows) {
  const referenceKeys = rows
    .map((row) => normalizeReferenceNameKey(row.name))
    .filter((key) => key && key !== '(not specified)');

  const hrmsMetaByKey = await buildHrmsEmployeeMetaByReferenceKeys(referenceKeys, 'audit-reference-hrms-meta');

  return rows.map((row) => {
    const key = normalizeReferenceNameKey(row.name);
    const meta = key ? hrmsMetaByKey.get(key) : null;
    return {
      ...row,
      department: meta?.department ?? null,
      designation: meta?.designation ?? null,
    };
  });
}

async function main() {
  const pool = getPool();
  const [refs] = await pool.execute(
    `SELECT DISTINCT ${SQL_A_EFFECTIVE_REFERENCE1} AS referenceName
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE ${SQL_A_EFFECTIVE_REFERENCE1} IS NOT NULL
     ORDER BY referenceName`
  );

  const rows = refs
    .map((r) => ({ name: String(r.referenceName || '').trim() }))
    .filter((r) => r.name);

  const enriched = await enrichRows(rows);
  const withDept = enriched.filter((r) => r.department).length;
  const withDesig = enriched.filter((r) => r.designation).length;
  const missing = enriched.filter((r) => !r.designation).slice(0, 20);

  console.log('\n=== Reference HRMS meta audit ===\n');
  console.log(`Distinct references: ${rows.length}`);
  console.log(`With department (HRMS): ${withDept}`);
  console.log(`With designation (HRMS): ${withDesig}`);
  console.log(`Missing designation: ${rows.length - withDesig}`);

  if (simulate || missing.length) {
    console.log('\nSample references without HRMS designation:\n');
    console.table(
      missing.map((r) => ({
        name: r.name,
        department: r.department ?? null,
      }))
    );
  }

  await pool.end();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
