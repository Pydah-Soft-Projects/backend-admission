import { getPool } from '../config-sql/database.js';

async function migrate() {
  const pool = getPool();
  console.log('Starting migration: Adding assigned_to_pro column...');

  try {
    // 1. Add columns to leads table
    const [columns] = await pool.execute('SHOW COLUMNS FROM leads');
    const columnNames = columns.map(c => c.Field);

    if (!columnNames.includes('assigned_to_pro')) {
      console.log('Adding assigned_to_pro column...');
      await pool.execute(`
        ALTER TABLE leads 
        ADD COLUMN assigned_to_pro CHAR(36) NULL AFTER assigned_by,
        ADD COLUMN pro_assigned_at DATETIME NULL AFTER assigned_to_pro,
        ADD COLUMN pro_assigned_by CHAR(36) NULL AFTER pro_assigned_at
      `);
      console.log('Columns added successfully.');
    } else {
      console.log('Columns already exist.');
    }

    // 2. Add foreign keys
    try {
      console.log('Adding foreign key constraints...');
      await pool.execute(`
        ALTER TABLE leads
        ADD CONSTRAINT fk_leads_assigned_to_pro FOREIGN KEY (assigned_to_pro) REFERENCES users(id) ON DELETE SET NULL,
        ADD CONSTRAINT fk_leads_pro_assigned_by FOREIGN KEY (pro_assigned_by) REFERENCES users(id) ON DELETE SET NULL
      `);
      console.log('Foreign keys added successfully.');
    } catch (fkError) {
      if (fkError.code === 'ER_DUP_CONSTRAINT_NAME') {
        console.log('Foreign keys already exist.');
      } else {
        throw fkError;
      }
    }

    // 3. Add indexes
    try {
      console.log('Adding indexes...');
      await pool.execute(`
        ALTER TABLE leads
        ADD INDEX idx_leads_assigned_to_pro (assigned_to_pro)
      `);
      console.log('Indexes added successfully.');
    } catch (idxError) {
      if (idxError.code === 'ER_DUP_KEYNAME') {
        console.log('Indexes already exist.');
      } else {
        throw idxError;
      }
    }

    console.log('Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
