/**
 * Idempotent migration: adds Communications template for the admission
 * confirmation SMS sent automatically when a joining is approved.
 *
 * - Does not modify or delete any existing rows.
 * - Skips entirely if template name already exists.
 * - Safe to run multiple times.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_NAME = 'Admission · confirmation on approval';

function splitSqlStatements(sql) {
  const lines = sql.split('\n');
  const withoutComments = lines.filter((l) => !/^\s*--/.test(l)).join('\n');
  const chunks = [];
  let buf = '';
  for (const ch of withoutComments) {
    buf += ch;
    if (ch === ';') {
      const t = buf.trim();
      if (t.length > 1) chunks.push(t);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

const run = async () => {
  try {
    const pool = getPool();

    const [tables] = await pool.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN ('message_templates', 'message_template_groups')`
    );
    const names = new Set((tables || []).map((r) => r.TABLE_NAME));
    if (!names.has('message_templates') || !names.has('message_template_groups')) {
      console.error('Required tables message_templates / message_template_groups not found. Skipping.');
      process.exitCode = 1;
      await closeDB();
      return;
    }

    const [existing] = await pool.execute(
      'SELECT id FROM message_templates WHERE name = ? LIMIT 1',
      [TEMPLATE_NAME]
    );
    if (existing.length > 0) {
      console.log(`✓ Template "${TEMPLATE_NAME}" already exists — nothing to do.`);
      await closeDB();
      return;
    }

    const sqlPath = path.join(
      __dirname,
      '..',
      '..',
      'sql',
      'migrations',
      '20260512_admission_confirmation_sms_template.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const statements = splitSqlStatements(sql);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      await pool.query(stmt);
    }

    console.log(`✓ Applied migration: "${TEMPLATE_NAME}".`);
  } catch (e) {
    console.error('migrateAdmissionConfirmationSmsTemplate:', e.message || e);
    process.exitCode = 1;
  } finally {
    await closeDB();
  }
};

run();
