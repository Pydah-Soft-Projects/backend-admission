/**
 * Set leads.call_status = 'Assigned' where a counsellor is assigned (assigned_to set)
 * but call_status is still NULL or blank — matches post-assignment behaviour in the API.
 *
 * Run manually when ready:
 *   node src/scripts-sql/backfillCallStatusAssignedForAssignedLeads.js --dry-run
 *   node src/scripts-sql/backfillCallStatusAssignedForAssignedLeads.js --apply
 *
 * Env:
 *   STRICT_COUNSELLOR=1 — only rows where assigned_to user has role_name = 'Student Counselor'
 *                          (JOIN users; slightly heavier than default).
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const DRY = process.argv.includes('--dry-run') || !APPLY;
const strictCounsellor =
  process.env.STRICT_COUNSELLOR === '1' || process.env.STRICT_COUNSELLOR === 'true';

const whereBase = strictCounsellor
  ? `l.assigned_to IS NOT NULL
     AND (l.call_status IS NULL OR TRIM(l.call_status) = '')
     AND u.role_name = 'Student Counselor'`
  : `assigned_to IS NOT NULL
     AND (call_status IS NULL OR TRIM(call_status) = '')`;

const countSql = strictCounsellor
  ? `SELECT COUNT(*) AS cnt FROM leads l INNER JOIN users u ON u.id = l.assigned_to WHERE ${whereBase}`
  : `SELECT COUNT(*) AS cnt FROM leads WHERE ${whereBase}`;

const sampleSql = strictCounsellor
  ? `SELECT l.id, l.enquiry_number, l.assigned_to, u.role_name AS assignee_role, l.call_status, l.lead_status
     FROM leads l INNER JOIN users u ON u.id = l.assigned_to
     WHERE ${whereBase}
     LIMIT 25`
  : `SELECT id, enquiry_number, assigned_to, call_status, lead_status
     FROM leads WHERE ${whereBase}
     LIMIT 25`;

const updateSql = strictCounsellor
  ? `UPDATE leads l
     INNER JOIN users u ON u.id = l.assigned_to
     SET l.call_status = 'Assigned', l.updated_at = NOW()
     WHERE ${whereBase}`
  : `UPDATE leads
     SET call_status = 'Assigned', updated_at = NOW()
     WHERE ${whereBase}`;

async function run() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;

  if (!host || !user || !database) {
    console.error('Missing DB_HOST, DB_USER, or DB_NAME in .env');
    process.exit(1);
  }

  console.log(DRY ? 'Mode: DRY-RUN (no writes)' : 'Mode: APPLY (writes enabled)');
  console.log(`STRICT_COUNSELLOR (join users): ${strictCounsellor ? 'yes' : 'no'}`);

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
    const [countRows] = await pool.query(countSql);
    const n = Number(countRows[0]?.cnt ?? 0);
    console.log(`\nLeads matching (would update): ${n}`);

    const [sample] = await pool.query(sampleSql);
    console.log('\nSample (up to 25):');
    console.table(sample);

    if (DRY) {
      console.log('\nDry run complete. Re-run with --apply to execute UPDATE.');
      return;
    }

    const [result] = await pool.query(updateSql);
    console.log(`\nUpdated — matched: ${result.affectedRows ?? 'n/a'}, changed: ${result.changedRows ?? 'n/a'}`);
    console.log('Done.');
  } catch (e) {
    console.error('Script failed:', e.message || e);
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
