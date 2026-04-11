/**
 * Copy remote MySQL (RDS) → local MySQL (mysql2 only, no mysqldump).
 *
 * Edit REMOTE / LOCAL below (passwords). Do not commit real passwords.
 * Drops and recreates LOCAL.database on your machine only. No remote changes.
 *   cd backend-admission && npm run db:copy-remote-to-local.
 */

import mysql from 'mysql2/promise';

/** @type {{ remote: object; local: { host: string; port: number; user: string; password: string; database: string } }} */
const CONFIG = {
  remote: {
    host: 'student-database.cfu0qmo26gh3.ap-south-1.rds.amazonaws.com',
    port: 3306,
    user: 'admin',
    password: 'your_password',
    database: 'admissions_db',
    ssl: { rejectUnauthorized: false },
    multipleStatements: true,
    charset: 'utf8mb4',
  },
  local: {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'your_local_password',
    database: 'admissions_db_local',
    ssl: false,
    multipleStatements: true,
    charset: 'utf8mb4',
  },
};

const BATCH = Math.min(5000, Math.max(100, parseInt(process.env.COPY_BATCH_SIZE || '500', 10)));

function stripDefiner(sql) {
  return sql.replace(/^CREATE\s+DEFINER\s*=\s*`[^`]*`@`[^`]*`\s+/i, 'CREATE ');
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

async function copyTable(sourceConn, destConn, table) {
  const [createRows] = await sourceConn.query(`SHOW CREATE TABLE \`${table}\``);
  const createSql = stripDefiner(createRows[0]['Create Table']);
  await destConn.query(createSql);

  let offset = 0;
  let total = 0;
  for (;;) {
    const [chunk] = await sourceConn.query(`SELECT * FROM \`${table}\` LIMIT ? OFFSET ?`, [BATCH, offset]);
    if (!chunk.length) break;

    const cols = Object.keys(chunk[0]);
    const colList = cols.map((c) => `\`${c.replace(/`/g, '``')}\``).join(',');
    const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const flat = chunk.flatMap((row) => cols.map((c) => row[c]));
    await destConn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${placeholders}`, flat);

    total += chunk.length;
    offset += BATCH;
    if (chunk.length < BATCH) break;
  }

  return total;
}

function localServerConfig() {
  const { host, port, user, password, ssl, multipleStatements, charset } = CONFIG.local;
  return { host, port, user, password, ssl, multipleStatements, charset };
}

async function main() {
  const remote = CONFIG.remote;
  const localDb = CONFIG.local.database;

  if (remote.password === 'your_password' || CONFIG.local.password === 'your_local_password') {
    console.error('Set CONFIG.remote.password and CONFIG.local.password in this file before running.');
    process.exit(1);
  }

  console.log(`Source: ${remote.user}@${remote.host}/${remote.database} (ssl=yes)`);
  console.log(`Target: ${CONFIG.local.user}@${CONFIG.local.host}/${localDb}`);

  let sourceConn;
  let adminLocal;
  try {
    sourceConn = await mysql.createConnection(remote);
    adminLocal = await mysql.createConnection(localServerConfig());
    await adminLocal.query(`DROP DATABASE IF EXISTS \`${localDb.replace(/`/g, '``')}\``);
    await adminLocal.query(
      `CREATE DATABASE \`${localDb.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await adminLocal.end();

    const destConn = await mysql.createConnection({
      ...localServerConfig(),
      database: localDb,
    });

    const tables = await getBaseTables(sourceConn, remote.database);
    console.log(`Found ${tables.length} base tables.`);

    await destConn.query('SET FOREIGN_KEY_CHECKS=0');
    await destConn.query('SET UNIQUE_CHECKS=0');

    for (const table of tables) {
      process.stdout.write(`  ${table} ... `);
      const n = await copyTable(sourceConn, destConn, table);
      console.log(`${n} rows`);
    }

    await destConn.query('SET UNIQUE_CHECKS=1');
    await destConn.query('SET FOREIGN_KEY_CHECKS=1');

    await destConn.end();
    await sourceConn.end();
    console.log('Done.');
  } catch (e) {
    console.error(e);
    try {
      if (sourceConn) await sourceConn.end();
    } catch (_) {}
    try {
      if (adminLocal) await adminLocal.end();
    } catch (_) {}
    process.exit(1);
  }
}

main();
