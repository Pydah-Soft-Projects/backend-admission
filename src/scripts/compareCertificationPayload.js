import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const targets = ['20260001','20260003','20260007','20260009'];

const conn = await mysql.createConnection({
  host: process.env.DB_SECONDARY_HOST,
  port: process.env.DB_SECONDARY_PORT || 3306,
  user: process.env.DB_SECONDARY_USER,
  password: process.env.DB_SECONDARY_PASSWORD,
  database: process.env.DB_SECONDARY_NAME,
  ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const marks = targets.map(() => '?').join(',');
const [rows] = await conn.execute(
  `SELECT admission_number, certificates_status, student_data FROM students WHERE admission_number IN (${marks}) ORDER BY admission_number`,
  targets
);

const out = rows.map((r) => {
  let payload = {};
  try {
    payload = typeof r.student_data === 'string' ? JSON.parse(r.student_data || '{}') : (r.student_data || {});
  } catch {}
  const certKeys = Object.keys(payload).filter((k) => /cert/i.test(k));
  return {
    admission_number: r.admission_number,
    certificates_status_column: r.certificates_status,
    cert_keys_in_student_data: certKeys,
    cert_values: Object.fromEntries(certKeys.map((k) => [k, payload[k]])),
    registration_certificates_status: payload?.registrationFormData?.certificates_status,
    registration_certification_status: payload?.registrationFormData?.certification_status,
    registration_certificate_checklist: payload?.registrationFormData?.certificate_checklist || null,
  };
});

console.log(JSON.stringify(out, null, 2));
await conn.end();
