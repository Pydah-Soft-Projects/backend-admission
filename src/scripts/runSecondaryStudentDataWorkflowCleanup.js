/**
 * Runs sql/migrations/20260514_secondary_strip_workflow_from_student_data.sql on the secondary DB (.env DB_SECONDARY_*).
 *
 * Usage (from backend-admission):
 *   node src/scripts/runSecondaryStudentDataWorkflowCleanup.js
 */
import dotenv from 'dotenv';
import fs from 'fs';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sqlPath = path.join(
    __dirname,
    '../../sql/migrations/20260514_secondary_strip_workflow_from_student_data.sql'
  );
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const cleaned = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const chunks = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const conn = await mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const stmt = chunks[i];
    const [r] = await conn.execute(stmt);
    out.push({ statementIndex: i + 1, affectedRows: r.affectedRows ?? r?.changedRows ?? 0 });
  }

  await conn.end();
  console.log(JSON.stringify({ ok: true, secondary: process.env.DB_SECONDARY_NAME, results: out }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
