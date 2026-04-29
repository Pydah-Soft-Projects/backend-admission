/**
 * Cached column sets for secondary MySQL tables (student_database).
 */

const cache = new Map();
const TTL_MS = 60_000;

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} tableName
 * @returns {Promise<Set<string>>}
 */
export async function getTableColumnSet(pool, tableName) {
  const [dbRows] = await pool.execute('SELECT DATABASE() AS d');
  const schema = dbRows[0]?.d;
  if (!schema) {
    return new Set();
  }
  const safeTable = String(tableName || '').trim();
  if (!/^[a-zA-Z0-9_]+$/.test(safeTable)) {
    return new Set();
  }
  const key = `${schema}:${safeTable}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.cols;
  }
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, safeTable]
  );
  const cols = new Set(rows.map((r) => r.COLUMN_NAME));
  cache.set(key, { cols, at: Date.now() });
  return cols;
}

export function clearSecondarySchemaCache() {
  cache.clear();
}
