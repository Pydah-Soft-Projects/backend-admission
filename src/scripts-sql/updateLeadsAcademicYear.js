/**
 * Set academic_year on leads that have it NULL.
 * Usage: node src/scripts-sql/updateLeadsAcademicYear.js [year]
 * Default year: 2026
 * Example: node src/scripts-sql/updateLeadsAcademicYear.js 2026
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const DEFAULT_YEAR = 2026;

const run = async () => {
  const yearArg = process.argv[2];
  const year = yearArg ? parseInt(yearArg, 10) : DEFAULT_YEAR;
  if (Number.isNaN(year) || year < 2000 || year > 2100) {
    console.error('Invalid year. Use e.g. 2025 or 2026.');
    process.exit(1);
  }

  let pool;
  try {
    pool = getPool();
    console.log(`Updating leads with academic_year IS NULL to academic_year = ${year}...\n`);

    const [result] = await pool.execute(
      'UPDATE leads SET academic_year = ? WHERE academic_year IS NULL',
      [year]
    );

    const affected = result.affectedRows != null ? result.affectedRows : 0;
    console.log(`✓ Updated ${affected} lead(s) to academic_year = ${year}.`);
    console.log('\n✅ Done.');
  } finally {
    await closeDB();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
