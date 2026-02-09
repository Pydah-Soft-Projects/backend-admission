/**
 * Migration: Add time_tracking_enabled to users and create user_login_logs table.
 * Run: node src/scripts-sql/addTimeTrackingAndUserLoginLogs.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;
  try {
    pool = getPool();
    console.log('Adding time tracking feature...\n');

    // 1. Add time_tracking_enabled to users
    try {
      await pool.execute(
        `ALTER TABLE users ADD COLUMN time_tracking_enabled BOOLEAN DEFAULT TRUE NOT NULL
         COMMENT 'When FALSE, user can only access Settings until they enable tracking'`
      );
      console.log('✓ Column time_tracking_enabled added to users.');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELD' || e.code === 'ER_DUP_FIELDNAME') {
        console.log('Column time_tracking_enabled already exists on users.');
      } else {
        throw e;
      }
    }

    // 2. Create user_login_logs table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_login_logs (
        id CHAR(36) PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('login', 'logout')),
        ip_address VARCHAR(45) NULL,
        user_agent VARCHAR(500) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_login_logs_user_id (user_id),
        INDEX idx_user_login_logs_created_at (created_at DESC),
        INDEX idx_user_login_logs_user_created (user_id, created_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Table user_login_logs created.');

    console.log('\n✅ Done.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await closeDB();
  }
};

run();
