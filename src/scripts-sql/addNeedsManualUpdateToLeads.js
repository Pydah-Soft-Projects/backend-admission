/**
 * Add needs_manual_update to leads table.
 * Set to TRUE when bulk-uploaded lead has district/mandal/school/college not matching DB.
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;
  try {
    pool = getPool();
    console.log('Adding needs_manual_update to leads...\n');

    try {
      await pool.execute('ALTER TABLE leads ADD COLUMN needs_manual_update BOOLEAN DEFAULT FALSE NOT NULL');
      console.log('✓ Column needs_manual_update added.');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELD') {
        console.log('Column needs_manual_update already exists.');
      } else {
        throw e;
      }
    }

    try {
      await pool.execute('CREATE INDEX idx_leads_needs_manual_update ON leads (needs_manual_update)');
      console.log('✓ Index idx_leads_needs_manual_update created.');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log('Index idx_leads_needs_manual_update already exists.');
      } else {
        throw e;
      }
    }

    console.log('\n✅ Done.');
  } finally {
    await closeDB();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
