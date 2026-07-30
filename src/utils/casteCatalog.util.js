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

/**
 * Coerce Settings / castes ids to a DB-friendly value (number when numeric).
 * @param {string|number|null|undefined} value
 * @returns {number|string|null}
 */
function toSecondaryId(value) {
  if (value == null || String(value).trim() === '') return null;
  const trimmed = String(value).trim();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && String(asNum) === trimmed) return asNum;
  return trimmed;
}

/**
 * Build lead_data._joiningReservation sidecar from a reservation payload.
 * categoryId / casteId are Settings DB ids (category required for sync; nested caste optional).
 */
export function buildJoiningReservationMeta(reservation = {}) {
  const categoryId =
    reservation?.categoryId != null && String(reservation.categoryId).trim() !== ''
      ? String(reservation.categoryId).trim()
      : null;
  const casteId =
    reservation?.casteId != null && String(reservation.casteId).trim() !== ''
      ? String(reservation.casteId).trim()
      : null;
  if (!categoryId && !casteId) return null;
  return { categoryId, casteId };
}

/**
 * Resolve students.caste / category_id / caste_id per shared RDS write contract:
 *   caste        = category name string (caste_categories.name)
 *   category_id  = caste_categories.id for that name
 *   caste_id     = castes.id if nested caste chosen, else NULL
 * Never invent free-text categories. Never put a category id in caste_id.
 *
 * @param {{ general?: string|null, categoryId?: string|number|null, casteId?: string|number|null }} input
 * @returns {Promise<{ caste: string|null, categoryId: number|string|null, casteId: number|string|null }>}
 */
export async function resolveSecondaryStudentCasteFields(input = {}) {
  const general = String(input.general ?? '').trim();
  const explicitCategoryId =
    input.categoryId != null && String(input.categoryId).trim() !== ''
      ? String(input.categoryId).trim()
      : '';
  const explicitCasteId =
    input.casteId != null && String(input.casteId).trim() !== ''
      ? String(input.casteId).trim()
      : '';

  const [categories, castes] = await Promise.all([
    fetchActiveCasteCategories(),
    fetchActiveCastes(),
  ]);

  const findCategoryById = (id) =>
    categories.find((c) => String(c.id) === String(id || ''));
  const findCategoryByName = (name) => {
    const key = normalizeCasteKey(name);
    if (!key) return null;
    return categories.find((c) => normalizeCasteKey(c.name) === key) || null;
  };
  const findCasteById = (id) => castes.find((c) => String(c.id) === String(id || ''));
  const findCasteByName = (name, categoryId) => {
    const key = normalizeCasteKey(name);
    if (!key) return null;
    const scoped = categoryId
      ? castes.filter((c) => String(c.categoryId) === String(categoryId))
      : castes;
    return scoped.find((c) => normalizeCasteKey(c.name) === key) || null;
  };

  let category = explicitCategoryId ? findCategoryById(explicitCategoryId) : null;

  // Prefer category-name match on reservation.general (students.caste must be category).
  if (!category && general) {
    category = findCategoryByName(general);
  }

  // Legacy: general held a nested caste name — map to parent category.
  let legacyNestedCaste = null;
  if (!category && general) {
    legacyNestedCaste = findCasteByName(general);
    if (legacyNestedCaste?.categoryId) {
      category = findCategoryById(legacyNestedCaste.categoryId);
    }
  }

  let nestedCaste = explicitCasteId ? findCasteById(explicitCasteId) : null;

  // Never treat a category id as caste_id.
  if (nestedCaste && findCategoryById(explicitCasteId)) {
    nestedCaste = null;
  }

  // Legacy repair: only when general was a nested caste (not a category name).
  if (!nestedCaste && legacyNestedCaste && category) {
    if (normalizeCasteKey(legacyNestedCaste.name) !== normalizeCasteKey(category.name)) {
      nestedCaste = legacyNestedCaste;
    }
  }

  // Reject nested caste that mirrors the category name (BC-A → BC-A row).
  if (nestedCaste && category) {
    if (normalizeCasteKey(nestedCaste.name) === normalizeCasteKey(category.name)) {
      nestedCaste = null;
    }
  }

  // Reject nested caste under a different category than the resolved one.
  if (nestedCaste && category && nestedCaste.categoryId) {
    if (String(nestedCaste.categoryId) !== String(category.id)) {
      nestedCaste = null;
    }
  }

  // If caste resolves a category we didn't have yet, adopt its parent.
  if (!category && nestedCaste?.categoryId) {
    category = findCategoryById(nestedCaste.categoryId);
  }

  const casteName = category?.name ? String(category.name).trim() : null;

  return {
    caste: casteName || null,
    categoryId: category?.id != null ? toSecondaryId(category.id) : null,
    casteId: nestedCaste?.id != null ? toSecondaryId(nestedCaste.id) : null,
  };
}
