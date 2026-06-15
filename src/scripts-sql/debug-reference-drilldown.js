/**
 * Debug reference drilldown vs stats grouping for a name.
 * Usage: node src/scripts-sql/debug-reference-drilldown.js "A KRANTHI MALA"
 */
import { getPool } from '../config-sql/database.js';

const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_A_REFNAME = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.referenceName'))), '')`;
const SQL_J_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_J_REFNAME = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.referenceName'))), '')`;
const SQL_L_DYNAMIC_JSON = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYNAMIC_JSON}, '$.reference1'))), '')`;
const SQL_A_EFFECTIVE_REFERENCE1 = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_J_REFERENCE1}, ${SQL_L_REFERENCE1})`;
const SQL_A_EFFECTIVE_REFERENCE_WIDE = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_A_REFNAME}, ${SQL_J_REFERENCE1}, ${SQL_J_REFNAME}, ${SQL_L_REFERENCE1})`;
const SQL_ADMISSION_PIVOT_JOINS = `LEFT JOIN joinings j ON j.id = a.joining_id LEFT JOIN leads l ON l.id = a.lead_id`;

const name = process.argv[2] || 'A KRANTHI MALA';
const key = name.trim().toLowerCase();

async function main() {
  const pool = getPool();

  const [byName] = await pool.execute(
    `SELECT COUNT(*) AS c FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}
     WHERE LOWER(TRIM(${SQL_A_EFFECTIVE_REFERENCE1})) = ? AND a.status != 'Admission Cancelled'`,
    [key]
  );

  const [byKey] = await pool.execute(
    `SELECT COUNT(*) AS c FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}
     WHERE COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') = ? AND a.status != 'Admission Cancelled'`,
    [name]
  );

  const [byWideName] = await pool.execute(
    `SELECT COUNT(*) AS c FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}
     WHERE LOWER(TRIM(${SQL_A_EFFECTIVE_REFERENCE_WIDE})) = ? AND a.status != 'Admission Cancelled'`,
    [key]
  );

  const [statsGroup] = await pool.execute(
    `SELECT COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') AS referenceKey,
            MAX(${SQL_A_EFFECTIVE_REFERENCE1}) AS referenceName,
            COUNT(*) AS cnt
     FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}
     WHERE a.status != 'Admission Cancelled'
     GROUP BY COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__')
     HAVING LOWER(TRIM(referenceName)) = ? OR LOWER(TRIM(referenceKey)) = ? OR referenceKey = ?`,
    [key, key, name]
  );

  const [samples] = await pool.execute(
    `SELECT a.admission_number, a.status,
            ${SQL_A_REFERENCE1} AS a_ref1, ${SQL_A_REFNAME} AS a_refname,
            ${SQL_J_REFERENCE1} AS j_ref1, ${SQL_L_REFERENCE1} AS l_ref1,
            ${SQL_A_EFFECTIVE_REFERENCE1} AS eff,
            COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') AS ref_key
     FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}
     WHERE LOWER(TRIM(${SQL_A_EFFECTIVE_REFERENCE1})) = ?
        OR COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') = ?
        OR LOWER(TRIM(${SQL_A_EFFECTIVE_REFERENCE_WIDE})) = ?
     LIMIT 5`,
    [key, name, key]
  );

  console.log('Name:', name);
  console.log('Count by LOWER(TRIM(eff_ref1)):', byName[0]?.c);
  console.log('Count by exact ref_key:', byKey[0]?.c);
  console.log('Count by wide ref (incl referenceName):', byWideName[0]?.c);
  console.log('Stats groups:', statsGroup);
  console.log('Samples:', samples);

  const endDate = new Date().toISOString().slice(0, 10);
  const [withFilters] = await pool.execute(
    `SELECT a.admission_number, a.status, DATE(COALESCE(a.admission_date, a.created_at)) AS adm_date
     FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}
     WHERE a.status = ?
       AND DATE(COALESCE(a.admission_date, a.created_at)) <= ?
       AND LOWER(TRIM(${SQL_A_EFFECTIVE_REFERENCE1})) = ?`,
    ['active', endDate, key]
  );
  console.log('With active + endDate filters:', withFilters);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
