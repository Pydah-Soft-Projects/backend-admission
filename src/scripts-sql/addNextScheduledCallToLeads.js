/**
 * Migration: Add next_scheduled_call column to leads table for follow-up scheduling.
 * Run: node src/scripts-sql/addNextScheduledCallToLeads.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Adding next_scheduled_call to leads table...\n');

    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'next_scheduled_call'`
    );

    if (columns.length > 0) {
      console.log('Column next_scheduled_call already exists. Skipping.');
      await closeDB();
      process.exit(0);
    }

    await pool.execute(
      'ALTER TABLE leads ADD COLUMN next_scheduled_call DATETIME NULL AFTER last_follow_up'
    );
    console.log('Added column next_scheduled_call.');

    await pool.execute(
      'CREATE INDEX idx_leads_next_scheduled_call ON leads (next_scheduled_call)'
    );
    console.log('Created index idx_leads_next_scheduled_call.');

    console.log('\nDone.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
