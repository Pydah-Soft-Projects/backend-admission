/**
 * Ensures joinings + admissions have qualification_merit (merit Yes/No / NULL).
 * Fixes: ER_BAD_FIELD_ERROR Unknown column 'qualification_merit' when saving joining draft.
 *
 * Usage (from backend-admission):
 *   node src/scripts/ensureQualificationMeritColumns.js
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

async function columnExists(pool, tableName, columnName) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function ensureColumn(pool, tableName) {
  const exists = await columnExists(pool, tableName, 'qualification_merit');
  if (exists) {
    console.log(`[skip] ${tableName}.qualification_merit already exists`);
    return;
  }
  console.log(`[run] ALTER TABLE ${tableName} ADD qualification_merit …`);
  await pool.execute(
    `ALTER TABLE \`${tableName}\`
     ADD COLUMN qualification_merit TINYINT(1) NULL DEFAULT NULL
     AFTER qualification_ug`
  );
  console.log(`[ok] ${tableName}.qualification_merit added`);
}

async function main() {
  const pool = getPool();
  try {
    await ensureColumn(pool, 'joinings');
    await ensureColumn(pool, 'admissions');
    console.log('Done.');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
