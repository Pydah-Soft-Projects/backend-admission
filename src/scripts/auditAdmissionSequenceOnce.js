/**
 * Audit 2026 admission numbers vs admission_sequences.
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

async function main() {
  const pool = getPool();

  const [seq] = await pool.execute(
    'SELECT * FROM admission_sequences WHERE year = 2026'
  );

  const [nums] = await pool.execute(
    `SELECT admission_number
     FROM admissions
     WHERE admission_number LIKE '202600%'
     ORDER BY CAST(SUBSTRING(admission_number, 5) AS UNSIGNED)`
  );

  const used = new Set(
    nums.map((r) => Number(String(r.admission_number).slice(4)))
  );

  const gaps = [];
  const max = Math.max(...used, 0);
  for (let i = 1; i <= max; i++) {
    if (!used.has(i)) gaps.push(`2026${String(i).padStart(4, '0')}`);
  }

  const [above99] = await pool.execute(
    `SELECT admission_number, student_name, enquiry_number
     FROM admissions
     WHERE CAST(SUBSTRING(admission_number, 5) AS UNSIGNED) > 99
     ORDER BY CAST(SUBSTRING(admission_number, 5) AS UNSIGNED)
     LIMIT 20`
  );

  console.log(
    JSON.stringify(
      {
        sequence: seq,
        count: nums.length,
        maxUsed: max,
        gaps,
        admissionsAbove99: above99,
      },
      null,
      2
    )
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
