/**
 * Clear "Not Provided" (and similar) placeholders from structured address columns.
 *
 * Usage:
 *   node src/scripts-sql/normalizePlaceholderAddresses.js --dry-run
 *   node src/scripts-sql/normalizePlaceholderAddresses.js --apply
 */
import { getPool } from '../config-sql/database.js';

const PLACEHOLDERS = [
  'Not Provided',
  'Not Specified',
  'N/A',
  'NA',
  'Nil',
  'None',
  '-',
  '—',
];

const ADDRESS_COLUMNS = [
  'address_door_street',
  'address_landmark',
  'address_village_city',
  'address_mandal',
  'address_district',
  'address_pin_code',
  'address_state',
];

const LEAD_ADDRESS_COLUMNS = ['address', 'village', 'mandal', 'district', 'state'];

async function clearPlaceholders(pool, table, columns, apply) {
  let affected = 0;
  for (const column of columns) {
    for (const placeholder of PLACEHOLDERS) {
      const [result] = await pool.execute(
        `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`,
        [placeholder]
      );
      const count = Number(result[0]?.c || 0);
      if (!count) continue;
      console.log(`${table}.${column}: ${count} row(s) with "${placeholder}"`);
      if (apply) {
        const [update] = await pool.execute(
          `UPDATE ${table} SET ${column} = '' WHERE ${column} = ?`,
          [placeholder]
        );
        affected += update.affectedRows || 0;
      }
    }
  }
  return affected;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run') || !apply;
  if (dryRun && !process.argv.includes('--dry-run')) {
    console.log('Defaulting to --dry-run. Pass --apply to write changes.');
  }

  const pool = getPool();
  console.log(apply ? 'Applying placeholder cleanup...' : 'Dry run — no writes.');

  let total = 0;
  total += await clearPlaceholders(pool, 'admissions', ADDRESS_COLUMNS, apply);
  total += await clearPlaceholders(pool, 'joinings', ADDRESS_COLUMNS, apply);
  total += await clearPlaceholders(pool, 'leads', LEAD_ADDRESS_COLUMNS, apply);

  console.log(apply ? `Updated ${total} cell(s).` : 'Dry run complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
