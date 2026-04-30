import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const admissionNo = '20260010';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const [[adm]] = await conn.execute(
  'SELECT id, joining_id, payment_total_fee, payment_total_paid, payment_balance, payment_status FROM admissions WHERE admission_number = ? LIMIT 1',
  [admissionNo]
);
if (!adm) {
  throw new Error(`Admission not found for ${admissionNo}`);
}

const [tx] = await conn.execute(
  "SELECT amount, status FROM payment_transactions WHERE (admission_id = ? OR joining_id = ?) AND mode = 'cash'",
  [adm.id, adm.joining_id]
);

const paid = tx
  .filter((r) => String(r.status || '').toLowerCase() === 'success')
  .reduce((sum, r) => sum + Number(r.amount || 0), 0);

const totalFee = Number(adm.payment_total_fee) || 0;
const balance = totalFee > 0 ? Math.max(totalFee - paid, 0) : 0;
const status = paid <= 0 ? 'not_started' : (balance <= 0.5 ? 'paid' : 'partial');

await conn.execute(
  'UPDATE admissions SET payment_total_paid = ?, payment_balance = ?, payment_status = ?, payment_last_payment_at = NOW(), updated_at = NOW() WHERE id = ?',
  [paid, balance, status, adm.id]
);

const [txFix] = await conn.execute(
  'UPDATE payment_transactions SET admission_id = ? WHERE admission_id IS NULL AND joining_id = ?',
  [adm.id, adm.joining_id]
);

const [[after]] = await conn.execute(
  'SELECT id, admission_number, payment_total_fee, payment_total_paid, payment_balance, payment_status FROM admissions WHERE id = ?',
  [adm.id]
);

console.log(JSON.stringify({
  admissionNo,
  updatedAdmission: after,
  linkedTransactions: txFix.affectedRows || 0,
}, null, 2));

await conn.end();
