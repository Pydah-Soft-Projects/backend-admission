/**
 * Cleanup quota-like values accidentally stored in `leads.source`.
 *
 * Why:
 * - "source" should represent lead origin (Bulk Upload / Manual / UTM etc).
 * - Quota labels like Convenor/Management/Spot were incorrectly stored in `leads.source`,
 *   causing student list "Source" to display quota.
 *
 * Usage (from backend-admission):
 *   node src/scripts/cleanupQuotaValuesInLeadSource.js            # dry-run (prints counts + sample)
 *   node src/scripts/cleanupQuotaValuesInLeadSource.js --apply    # apply UPDATE
 *   node src/scripts/cleanupQuotaValuesInLeadSource.js --apply --limit=5000
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

function parseArgs(argv) {
  const args = { apply: false, limit: null, sample: 25 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--limit=')) args.limit = Number(a.split('=')[1] || '') || null;
    else if (a.startsWith('--sample=')) args.sample = Number(a.split('=')[1] || '') || 25;
  }
  return args;
}

const QUOTA_PATTERNS = [
  // exact-ish / common variants
  'conv',
  'convenor',
  'convener',
  'cq',
  'mq',
  'mang',
  'management',
  'spot',
  'lateral entry',
  // fuzzy matches
  '%conven%',
  '%manag%',
  '%spot%',
  '%lateral%',
];

const buildWhere = () => {
  // normalize: trim + lowercase (collation may already be CI but be explicit)
  const clauses = [];
  const params = [];
  for (const p of QUOTA_PATTERNS) {
    if (p.includes('%')) {
      clauses.push('LOWER(TRIM(COALESCE(source, ""))) LIKE ?');
      params.push(p.replace(/%/g, '%'));
    } else {
      clauses.push('LOWER(TRIM(COALESCE(source, ""))) = ?');
      params.push(p);
    }
  }
  return { where: `(${clauses.join(' OR ')})`, params };
};

async function main() {
  const args = parseArgs(process.argv);
  const pool = getPool();

  const { where, params } = buildWhere();
  const [countRows] = await pool.execute(`SELECT COUNT(*) AS cnt FROM leads WHERE ${where}`, params);
  const total = Number(countRows?.[0]?.cnt || 0);

  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', matches: total }, null, 2));

  if (total === 0) {
    await closeDB();
    return;
  }

  const sampleN = Math.max(0, Math.min(args.sample, 200));
  if (sampleN > 0) {
    const [rows] = await pool.execute(
      `SELECT id, enquiry_number, name, phone, source, quota, upload_batch_id, created_at, updated_at
       FROM leads
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT ${Number(sampleN)}`,
      params
    );
    console.log(JSON.stringify({ sample: rows }, null, 2));
  }

  if (!args.apply) {
    await closeDB();
    return;
  }

  // Optional safety valve: apply in batches (limit)
  if (args.limit && args.limit > 0) {
    const [targetIds] = await pool.execute(
      `SELECT id FROM leads WHERE ${where} ORDER BY updated_at DESC LIMIT ${Number(args.limit)}`,
      params
    );
    const ids = (targetIds || []).map((r) => r.id);
    if (ids.length === 0) {
      await closeDB();
      return;
    }
    const marks = ids.map(() => '?').join(',');
    const [res] = await pool.execute(
      `UPDATE leads SET source = NULL, updated_at = NOW() WHERE id IN (${marks})`,
      ids
    );
    console.log(JSON.stringify({ updated: res?.affectedRows ?? null, batch: ids.length, batchId: uuidv4() }, null, 2));
    await closeDB();
    return;
  }

  const [res] = await pool.execute(
    `UPDATE leads SET source = NULL, updated_at = NOW() WHERE ${where}`,
    params
  );

  console.log(JSON.stringify({ updated: res?.affectedRows ?? null }, null, 2));
  await closeDB();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closeDB();
  } catch {
    // ignore
  }
  process.exit(1);
});

