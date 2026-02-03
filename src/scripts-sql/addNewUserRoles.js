/**
 * Migration: Add new user roles "Student Counselor" and "Data Entry User" to the users table.
 * Updates the role_name CHECK constraint to allow these values.
 * Run: node src/scripts-sql/addNewUserRoles.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Adding new user roles: Student Counselor, Data Entry User...\n');

    // Find the CHECK constraint name on users.role_name (MySQL 8.0.16+)
    const [constraints] = await pool.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_TYPE = 'CHECK'`
    );

    if (constraints.length === 0) {
      console.log('No CHECK constraint found on users table. If using MySQL < 8.0.16, add the new roles manually or recreate the constraint.');
      await closeDB();
      process.exit(0);
    }

    const constraintName = constraints[0].CONSTRAINT_NAME;
    console.log(`Dropping existing constraint: ${constraintName}`);

    await pool.execute(`ALTER TABLE users DROP CHECK \`${constraintName}\``);

    console.log('Adding new constraint with Student Counselor and Data Entry User.');
    await pool.execute(
      `ALTER TABLE users ADD CONSTRAINT users_role_name_check
       CHECK (role_name IN ('Super Admin', 'Sub Super Admin', 'User', 'Student Counselor', 'Data Entry User'))`
    );

    console.log('Done. New roles Student Counselor and Data Entry User are now allowed.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    if (error.message && error.message.includes('Duplicate constraint name')) {
      console.log('Constraint already updated. You can ignore this if roles were added earlier.');
    }
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
