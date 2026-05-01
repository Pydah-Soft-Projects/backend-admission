import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : null,
  });

  try {
    console.log('Reading SQL script...');
    const sqlPath = path.join(__dirname, '../scripts-sql/create_user_performance_summary_table.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Executing SQL script...');
    // The script might have multiple statements separated by semicolons
    // mysql2/promise.execute doesn't support multiple statements by default
    // We can use .query if we enable multipleStatements: true, or split them.
    // Our script has only one CREATE TABLE statement mostly.
    
    await connection.query(sql);
    console.log('Migration successful: Table created.');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await connection.end();
  }
}

runMigration();
