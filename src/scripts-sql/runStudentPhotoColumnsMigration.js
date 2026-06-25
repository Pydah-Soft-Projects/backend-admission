/**
 * One-off: apply sql/migrations/20260623_add_student_photo_column.sql
 * Safe to re-run: ignores ER_DUP_FIELDNAME if columns already exist.
 *
 * Usage (from backend-admission):
 *   node src/scripts-sql/runStudentPhotoColumnsMigration.js
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
  '../../sql/migrations/20260623_add_student_photo_column.sql'
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
      console.log('Applied:', statement.split('\n')[0].slice(0, 80) + '…');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('Skipped (column exists):', statement.split('\n')[0].slice(0, 80));
        continue;
      }
      throw e;
    }
  }
  console.log('Student photo column migration finished.');
  await closeDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
