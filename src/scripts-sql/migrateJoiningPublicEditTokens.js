import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const run = async () => {
  let pool;
  try {
    pool = getPool();
    const [rows] = await pool.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'joining_public_edit_tokens'`
    );
    if (rows.length > 0) {
      console.log('✓ joining_public_edit_tokens already exists');
      await closeDB();
      process.exit(0);
    }
    const sqlPath = path.join(__dirname, 'migrations', '20260201_joining_public_edit_tokens.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    console.log('✓ Created table joining_public_edit_tokens');
  } catch (e) {
    console.error('migrateJoiningPublicEditTokens:', e.message || e);
    process.exitCode = 1;
  } finally {
    await closeDB();
  }
};

run();
