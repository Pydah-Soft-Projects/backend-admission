/**
 * Find admissions where reference1 is missing on admission.lead_data but present on joining or lead.
 *
 * Usage: node src/scripts-sql/analyze-admission-reference-gaps.js [--limit=30]
 */
import { getPool } from '../config-sql/database.js';

const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 30);

const SQL_A_LEAD_DATA = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_A_REF = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA}, '$.reference1'))), '')`;
const SQL_J_LEAD_DATA = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REF = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA}, '$.reference1'))), '')`;
const SQL_L_DYN = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REF = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYN}, '$.reference1'))), '')`;

async function main() {
  const pool = getPool();

  const [summary] = await pool.execute(
    `SELECT
       COUNT(*) AS total_admissions,
       SUM(CASE WHEN ${SQL_A_REF} IS NOT NULL THEN 1 ELSE 0 END) AS admission_has_ref,
       SUM(CASE WHEN ${SQL_A_REF} IS NULL AND ${SQL_J_REF} IS NOT NULL THEN 1 ELSE 0 END) AS missing_on_adm_has_joining,
       SUM(CASE WHEN ${SQL_A_REF} IS NULL AND ${SQL_J_REF} IS NULL AND ${SQL_L_REF} IS NOT NULL THEN 1 ELSE 0 END) AS missing_on_adm_has_lead_only,
       SUM(CASE WHEN ${SQL_A_REF} IS NULL AND ${SQL_J_REF} IS NULL AND ${SQL_L_REF} IS NULL THEN 1 ELSE 0 END) AS no_ref_anywhere
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id`
  );

  console.log('\n=== Admission reference coverage ===\n');
  console.table(summary);

  const [samples] = await pool.execute(
    `SELECT
       a.admission_number,
       a.id AS admission_id,
       ${SQL_A_REF} AS admission_ref,
       ${SQL_J_REF} AS joining_ref,
       ${SQL_L_REF} AS lead_dynamic_ref
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE ${SQL_A_REF} IS NULL
       AND (${SQL_J_REF} IS NOT NULL OR ${SQL_L_REF} IS NOT NULL)
     ORDER BY a.admission_number DESC
     LIMIT ${Number(limit)}`
  );

  console.log(
    `\nSample admissions with reference on joining/lead but NOT on admission.lead_data (${samples.length} rows):\n`
  );
  console.table(samples);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
