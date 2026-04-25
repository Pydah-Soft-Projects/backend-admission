/**
 * Lists (and optionally fixes) leads where call/visit shows interest but
 * `lead_status` is not `Interested` / `CET Applied` — the usual cause of
 * overview funnel (lead_status) vs user-performance (call/visit buckets) drift.
 *
 * **Sync rules** (align `lead_status` to operational state):
 *   - `call_status` = CET Applied → `lead_status` = `CET Applied`
 *   - `call_status` = Interested, or `visit_status` = Interested (PRO) → `lead_status` = `Interested`
 * (CET on call takes precedence if both interest signals exist.)
 *
 * The API usually applies similar logic via `resolveLeadStatus` in `updateLead` /
 * `logCallCommunication`, but not every code path (or backfills) do — this script
 * can repair the DB. **We do not** overwrite `lead_status` for rows that
 * should stay out of the interest funnel, including `Not Interested`, `Call Back`,
 * `Confirmed`, and `Admitted` (use `--all` to list skipped rows; they are
 * not auto-updated by `--apply`).
 *
 * Run from `backend-admission`:
 *   `node src/scripts/diagnoseLeadStatusVsCallVisitStatus.js`          (preview)
 *   `node src/scripts/diagnoseLeadStatusVsCallVisitStatus.js --apply`  (UPDATE)
 *   `npm run db:diagnose-status-apply`    (UPDATE — use this on Windows; `npm run ... -- --apply` often does not pass flags through)
 *   or `set DIAGNOSE_LEAD_STATUS_APPLY=1` then `npm run db:diagnose-status-mismatch` (UPDATE)
 *
 * Options:
 *   --academic-year=2026   filter leads.academic_year
 *   --cycle=1              filter leads.cycle_number (if column exists)
 *   --limit=200            max list rows (default 200; apply updates all match rows, no cap)
 *   --json                 print JSON only (no --apply with json)
 *   --counsellor           only counsellor + call_status Interested/CET Applied
 *   --pro                  only PRO + visit_status Interested
 *   --all                  list *all* mismatches including non-fixable `lead_status` (still not updated)
 *   --apply                run UPDATE; default is dry-run (preview / counts only)
 *   -a                     same as --apply
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

/**
 * `npm run foo -- --apply` is unreliable on some Windows + npm versions (arg never reaches node).
 * Prefer `npm run db:diagnose-status-apply` or set env DIAGNOSE_LEAD_STATUS_APPLY=1, or `node ... --apply`.
 */
function isApplyRequest() {
  if (process.argv.slice(2).some((a) => a === '--apply' || a === '-a')) {
    return true;
  }
  const v = process.env.DIAGNOSE_LEAD_STATUS_APPLY;
  if (v == null) return false;
  const t = String(v).trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}

const parseArg = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (process.argv.includes(`--${name}`)) return true;
  return null;
};

const toNum = (v) => {
  if (v == null || v === true || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * `LIMIT ?` in prepared statements often raises ER_WRONG_ARGUMENTS (1210) on
 * some MySQL/MariaDB builds; inlining a bounded integer is safe and avoids it.
 */
function toSafeLimit(n) {
  const k = Math.floor(Number(n));
  if (!Number.isFinite(k) || k < 1) return 200;
  return Math.min(50_000, k);
}

function trunc(s, max) {
  if (s == null || s === '') return '—';
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Few columns, fixed widths — easier to read than a wide `console.table`.
 */
function printLeadTable(rows) {
  if (!rows.length) {
    console.log('(no rows)\n');
    return;
  }
  const w = { enq: 11, name: 20, was: 11, nxt: 12, call: 13, visit: 10, when: 10 };
  const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
  const line = (cols) =>
    cols
      .map(
        (c, i) =>
          pad(
            c,
            [w.enq, w.name, w.was, w.nxt, w.call, w.visit, w.when][i]
          )
      )
      .join('  ');

  console.log(
    line(['Enquiry #', 'Name', 'lead (was)', '→ next', 'call', 'visit', 'Updated']) +
      '\n' +
      '─'.repeat(98)
  );
  rows.forEach((r) => {
    const when = r.updated_at
      ? String(r.updated_at).replace('T', ' ').slice(0, 10)
      : '—';
    console.log(
      line([
        trunc(r.enquiry_number, w.enq),
        trunc(r.name, w.name),
        trunc(r.lead_status, w.was),
        trunc(r.next_lead_status, w.nxt),
        trunc(r.call_status, w.call),
        trunc(r.visit_status, w.visit),
        when,
      ])
    );
  });
  console.log('');
}

/** `lead_status` we never replace with `Interested` / `CET Applied` via --apply. */
const LEAD_STATUS_NEVER_AUTO_SYNC = ['Not Interested', 'Call Back', 'Confirmed', 'Admitted'];
const sqlLeadStatusNotAutoSync = LEAD_STATUS_NEVER_AUTO_SYNC.map((s) =>
  `'${String(s).replace(/'/g, "''")}'`
).join(', ');

/** For UPDATE — fixable WHERE excludes protected `lead_status` (never overwrite Call Back with Interested). */
const sqlNextLeadStatus = `CASE
    WHEN LOWER(TRIM(COALESCE(l.call_status, ''))) IN ('cet applied', 'cet_applied') THEN 'CET Applied'
    WHEN LOWER(TRIM(COALESCE(l.call_status, ''))) = 'interested' THEN 'Interested'
    WHEN LOWER(TRIM(COALESCE(l.visit_status, ''))) = 'interested' THEN 'Interested'
    ELSE l.lead_status
  END`;

/** For SELECT (incl. --all): protected `lead_status` → preview "→" unchanged. */
const sqlNextLeadStatusPreview = `CASE
  WHEN l.lead_status IN (${sqlLeadStatusNotAutoSync}) THEN l.lead_status
  WHEN LOWER(TRIM(COALESCE(l.call_status, ''))) IN ('cet applied', 'cet_applied') THEN 'CET Applied'
  WHEN LOWER(TRIM(COALESCE(l.call_status, ''))) = 'interested' THEN 'Interested'
  WHEN LOWER(TRIM(COALESCE(l.visit_status, ''))) = 'interested' THEN 'Interested'
  ELSE l.lead_status
END`;

async function main() {
  const jsonOnly = process.argv.includes('--json');
  const wantApply = isApplyRequest();
  const listAllMismatches = process.argv.includes('--all');
  const limitN = toSafeLimit(toNum(parseArg('limit')) ?? 200);
  const academicYear = toNum(parseArg('academic-year'));
  const cycleNumber = toNum(parseArg('cycle'));
  const counsellorOnly = process.argv.includes('--counsellor');
  const proOnly = process.argv.includes('--pro');

  if (jsonOnly && wantApply) {
    console.error('Refusing: do not combine --json with --apply');
    process.exit(1);
  }

  const wantCounsellor = !proOnly;
  const wantPro = !counsellorOnly;

  const branch = [];
  if (wantCounsellor) {
    branch.push(
      `(l.assigned_to IS NOT NULL
        AND l.call_status IS NOT NULL AND TRIM(l.call_status) <> ''
        AND LOWER(TRIM(l.call_status)) IN ('interested', 'cet applied'))`
    );
  }
  if (wantPro) {
    branch.push(
      `(l.assigned_to_pro IS NOT NULL
        AND l.visit_status IS NOT NULL AND TRIM(l.visit_status) <> ''
        AND LOWER(TRIM(l.visit_status)) = 'interested')`
    );
  }
  if (branch.length === 0) {
    console.error('Use at least one of --counsellor / --pro (default: both).');
    process.exit(1);
  }

  const wherePartsMism = [];
  const params = [];
  wherePartsMism.push(`(${branch.join(' OR ')})`);
  wherePartsMism.push(
    `(l.lead_status IS NULL OR l.lead_status NOT IN ('Interested', 'CET Applied'))`
  );
  if (academicYear != null) {
    wherePartsMism.push('l.academic_year = ?');
    params.push(academicYear);
  }
  if (cycleNumber != null) {
    wherePartsMism.push('l.cycle_number = ?');
    params.push(cycleNumber);
  }

  const whereMismSql = `WHERE ${wherePartsMism.join(' AND ')}`;
  const whereFixParts = [
    ...wherePartsMism,
    `(l.lead_status IS NULL OR l.lead_status NOT IN (${sqlLeadStatusNotAutoSync}))`,
  ];
  const whereFixSql = `WHERE ${whereFixParts.join(' AND ')}`;
  const pool = getPool();

  const [countMism] = await pool.execute(
    `SELECT COUNT(*) AS c FROM leads l ${whereMismSql}`,
    params
  );
  const nMism = Number(
    typeof countMism[0]?.c === 'bigint' ? countMism[0].c : countMism[0]?.c || 0
  );

  const [countFix] = await pool.execute(
    `SELECT COUNT(*) AS c FROM leads l ${whereFixSql}`,
    params
  );
  const nFix = Number(
    typeof countFix[0]?.c === 'bigint' ? countFix[0].c : countFix[0]?.c || 0
  );

  if (!jsonOnly) {
    console.log('call/visit shows interest but lead_status is not Interested / CET Applied\n');
    console.log(`  All such mismatches:   ${nMism}`);
    console.log(`  Fixable (excl. Not Interested / Call Back / Confirmed / Admitted): ${nFix}`);
    if (nMism > nFix) {
      console.log(
        `  (Skipped ${nMism - nFix} rows with a protected lead_status — not auto-updated. Use --all to list them.)`
      );
    }
    if (academicYear != null) console.log(`  Filter academic_year: ${academicYear}`);
    if (cycleNumber != null) console.log(`  Filter cycle_number: ${cycleNumber}`);
    if (counsellorOnly) console.log('  Branch: counsellor (call_status) only');
    if (proOnly) console.log('  Branch: PRO (visit_status) only');
    if (listAllMismatches) console.log('  Mode: --all (list includes terminal lead_status rows)');
    if (wantApply) console.log('  Mode: --apply (UPDATE fixable rows)\n');
    else {
      console.log(
        '  (Dry run — to UPDATE use: `npm run db:diagnose-status-apply` or `node src/scripts/diagnoseLeadStatusVsCallVisitStatus.js --apply`)\n'
      );
    }
  }

  if (wantApply) {
    const [upd] = await pool.execute(
      `UPDATE leads l
       SET
         l.lead_status = ${sqlNextLeadStatus},
         l.updated_at = NOW()
       ${whereFixSql}`,
      params
    );
    const affected = upd?.affectedRows ?? 0;
    console.log(`UPDATE completed. Rows affected: ${affected}.\n`);
    await closeDB();
    return;
  }

  const forList = listAllMismatches ? whereMismSql : whereFixSql;
  const [rows] = await pool.execute(
    `SELECT
       l.id,
       l.enquiry_number,
       l.name,
       l.lead_status,
       l.call_status,
       l.visit_status,
       (${sqlNextLeadStatusPreview}) AS next_lead_status,
       CASE
         WHEN l.assigned_to IS NOT NULL
           AND l.call_status IS NOT NULL
           AND LOWER(TRIM(l.call_status)) IN ('interested', 'cet applied')
           AND l.assigned_to_pro IS NOT NULL
           AND l.visit_status IS NOT NULL
           AND LOWER(TRIM(l.visit_status)) = 'interested'
           THEN 'SC+PRO'
         WHEN l.assigned_to IS NOT NULL
           AND l.call_status IS NOT NULL
           AND LOWER(TRIM(l.call_status)) IN ('interested', 'cet applied')
           THEN 'SC'
         WHEN l.assigned_to_pro IS NOT NULL
           AND l.visit_status IS NOT NULL
           AND LOWER(TRIM(l.visit_status)) = 'interested'
           THEN 'PRO'
         ELSE '—'
       END AS via,
       l.updated_at
     FROM leads l
     ${forList}
     ORDER BY l.updated_at DESC
     LIMIT ${limitN}`,
    params
  );

  if (jsonOnly) {
    const totalLabel = listAllMismatches ? nMism : nFix;
    const slim = rows.map((r) => ({
      id: r.id,
      enquiry_number: r.enquiry_number,
      name: r.name,
      lead_status: r.lead_status,
      next_lead_status: r.next_lead_status,
      call_status: r.call_status,
      visit_status: r.visit_status,
      via: r.via,
      updated_at: r.updated_at,
    }));
    console.log(
      JSON.stringify(
        { total: totalLabel, allMismatches: nMism, fixable: nFix, limit: limitN, rows: slim },
        null,
        2
      )
    );
  } else {
    console.log(
      `Sample up to ${limitN} rows, ${listAllMismatches ? 'all mismatches' : 'fixable only'} (newest first). Columns: lead (was) → next.\n`
    );
    printLeadTable(rows);
  }

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
