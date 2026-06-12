/**
 * One-off: count admissions whose effective Reference 1 is Direct (matches Source list).
 * Usage: node src/scripts-sql/checkDirectReferenceCount.js
 */
import { getPool } from '../config-sql/database.js';

const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_J_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_L_DYNAMIC_JSON = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYNAMIC_JSON}, '$.reference1'))), '')`;
const SQL_A_EFFECTIVE_REFERENCE1 = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_J_REFERENCE1}, ${SQL_L_REFERENCE1})`;

async function main() {
  const pool = getPool();
  await pool.execute('SET SESSION sort_buffer_size = 4194304');

  const [totals] = await pool.execute(`
    SELECT
      COUNT(*) AS total_admissions,
      SUM(CASE WHEN LOWER(${SQL_A_EFFECTIVE_REFERENCE1}) = 'direct' THEN 1 ELSE 0 END) AS effective_ref_direct
    FROM admissions a
    LEFT JOIN joinings j ON j.id = a.joining_id
    LEFT JOIN leads l ON l.id = a.lead_id
  `);

  const [rows] = await pool.execute(`
    SELECT
      a.admission_number,
      a.student_name,
      a.course,
      l.source AS lead_source,
      ${SQL_A_EFFECTIVE_REFERENCE1} AS effective_reference1
    FROM admissions a
    LEFT JOIN joinings j ON j.id = a.joining_id
    LEFT JOIN leads l ON l.id = a.lead_id
    WHERE LOWER(${SQL_A_EFFECTIVE_REFERENCE1}) = 'direct'
  `);

  console.log('\n=== Direct reference admission counts ===\n');
  console.table(totals);
  console.log('\n=== Admissions with effective Reference 1 = Direct ===\n');
  console.table(rows);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
