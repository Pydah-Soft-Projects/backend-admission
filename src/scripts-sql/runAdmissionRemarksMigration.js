/**
 * One-off: apply sql/migrations/20260728_add_admission_remarks.sql
 * Safe to re-run: ignores ER_DUP_FIELDNAME if columns already exist.
 *
 * Usage (from backend-admission):
 *   node src/scripts-sql/runAdmissionRemarksMigration.js
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationPath = path.join(
  __dirname,
  '../../sql/migrations/20260728_add_admission_remarks.sql'
);

async function main() {
  const pool = getPool();
  const raw = fs.readFileSync(migrationPath, 'utf8');
  const cleaned = raw
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    try {
      await pool.query(statement);
      console.log('Applied (primary DB):', statement.split('\n')[0].slice(0, 80) + '…');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('Skipped (column exists):', statement.split('\n')[0].slice(0, 80));
        continue;
      }
      throw e;
    }
  }
  console.log('Primary database admission remarks migration finished.');
  await closeDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});