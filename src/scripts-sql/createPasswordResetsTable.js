/**
 * Migration: Create password_resets table
 * Run: node src/scripts-sql/createPasswordResetsTable.js
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  try {
    const pool = getPool();
    console.log('Creating password_resets table...');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id CHAR(36) PRIMARY KEY,
        mobile_number VARCHAR(20) NOT NULL,
        otp_code VARCHAR(10) NOT NULL,
        expires_at DATETIME NOT NULL,
        is_verified BOOLEAN DEFAULT FALSE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_password_resets_mobile (mobile_number),
        INDEX idx_password_resets_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('Table password_resets created successfully.');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
