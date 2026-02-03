/**
 * Migration: Add academic_year and student_group columns to leads table.
 * Run: node src/scripts-sql/addAcademicYearAndStudentGroupToLeads.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Adding academic_year and student_group to leads table...\n');

    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME IN ('academic_year', 'student_group')`
    );
    const existing = new Set(cols.map((r) => r.COLUMN_NAME));

    if (!existing.has('academic_year')) {
      await pool.execute(
        'ALTER TABLE leads ADD COLUMN academic_year SMALLINT UNSIGNED NULL AFTER lead_status'
      );
      console.log('Added column academic_year.');
    } else {
      console.log('Column academic_year already exists. Skipping.');
    }

    if (!existing.has('student_group')) {
      await pool.execute(
        'ALTER TABLE leads ADD COLUMN student_group VARCHAR(50) NULL AFTER academic_year'
      );
      console.log('Added column student_group.');
    } else {
      console.log('Column student_group already exists. Skipping.');
    }

    try {
      await pool.execute('CREATE INDEX idx_leads_academic_year ON leads (academic_year)');
      console.log('Created index idx_leads_academic_year.');
    } catch (e) {
      if (e.code !== 'ER_DUP_KEYNAME') throw e;
      console.log('Index idx_leads_academic_year already exists.');
    }

    try {
      await pool.execute('CREATE INDEX idx_leads_student_group ON leads (student_group)');
      console.log('Created index idx_leads_student_group.');
    } catch (e) {
      if (e.code !== 'ER_DUP_KEYNAME') throw e;
      console.log('Index idx_leads_student_group already exists.');
    }

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
