/**
 * Migration: Add mobile_number column to users table
 * Run: node src/scripts-sql/addMobileToUsers.js
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  try {
    const pool = getPool();
    console.log('Adding mobile_number column to users table...');

    // Check if column exists
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'mobile_number'`
    );

    if (columns.length > 0) {
      console.log('Column mobile_number already exists.');
    } else {
      await pool.execute(
        `ALTER TABLE users ADD COLUMN mobile_number VARCHAR(15) UNIQUE DEFAULT NULL AFTER email`
      );
      console.log('Column mobile_number added successfully.');
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
