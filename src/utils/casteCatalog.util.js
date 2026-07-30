import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { getTableColumnSet } from './secondarySchema.util.js';

const isMissingTableError = (err) =>
  err?.code === 'ER_NO_SUCH_TABLE' ||
  err?.errno === 1146 ||
  String(err?.sqlMessage || '').includes("doesn't exist");

export const normalizeCasteKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

const formatCategoryRow = (row) => ({
  id: String(row.id),
  name: String(row.name ?? '').trim(),
  sortOrder: row.sort_order != null ? Number(row.sort_order) : null,
});

const formatCasteRow = (row) => ({
  id: String(row.id),
  categoryId: String(row.category_id ?? ''),
  name: String(row.name ?? '').trim(),
  sortOrder: row.sort_order != null ? Number(row.sort_order) : null,
});

/**
 * Active rows from secondary `student_database.caste_categories`.
 * @returns {Promise<Array<{ id: string, name: string, sortOrder: number|null }>>}
 */
export async function fetchActiveCasteCategories() {
  try {
    const pool = getSecondaryPool();
    const cols = await getTableColumnSet(pool, 'caste_categories');
    if (!cols.size || !cols.has('name') || !cols.has('id')) return [];

    const selectCols = ['id', 'name'].filter((c) => cols.has(c));
    const conditions = cols.has('is_active') ? 'WHERE is_active = 1' : '';
    const orderBy = cols.has('sort_order')
      ? 'ORDER BY sort_order ASC, name ASC'
      : 'ORDER BY name ASC';

    const [rows] = await pool.execute(
      `SELECT ${selectCols.join(', ')}${cols.has('sort_order') ? ', sort_order' : ''}
       FROM caste_categories ${conditions} ${orderBy}`
    );
    return rows.map(formatCategoryRow).filter((c) => c.name);
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn('[caste_categories] table missing in secondary student database');
      return [];
    }
    console.warn('[caste_categories] lookup failed:', err.message || err);
    return [];
  }
}

/**
 * Active rows from secondary `student_database.castes`.
 * @param {{ categoryId?: string|number|null }} [options]
 * @returns {Promise<Array<{ id: string, categoryId: string, name: string, sortOrder: number|null }>>}
 */
export async function fetchActiveCastes(options = {}) {
  try {
    const pool = getSecondaryPool();
    const cols = await getTableColumnSet(pool, 'castes');
    if (!cols.size || !cols.has('name') || !cols.has('id')) return [];

    const selectCols = ['id', 'name']
      .concat(cols.has('category_id') ? ['category_id'] : [])
      .filter((c) => cols.has(c));

    const conditions = [];
    const params = [];
    if (cols.has('is_active')) conditions.push('c.is_active = 1');

    const categoryId = options?.categoryId;
    if (
      categoryId != null &&
      String(categoryId).trim() !== '' &&
      cols.has('category_id')
    ) {
      conditions.push('c.category_id = ?');
      params.push(String(categoryId).trim());
    }

    const catCols = await getTableColumnSet(pool, 'caste_categories');
    const canJoinCategories = catCols.size > 0 && cols.has('category_id');

    if (canJoinCategories) {
      const joinConditions = [...conditions];
      if (catCols.has('is_active')) {
        joinConditions.push('(cat.id IS NULL OR cat.is_active = 1)');
      }
      const joinWhere = joinConditions.length ? `WHERE ${joinConditions.join(' AND ')}` : '';
      const orderBy =
        catCols.has('sort_order') && cols.has('sort_order')
          ? 'ORDER BY COALESCE(cat.sort_order, 9999) ASC, c.sort_order ASC, c.name ASC'
          : cols.has('sort_order')
            ? 'ORDER BY c.sort_order ASC, c.name ASC'
            : 'ORDER BY c.name ASC';

      const [rows] = await pool.execute(
        `SELECT ${selectCols.map((col) => `c.\`${col}\``).join(', ')}${
          cols.has('sort_order') ? ', c.sort_order' : ''
        }
         FROM castes c
         LEFT JOIN caste_categories cat ON cat.id = c.category_id
         ${joinWhere}
         ${orderBy}`,
        params
      );
      return rows.map(formatCasteRow).filter((c) => c.name);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = cols.has('sort_order')
      ? 'ORDER BY c.sort_order ASC, c.name ASC'
      : 'ORDER BY c.name ASC';
    const [rows] = await pool.execute(
      `SELECT ${selectCols.map((col) => `c.\`${col}\``).join(', ')}${
        cols.has('sort_order') ? ', c.sort_order' : ''
      }
       FROM castes c
       ${where}
       ${orderBy}`,
      params
    );
    return rows.map(formatCasteRow).filter((c) => c.name);
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn('[castes] table missing in secondary student database');
      return [];
    }
    console.warn('[castes] lookup failed:', err.message || err);
    return [];
  }
}

/**
 * Catalog for joining form dropdowns — always from secondary student_database.
 * Never injects hardcoded/random defaults.
 */
export async function fetchCasteCatalogForJoining() {
  const [categories, castes] = await Promise.all([
    fetchActiveCasteCategories(),
    fetchActiveCastes(),
  ]);

  return {
    categories,
    castes,
    source: 'secondary',
  };
}
