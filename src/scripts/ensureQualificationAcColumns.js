/**
 * Ensures joinings + admissions have qualification_ac (AC / Non-AC).
 * Fixes: ER_BAD_FIELD_ERROR Unknown column 'qualification_ac' when saving joining draft.
 *
 * Usage (from backend-admission):
 *   node src/scripts/ensureQualificationAcColumns.js
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
  const exists = await columnExists(pool, tableName, 'qualification_ac');
  if (exists) {
    console.log(`[skip] ${tableName}.qualification_ac already exists`);
    return;
  }
  console.log(`[run] ALTER TABLE ${tableName} ADD qualification_ac …`);
  await pool.execute(
    `ALTER TABLE \`${tableName}\`
     ADD COLUMN qualification_ac TINYINT(1) NULL DEFAULT NULL
     AFTER qualification_merit`
  );
  console.log(`[ok] ${tableName}.qualification_ac added`);
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
