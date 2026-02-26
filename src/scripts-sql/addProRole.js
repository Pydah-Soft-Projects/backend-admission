/**
 * Migration: Add new user role "PRO" to the users table.
 * Updates the role_name CHECK constraint to allow this value.
 * Run: node src/scripts-sql/addProRole.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Adding new user role: PRO...\n');

    // Find the CHECK constraint name on users.role_name
    // We look for constraints that might be the role_name check
    const [constraints] = await pool.execute(
      `SELECT CONSTRAINT_NAME 
       FROM information_schema.TABLE_CONSTRAINTS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'users' 
       AND CONSTRAINT_TYPE = 'CHECK'`
    );

    if (constraints.length === 0) {
      console.log('No CHECK constraint found on users table.');
      console.log('Adding new constraint with PRO support.');
    } else {
      // Drop existing constraints to be sure
      for (const constraint of constraints) {
        console.log(`Dropping constraint: ${constraint.CONSTRAINT_NAME}`);
        try {
          await pool.execute(`ALTER TABLE users DROP CHECK \`${constraint.CONSTRAINT_NAME}\``);
        } catch (e) {
          console.warn(`Could not drop constraint ${constraint.CONSTRAINT_NAME}: ${e.message}`);
        }
      }
    }

    console.log('Adding updated constraint with PRO support.');
    await pool.execute(
      `ALTER TABLE users ADD CONSTRAINT users_role_name_check 
       CHECK (role_name IN ('Super Admin', 'Sub Super Admin', 'User', 'Student Counselor', 'Data Entry User', 'PRO'))`
    );

    console.log('Done. PRO role is now allowed in the database.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
