import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const primary = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const secondary = await mysql.createConnection({
  host: process.env.DB_SECONDARY_HOST,
  port: process.env.DB_SECONDARY_PORT || 3306,
  user: process.env.DB_SECONDARY_USER,
  password: process.env.DB_SECONDARY_PASSWORD,
  database: process.env.DB_SECONDARY_NAME,
  ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const targets = ['20260001','20260009','20260010'];
const marks = targets.map(() => '?').join(',');

const [aRows] = await primary.execute(
  `SELECT admission_number, lead_data FROM admissions WHERE admission_number IN (${marks}) ORDER BY admission_number`,
  targets
);
const [sRows] = await secondary.execute(
  `SELECT admission_number, student_photo, student_data FROM students WHERE admission_number IN (${marks}) ORDER BY admission_number`,
  targets
);

const primaryOut = aRows.map((r) => {
  let ld = {};
  try { ld = typeof r.lead_data === 'string' ? JSON.parse(r.lead_data || '{}') : (r.lead_data || {}); } catch {}
  const extras = ld?._joiningRegistrationExtras || {};
  const p = String(extras.student_photo || '').trim();
  return {
    admission_number: r.admission_number,
    extras_student_photo_preview: p ? p.slice(0, 80) : null,
    extras_student_photo_len: p.length || 0,
    extras_student_photo_is_data_url: /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(p),
  };
});

const secondaryOut = sRows.map((r) => {
  let sd = {};
  try { sd = typeof r.student_data === 'string' ? JSON.parse(r.student_data || '{}') : (r.student_data || {}); } catch {}
  const sp = String(r.student_photo || '').trim();
  return {
    admission_number: r.admission_number,
    student_photo_preview: sp ? sp.slice(0, 80) : null,
    student_photo_len: sp.length || 0,
    student_photo_is_data_url: /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(sp),
    student_data_student_photo_preview: String(sd?.registrationFormData?.student_photo || '').slice(0,80) || null,
  };
});

console.log(JSON.stringify({ primary: primaryOut, secondary: secondaryOut }, null, 2));
await primary.end();
await secondary.end();
