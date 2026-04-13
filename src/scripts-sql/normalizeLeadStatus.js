/**
 * Normalize legacy values on leads.lead_status to a canonical set used across the app.
 *
 * Canonical:
 *   New | Assigned | Interested | Not Interested | Partial | Admitted | Closed | Cancelled
 *   | Not Answered | Call Back | Wrong Data | Confirmed | CET Applied
 *
 * Usage (manual):
 *   node src/scripts-sql/normalizeLeadStatus.js --dry-run
 *   node src/scripts-sql/normalizeLeadStatus.js --apply
 *
 * Requires MySQL 8+ (REGEXP_REPLACE used for whitespace normalization).
 */
import dotenv from 'dotenv';
import mysql2 from 'mysql2';
import mysql from 'mysql2/promise';

dotenv.config();

const esc = (v) => mysql2.escape(v);
const APPLY = process.argv.includes('--apply');
const DRY = process.argv.includes('--dry-run') || !APPLY;

function normKey(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const CANONICAL = [
  'New',
  'Assigned',
  'Interested',
  'Not Interested',
  'Partial',
  'Admitted',
  'Closed',
  'Cancelled',
  'Not Answered',
  'Call Back',
  'Wrong Data',
  'Confirmed',
  'CET Applied',
];

const LEGACY_ALIASES = [
  ['New', ['new', 'NEW']],
  ['Assigned', ['assigned', 'ASSIGNED']],
  ['Interested', ['interested', 'INTERESTED']],
  ['Not Interested', ['not interested', 'not_interested', 'NOT_INTERESTED', 'not interest', 'not-interest']],
  ['Partial', ['partial', 'PARTIAL', 'partially interested', 'partial interested']],
  ['Admitted', ['admitted', 'ADMITTED', 'admission done', 'admission_done']],
  ['Closed', ['closed', 'CLOSED']],
  ['Cancelled', ['cancelled', 'CANCELLED', 'canceled', 'CANCELED']],
  ['Not Answered', ['not answered', 'not_answered', 'NOT_ANSWERED', 'no answer', 'no_answer', 'NO_ANSWER', 'not answer', 'unanswered', 'no anser']],
  ['Call Back', ['call back', 'call_back', 'CALL_BACK', 'callback', 'call back requested']],
  ['Wrong Data', ['wrong data', 'wrong_data', 'wrong number', 'invalid number']],
  ['Confirmed', ['confirmed', 'CONFIRMED']],
  ['CET Applied', ['cet applied', 'cet_applied', 'CET_APPLIED', 'eamcet applied', 'eamcet_applied', 'polycet applied', 'polycet_applied']],
];

function buildNormalizationMap() {
  const map = new Map();
  for (const [canonical, aliases] of LEGACY_ALIASES) {
    for (const a of aliases) map.set(normKey(a), canonical);
  }
  for (const c of CANONICAL) map.set(normKey(c), c);
  return map;
}

const normExpr = (col) => `LOWER(REGEXP_REPLACE(TRIM(${col}), '[[:space:]]+', ' '))`;

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
  const caseSql = buildCaseSql('lead_status', map);

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

  const previewSql = `
    SELECT
      lead_status AS raw_value,
      ${normExpr('lead_status')} AS normalized,
      (${caseSql}) AS would_become,
      COUNT(*) AS cnt
    FROM leads
    WHERE lead_status IS NOT NULL AND TRIM(lead_status) <> ''
    GROUP BY lead_status
    HAVING lead_status <> (${caseSql})
    ORDER BY cnt DESC
  `;

  const countSql = `
    SELECT COUNT(*) AS cnt FROM leads
    WHERE lead_status IS NOT NULL AND TRIM(lead_status) <> ''
      AND lead_status <> (${caseSql})
  `;

  try {
    console.log(DRY ? 'Mode: DRY-RUN (no writes)' : 'Mode: APPLY (writes enabled)');

    const [distinctBefore] = await pool.query(`
      SELECT lead_status AS v, COUNT(*) AS cnt
      FROM leads
      WHERE lead_status IS NOT NULL AND TRIM(lead_status) <> ''
      GROUP BY lead_status
      ORDER BY cnt DESC
      LIMIT 200
    `);
    console.log('\nTop distinct lead_status values (up to 200 groups):');
    console.table(distinctBefore);

    const [previewRows] = await pool.query(previewSql);
    console.log('\nPlanned lead_status changes (grouped):');
    console.table(previewRows);

    const [countRows] = await pool.query(countSql);
    const changeCount = Number(countRows[0]?.cnt ?? 0);
    console.log(`\nLead rows that would change: ${changeCount}`);

    const allKeys = [...map.keys()].map((k) => esc(k)).join(', ');
    const [unmapped] = await pool.query(`
      SELECT lead_status AS v, COUNT(*) AS cnt
      FROM leads
      WHERE lead_status IS NOT NULL AND TRIM(lead_status) <> ''
      GROUP BY lead_status
      HAVING ${normExpr('lead_status')} NOT IN (${allKeys})
      ORDER BY cnt DESC
      LIMIT 50
    `);
    if (unmapped.length > 0) {
      console.log('\nDistinct lead_status values NOT covered by mapping:');
      console.table(unmapped);
    }

    if (DRY) {
      console.log('\nDry run complete. Re-run with --apply to execute updates.');
      return;
    }

    if (changeCount === 0) {
      console.log('No lead rows to update.');
      return;
    }

    const updateSql = `
      UPDATE leads
      SET lead_status = (${caseSql}),
          updated_at = NOW()
      WHERE lead_status IS NOT NULL AND TRIM(lead_status) <> ''
        AND lead_status <> (${caseSql})
    `;
    const [ur] = await pool.query(updateSql);
    console.log(`\nLeads updated (matched): ${ur.affectedRows ?? 'n/a'}, changed: ${ur.changedRows ?? 'n/a'}`);
    console.log('\nApply complete.');
  } catch (e) {
    console.error('Script failed:', e.message || e);
    if (String(e.message || '').includes('REGEXP_REPLACE')) {
      console.error('Hint: REGEXP_REPLACE requires MySQL 8+.');
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

