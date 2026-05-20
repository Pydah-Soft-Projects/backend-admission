import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { getTableColumnSet } from './secondarySchema.util.js';

const isMissingTableError = (err) =>
  err?.code === 'ER_NO_SUCH_TABLE' ||
  err?.errno === 1146 ||
  String(err?.sqlMessage || '').includes("doesn't exist");

const formatQuotaRow = (row) => ({
  id: String(row.id),
  name: String(row.name ?? '').trim(),
  code: String(row.code ?? '').trim(),
  sortOrder: row.sort_order != null ? Number(row.sort_order) : null,
});

/**
 * Active rows from secondary `student_database.student_quotas`.
 * @returns {Promise<Array<{ id: string, name: string, code: string, sortOrder: number|null }>>}
 */
export async function fetchActiveStudentQuotas() {
  try {
    const pool = getSecondaryPool();
    const cols = await getTableColumnSet(pool, 'student_quotas');
    if (!cols.size) return [];

    const selectCols = ['id', 'name', 'code'].filter((c) => cols.has(c));
    if (!selectCols.includes('name')) return [];

    const conditions = cols.has('is_active') ? 'WHERE is_active = 1' : '';
    const orderBy = cols.has('sort_order')
      ? 'ORDER BY sort_order ASC, name ASC'
      : 'ORDER BY name ASC';

    const [rows] = await pool.execute(
      `SELECT ${selectCols.join(', ')}${cols.has('sort_order') ? ', sort_order' : ''} FROM student_quotas ${conditions} ${orderBy}`
    );
    return rows.map(formatQuotaRow).filter((q) => q.name);
  } catch (err) {
    if (isMissingTableError(err)) return [];
    console.warn('[student_quotas] lookup failed:', err.message || err);
    return [];
  }
}

/** Display labels for dropdowns (preserves catalog sort). */
export function quotaNamesFromCatalog(quotas) {
  return (Array.isArray(quotas) ? quotas : []).map((q) => q.name).filter(Boolean);
}

/**
 * Merge secondary catalog names with legacy values already stored on leads.
 * @param {string[]} catalogNames
 * @param {string[]} legacyNames
 */
export function mergeQuotaOptionLabels(catalogNames, legacyNames) {
  const seen = new Set();
  const out = [];
  for (const name of catalogNames) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name.trim());
  }
  for (const raw of legacyNames) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
