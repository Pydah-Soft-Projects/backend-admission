import { getPool } from '../config-sql/database-secondary.js';

async function migrate() {
  const pool = getPool();
  try {
    console.log('Adding father_photo and mother_photo to secondary students table...');
    await pool.query(`
      ALTER TABLE students
        ADD COLUMN father_photo LONGTEXT NULL COMMENT 'Father portrait synced from primary',
        ADD COLUMN mother_photo LONGTEXT NULL COMMENT 'Mother portrait synced from primary';
    `);
    console.log('Migration completed successfully.');
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('Columns already exist. Skipping migration.');
    } else {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  } finally {
    process.exit(0);
  }
}

migrate();
