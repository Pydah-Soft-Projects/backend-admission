/**
 * Migration: Extend user_login_logs event_type to include tracking_enabled and tracking_disabled.
 * Run: node src/scripts-sql/extendUserLoginLogsEventTypes.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;
  try {
    pool = getPool();
    console.log('Extending user_login_logs event types...\n');

    const [constraints] = await pool.execute(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_login_logs' AND CONSTRAINT_TYPE = 'CHECK'`
    );

    if (constraints.length > 0) {
      const name = constraints[0].CONSTRAINT_NAME;
      await pool.execute(`ALTER TABLE user_login_logs DROP CHECK \`${name}\``);
      console.log('✓ Dropped existing CHECK constraint.');
    }

    try {
      await pool.execute(
        `ALTER TABLE user_login_logs ADD CONSTRAINT user_login_logs_event_type_check
         CHECK (event_type IN ('login', 'logout', 'tracking_enabled', 'tracking_disabled'))`
      );
      console.log('✓ Added extended event_type CHECK constraint.');
    } catch (e) {
      if (e.code === 'ER_DUP_CONSTRAINT_NAME' || e.errno === 382) {
        console.log('Constraint already updated (event types include tracking_enabled/tracking_disabled).');
      } else {
        throw e;
      }
    }

    console.log('\n✅ Done.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await closeDB();
  }
};

run();
