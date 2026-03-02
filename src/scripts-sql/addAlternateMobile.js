/**
 * Migration: Add alternate_mobile column to leads table
 * Run: node src/scripts-sql/addAlternateMobile.js
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const run = async () => {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });

    try {
        console.log('Connected to database. Checking if alternate_mobile column exists...');

        const [rows] = await connection.execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'alternate_mobile'`,
            [process.env.DB_NAME]
        );

        if (rows.length > 0) {
            console.log('✅ Column alternate_mobile already exists. No changes needed.');
        } else {
            console.log('Adding alternate_mobile column...');
            await connection.execute(
                `ALTER TABLE leads ADD COLUMN alternate_mobile VARCHAR(20) DEFAULT '' AFTER phone`
            );
            console.log('✅ Column alternate_mobile added successfully!');
        }
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    } finally {
        await connection.end();
    }
};

run();
