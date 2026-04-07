/**
 * Backfill leads.call_status from communications: latest call per lead (by sent_at, id).
 * Only updates rows where call_status IS NULL or blank (unless FORCE_OVERWRITE=1).
 *
 * Run:
 *   node src/scripts-sql/backfillLeadCallStatusFromCommunications.js
 *   node src/scripts-sql/backfillLeadCallStatusFromCommunications.js --dry-run
 *
 * Env:
 *   FORCE_OVERWRITE=1  — set call_status from latest call even if already set
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const forceOverwrite = process.env.FORCE_OVERWRITE === '1' || process.env.FORCE_OVERWRITE === 'true';

async function run() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;

  if (!host || !user || !database) {
    console.error('Missing DB_HOST, DB_USER, or DB_NAME in .env');
    process.exit(1);
  }

  console.log(
    dryRun ? 'DRY RUN (no rows updated)' : forceOverwrite ? 'LIVE: overwriting existing call_status' : 'LIVE: only NULL/empty call_status'
  );
  console.log(`Connecting to MySQL (${host}, db: ${database})…`);

  const pool = mysql.createPool({
    host,
    port: Number(process.env.DB_PORT) || 3306,
    user,
    password: process.env.DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 1,
    connectTimeout: 25000,
    enableKeepAlive: false,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const whereTarget = forceOverwrite
    ? '1=1'
    : '(l.call_status IS NULL OR TRIM(l.call_status) = \'\')';

  const previewSql = `
    SELECT COUNT(*) AS cnt
    FROM leads l
    INNER JOIN (
      SELECT lead_id, call_outcome
      FROM (
        SELECT lead_id, call_outcome,
          ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY sent_at DESC, id DESC) AS rn
        FROM communications
        WHERE type = 'call'
          AND call_outcome IS NOT NULL
          AND TRIM(call_outcome) <> ''
      ) t
      WHERE rn = 1
    ) x ON l.id = x.lead_id
    WHERE ${whereTarget}
  `;

  const updateSql = `
    UPDATE leads l
    INNER JOIN (
      SELECT lead_id, call_outcome
      FROM (
        SELECT lead_id, call_outcome,
          ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY sent_at DESC, id DESC) AS rn
        FROM communications
        WHERE type = 'call'
          AND call_outcome IS NOT NULL
          AND TRIM(call_outcome) <> ''
      ) t
      WHERE rn = 1
    ) x ON l.id = x.lead_id
    SET l.call_status = x.call_outcome
    WHERE ${whereTarget}
  `;

  try {
    const [countRows] = await pool.execute(previewSql);
    const n = countRows[0]?.cnt ?? 0;
    console.log(`Leads that would be updated: ${n}`);

    if (dryRun) {
      const sampleSql = `
        SELECT l.id, l.enquiry_number, l.call_status AS current_call_status, x.call_outcome AS latest_outcome
        FROM leads l
        INNER JOIN (
          SELECT lead_id, call_outcome
          FROM (
            SELECT lead_id, call_outcome,
              ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY sent_at DESC, id DESC) AS rn
            FROM communications
            WHERE type = 'call'
              AND call_outcome IS NOT NULL
              AND TRIM(call_outcome) <> ''
          ) t
          WHERE rn = 1
        ) x ON l.id = x.lead_id
        WHERE ${whereTarget}
        LIMIT 15
      `;
      const [rows] = await pool.execute(sampleSql);
      console.log('Sample (up to 15):');
      console.table(rows);
      console.log('Done (dry run).');
    } else {
      const [result] = await pool.execute(updateSql);
      console.log(`Rows matched/updated: ${result.affectedRows ?? result.changedRows ?? 'n/a'}`);
      console.log('Done.');
    }
  } catch (e) {
    console.error('Backfill failed:', e.message || e);
    if (String(e.message || '').includes('ROW_NUMBER')) {
      console.error('Hint: ROW_NUMBER requires MySQL 8+. Run the .sql in an 8+ instance or adapt for 5.7.');
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
