/**
 * Repair admissions/joinings where managed_branch_id disagrees with branch text
 * (e.g. lead course_interested says DCSE but admissions.branch still DMEC).
 *
 * Usage:
 *   node src/scripts/repairAdmissionBranchFromManagedId.js 20260048
 *   node src/scripts/repairAdmissionBranchFromManagedId.js --dry-run
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();
const DRY = process.argv.includes('--dry-run');
const nums = process.argv.filter((a) => a !== '--dry-run' && !a.startsWith('--'));

async function main() {
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
  });

  let where = '';
  const params = [];
  if (nums.length > 0) {
    where = `WHERE admission_number IN (${nums.map(() => '?').join(',')})`;
    params.push(...nums);
  }

  const [rows] = await primary.execute(
    `SELECT id, joining_id, admission_number, managed_course_id, managed_branch_id, course, branch
     FROM admissions ${where}`,
    params
  );

  for (const row of rows) {
    const bid = String(row.managed_branch_id ?? '').trim();
    const cid = String(row.managed_course_id ?? '').trim();
    if (!bid || !cid) {
      console.log('SKIP (no managed ids):', row.admission_number);
      continue;
    }
    const [br] = await secondary.execute(
      'SELECT name, code FROM course_branches WHERE id = ? AND course_id = ? LIMIT 1',
      [bid, cid]
    );
    if (!br.length) {
      console.log('SKIP (branch not in secondary):', row.admission_number, bid);
      continue;
    }
    const label = String(br[0].code || br[0].name || '').trim();
    if (!label || label === row.branch) {
      console.log('OK:', row.admission_number, row.branch);
      continue;
    }
    console.log('REPAIR:', row.admission_number, row.branch, '->', label, `(managed_branch_id=${bid})`);
    if (!DRY) {
      await primary.execute(
        `UPDATE admissions SET branch = ?, updated_at = NOW() WHERE id = ?`,
        [label, row.id]
      );
      if (row.joining_id) {
        await primary.execute(
          `UPDATE joinings SET branch = ?, managed_branch_id = ?, managed_course_id = ?, updated_at = NOW() WHERE id = ?`,
          [label, bid, cid, row.joining_id]
        );
      }
    }
  }

  await primary.end();
  await secondary.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
