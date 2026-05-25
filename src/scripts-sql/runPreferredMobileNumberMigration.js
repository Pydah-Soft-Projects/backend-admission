/**
 * Apply preferred_mobile_number columns on primary + secondary DBs.
 * Safe to re-run: ignores ER_DUP_FIELDNAME if columns already exist.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';
import { getPool as getSecondaryPool, closeDB as closeSecondaryDB } from '../config-sql/database-secondary.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applyMigrationFile(pool, relativePath, label) {
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

  console.log(`\n=== ${label} ===`);
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
  const primary = getPool();
  await applyMigrationFile(
    primary,
    '../../sql/migrations/20260523_add_preferred_mobile_number.sql',
    'Primary DB'
  );
  await closeDB();

  try {
    const secondary = getSecondaryPool();
    await applyMigrationFile(
      secondary,
      '../../sql/migrations/20260523_secondary_add_preferred_mobile_number.sql',
      'Secondary DB'
    );
    await closeSecondaryDB();
  } catch (err) {
    console.warn('Secondary DB migration skipped or failed:', err?.message || err);
  }

  console.log('\nPreferred mobile number migration finished.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
