/**
 * Backfill empty qualification_ac (NULL) to Non-AC (0) on joinings + admissions.
 * Also sets column DEFAULT to 0 for new rows.
 *
 * Usage (from backend-admission):
 *   node src/scripts/backfillEmptyQualificationAcToNonAc.js            # dry-run
 *   node src/scripts/backfillEmptyQualificationAcToNonAc.js --apply    # apply UPDATE
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

function parseArgs(argv) {
  const args = { apply: false, sample: 15 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--sample=')) args.sample = Number(a.split('=')[1] || '') || 15;
  }
  return args;
}

const TABLES = [
  { name: 'joinings', labelCol: 'student_name', idCol: 'id' },
  { name: 'admissions', labelCol: 'student_name', idCol: 'id' },
];

async function countNullAc(pool, tableName) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM \`${tableName}\` WHERE qualification_ac IS NULL`
  );
  return Number(rows?.[0]?.cnt || 0);
}

async function sampleNullAc(pool, tableName, labelCol, idCol, limit) {
  const n = Math.max(0, Math.min(limit, 50));
  if (n === 0) return [];
  const [rows] = await pool.execute(
    `SELECT ${idCol} AS id, ${labelCol} AS label, qualification_ac, updated_at
     FROM \`${tableName}\`
     WHERE qualification_ac IS NULL
     ORDER BY updated_at DESC
     LIMIT ${n}`
  );
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const pool = getPool();

  const summary = { mode: args.apply ? 'apply' : 'dry-run', tables: {} };

  for (const t of TABLES) {
    const nullCount = await countNullAc(pool, t.name);
    summary.tables[t.name] = { nullAc: nullCount };
    if (nullCount > 0 && args.sample > 0) {
      summary.tables[t.name].sample = await sampleNullAc(
        pool,
        t.name,
        t.labelCol,
        t.idCol,
        args.sample
      );
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  const totalNull = Object.values(summary.tables).reduce(
    (sum, row) => sum + (row.nullAc || 0),
    0
  );
  if (totalNull === 0) {
    console.log('Nothing to update — all rows already have AC / Non-AC set.');
    await closeDB();
    return;
  }

  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply to set qualification_ac = 0 (Non-AC).');
    await closeDB();
    return;
  }

  const applied = {};
  for (const t of TABLES) {
    const [res] = await pool.execute(
      `UPDATE \`${t.name}\`
       SET qualification_ac = 0, updated_at = NOW()
       WHERE qualification_ac IS NULL`
    );
    applied[t.name] = res?.affectedRows ?? 0;

    // New rows default to Non-AC
    await pool.execute(
      `ALTER TABLE \`${t.name}\`
       MODIFY COLUMN qualification_ac TINYINT(1) NULL DEFAULT 0`
    );
  }

  console.log(JSON.stringify({ applied }, null, 2));

  for (const t of TABLES) {
    const remaining = await countNullAc(pool, t.name);
    console.log(JSON.stringify({ table: t.name, remainingNullAc: remaining }, null, 2));
  }

  await closeDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
