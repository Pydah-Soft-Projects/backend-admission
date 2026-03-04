import { getPool } from '../config-sql/database.js';

const migrate = async () => {
  const pool = getPool();
  try {
    console.log('Starting migration: Add hrms_id to users table...');
    
    // Check if column already exists
    const [columns] = await pool.execute('SHOW COLUMNS FROM users LIKE "hrms_id"');
    
    if (columns.length === 0) {
      await pool.execute('ALTER TABLE users ADD COLUMN hrms_id VARCHAR(255) NULL AFTER id, ADD COLUMN emp_no VARCHAR(50) NULL AFTER hrms_id');
      console.log('Columns hrms_id and emp_no added successfully.');
    } else {
      console.log('Column hrms_id already exists.');
    }

    // Also update password to be NULLABLE if we want to allow users without local passwords
    // However, keeping it NOT NULL with a default or dummy value for legacy compatibility might be safer
    // Or just make it NULLABLE.
    await pool.execute('ALTER TABLE users MODIFY COLUMN password VARCHAR(255) NULL');
    console.log('Column password modified to be NULLABLE.');

    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
};

migrate().then(() => process.exit(0));
