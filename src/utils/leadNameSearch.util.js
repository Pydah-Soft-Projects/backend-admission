/**
 * Fuzzy name matching for lead search (MySQL-friendly).
 *
 * - **Short queries** (length ≤ LEAD_NAME_FUZZY_MAX_CHARS): typo expansion via
 *   single deletions + adjacent swaps, OR'd as `LOWER(name) LIKE %variant%`.
 * - **Long / full names**: a **single** `LIKE` on the typed string only. Many ORs
 *   with leading wildcards force repeated full scans and were causing multi-minute
 *   searches on large tables.
 *
 * Env: LEAD_NAME_FUZZY_MAX_CHARS (default 14), LEAD_NAME_SEARCH_MAX_VARIANTS (default 14).
 */

const FUZZY_MAX_CHARS = Number(process.env.LEAD_NAME_FUZZY_MAX_CHARS || 14);
const MAX_VARIANTS = Number(process.env.LEAD_NAME_SEARCH_MAX_VARIANTS || 14);

function adjacentSwapVariants(s) {
  const out = [];
  if (!s || s.length < 2) return out;
  const chars = [...s];
  for (let i = 0; i < chars.length - 1; i += 1) {
    const copy = [...chars];
    [copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
    out.push(copy.join(''));
  }
  return out;
}

function deleteOneCharVariants(s) {
  const out = [];
  if (!s || s.length < 2) return out;
  for (let i = 0; i < s.length; i += 1) {
    out.push(s.slice(0, i) + s.slice(i + 1));
  }
  return out;
}

/** @param {string} raw */
export function collectLeadNameSearchVariants(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!s) return [];
  const lower = s.toLowerCase();

  if (lower.length > FUZZY_MAX_CHARS) {
    return [lower];
  }

  const set = new Set([lower]);
  if (lower.length <= 22) {
    for (const v of deleteOneCharVariants(lower)) {
      if (v.length >= 1) set.add(v);
    }
    for (const v of adjacentSwapVariants(lower)) {
      set.add(v);
    }
  }
  return [...set].slice(0, MAX_VARIANTS);
}

/**
 * @param {string} columnExpr e.g. `l.name` or `name`
 * @param {string} searchTerm trimmed, length ≥ 2 (caller enforces)
 * @param {unknown[]} params
 * @returns {string | null}
 */
export function buildLeadNameFuzzySql(columnExpr, searchTerm, params) {
  const variants = collectLeadNameSearchVariants(searchTerm);
  if (variants.length === 0) return null;
  const parts = variants.map(() => `LOWER(${columnExpr}) LIKE ?`);
  variants.forEach((v) => params.push(`%${v}%`));
  return `(${parts.join(' OR ')})`;
}

/**
 * OR-group for student / father phone: raw substring + digits-only match on lightly normalized numbers
 * (spaces, dashes, parentheses, + stripped). Caller appends `values` after the enquiry `?` bind.
 *
 * @param {string} phoneColExpr e.g. `l.phone` or `phone`
 * @param {string} fatherPhoneColExpr e.g. `l.father_phone` or `father_phone`
 * @param {string} searchTerm trimmed (caller enforces min length for overall search)
 * @returns {{ sql: string, values: string[] }}
 */
export function buildLeadSearchPhoneOrSql(phoneColExpr, fatherPhoneColExpr, searchTerm) {
  const digitsOnly = String(searchTerm ?? '').replace(/\D/g, '');
  if (digitsOnly.length < 2) return { sql: '', values: [] };
  const norm = (col) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${col},''),' ',''),'-',''),'(',''),')',''),'+','')`;
  const rawLike = `%${searchTerm}%`;
  const digitsLike = `%${digitsOnly}%`;
  const values = [rawLike, rawLike, digitsLike, digitsLike];
  const sql = ` OR (${phoneColExpr} LIKE ? OR ${fatherPhoneColExpr} LIKE ? OR ${norm(phoneColExpr)} LIKE ? OR ${norm(fatherPhoneColExpr)} LIKE ?)`;
  return { sql, values };
}
