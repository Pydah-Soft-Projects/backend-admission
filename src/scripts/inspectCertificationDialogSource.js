import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const conn = await mysql.createConnection({
  host: process.env.DB_SECONDARY_HOST,
  port: process.env.DB_SECONDARY_PORT || 3306,
  user: process.env.DB_SECONDARY_USER,
  password: process.env.DB_SECONDARY_PASSWORD,
  database: process.env.DB_SECONDARY_NAME,
  ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const [rows] = await conn.execute(
  'SELECT admission_number, certificates_status, student_data FROM students WHERE admission_number IN (?,?) ORDER BY admission_number',
  ['20260001','20260009']
);

const out = rows.map((r) => {
  let payload = {};
  try { payload = typeof r.student_data === 'string' ? JSON.parse(r.student_data || '{}') : (r.student_data || {}); } catch {}
  const certEntries = Object.entries(payload).filter(([k]) => /cert|10th|diploma|tc|original/i.test(k));
  return {
    admission_number: r.admission_number,
    certificates_status_column: r.certificates_status,
    cert_entries: Object.fromEntries(certEntries),
    registrationFormData_certificate_checklist: payload?.registrationFormData?.certificate_checklist || null,
  };
});

console.log(JSON.stringify(out, null, 2));
await conn.end();
