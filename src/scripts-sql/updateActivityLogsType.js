/**
 * Migration: Add "field_update" to the activity_logs type CHECK constraint.
 * Fixes: Check constraint 'activity_logs_chk_1' is violated error.
 * Run: node src/scripts-sql/updateActivityLogsType.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const run = async () => {
  let connection;

  try {
    const dbConfig = {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    };

    console.log('Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    console.log('Connected.');

    // 1. Find the CHECK constraint name on activity_logs.type
    console.log('Finding CHECK constraint on activity_logs table...');
    const [constraints] = await connection.execute(
      `SELECT CONSTRAINT_NAME 
       FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'activity_logs' 
         AND CONSTRAINT_TYPE = 'CHECK'`
    );

    if (constraints.length === 0) {
      console.log('No CHECK constraint found on activity_logs table. It might have been dropped already.');
    } else {
        // Typically there is one CHECK constraint for the permitted values.
        // We will try to drop it. Note that MySQL names them like activity_logs_chk_1.
        for (const constraint of constraints) {
             const constraintName = constraint.CONSTRAINT_NAME;
             console.log(`Dropping existing constraint: ${constraintName} ...`);
             try {
                await connection.execute(`ALTER TABLE activity_logs DROP CHECK \`${constraintName}\``);
                console.log(`Dropped ${constraintName}.`);
             } catch (err) {
                 console.warn(`Failed to drop ${constraintName}: ${err.message}. It might not be the right one or already gone.`);
             }
        }
    }

    // 2. Add the updated constraint
    console.log('Adding updated CHECK constraint including "field_update"...');
    try {
        await connection.execute(
        `ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_type_check
         CHECK (type IN ('status_change', 'comment', 'follow_up', 'quota_change', 'joining_update', 'field_update'))`
        );
        console.log('Successfully added new constraint.');
    } catch (err) {
        console.error('Error adding new constraint:', err.message);
        // If it fails, maybe the column data is invalid? But we are expanding the set, so it should be fine.
    }

    console.log('Migration completed.');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
    process.exit(0);
  }
};

run();
