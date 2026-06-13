/**
 * Copy remote MySQL (RDS) admissions_db → local MySQL admissions_db (same name).
 *
 * Sample/dev copy (recommended for local):
 *   COPY_SAMPLE_ROWS=10          10 rows per table (except full tables below)
 *   COPY_FULL_TABLES=users       comma-separated tables copied fully
 *
 *   cd backend-admission
 *   $env:LOCAL_DB_PASSWORD="root"
 *   $env:COPY_SAMPLE_ROWS="10"
 *   $env:COPY_FULL_TABLES="users"
 *   npm run db:copy-remote-to-local
 *
 * Full copy (slow, large DB):
 *   $env:COPY_SAMPLE_ROWS="0"
 *   npm run db:copy-remote-to-local
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const remoteDb = process.env.DB_NAME || 'admissions_db';
const localDb = process.env.LOCAL_DB_NAME || remoteDb;
const SAMPLE_ROWS = Math.max(0, parseInt(process.env.COPY_SAMPLE_ROWS || '10', 10));
const FULL_TABLES = new Set(
  (process.env.COPY_FULL_TABLES || 'users')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
);

const CONFIG = {
  remote: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: remoteDb,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    multipleStatements: true,
    charset: process.env.DB_CHARSET || 'utf8mb4',
    jsonStrings: true,
  },
  local: {
    host: process.env.LOCAL_DB_HOST || '127.0.0.1',
    port: Number(process.env.LOCAL_DB_PORT) || 3306,
    user: process.env.LOCAL_DB_USER || 'root',
    password: process.env.LOCAL_DB_PASSWORD ?? '',
    database: localDb,
    ssl: false,
    multipleStatements: true,
    charset: process.env.DB_CHARSET || 'utf8mb4',
    jsonStrings: true,
  },
};

const BATCH = Math.min(5000, Math.max(100, parseInt(process.env.COPY_BATCH_SIZE || '500', 10)));

function normalizeCell(value) {
  if (value === undefined) return null;
  if (value === null || Buffer.isBuffer(value) || value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function stripDefiner(sql) {
  return sql.replace(/^CREATE\s+DEFINER\s*=\s*`[^`]*`@`[^`]*`\s+/i, 'CREATE ');
}

function validateConfig() {
  const missing = [];
  if (!CONFIG.remote.host) missing.push('DB_HOST');
  if (!CONFIG.remote.user) missing.push('DB_USER');
  if (!CONFIG.remote.password) missing.push('DB_PASSWORD');
  if (!CONFIG.remote.database) missing.push('DB_NAME');
  if (!CONFIG.local.user) missing.push('LOCAL_DB_USER');
  if (process.env.LOCAL_DB_PASSWORD === undefined) {
    missing.push('LOCAL_DB_PASSWORD (set it, even if empty: LOCAL_DB_PASSWORD=)');
  }
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function localServerConfig() {
  const { host, port, user, password, ssl, multipleStatements, charset } = CONFIG.local;
  return { host, port, user, password, ssl, multipleStatements, charset, jsonStrings: true };
}

async function recreateLocalDatabase() {
  const adminLocal = await mysql.createConnection(localServerConfig());
  const localDbName = CONFIG.local.database;
  await adminLocal.query(`DROP DATABASE IF EXISTS \`${localDbName.replace(/`/g, '``')}\``);
  await adminLocal.query(
    `CREATE DATABASE \`${localDbName.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await adminLocal.end();
}

async function getBaseTables(conn, schema) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [schema]
  );
  return rows.map((r) => r.name);
}

async function getInsertableColumns(conn, schema, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       AND (GENERATION_EXPRESSION IS NULL OR GENERATION_EXPRESSION = '')
     ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );
  return rows.map((r) => r.name);
}

async function getPrimaryKeyColumns(conn, schema, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );
  return rows.map((r) => r.name);
}

async function insertRows(destConn, table, insertCols, rows) {
  if (!rows.length) return 0;

  const colList = insertCols.map((c) => `\`${c.replace(/`/g, '``')}\``).join(',');
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const placeholders = chunk.map(() => `(${insertCols.map(() => '?').join(',')})`).join(',');
    const flat = chunk.flatMap((row) => insertCols.map((c) => normalizeCell(row[c])));

    try {
      await destConn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${placeholders}`, flat);
      inserted += chunk.length;
    } catch (_) {
      for (const row of chunk) {
        try {
          const values = insertCols.map((c) => normalizeCell(row[c]));
          await destConn.query(
            `INSERT INTO \`${table}\` (${colList}) VALUES (${insertCols.map(() => '?').join(',')})`,
            values
          );
          inserted += 1;
        } catch (rowErr) {
          process.stdout.write(`\n    skipped 1 row in ${table}: ${rowErr.message}\n  `);
        }
      }
    }
  }

  return inserted;
}

function orderColumn(insertCols) {
  if (insertCols.includes('created_at')) return 'created_at';
  if (insertCols.includes('updated_at')) return 'updated_at';
  return insertCols[0];
}

async function copyTable(sourceConn, destConn, schema, table, maxRows = 0) {
  const [createRows] = await sourceConn.query(`SHOW CREATE TABLE \`${table}\``);
  const createSql = stripDefiner(createRows[0]['Create Table']);
  await destConn.query(createSql);

  const insertCols = await getInsertableColumns(sourceConn, schema, table);
  if (!insertCols.length) return 0;

  const selectList = insertCols.map((c) => `\`${c.replace(/`/g, '``')}\``).join(',');
  const orderCol = orderColumn(insertCols);

  if (maxRows > 0) {
    const [rows] = await sourceConn.query(
      `SELECT ${selectList} FROM \`${table}\` ORDER BY \`${orderCol.replace(/`/g, '``')}\` DESC LIMIT ?`,
      [maxRows]
    );
    return insertRows(destConn, table, insertCols, rows);
  }

  const pkCols = await getPrimaryKeyColumns(sourceConn, schema, table);
  const orderCols = pkCols.length ? pkCols : insertCols;
  const orderBy = ` ORDER BY ${orderCols.map((c) => `\`${c.replace(/`/g, '``')}\``).join(',')}`;

  let lastKey = null;
  let total = 0;
  for (;;) {
    let chunk;
    if (pkCols.length === 1) {
      const pk = pkCols[0];
      const whereClause = lastKey === null ? '' : ` WHERE \`${pk.replace(/`/g, '``')}\` > ?`;
      const params = lastKey === null ? [BATCH] : [lastKey, BATCH];
      [chunk] = await sourceConn.query(
        `SELECT ${selectList} FROM \`${table}\`${whereClause}${orderBy} LIMIT ?`,
        params
      );
    } else {
      const [chunkFallback] = await sourceConn.query(
        `SELECT ${selectList} FROM \`${table}\`${orderBy} LIMIT ? OFFSET ?`,
        [BATCH, total]
      );
      chunk = chunkFallback;
    }

    if (!chunk.length) break;

    total += await insertRows(destConn, table, insertCols, chunk);

    if (pkCols.length === 1) {
      lastKey = chunk[chunk.length - 1][pkCols[0]];
    }
    if (chunk.length < BATCH) break;
  }

  return total;
}

function rowLimitForTable(table) {
  if (FULL_TABLES.has(table)) return 0;
  if (SAMPLE_ROWS > 0) return SAMPLE_ROWS;
  return 0;
}

async function copyDatabase() {
  const remote = CONFIG.remote;
  const localDbName = CONFIG.local.database;

  let sourceConn;
  try {
    sourceConn = await mysql.createConnection(remote);
    const destConn = await mysql.createConnection({
      ...localServerConfig(),
      database: localDbName,
    });

    const tables = await getBaseTables(sourceConn, remote.database);
    console.log(`Found ${tables.length} base tables.`);
    if (SAMPLE_ROWS > 0) {
      console.log(`Sample mode: ${SAMPLE_ROWS} rows per table; full copy for: ${[...FULL_TABLES].join(', ')}`);
    }

    await destConn.query('SET FOREIGN_KEY_CHECKS=0');
    await destConn.query('SET UNIQUE_CHECKS=0');
    await destConn.query('SET SESSION sql_mode = ""');

    for (const table of tables) {
      process.stdout.write(`  ${table} ... `);
      const maxRows = rowLimitForTable(table);
      const n = await copyTable(sourceConn, destConn, remote.database, table, maxRows);
      console.log(`${n} rows`);
    }

    await destConn.query('SET UNIQUE_CHECKS=1');
    await destConn.query('SET FOREIGN_KEY_CHECKS=1');

    await destConn.end();
    await sourceConn.end();
  } catch (e) {
    try {
      if (sourceConn) await sourceConn.end();
    } catch (_) {}
    throw e;
  }
}

async function main() {
  validateConfig();

  const remote = CONFIG.remote;
  const localDbName = CONFIG.local.database;

  console.log(`Source: ${remote.user}@${remote.host}/${remote.database} (ssl=${!!remote.ssl})`);
  console.log(`Target: ${CONFIG.local.user}@${CONFIG.local.host}/${localDbName}`);
  console.log('WARNING: This drops and recreates the LOCAL database only.');

  await recreateLocalDatabase();
  await copyDatabase();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
