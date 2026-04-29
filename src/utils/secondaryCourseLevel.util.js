/**
 * Resolve academic/program level from a secondary `courses` row (column or JSON metadata).
 */

import { getTableColumnSet } from './secondarySchema.util.js';

const BASE_COURSE_COLS = [
  'id',
  'college_id',
  'name',
  'code',
  'total_years',
  'semesters_per_year',
  'year_semester_config',
  'metadata',
  'is_active',
  'created_at',
  'updated_at',
];

/**
 * Comma-separated column list for `SELECT ... FROM courses` including optional level columns.
 * @param {import('mysql2/promise').Pool} pool
 */
export async function buildCoursesSelectList(pool) {
  const cols = await getTableColumnSet(pool, 'courses');
  const extra = [];
  for (const c of ['level', 'program_level', 'course_level']) {
    if (cols.has(c)) extra.push(c);
  }
  return [...BASE_COURSE_COLS, ...extra].join(', ');
}

export function normalizeJsonObject(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    try {
      const asText = raw.toString('utf8');
      return normalizeJsonObject(asText);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} courseRow — raw row from `courses`
 * @returns {string|null}
 */
export function resolveCourseLevelFromRow(courseRow) {
  if (!courseRow) return null;
  const direct =
    courseRow.level ?? courseRow.program_level ?? courseRow.course_level ?? courseRow.student_level;
  if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
    return String(direct).trim();
  }
  const meta = normalizeJsonObject(courseRow.metadata);
  if (meta) {
    const fromMeta =
      meta.level ?? meta.program_level ?? meta.course_level ?? meta.academic_level ?? meta.student_level;
    if (fromMeta !== undefined && fromMeta !== null && String(fromMeta).trim() !== '') {
      return String(fromMeta).trim();
    }
  }
  return null;
}
