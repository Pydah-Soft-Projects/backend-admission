/**
 * One-time migration: transport_application_counters keyed by academic year + college + course.
 * Run: node src/scripts-sql/migrateTransportApplicationCountersByCollegeCourse.js
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database-secondary.js';
import { getTableColumnSet } from '../utils/secondarySchema.util.js';

dotenv.config();

async function columnExists(pool, table, column) {
  const cols = await getTableColumnSet(pool, table);
  return cols.has(column);
}

async function main() {
  const pool = getPool();

  const [reqCols] = await pool.execute('DESCRIBE transport_requests');
  const appNumberCol = reqCols.find((c) => c.Field === 'application_number');
  if (appNumberCol && Number(appNumberCol.Character_maximum_length || 0) < 32) {
    await pool.execute(
      `ALTER TABLE transport_requests
       MODIFY COLUMN application_number VARCHAR(32) NULL
       COMMENT 'e.g. PCE-BTECH-0001 — serial per academic year, college, and course'`
    );
    console.log('Widened transport_requests.application_number to VARCHAR(32).');
  }

  const hasCollegeCode = await columnExists(pool, 'transport_application_counters', 'college_code');
  if (!hasCollegeCode) {
    await pool.execute(
      `ALTER TABLE transport_application_counters
       ADD COLUMN college_code VARCHAR(50) NOT NULL DEFAULT '' AFTER academic_year,
       ADD COLUMN course_code VARCHAR(50) NOT NULL DEFAULT '' AFTER college_code`
    );
    console.log('Added college_code and course_code to transport_application_counters.');
  }

  const [pkRows] = await pool.execute('SHOW KEYS FROM transport_application_counters WHERE Key_name = "PRIMARY"');
  const pkCols = pkRows.map((r) => r.Column_name);
  const expectedPk = ['academic_year', 'college_code', 'course_code'];
  const pkMatches =
    pkCols.length === expectedPk.length && expectedPk.every((c, i) => pkCols[i] === c);

  if (!pkMatches) {
    await pool.execute('ALTER TABLE transport_application_counters DROP PRIMARY KEY');
    await pool.execute(
      'ALTER TABLE transport_application_counters ADD PRIMARY KEY (academic_year, college_code, course_code)'
    );
    console.log('Updated transport_application_counters primary key.');
  }

  const [deleted] = await pool.execute(
    `DELETE FROM transport_application_counters WHERE college_code = '' AND course_code = ''`
  );
  console.log(`Removed ${deleted.affectedRows ?? 0} legacy global counter row(s).`);
  console.log('Migration complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
