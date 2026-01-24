import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createSchema = async () => {
  let pool;
  
  try {
    console.log('📋 Creating database schema...');
    
    // Get database connection pool
    pool = getPool();
    
    // First, ensure database exists
    console.log('1. Checking database exists...');
    const [databases] = await pool.execute(
      `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
      [process.env.DB_NAME]
    );
    
    if (databases.length === 0) {
      console.log(`   Database '${process.env.DB_NAME}' does not exist. Creating...`);
      // Use query() for raw SQL (not prepared statement)
      await pool.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log(`   ✅ Database '${process.env.DB_NAME}' created successfully!`);
    } else {
      console.log(`   ✅ Database '${process.env.DB_NAME}' already exists.`);
    }
    
    // Use the database - must use query() not execute() for USE command
    await pool.query(`USE \`${process.env.DB_NAME}\``);
    
    // Read schema file
    console.log('2. Reading schema file...');
    const schemaPath = path.join(__dirname, '../config-sql/schema.sql');
    const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    
    // Split by semicolons and execute each statement
    console.log('3. Creating tables...');
    // Remove single-line comments and split by semicolons
    const statements = schemaSQL
      .split('\n')
      .map(line => {
        // Remove inline comments (-- comment)
        const commentIndex = line.indexOf('--');
        if (commentIndex !== -1) {
          return line.substring(0, commentIndex).trim();
        }
        return line.trim();
      })
      .filter(line => line.length > 0)
      .join('\n')
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.match(/^--/));
    
    let tablesCreated = 0;
    let failedStatements = [];
    
    // First pass: Create all tables (ignore foreign key errors)
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          // Use query() for raw SQL statements (not prepared statements)
          await pool.query(statement);
          // Extract table name if it's a CREATE TABLE statement
          const tableMatch = statement.match(/CREATE TABLE.*?IF NOT EXISTS.*?`?(\w+)`?/i) || 
                            statement.match(/CREATE TABLE.*?`?(\w+)`?/i);
          if (tableMatch) {
            console.log(`   ✅ Created table: ${tableMatch[1]}`);
            tablesCreated++;
          }
        } catch (error) {
          // Ignore "table already exists" errors
          if (error.message.includes('already exists') || error.code === 'ER_TABLE_EXISTS_ERROR') {
            const tableMatch = statement.match(/CREATE TABLE.*?IF NOT EXISTS.*?`?(\w+)`?/i) || 
                              statement.match(/CREATE TABLE.*?`?(\w+)`?/i);
            if (tableMatch) {
              console.log(`   ℹ️  Table '${tableMatch[1]}' already exists (skipped)`);
            }
          } else if (error.message.includes('Failed to open the referenced table')) {
            // Foreign key error - table doesn't exist yet, will retry
            failedStatements.push(statement);
          } else {
            console.error(`   ⚠️  Error executing statement: ${error.message}`);
            console.error(`   Statement: ${statement.substring(0, 150)}...`);
            // Don't add to failedStatements if it's a syntax error
            if (!error.message.includes('syntax')) {
              failedStatements.push(statement);
            }
          }
        }
      }
    }
    
    // Second pass: Retry failed statements (foreign key dependencies should be resolved now)
    if (failedStatements.length > 0) {
      console.log(`\n4. Retrying ${failedStatements.length} failed statements...`);
      for (const statement of failedStatements) {
        try {
          await pool.query(statement);
          const tableMatch = statement.match(/CREATE TABLE.*?IF NOT EXISTS.*?`?(\w+)`?/i) || 
                            statement.match(/CREATE TABLE.*?`?(\w+)`?/i);
          if (tableMatch) {
            console.log(`   ✅ Created table: ${tableMatch[1]}`);
            tablesCreated++;
          }
        } catch (error) {
          if (error.message.includes('already exists') || error.code === 'ER_TABLE_EXISTS_ERROR') {
            const tableMatch = statement.match(/CREATE TABLE.*?IF NOT EXISTS.*?`?(\w+)`?/i) || 
                              statement.match(/CREATE TABLE.*?`?(\w+)`?/i);
            if (tableMatch) {
              console.log(`   ℹ️  Table '${tableMatch[1]}' already exists (skipped)`);
            }
          } else {
            console.error(`   ❌ Still failed: ${error.message}`);
            console.error(`   Statement: ${statement.substring(0, 150)}...`);
          }
        }
      }
    }
    
    console.log(`\n✅ Schema creation complete! ${tablesCreated} tables processed.`);
    console.log('\n📊 Verifying tables...');
    
    // List all tables
    const [tables] = await pool.execute(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
      [process.env.DB_NAME]
    );
    
    console.log(`\n📋 Tables in database '${process.env.DB_NAME}':`);
    tables.forEach((table, index) => {
      console.log(`   ${index + 1}. ${table.TABLE_NAME}`);
    });
    
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating schema:', error.message);
    console.error(error);
    if (pool) {
      await closeDB();
    }
    process.exit(1);
  }
};

createSchema();
