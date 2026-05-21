/**
 * Simulate admission course/branch update for one admission number (dry-run or apply).
 * Usage:
 *   node src/scripts/testUpdateAdmissionCourseBranch.js 20260048 50 --apply
 *   node src/scripts/testUpdateAdmissionCourseBranch.js 20260048 50
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const admissionNumber = process.argv[2];
const branchId = process.argv[3] || '50';
const APPLY = process.argv.includes('--apply');

if (!admissionNumber) {
  console.error('Usage: node src/scripts/testUpdateAdmissionCourseBranch.js <admissionNumber> [branchId] [--apply]');
  process.exit(1);
}

async function main() {
  const pool = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const sec = await mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
  });

  const [adm] = await pool.execute(
    'SELECT id, joining_id, managed_course_id, managed_branch_id, branch FROM admissions WHERE admission_number = ?',
    [admissionNumber]
  );
  if (!adm.length) {
    console.error('Admission not found');
    process.exit(1);
  }
  const row = adm[0];
  const courseId = String(row.managed_course_id || '2');
  const [br] = await sec.execute(
    'SELECT name, code FROM course_branches WHERE id = ? AND course_id = ?',
    [branchId, courseId]
  );
  const branchLabel = br[0] ? String(br[0].code || br[0].name) : 'UNKNOWN';
  console.log('Will set branchId', branchId, 'label', branchLabel);

  if (!APPLY) {
    console.log('Dry run — pass --apply to execute');
    await pool.end();
    await sec.end();
    return;
  }

  await pool.execute(
    `UPDATE admissions SET managed_branch_id = ?, branch = ?, updated_at = NOW() WHERE id = ?`,
    [branchId, branchLabel, row.id]
  );
  if (row.joining_id) {
    await pool.execute(
      `UPDATE joinings SET managed_branch_id = ?, branch = ?, updated_at = NOW() WHERE id = ?`,
      [branchId, branchLabel, row.joining_id]
    );
  }
  console.log('Done');
  await pool.end();
  await sec.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
