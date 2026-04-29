/**
 * Inspect student_database (DB_SECONDARY_*) for tables that may hold registration / form definitions.
 *
 * Usage (from backend-admission folder):
 *   node src/scripts-sql/analyzeSecondaryRegistrationForms.js
 *
 * Loads .env from project root (same as server). Does not modify the database.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const host = process.env.DB_SECONDARY_HOST;
const port = Number(process.env.DB_SECONDARY_PORT || 3306);
const user = process.env.DB_SECONDARY_USER;
const password = process.env.DB_SECONDARY_PASSWORD;
const database = process.env.DB_SECONDARY_NAME;
const ssl = process.env.DB_SECONDARY_SSL === 'true';

const FORM_HINT = /(form|registration|enquiry|field|template|dynamic|application|admission)/i;

async function main() {
  console.log('=== Secondary DB registration / form analysis ===\n');
  console.log(`Host: ${host || '(missing)'}`);
  console.log(`Database: ${database || '(missing)'}`);
  console.log(`User: ${user || '(missing)'}`);
  console.log('');

  if (!host || !database || !user) {
    console.error('Missing DB_SECONDARY_HOST, DB_SECONDARY_NAME, or DB_SECONDARY_USER in .env');
    process.exit(1);
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
  } catch (e) {
    console.error('Connection failed:', e.message);
    process.exit(1);
  }

  try {
    const [dbRow] = await conn.execute('SELECT DATABASE() AS db');
    console.log('Connected. Current database:', dbRow[0]?.db);
    console.log('');

    const [tables] = await conn.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database]
    );

    const names = tables.map((r) => r.TABLE_NAME);
    console.log(`Total tables: ${names.length}\n`);

    const standardForms = names.includes('form_builder_forms');
    const standardFields = names.includes('form_builder_fields');
    console.log('CRM-standard form tables:');
    console.log(`  form_builder_forms:  ${standardForms ? 'YES' : 'NO'}`);
    console.log(`  form_builder_fields: ${standardFields ? 'YES' : 'NO'}`);
    console.log('');

    let formsEmbeddedJson = false;
    if (names.includes('forms')) {
      const [formCols] = await conn.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'forms'`,
        [database]
      );
      const formColSet = new Set(formCols.map((r) => r.COLUMN_NAME));
      formsEmbeddedJson =
        formColSet.has('form_fields') &&
        (formColSet.has('form_id') || formColSet.has('form_name'));
      console.log('Student `forms` table with JSON `form_fields` column:');
      console.log(`  ${formsEmbeddedJson ? 'YES (API uses embedded layout; no form_builder_fields needed)' : 'NO'}`);
      console.log('');
    }

    const hinted = names.filter((n) => FORM_HINT.test(n));
    console.log('Tables whose names suggest forms / registration (pattern /form|registration|enquiry|field|template|dynamic|application|admission/i):');
    if (hinted.length === 0) {
      console.log('  (none)');
    } else {
      hinted.forEach((t) => console.log(`  - ${t}`));
    }
    console.log('');

    for (const table of hinted.slice(0, 25)) {
      const [cols] = await conn.execute(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [database, table]
      );
      console.log(`--- ${table} (${cols.length} columns) ---`);
      const colNames = cols.map((c) => c.COLUMN_NAME).join(', ');
      console.log(colNames);
      if (/^[a-zA-Z0-9_]+$/.test(table)) {
        try {
          const [cnt] = await conn.execute(`SELECT COUNT(*) AS c FROM \`${table}\``);
          console.log(`Row count: ${cnt[0]?.c ?? '?'}`);
        } catch {
          console.log('Row count: (could not read)');
        }
      } else {
        console.log('Row count: (skipped — non-alphanumeric table name)');
      }
      console.log('');
    }

    console.log('=== Suggested .env (pick tables that match your schema) ===\n');
    if (formsEmbeddedJson) {
      console.log('# Joining / registration-form API reads `forms` + parses `form_fields` JSON.');
      console.log('# With REGISTRATION_FORM_SOURCE=auto, secondary is used when this table exists (before form_builder_forms).');
      console.log('# Optional explicit table:');
      console.log('# SECONDARY_REGISTRATION_FORMS_TABLE=forms');
      console.log('# SECONDARY_REGISTRATION_DEFAULT_FORM_ID=default_student_form');
      console.log('REGISTRATION_FORM_SOURCE=auto');
    } else if (standardForms && standardFields) {
      console.log('# Matches admissions CRM form builder:');
      console.log('SECONDARY_REGISTRATION_FORMS_TABLE=form_builder_forms');
      console.log('SECONDARY_REGISTRATION_FIELDS_TABLE=form_builder_fields');
      console.log('REGISTRATION_FORM_SOURCE=secondary');
    } else if (hinted.length >= 2) {
      console.log('# Review columns above; set the form header table and the line-item / field table, e.g.:');
      console.log('# SECONDARY_REGISTRATION_FORMS_TABLE=<your_forms_table>');
      console.log('# SECONDARY_REGISTRATION_FIELDS_TABLE=<your_fields_table>');
      console.log('# REGISTRATION_FORM_SOURCE=secondary');
    } else {
      console.log('# No obvious form tables on secondary. Either:');
      console.log('# 1) Create form_builder_forms + form_builder_fields on this DB (same DDL as admissions CRM), or');
      console.log('# 2) Leave REGISTRATION_FORM_SOURCE=auto (API falls back to primary admissions DB).');
    }
    console.log('');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
