/**
 * Migration: Create user_audit_logs for Super Admin user-management change history.
 * Run: node src/scripts-sql/addUserAuditLogs.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;
  try {
    pool = getPool();
    console.log('Adding user_audit_logs table...\n');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_audit_logs (
        id CHAR(36) PRIMARY KEY,
        target_user_id CHAR(36) NULL,
        target_user_name VARCHAR(255) NULL,
        target_user_email VARCHAR(255) NULL,
        action VARCHAR(20) NOT NULL,
        changed_by CHAR(36) NULL,
        changed_by_name VARCHAR(255) NULL,
        changes_json JSON NOT NULL,
        ip_address VARCHAR(45) NULL,
        user_agent VARCHAR(500) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_user_audit_logs_target (target_user_id),
        INDEX idx_user_audit_logs_changed_by (changed_by),
        INDEX idx_user_audit_logs_created_at (created_at DESC),
        INDEX idx_user_audit_logs_target_created (target_user_id, created_at DESC),
        INDEX idx_user_audit_logs_action (action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Table user_audit_logs created.');

    console.log('\n✅ Done.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await closeDB();
  }
};

run();
