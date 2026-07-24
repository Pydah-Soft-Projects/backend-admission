/**
 * Backfill admissions.branch / joinings.branch: store catalog name (CSE), not code (BCSE).
 * Usage: node src/scripts-sql/normalizeAdmissionBranchNames.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { getPool, closeDB } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { pickSecondaryBranchDisplayLabel } from '../data/admissionsCourseBranchMap2026.js';

async function main() {
  const pool = getPool();
  const secondary = getSecondaryPool();

  const [branches] = await secondary.execute(
    'SELECT id, name, code FROM course_branches WHERE name IS NOT NULL AND TRIM(name) != ""'
  );
  const labelById = new Map();
  for (const row of branches) {
    const label = pickSecondaryBranchDisplayLabel(row);
    if (label) labelById.set(String(row.id), label);
  }
  console.log('catalog branches', labelById.size);

  let admUpdated = 0;
  let joinUpdated = 0;

  const [admRows] = await pool.execute(
    `SELECT id, managed_branch_id, branch
     FROM admissions
     WHERE managed_branch_id IS NOT NULL AND TRIM(CAST(managed_branch_id AS CHAR)) != ''`
  );
  for (const row of admRows) {
    const id = String(row.managed_branch_id).trim();
    const label = labelById.get(id);
    if (!label) continue;
    const current = String(row.branch || '').trim();
    if (current.toUpperCase() === label.toUpperCase()) continue;
    await pool.execute('UPDATE admissions SET branch = ?, updated_at = NOW() WHERE id = ?', [
      label,
      row.id,
    ]);
    admUpdated += 1;
    console.log(`admission ${row.id}: "${current}" → "${label}"`);
  }

  const [joinRows] = await pool.execute(
    `SELECT id, managed_branch_id, branch
     FROM joinings
     WHERE managed_branch_id IS NOT NULL AND TRIM(CAST(managed_branch_id AS CHAR)) != ''`
  );
  for (const row of joinRows) {
    const id = String(row.managed_branch_id).trim();
    const label = labelById.get(id);
    if (!label) continue;
    const current = String(row.branch || '').trim();
    if (current.toUpperCase() === label.toUpperCase()) continue;
    await pool.execute('UPDATE joinings SET branch = ?, updated_at = NOW() WHERE id = ?', [
      label,
      row.id,
    ]);
    joinUpdated += 1;
    console.log(`joining ${row.id}: "${current}" → "${label}"`);
  }

  console.log(JSON.stringify({ admUpdated, joinUpdated }, null, 2));
  await closeDB();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDB();
  } catch {}
  process.exit(1);
});
