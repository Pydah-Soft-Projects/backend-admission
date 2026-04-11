/**
 * Normalize legacy counsellor values on leads.call_status (and optionally communications.call_outcome)
 * to the canonical Student Counselor set used by the app:
 *   Interested | Not Interested | Not Answered | Wrong Data | Call Back | Confirmed | CET Applied
 *
 * Designed for large tables: one UPDATE per table using a single CASE expression (one full scan each),
 * not per-row loops.
 *
 * Usage (run manually when ready — do not run in CI without review):
 *   node src/scripts-sql/normalizeLeadCallStatus.js --dry-run
 *   node src/scripts-sql/normalizeLeadCallStatus.js --apply
 *
 * Env:
 *   ALSO_FIX_COMMUNICATIONS=1  — same mapping on communications.call_outcome where type = 'call'
 *
 * Requires: MySQL 8+ (uses REGEXP_REPLACE for whitespace normalization inside values).
 */
import dotenv from 'dotenv';
import mysql2 from 'mysql2';
import mysql from 'mysql2/promise';

dotenv.config();

const esc = (v) => mysql2.escape(v);

const APPLY = process.argv.includes('--apply');
const DRY = process.argv.includes('--dry-run') || !APPLY;

const alsoComms =
  process.env.ALSO_FIX_COMMUNICATIONS === '1' || process.env.ALSO_FIX_COMMUNICATIONS === 'true';

/** Collapse internal whitespace, trim, lowercase — must match SQL normExpr below */
function normKey(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Canonical labels (exact casing stored in DB / UI) */
const CANONICAL = [
  'Interested',
  'Not Interested',
  'Not Answered',
  'Wrong Data',
  'Call Back',
  'Confirmed',
  'CET Applied',
];

/**
 * Legacy / alias → canonical.
 * Keys are human-readable; they are normalized with normKey() when building the map.
 */
const LEGACY_ALIASES = [
  // Not Answered family
  [
    'Not Answered',
    [
      'No Answer',
      'no answer',
      'NO ANSWER',
      'no_answer',
      'NO_ANSWER',
      'Not answer',
      'not answer',
      'Not Answered',
      'Unanswered',
      'unanswered',
      'No ans',
      'no ans',
      'Missed',
      'missed',
    ],
  ],
  // Not Interested
  ['Not Interested', ['not_interested', 'Not_interested', 'NOT_INTERESTED', 'not interested']],
  // Interested / answered-style positives from older logs
  ['Interested', ['interested', 'INTERESTED', 'answered', 'Answered', 'ANSWERED']],
  // Call back
  ['Call Back', ['call back', 'Call back', 'CALL BACK', 'callback', 'Callback', 'CALLBACK', 'callback_requested', 'Call back requested']],
  // Wrong / invalid number
  ['Wrong Data', ['wrong data', 'Wrong number', 'wrong number', 'WRONG NUMBER', 'Wrong Number', 'wrong_data', 'invalid number', 'Invalid number']],
  // Confirmed
  ['Confirmed', ['confirmed', 'CONFIRMED']],
  // CET
  ['CET Applied', ['cet applied', 'CET applied', 'CET APPLIED', 'cet_applied', 'CET_Applied']],
  // Busy / voicemail / switch off → closest counsellor bucket (adjust list if your org prefers different mapping)
  ['Not Answered', ['busy', 'Busy', 'BUSY', 'voicemail', 'Voicemail', 'switch off', 'Switch off', 'switch_off', 'Switch_off', 'SWITCH OFF']],
];

function buildNormalizationMap() {
  const map = new Map();

  for (const [canonical, aliases] of LEGACY_ALIASES) {
    for (const a of aliases) {
      map.set(normKey(a), canonical);
    }
  }

  // Canonical self-mapping (fixes casing / spacing for values already semantically correct)
  for (const c of CANONICAL) {
    map.set(normKey(c), c);
  }

  return map;
}

/** MySQL expression equivalent to normKey (trim + collapse whitespace + lower) — MySQL 8+ */
const normExpr = (col) =>
  `LOWER(REGEXP_REPLACE(TRIM(${col}), '[[:space:]]+', ' '))`;

/**
 * Build CASE ... END that maps normalized column to canonical; else leaves column unchanged.
 */
function buildCaseSql(columnName, map) {
  const byTarget = new Map();
  for (const [nk, canon] of map.entries()) {
    if (!byTarget.has(canon)) byTarget.set(canon, new Set());
    byTarget.get(canon).add(nk);
  }

  const branches = [];
  for (const [canon, normKeys] of byTarget) {
    const list = [...normKeys].map((k) => esc(k)).join(', ');
    branches.push(`WHEN ${normExpr(columnName)} IN (${list}) THEN ${esc(canon)}`);
  }

  return `CASE\n      ${branches.join('\n      ')}\n      ELSE ${columnName}\n    END`;
}

async function run() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;

  if (!host || !user || !database) {
    console.error('Missing DB_HOST, DB_USER, or DB_NAME in .env');
    process.exit(1);
  }

  const map = buildNormalizationMap();

  // Detect conflicting normalized keys (last writer would win in a naive merge — LEGACY_ALIASES order matters)
  const seen = new Map();
  for (const [k, v] of map.entries()) {
    if (seen.has(k) && seen.get(k) !== v) {
      console.error(`Conflict: normalized key "${k}" maps to both "${seen.get(k)}" and "${v}"`);
      process.exit(1);
    }
    seen.set(k, v);
  }

  console.log(DRY ? 'Mode: DRY-RUN (no writes)' : 'Mode: APPLY (writes enabled)');
  console.log(`Also fix communications.call_outcome: ${alsoComms ? 'yes' : 'no'}`);

  const pool = mysql.createPool({
    host,
    port: Number(process.env.DB_PORT) || 3306,
    user,
    password: process.env.DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 1,
    connectTimeout: 25000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const caseLeads = buildCaseSql('call_status', map);
  const previewLeadsSql = `
    SELECT
      call_status AS raw_value,
      ${normExpr('call_status')} AS normalized,
      (${caseLeads}) AS would_become,
      COUNT(*) AS cnt
    FROM leads
    WHERE call_status IS NOT NULL AND TRIM(call_status) <> ''
    GROUP BY call_status
    HAVING call_status <> (${caseLeads})
    ORDER BY cnt DESC
  `;

  const countLeadsSql = `
    SELECT COUNT(*) AS cnt FROM leads
    WHERE call_status IS NOT NULL AND TRIM(call_status) <> ''
      AND call_status <> (${caseLeads})
  `;

  try {
    const [distinctBefore] = await pool.query(`
      SELECT call_status AS v, COUNT(*) AS cnt
      FROM leads
      WHERE call_status IS NOT NULL AND TRIM(call_status) <> ''
      GROUP BY call_status
      ORDER BY cnt DESC
      LIMIT 200
    `);
    console.log('\nTop distinct call_status values (up to 200 groups):');
    console.table(distinctBefore);

    const [previewRows] = await pool.query(previewLeadsSql);
    console.log('\nPlanned lead call_status changes (grouped):');
    console.table(previewRows);

    const [countRows] = await pool.query(countLeadsSql);
    const leadChangeCount = Number(countRows[0]?.cnt ?? 0);
    console.log(`\nLeads rows that would change: ${leadChangeCount}`);

    // Unmapped sample: values whose normalized form is not in map (should not happen if map complete; catch typos in DB)
    const allKeys = [...map.keys()].map((k) => esc(k)).join(', ');
    const [unmapped] = await pool.query(`
      SELECT call_status AS v, COUNT(*) AS cnt
      FROM leads
      WHERE call_status IS NOT NULL AND TRIM(call_status) <> ''
      GROUP BY call_status
      HAVING ${normExpr('call_status')} NOT IN (${allKeys})
      ORDER BY cnt DESC
      LIMIT 50
    `);
    if (unmapped.length > 0) {
      console.log('\nDistinct call_status values NOT covered by mapping (review and extend LEGACY_ALIASES):');
      console.table(unmapped);
    }

    if (alsoComms) {
      const caseComms = buildCaseSql('call_outcome', map);
      const [commPreview] = await pool.query(`
        SELECT call_outcome AS raw_value,
               ${normExpr('call_outcome')} AS normalized,
               (${caseComms}) AS would_become,
               COUNT(*) AS cnt
        FROM communications
        WHERE type = 'call' AND call_outcome IS NOT NULL AND TRIM(call_outcome) <> ''
        GROUP BY call_outcome
        HAVING call_outcome <> (${caseComms})
        ORDER BY cnt DESC
        LIMIT 200
      `);
      console.log('\nPlanned communications.call_outcome changes (grouped, sample):');
      console.table(commPreview);

      const [commCount] = await pool.query(`
        SELECT COUNT(*) AS cnt FROM communications
        WHERE type = 'call' AND call_outcome IS NOT NULL AND TRIM(call_outcome) <> ''
          AND call_outcome <> (${caseComms})
      `);
      console.log(`Communications rows that would change: ${Number(commCount[0]?.cnt ?? 0)}`);
    }

    if (DRY) {
      console.log('\nDry run complete. Re-run with --apply to execute updates.');
      return;
    }

    if (leadChangeCount === 0) {
      console.log('No lead rows to update.');
    } else {
      const updateLeads = `
        UPDATE leads
        SET call_status = (${caseLeads}),
            updated_at = NOW()
        WHERE call_status IS NOT NULL AND TRIM(call_status) <> ''
          AND call_status <> (${caseLeads})
      `;
      const [ur] = await pool.query(updateLeads);
      console.log(`\nLeads updated (matched): ${ur.affectedRows ?? 'n/a'}, changed: ${ur.changedRows ?? 'n/a'}`);
    }

    if (alsoComms) {
      const caseComms = buildCaseSql('call_outcome', map);
      const updateComms = `
        UPDATE communications
        SET call_outcome = (${caseComms}),
            updated_at = NOW()
        WHERE type = 'call' AND call_outcome IS NOT NULL AND TRIM(call_outcome) <> ''
          AND call_outcome <> (${caseComms})
      `;
      const [cr] = await pool.query(updateComms);
      console.log(`Communications updated (matched): ${cr.affectedRows ?? 'n/a'}, changed: ${cr.changedRows ?? 'n/a'}`);
    }

    console.log('\nApply complete.');
  } catch (e) {
    console.error('Script failed:', e.message || e);
    if (String(e.message || '').includes('REGEXP_REPLACE')) {
      console.error('Hint: REGEXP_REPLACE requires MySQL 8+. Upgrade or change normExpr to TRIM/LOWER only and expand alias lists.');
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
    console.log('Connection closed.');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
