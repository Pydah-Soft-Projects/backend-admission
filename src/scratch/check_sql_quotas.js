import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT DISTINCT quota FROM admissions'
  );
  console.log("Distinct Quotas in admissions table:", rows);

  const [rowsSecondary] = await pool.execute(
    'SELECT student_status, count(*) as count FROM admissions group by student_status'
  );
  console.log("Student status counts in admissions table:", rowsSecondary);

  process.exit(0);
}

main().catch(console.error);
