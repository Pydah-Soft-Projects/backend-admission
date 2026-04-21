/**
 * Backfill target_date for assigned leads that still have target_date NULL.
 *
 * Default: set target_date to April 25 of a chosen calendar year (default = current year).
 * Override the full date with --target-date=YYYY-MM-DD.
 *
 * Why: Automated reclamation only selects (target_date <= CURRENT_DATE) with non-null
 *      dates matching; NULL target_date is excluded from the reclaim query.
 *
 * Usage (dry-run — counts + sample only, no writes):
 *   node src/scripts-sql/backfillTargetDateForAssignedLeads.js
 *
 * Apply (updates all matching rows, no LIMIT):
 *   node src/scripts-sql/backfillTargetDateForAssignedLeads.js --apply
 *
 * Options:
 *   --target-date=2026-04-25   Exact DATE to set (overrides --year)
 *   --year=2026              Use April 25 of this year (ignored if --target-date set)
 *   --lead-status=Assigned   Optional: only leads with this lead_status
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

function parseArgs() {
  const out = {
    apply: false,
    targetDate: null,
    year: null,
    leadStatus: null,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') out.apply = true;
    if (arg.startsWith('--target-date=')) {
      const v = arg.slice('--target-date='.length).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) out.targetDate = v;
    }
    if (arg.startsWith('--year=')) {
      const n = parseInt(arg.slice('--year='.length), 10);
      if (Number.isFinite(n) && n >= 2000 && n <= 2100) out.year = n;
    }
    if (arg.startsWith('--lead-status=')) {
      out.leadStatus = arg.slice('--lead-status='.length).trim() || null;
    }
  }
  return out;
}

function resolveTargetYmd(args) {
  if (args.targetDate) return args.targetDate;
  const y = args.year ?? new Date().getFullYear();
  return `${y}-04-25`;
}

async function main() {
  const args = parseArgs();
  const targetYmd = resolveTargetYmd(args);
  const pool = getPool();

  const statusClause = args.leadStatus ? 'AND lead_status = ?' : '';
  const countParams = args.leadStatus ? [args.leadStatus] : [];

  const [[countRow]] = await pool.execute(
    `
    SELECT COUNT(*) AS cnt
    FROM leads
    WHERE target_date IS NULL
      AND (assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL)
      ${statusClause}
    `,
    countParams
  );

  const total = Number(countRow?.cnt || 0);

  console.log('\n=== Backfill target_date (assigned leads with NULL target) ===');
  console.log(`Mode: ${args.apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`);
  console.log(`Set target_date to: ${targetYmd}`);
  if (args.leadStatus) console.log(`Filter lead_status = ${args.leadStatus}`);
  console.log(`Matching rows: ${total}\n`);

  if (total === 0) {
    console.log('No matching rows.');
    await closeDB();
    return;
  }

  const sampleParams = args.leadStatus ? [args.leadStatus] : [];
  const [sample] = await pool.execute(
    `
    SELECT id, name, phone, lead_status, assigned_at, pro_assigned_at, target_date
    FROM leads
    WHERE target_date IS NULL
      AND (assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL)
      ${statusClause}
    ORDER BY COALESCE(assigned_at, pro_assigned_at, updated_at) ASC
    LIMIT 40
    `,
    sampleParams
  );

  console.table(
    (sample || []).map((r) => ({
      id: r.id,
      name: r.name,
      lead_status: r.lead_status,
      new_target: targetYmd,
    }))
  );
  if (total > 40) {
    console.log(`(Sample: first 40 of ${total} rows.)\n`);
  }

  if (!args.apply) {
    console.log('Re-run with --apply to UPDATE all matching rows (no row limit).\n');
    await closeDB();
    return;
  }

  const updateParams = args.leadStatus ? [targetYmd, args.leadStatus] : [targetYmd];

  const [result] = await pool.execute(
    `
    UPDATE leads
    SET
      target_date = ?,
      updated_at = NOW()
    WHERE target_date IS NULL
      AND (assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL)
      ${statusClause}
    `,
    updateParams
  );

  const affected = Number(result?.affectedRows ?? 0);
  console.log(`UPDATE complete. affectedRows: ${affected}\n`);

  await closeDB();
}

main().catch(async (err) => {
  console.error('\nScript failed:', err?.message || err);
  await closeDB().catch(() => {});
  process.exit(1);
});
