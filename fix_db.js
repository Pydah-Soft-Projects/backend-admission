import { getPool } from './src/config-sql/database.js';

async function fixSmsBulkJobsTable() {
  let pool;
  try {
    pool = getPool();
    console.log("Checking if header_handle column exists in sms_bulk_jobs...");
    
    await pool.execute(`
      ALTER TABLE sms_bulk_jobs 
      ADD COLUMN header_handle VARCHAR(1024) NULL DEFAULT NULL AFTER template_name;
    `);
    
    console.log("✅ Successfully added 'header_handle' column to sms_bulk_jobs table!");
  } catch(e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log("Column 'header_handle' already exists. No action needed.");
    } else {
      console.error("Error adding column:", e);
    }
  } finally {
    if (pool) process.exit(0);
  }
}

fixSmsBulkJobsTable();
