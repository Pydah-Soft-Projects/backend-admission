/**
 * Adds call_status and visit_status to leads (nullable).
 * Run: node src/scripts-sql/addCallStatusVisitStatusToLeads.js
 *
 * Uses its own pool with connectTimeout so a bad/unreachable host fails fast
 * instead of hanging. Always ends the pool so Node can exit.
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function run() {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const database = process.env.DB_NAME;

  if (!host || !user || !database) {
    console.error('Missing DB_HOST, DB_USER, or DB_NAME in .env');
    process.exit(1);
  }

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
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    console.log('Running column check…');
    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME IN ('call_status','visit_status')`
    );

    const colNames = new Set(
      cols.map((c) => c.COLUMN_NAME || c.column_name).filter(Boolean)
    );

    if (!colNames.has('call_status')) {
      await pool.execute(
        'ALTER TABLE leads ADD COLUMN call_status VARCHAR(50) NULL DEFAULT NULL AFTER lead_status'
      );
      console.log('Added call_status');
    } else {
      console.log('call_status already exists');
    }

    if (!colNames.has('visit_status')) {
      await pool.execute(
        'ALTER TABLE leads ADD COLUMN visit_status VARCHAR(50) NULL DEFAULT NULL AFTER call_status'
      );
      console.log('Added visit_status');
    } else {
      console.log('visit_status already exists');
    }

    console.log('Done.');
  } catch (e) {
    console.error('Migration failed:', e.message || e);
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
