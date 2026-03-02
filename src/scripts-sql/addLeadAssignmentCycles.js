import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const migrate = async () => {
  let pool;
  try {
    console.log('📋 Migrating leads table for Assignment Cycles...');
    pool = getPool();
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'leads' AND TABLE_SCHEMA = DATABASE()
    `);
    const columnNames = columns.map(c => c.COLUMN_NAME.toLowerCase());

    // 1. Add target_date column
    if (!columnNames.includes('target_date')) {
      console.log('   Adding target_date column...');
      await pool.query(`
        ALTER TABLE leads 
        ADD COLUMN target_date DATE NULL AFTER assigned_by
      `);
      console.log('   ✅ target_date column added.');
    } else {
      console.log('   ℹ️  target_date column already exists.');
    }

    // 2. Add cycle_number column
    if (!columnNames.includes('cycle_number')) {
      console.log('   Adding cycle_number column...');
      await pool.query(`
        ALTER TABLE leads 
        ADD COLUMN cycle_number INT DEFAULT 1 AFTER target_date
      `);
      console.log('   ✅ cycle_number column added.');
    } else {
      console.log('   ℹ️  cycle_number column already exists.');
    }

    // 3. Add index for target_date and lead_status for efficient reclamation
    console.log('   Adding index for target_date and lead_status...');
    // Check if index exists first (MySQL 8.0 doesn't support IF NOT EXISTS for indexes in ALTER TABLE easily without a procedure)
    const [indexes] = await pool.query(`
      SHOW INDEX FROM leads WHERE Key_name = 'idx_leads_reclamation'
    `);

    if (indexes.length === 0) {
      await pool.query(`
        CREATE INDEX idx_leads_reclamation ON leads (target_date, lead_status)
      `);
      console.log('   ✅ Index idx_leads_reclamation created.');
    } else {
      console.log('   ℹ️  Index idx_leads_reclamation already exists.');
    }

    console.log('✅ Migration complete!');
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (pool) await closeDB();
    process.exit(1);
  }
};

migrate();
