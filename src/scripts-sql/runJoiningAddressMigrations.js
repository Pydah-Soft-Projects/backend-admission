/**
 * Apply joining/admission address column migrations (relative phone + address state).
 * Safe to re-run: ignores ER_DUP_FIELDNAME if columns already exist.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_FILES = [
  '../../sql/migrations/20260610_add_relative_phone.sql',
  '../../sql/migrations/20260611_add_address_state_columns.sql',
];

async function applyMigrationFile(pool, relativePath) {
  const migrationPath = path.join(__dirname, relativePath);
  const raw = fs.readFileSync(migrationPath, 'utf8');
  const cleaned = raw
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`\n=== ${path.basename(migrationPath)} ===`);
  for (const statement of statements) {
    try {
      await pool.query(statement);
      console.log('Applied:', statement.split('\n')[0].slice(0, 90));
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('Skipped (column exists):', statement.split('\n')[0].slice(0, 90));
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  const pool = getPool();
  for (const file of MIGRATION_FILES) {
    await applyMigrationFile(pool, file);
  }
  console.log('\nJoining address migrations finished.');
  await closeDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
