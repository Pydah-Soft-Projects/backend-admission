/**
 * Migration: Add missing "address" column to the leads table.
 * Fixes: Error: Unknown column 'address' in 'field list'
 * Run: node src/scripts-sql/addAddressColumnToLeads.js (from backend-admission directory)
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

    // Check if column exists
    console.log('Checking if address column exists in leads table...');
    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'leads' 
         AND COLUMN_NAME = 'address'`
    );

    if (columns.length > 0) {
      console.log('Address column already exists. Skipping.');
    } else {
      console.log('Adding address column to leads table...');
      // Adding it after village to match schema.sql approximately (village is before address in schema)
      await connection.execute(
        `ALTER TABLE leads ADD COLUMN address VARCHAR(255) DEFAULT '' AFTER village`
      );
      console.log('Successfully added address column.');
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
