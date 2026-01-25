import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const addFormIdColumn = async () => {
  let pool;

  try {
    pool = getPool();

    console.log('Adding form_id column to short_urls table...');

    // Check if column already exists
    const [columns] = await pool.execute(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'short_urls'
        AND COLUMN_NAME = 'form_id'
    `);

    if (columns.length > 0) {
      console.log('✓ form_id column already exists in short_urls table');
      await closeDB();
      process.exit(0);
    }

    // Add form_id column
    await pool.execute(`
      ALTER TABLE short_urls
      ADD COLUMN form_id CHAR(36) NULL AFTER utm_content
    `);

    console.log('✓ Added form_id column to short_urls table');

    // Add foreign key constraint
    try {
      await pool.execute(`
        ALTER TABLE short_urls
        ADD CONSTRAINT fk_short_urls_form_id
        FOREIGN KEY (form_id) REFERENCES form_builder_forms(id) ON DELETE SET NULL
      `);
      console.log('✓ Added foreign key constraint for form_id');
    } catch (error) {
      if (error.code === 'ER_CANNOT_ADD_FOREIGN') {
        console.log('⚠️  Could not add foreign key constraint (form_builder_forms table may not exist yet)');
        console.log('   This is okay - you can add it later after creating the form_builder_forms table');
      } else {
        throw error;
      }
    }

    // Add index
    try {
      await pool.execute(`
        CREATE INDEX idx_short_urls_form_id ON short_urls(form_id)
      `);
      console.log('✓ Added index on form_id');
    } catch (error) {
      if (error.code === 'ER_DUP_KEYNAME') {
        console.log('⚠️  Index already exists');
      } else {
        throw error;
      }
    }

    console.log('\n✅ Successfully added form_id column to short_urls table!');
    console.log('   The column is now ready to store form associations with UTM URLs.');

    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('Error adding form_id column:', error);
    if (pool) {
      await closeDB();
    }
    process.exit(1);
  }
};

addFormIdColumn();
