/** Quick test for reference drilldown two-phase query. */
import { getPool } from '../config-sql/database.js';

const ADMISSION_CANCELLED_STATUS = 'Admission Cancelled';
const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_J_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_L_DYNAMIC_JSON = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYNAMIC_JSON}, '$.reference1'))), '')`;
const SQL_A_EFFECTIVE_REFERENCE1 = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_J_REFERENCE1}, ${SQL_L_REFERENCE1})`;
const SQL_A_EFFECTIVE_ADMISSION_DATE = `COALESCE(a.admission_date, a.created_at)`;
const SQL_A_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(a.managed_course_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.course_id AS CHAR)), ''))`;
const SQL_ADMISSION_PIVOT_JOINS = `LEFT JOIN joinings j ON j.id = a.joining_id LEFT JOIN leads l ON l.id = a.lead_id`;

const referenceKey = 'A KRANTHI MALA';
const endDate = new Date().toISOString().slice(0, 10);
const conditions = [
  `DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`,
  `a.status = ?`,
  `COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') = ?`,
];
const params = [endDate, 'active', referenceKey];
const whereClause = `WHERE ${conditions.join(' AND ')}`;
const pivotFrom = `FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}`;

const pool = getPool();
try {
  const [idRows] = await pool.execute(
    `SELECT a.id, a.admission_number ${pivotFrom} ${whereClause} ORDER BY a.admission_number DESC LIMIT 500`,
    params
  );
  console.log('with ORDER BY', idRows);
} catch (err) {
  console.log('ORDER BY failed:', err.message);
}

const [idRowsNoSort] = await pool.execute(
  `SELECT a.id, a.admission_number ${pivotFrom} ${whereClause} LIMIT 500`,
  params
);
console.log(
  'without ORDER BY',
  [...idRowsNoSort].sort((a, b) => String(b.admission_number).localeCompare(String(a.admission_number)))
);
await pool.end();
