/**
 * Apply sql/migrations/20260724_admission_minimum_fee_configs.sql
 * Safe to re-run (CREATE TABLE IF NOT EXISTS).
 *
 * Usage (from backend-admission):
 *   npm run migrate:minimum-fee-configs
 *   node src/scripts-sql/runMinimumFeeConfigsMigration.js
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
  '../../sql/migrations/20260724_admission_minimum_fee_configs.sql'
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
      console.error('Failed:', e.message || e);
      throw e;
    }
  }

  console.log('admission_minimum_fee_configs migration complete.');
  await closeDB();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDB();
  } catch {
    // ignore
  }
  process.exit(1);
});
