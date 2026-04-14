/**
 * Recompute leads.lead_status from call_status + visit_status using the
 * same merged mapping used by runtime resolver logic.
 *
 * Canonical lead_status after merge:
 *   New | Assigned | Interested | Not Interested | Call Back | Wrong Data | Visited | Confirmed
 *
 * Usage:
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

const normExpr = (col) => `LOWER(REGEXP_REPLACE(TRIM(${col}), '[[:space:]]+', ' '))`;

/**
 * Channel status aliases -> merged lead_status.
 * Keep aligned with src/utils/leadChannelStatus.util.js
 */
const CHANNEL_ALIASES = [
  ['Confirmed', ['confirmed']],
  ['Visited', ['visited']],
  ['Interested', ['interested', 'cet applied', 'cet_applied']],
  ['Not Interested', ['not interested', 'not_interested', 'not-interest', 'not interest']],
  ['Call Back', ['call back', 'call_back', 'callback', 're-visit', 'revisit', 'scheduled revisit']],
  ['Wrong Data', ['wrong data', 'wrong_data', 'wrong number', 'invalid number']],
  ['Assigned', ['assigned']],
  ['New', ['new']],
];

/**
 * Legacy lead_status aliases -> merged lead_status
 * (fallback when neither call_status nor visit_status yields a mapped value).
 */
const LEAD_ALIASES = [
  ['New', ['new']],
  ['Assigned', ['assigned']],
  ['Interested', ['interested', 'cet applied', 'cet_applied', 'partial', 'partially interested', 'partial interested']],
  ['Not Interested', ['not interested', 'not_interested', 'not-interest', 'not interest']],
  ['Call Back', ['call back', 'call_back', 'callback', 'scheduled revisit', 're-visit', 'revisit', 'not answered', 'not_answered', 'no answer', 'unanswered']],
  ['Wrong Data', ['wrong data', 'wrong_data', 'wrong number', 'invalid number']],
  ['Visited', ['visited']],
  ['Confirmed', ['confirmed', 'admitted', 'admission done', 'admission_done']],
];

function buildMap(aliasRows) {
  const map = new Map();
  for (const [canonical, aliases] of aliasRows) {
    for (const alias of aliases) map.set(normKey(alias), canonical);
    map.set(normKey(canonical), canonical);
  }
  return map;
}

function buildCaseSql(columnName, map, elseSql = 'NULL') {
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
  return `CASE
      ${branches.join('\n      ')}
      ELSE ${elseSql}
    END`;
}

function buildRankExpr(expr) {
  return `CASE ${expr}
      WHEN 'Confirmed' THEN 1
      WHEN 'Visited' THEN 2
      WHEN 'Interested' THEN 3
      WHEN 'Call Back' THEN 4
      WHEN 'Not Interested' THEN 5
      WHEN 'Wrong Data' THEN 6
      WHEN 'Assigned' THEN 7
      WHEN 'New' THEN 8
      ELSE 999
    END`;
}

function buildResolvedLeadSql(mappedCallExpr, mappedVisitExpr, mappedDesiredExpr) {
  const callRank = buildRankExpr(mappedCallExpr);
  const visitRank = buildRankExpr(mappedVisitExpr);
  return `CASE
      WHEN ${mappedCallExpr} IS NOT NULL AND ${mappedVisitExpr} IS NOT NULL THEN
        CASE
          WHEN ${mappedCallExpr} = ${mappedVisitExpr} THEN ${mappedCallExpr}
          WHEN ${mappedDesiredExpr} IS NOT NULL AND (${mappedDesiredExpr} = ${mappedCallExpr} OR ${mappedDesiredExpr} = ${mappedVisitExpr}) THEN ${mappedDesiredExpr}
          WHEN ${callRank} <= ${visitRank} THEN ${mappedCallExpr}
          ELSE ${mappedVisitExpr}
        END
      WHEN ${mappedCallExpr} IS NOT NULL THEN ${mappedCallExpr}
      WHEN ${mappedVisitExpr} IS NOT NULL THEN ${mappedVisitExpr}
      WHEN ${mappedDesiredExpr} IS NOT NULL THEN ${mappedDesiredExpr}
      ELSE 'New'
    END`;
}

async function run() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;
  if (!host || !user || !database) {
    console.error('Missing DB_HOST, DB_USER, or DB_NAME in .env');
    process.exit(1);
  }

  const channelMap = buildMap(CHANNEL_ALIASES);
  const leadMap = buildMap(LEAD_ALIASES);

  const mappedCallSql = buildCaseSql('call_status', channelMap, 'NULL');
  const mappedVisitSql = buildCaseSql('visit_status', channelMap, 'NULL');
  const mappedDesiredSql = buildCaseSql('lead_status', leadMap, 'NULL');
  const resolvedLeadSql = buildResolvedLeadSql(mappedCallSql, mappedVisitSql, mappedDesiredSql);

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

  try {
    console.log(DRY ? 'Mode: DRY-RUN (no writes)' : 'Mode: APPLY (writes enabled)');

    const [distinctBefore] = await pool.query(`
      SELECT lead_status AS v, COUNT(*) AS cnt
      FROM leads
      GROUP BY lead_status
      ORDER BY cnt DESC
      LIMIT 200
    `);
    console.log('\nTop distinct existing lead_status values (up to 200 groups):');
    console.table(distinctBefore);

    const [previewRows] = await pool.query(`
      SELECT
        lead_status AS old_lead_status,
        (${mappedCallSql}) AS mapped_call_status,
        (${mappedVisitSql}) AS mapped_visit_status,
        (${resolvedLeadSql}) AS new_lead_status,
        COUNT(*) AS cnt
      FROM leads
      GROUP BY old_lead_status, mapped_call_status, mapped_visit_status, new_lead_status
      HAVING COALESCE(old_lead_status, '') <> COALESCE(new_lead_status, '')
      ORDER BY cnt DESC
      LIMIT 300
    `);
    console.log('\nPlanned lead_status changes (grouped by old + mapped channel statuses):');
    console.table(previewRows);

    const [countRows] = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM leads
      WHERE COALESCE(lead_status, '') <> COALESCE((${resolvedLeadSql}), '')
    `);
    const changeCount = Number(countRows[0]?.cnt ?? 0);
    console.log(`\nLead rows that would change: ${changeCount}`);

    if (DRY) {
      console.log('\nDry run complete. Re-run with --apply to execute updates.');
      return;
    }

    if (changeCount === 0) {
      console.log('No lead rows to update.');
      return;
    }

    const [ur] = await pool.query(`
      UPDATE leads
      SET lead_status = (${resolvedLeadSql}),
          updated_at = NOW()
      WHERE COALESCE(lead_status, '') <> COALESCE((${resolvedLeadSql}), '')
    `);
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

