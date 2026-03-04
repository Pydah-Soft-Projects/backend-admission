import { getPool } from '../config-sql/database.js';

async function migrate() {
  const pool = getPool();
  try {
    console.log('Starting migration: Making email and password optional...');

    // 1. Alter users table to make email and password nullable
    // Note: We also need to ensure hrms_id and emp_no exist if they don't
    await pool.execute(`
      ALTER TABLE users 
      MODIFY COLUMN email VARCHAR(255) NULL,
      MODIFY COLUMN password VARCHAR(255) NULL,
      MODIFY COLUMN mobile_number VARCHAR(20) NULL;
    `);

    // 2. Check and add hrms_id and emp_no if they are missing (defensive)
    const [columns] = await pool.execute('SHOW COLUMNS FROM users');
    const columnNames = columns.map(c => c.Field);

    if (!columnNames.includes('hrms_id')) {
      await pool.execute('ALTER TABLE users ADD COLUMN hrms_id VARCHAR(255) NULL AFTER id');
      console.log('Added hrms_id column');
    }
    if (!columnNames.includes('emp_no')) {
      await pool.execute('ALTER TABLE users ADD COLUMN emp_no VARCHAR(255) NULL AFTER hrms_id');
      console.log('Added emp_no column');
    }

    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

migrate();
