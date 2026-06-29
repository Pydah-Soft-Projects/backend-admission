import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  mapCourseLabel,
  pickSecondaryBranchDisplayLabel,
} from '../data/admissionsCourseBranchMap2026.js';

const normalize = (value) =>
  typeof value === 'string' ? value.trim() : value === undefined ? '' : String(value);

/**
 * Resolve branch label for Fee Management `feestructures` queries.
 * Prefers catalog display name (CSE) over roll code (BCSE).
 */
export async function resolveFeePortalBranchLabel({
  branchLabel = '',
  courseLabel = '',
  managedBranchId = null,
} = {}) {
  const hint = normalize(branchLabel);
  const branchId = Number.parseInt(String(managedBranchId ?? '').trim(), 10);

  try {
    const secondaryPool = getSecondaryPool();

    if (Number.isFinite(branchId)) {
      const [rows] = await secondaryPool.execute(
        'SELECT name, code FROM course_branches WHERE id = ? LIMIT 1',
        [branchId]
      );
      if (rows.length > 0) {
        const resolved = pickSecondaryBranchDisplayLabel(rows[0], hint);
        if (resolved) return resolved;
      }
    }

    if (!hint) return hint;

    const course = mapCourseLabel(courseLabel);
    const token = hint.toUpperCase();
    const params = [token, token];
    let sql = `
      SELECT cb.name, cb.code
      FROM course_branches cb
    `;
    if (course) {
      sql += `
        INNER JOIN courses c ON c.id = cb.course_id
        WHERE (UPPER(TRIM(cb.name)) = ? OR UPPER(TRIM(cb.code)) = ?)
          AND UPPER(TRIM(c.name)) = ?
      `;
      params.push(course.toUpperCase());
    } else {
      sql += ' WHERE UPPER(TRIM(cb.name)) = ? OR UPPER(TRIM(cb.code)) = ?';
    }
    sql += ' ORDER BY cb.is_active DESC, cb.id ASC LIMIT 1';

    const [rows] = await secondaryPool.execute(sql, params);
    if (rows.length > 0) {
      const resolved = pickSecondaryBranchDisplayLabel(rows[0], hint);
      if (resolved) return resolved;
    }
  } catch (err) {
    console.warn('[feePortalBranchLabel] lookup failed:', err?.message || err);
  }

  return hint;
}
