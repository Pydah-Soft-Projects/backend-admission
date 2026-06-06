import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { v4 as uuidv4 } from 'uuid';
import { hydrateUserRowsFromHrms } from './user.controller.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';
import { syncToSecondaryDatabase, warnIfSecondaryStudentSyncMissed } from '../utils/studentSync.util.js';
import { updatePerformanceMetric } from '../services/userPerformance.service.js';
import smsService from '../services/sms.service.js';
import ExcelJS from 'exceljs';
import {
  FATHER_PHOTO_REG_KEYS,
  MOTHER_PHOTO_REG_KEYS,
} from '../utils/joiningParentPhotos.util.js';
import {
  formatBtechCourseDisplayName,
  isBtechCourseName,
  resolveBtechCourseDisplayName,
  SQL_A_BTECH_LATERAL_TRACK,
  SQL_BTECH_LATERAL_TRACK,
  SQL_COURSE_DISPLAY_NAME,
} from '../utils/lateralBatch.util.js';
import { resolveSecondaryManagedIds } from '../data/admissionsCourseBranchMap2026.js';
import {
  readReference1FromDynamicFields,
  resolveAdmissionReference1,
  renameReferenceNameGlobally,
  hideReferenceNameFromPicker,
  clearReferenceNameGlobally,
  getReferenceNameUsage,
} from '../utils/joiningReference.util.js';

const normCourseBranchLabel = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s._\-/&,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ensureLeadId = (leadId) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    const error = new Error('Invalid lead identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ensureAdmissionId = (admissionId) => {
  if (!admissionId || typeof admissionId !== 'string' || admissionId.length !== 36) {
    const error = new Error('Invalid admission identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ADMISSION_CANCELLED_STATUS = 'Admission Cancelled';

/** In-memory caches for admission desk reads (stats labels, intake map, list counts). */
const admissionQueryCache = new Map();
const ADMISSION_CACHE_TTL = {
  statsAuxMs: Number(process.env.ADMISSION_STATS_AUX_CACHE_MS || 120000),
  collegeCoursesMs: Number(process.env.ADMISSION_COLLEGE_COURSES_CACHE_MS || 300000),
  listCountMs: Number(process.env.ADMISSION_LIST_COUNT_CACHE_MS || 15000),
};

const stableStringify = (value) => {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const getAdmissionCached = (key) => {
  const entry = admissionQueryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    admissionQueryCache.delete(key);
    return null;
  }
  return entry.value;
};

const setAdmissionCached = (key, value, ttlMs) => {
  admissionQueryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const clearAdmissionQueryCache = () => {
  admissionQueryCache.clear();
};

const getAdmissionCachedCount = async (pool, sql, params, ttlMs, scopeKey) => {
  const key = `admission-count:${scopeKey}:${sql}:${stableStringify(params)}`;
  const cached = getAdmissionCached(key);
  if (cached !== null) return cached;
  const [rows] = await pool.execute(sql, params);
  const raw = rows?.[0]?.total ?? 0;
  const count = typeof raw === 'bigint' ? Number(raw) : Number(raw || 0);
  setAdmissionCached(key, count, ttlMs);
  return count;
};

/** Convenor quota (CQ / CONV) — matches admissions.quota and lead source labels. */
const SQL_IS_CONV_QUOTA = `(
  UPPER(TRIM(COALESCE(quota, ''))) IN ('CONV', 'CONVENOR', 'CONVENER')
  OR UPPER(TRIM(COALESCE(quota, ''))) LIKE '%CONV%'
  OR (
    UPPER(TRIM(COALESCE(quota, ''))) LIKE '%LATERAL%ENTRY%'
    OR UPPER(TRIM(COALESCE(quota, ''))) = 'LATERAL ENTRY'
  )
)`;
/** Management quota (MQ / MANG). */
const SQL_IS_MANG_QUOTA = `(
  UPPER(TRIM(COALESCE(quota, ''))) IN ('MANG', 'MANAGEMENT')
  OR (UPPER(TRIM(COALESCE(quota, ''))) LIKE '%MANG%' AND UPPER(TRIM(COALESCE(quota, ''))) NOT LIKE '%CONV%')
  OR (
    UPPER(TRIM(COALESCE(quota, ''))) LIKE '%LATERAL%SPOT%'
    OR UPPER(TRIM(COALESCE(quota, ''))) = 'LATERAL SPOT'
  )
)`;
const SQL_IS_ACTIVE_ADMISSION = `status != '${ADMISSION_CANCELLED_STATUS}'`;
const SQL_IS_CANCELLED_ADMISSION = `status = '${ADMISSION_CANCELLED_STATUS}'`;
/** Spot quota (excludes lateral-spot, which is counted under management). */
const SQL_IS_SPOT_QUOTA = `(
  UPPER(TRIM(COALESCE(quota, ''))) IN ('SPOT')
  OR UPPER(TRIM(COALESCE(quota, ''))) = 'SPOT ADMISSION'
  OR (
    UPPER(TRIM(COALESCE(quota, ''))) LIKE '%SPOT%'
    AND UPPER(TRIM(COALESCE(quota, ''))) NOT LIKE '%LATERAL%'
    AND UPPER(TRIM(COALESCE(quota, ''))) NOT LIKE '%MANG%'
    AND UPPER(TRIM(COALESCE(quota, ''))) NOT LIKE '%CONV%'
  )
)`;
/** Qualification Merit Yes/No from joining form (`qualification_merit`: 1 = Yes, 0 = No). */
const SQL_IS_MERIT_YES = 'qualification_merit = 1';
const SQL_IS_MERIT_NO = 'qualification_merit = 0';

const parseBranchMetadataObject = (metadata) => {
  if (!metadata) return null;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof metadata === 'object' ? metadata : null;
};

const readIntakeFromMetadata = (metadata, kind) => {
  const meta = parseBranchMetadataObject(metadata);
  if (!meta) return null;
  const keys =
    kind === 'cq'
      ? ['cq_intake', 'cqIntake', 'convenor_intake', 'conv_intake', 'CONV_intake']
      : ['mq_intake', 'mqIntake', 'management_intake', 'mang_intake', 'MANG_intake'];
  for (const key of keys) {
    const raw = meta[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
};

const branchIntakeMapKey = (courseId, branchId) =>
  `${String(courseId ?? '').trim()}::${String(branchId ?? '').trim()}`;

const parseIntakeInput = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
};

let admissionBranchIntakeTableReady = false;

const ensureAdmissionBranchIntakeTable = async (pool) => {
  if (admissionBranchIntakeTableReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admission_branch_intake (
      id CHAR(36) PRIMARY KEY,
      course_id VARCHAR(64) NOT NULL DEFAULT '',
      branch_id VARCHAR(64) NOT NULL DEFAULT '',
      course_name VARCHAR(255) NOT NULL DEFAULT '',
      branch_name VARCHAR(255) NOT NULL DEFAULT '',
      cq_intake INT UNSIGNED NULL DEFAULT NULL,
      mq_intake INT UNSIGNED NULL DEFAULT NULL,
      updated_by CHAR(36) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admission_branch_intake_ids (course_id, branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  admissionBranchIntakeTableReady = true;
};

const loadBranchIntakeMap = async () => {
  const cacheKey = 'admission:branch-intake-map:v1';
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  const map = new Map();
  const pool = getPool();
  try {
    await ensureAdmissionBranchIntakeTable(pool);
    const [crmRows] = await pool.execute(
      'SELECT course_id, branch_id, cq_intake, mq_intake FROM admission_branch_intake'
    );
    for (const row of crmRows || []) {
      map.set(branchIntakeMapKey(row.course_id, row.branch_id), {
        cqIntake: row.cq_intake != null ? Number(row.cq_intake) : null,
        mqIntake: row.mq_intake != null ? Number(row.mq_intake) : null,
      });
    }
  } catch (err) {
    console.error('loadBranchIntakeMap: CRM intake table failed:', err?.message || err);
  }
  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute('SELECT id, metadata FROM course_branches');
    for (const row of rows || []) {
      const branchOnlyKey = String(row.id);
      if (map.has(branchOnlyKey)) continue;
      map.set(branchOnlyKey, {
        cqIntake: readIntakeFromMetadata(row.metadata, 'cq'),
        mqIntake: readIntakeFromMetadata(row.metadata, 'mq'),
      });
    }
  } catch (err) {
    console.error('loadBranchIntakeMap: secondary course_branches query failed:', err?.message || err);
  }
  setAdmissionCached(cacheKey, map, ADMISSION_CACHE_TTL.statsAuxMs);
  return map;
};

const resolveBranchIntakeFromMap = (map, courseId, branchId) => {
  const byCourseBranch = map.get(branchIntakeMapKey(courseId, branchId));
  if (byCourseBranch) return byCourseBranch;
  const branchOnly = map.get(String(branchId ?? '').trim());
  return branchOnly || {};
};

/** Managed (secondary student-DB) ids win over legacy primary FK columns — matches joining form + catalog. */
const SQL_A_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(a.managed_course_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.course_id AS CHAR)), ''))`;
const SQL_A_EFF_BRANCH_ID = `COALESCE(NULLIF(TRIM(CAST(a.managed_branch_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.branch_id AS CHAR)), ''))`;
const SQL_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(managed_course_id AS CHAR)), ''), NULLIF(TRIM(CAST(course_id AS CHAR)), ''))`;
const SQL_EFF_BRANCH_ID = `COALESCE(NULLIF(TRIM(CAST(managed_branch_id AS CHAR)), ''), NULLIF(TRIM(CAST(branch_id AS CHAR)), ''))`;

const effectiveAdmissionCourseBranchIds = (row) => {
  const managedCourse = normalizeManagedIdForDb(row?.managed_course_id);
  const managedBranch = normalizeManagedIdForDb(row?.managed_branch_id);
  const primaryCourse =
    row?.course_id != null && String(row.course_id).trim() !== ''
      ? String(row.course_id).trim()
      : null;
  const primaryBranch =
    row?.branch_id != null && String(row.branch_id).trim() !== ''
      ? String(row.branch_id).trim()
      : null;
  return {
    courseId: managedCourse ?? primaryCourse,
    branchId: managedBranch ?? primaryBranch,
  };
};

/** FK columns only when managed id exists in primary `courses` / `branches` (same as joining save). */
const resolvePrimaryCourseBranchFkIds = async (pool, courseId, branchId) => {
  let fkCourseId = null;
  let fkBranchId = null;
  if (courseId != null && String(courseId).trim() !== '') {
    const [pc] = await pool.execute('SELECT id FROM courses WHERE id = ?', [courseId]);
    if (pc.length > 0) fkCourseId = pc[0].id;
  }
  if (branchId != null && String(branchId).trim() !== '') {
    const [pb] = await pool.execute('SELECT id FROM branches WHERE id = ?', [branchId]);
    if (pb.length > 0) fkBranchId = pb[0].id;
  }
  return { fkCourseId, fkBranchId };
};

/** Validate managed ids against secondary DB; fill `admissions.course` / `admissions.branch` labels from catalog. */
const enrichAdmissionCourseInfoFromSecondary = async (courseInfo) => {
  if (!courseInfo || typeof courseInfo !== 'object') return courseInfo;
  const info = { ...courseInfo };
  const lockManagedIds =
    String(info.courseId ?? '').trim() !== '' || String(info.branchId ?? '').trim() !== '';
  let secondaryPool;
  try {
    secondaryPool = getSecondaryPool();
  } catch (err) {
    console.error('enrichAdmissionCourseInfoFromSecondary: secondary pool unavailable:', err?.message || err);
    return info;
  }
  let courseDoc = null;
  let branchDoc = null;

  try {
    if (info.branchId && !info.courseId) {
      const [branches] = await secondaryPool.execute(
        'SELECT id, course_id, name FROM course_branches WHERE id = ? LIMIT 1',
        [info.branchId]
      );
      if (branches.length > 0) {
        branchDoc = branches[0];
        info.courseId = branchDoc.course_id;
      }
    }

    if (info.courseId) {
      const [courses] = await secondaryPool.execute(
        'SELECT id, name FROM courses WHERE id = ? LIMIT 1',
        [info.courseId]
      );
      if (courses.length > 0) {
        courseDoc = courses[0];
        info.courseId = String(courseDoc.id);
        if (!String(info.course || '').trim()) {
          info.course = courseDoc.name || '';
        }
      }
    }

    if (info.branchId) {
      if (!branchDoc) {
        const params = [info.branchId];
        let sql = 'SELECT id, course_id, name, code FROM course_branches WHERE id = ?';
        if (info.courseId) {
          sql += ' AND course_id = ?';
          params.push(info.courseId);
        }
        sql += ' LIMIT 1';
        const [branches] = await secondaryPool.execute(sql, params);
        if (branches.length > 0) branchDoc = branches[0];
      }
      if (branchDoc) {
        info.branchId = String(branchDoc.id);
        const catalogBranch = String(branchDoc.code || branchDoc.name || '').trim();
        if (catalogBranch) {
          info.branch = catalogBranch;
        }
        if (!info.courseId && branchDoc.course_id != null) {
          info.courseId = String(branchDoc.course_id);
        }
      }
    }

    if (courseDoc) {
      const catalogCourse = String(courseDoc.name || '').trim();
      if (catalogCourse) {
        info.course = catalogCourse;
      }
    }

    // Backfill managed ids from labels only when ids are missing (imports / legacy rows).
    // Never remap from lead `course_interested` or stale branch text when managed ids are set.
    const storedCourse = String(info.course || '').trim();
    const storedBranch = String(info.branch || '').trim();
    if (!lockManagedIds && !info.branchId && storedCourse && storedBranch) {
      const mapped = resolveSecondaryManagedIds(storedCourse, storedBranch);
      if (mapped.managedCourseId && mapped.managedBranchId) {
        info.courseId = mapped.managedCourseId;
        info.branchId = mapped.managedBranchId;
        info.course = mapped.course;
        info.branch = mapped.branch;
      } else if (info.courseId) {
        const label = normCourseBranchLabel(storedBranch);
        const [byLabel] = await secondaryPool.execute(
          `SELECT id, course_id, name, code FROM course_branches
           WHERE course_id = ?
             AND (
               UPPER(TRIM(code)) = ?
               OR UPPER(TRIM(name)) = ?
               OR UPPER(TRIM(code)) LIKE CONCAT('%', ?, '%')
             )
           ORDER BY is_active DESC, id ASC
           LIMIT 1`,
          [info.courseId, label, label, label]
        );
        if (byLabel.length > 0) {
          info.branchId = String(byLabel[0].id);
          info.branch = String(byLabel[0].code || byLabel[0].name || '').trim() || storedBranch;
        }
      }
    }
  } catch (err) {
    console.error('enrichAdmissionCourseInfoFromSecondary: lookup failed:', err?.message || err);
  }

  return info;
};

/** Sync display labels from managed ids; stale `branch` / `course` text must not override branchId. */
const reconcileAdmissionCourseInfoFromRow = async (row) => {
  const { courseId, branchId } = effectiveAdmissionCourseBranchIds(row);
  const course = String(row.course || '').trim();
  const branch = String(row.branch || '').trim();
  const base = {
    courseId,
    branchId,
    course,
    branch,
    quota: row.quota || '',
  };
  if (!course && !branch) return base;
  return enrichAdmissionCourseInfoFromSecondary(base);
};

/** Managed course ids under a secondary `colleges.id` (for admission filters). */
const loadManagedCourseIdsForCollege = async (collegeId) => {
  const id = String(collegeId ?? '').trim();
  if (!id) return null;

  const cacheKey = `admission:college-courses:${id}`;
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      'SELECT id FROM courses WHERE college_id = ?',
      [id]
    );
    const courseIds = (rows || []).map((r) => String(r.id ?? '').trim()).filter(Boolean);
    setAdmissionCached(cacheKey, courseIds, ADMISSION_CACHE_TTL.collegeCoursesMs);
    return courseIds;
  } catch (err) {
    console.error('loadManagedCourseIdsForCollege failed:', err?.message || err);
    return [];
  }
};

const appendManagedCollegeCourseFilter = (conditions, params, courseIdExpr, managedCourseIds) => {
  if (managedCourseIds === null) return;
  if (managedCourseIds.length === 0) {
    conditions.push('1 = 0');
    return;
  }
  const placeholders = managedCourseIds.map(() => '?').join(', ');
  conditions.push(`${courseIdExpr} IN (${placeholders})`);
  params.push(...managedCourseIds);
};

const loadSecondaryCourseBranchLabelMaps = async () => {
  const cacheKey = 'admission:secondary-label-maps:v1';
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  const courses = new Map();
  const branches = new Map();
  try {
    const secondaryPool = getSecondaryPool();
    const [courseRows] = await secondaryPool.execute('SELECT id, name FROM courses');
    for (const row of courseRows || []) {
      const id = String(row.id ?? '').trim();
      const name = String(row.name ?? '').trim();
      if (id && name) courses.set(id, name);
    }
    const [branchRows] = await secondaryPool.execute(
      'SELECT id, name, code FROM course_branches'
    );
    for (const row of branchRows || []) {
      const id = String(row.id ?? '').trim();
      const label = String(row.code || row.name || '').trim();
      if (id && label) branches.set(id, label);
    }
  } catch (err) {
    console.error(
      'loadSecondaryCourseBranchLabelMaps failed:',
      err?.message || err
    );
  }
  const payload = { courses, branches };
  setAdmissionCached(cacheKey, payload, ADMISSION_CACHE_TTL.statsAuxMs);
  return payload;
};

const loadAdmissionBranchIntakeLabelMap = async (pool) => {
  const cacheKey = 'admission:intake-branch-labels:v1';
  const cached = getAdmissionCached(cacheKey);
  if (cached) return cached;

  const map = new Map();
  try {
    await ensureAdmissionBranchIntakeTable(pool);
    const [rows] = await pool.execute(
      'SELECT branch_id, branch_name FROM admission_branch_intake WHERE TRIM(branch_name) != ""'
    );
    for (const row of rows || []) {
      const id = String(row.branch_id ?? '').trim();
      const name = String(row.branch_name ?? '').trim();
      if (id && name) map.set(id, name);
    }
  } catch (err) {
    console.error('loadAdmissionBranchIntakeLabelMap failed:', err?.message || err);
  }
  setAdmissionCached(cacheKey, map, ADMISSION_CACHE_TTL.statsAuxMs);
  return map;
};

const resolveStatsBranchDisplayName = (row, secondaryLabels, intakeBranchLabels) => {
  const branchId = String(row.branchId || '').trim();
  if (branchId) {
    const fromCatalog =
      secondaryLabels.branches.get(branchId) || intakeBranchLabels.get(branchId);
    if (fromCatalog) return fromCatalog;
  }
  return String(row.branchName || '').trim();
};

/** Lead-group / 2026 import labels — not secondary catalog course names. */
const GENERIC_IMPORT_COURSE_LABELS = new Set([
  'degree',
  'diploma',
  'inter',
  '10th',
  '10+2',
  'others',
  'dap-ptv',
]);

const isGenericImportCourseLabel = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return !n || GENERIC_IMPORT_COURSE_LABELS.has(n);
};

/** Prefer secondary `courses.name` when admission text is a generic import label (e.g. "Degree"). */
const resolveStatsCourseDisplayName = (row, secondaryLabels) => {
  const courseId = String(row.courseId || '').trim();
  const fromStored = String(row.courseName || '').trim();
  let label = fromStored;
  if (courseId) {
    const fromCatalog = secondaryLabels.courses.get(courseId);
    if (!fromCatalog) {
      label = fromStored;
    } else if (!fromStored || isGenericImportCourseLabel(fromStored)) {
      label = fromCatalog;
    } else if (/\(lateral\)/i.test(fromStored) && !/\(lateral\)/i.test(fromCatalog)) {
      label = fromStored;
    } else {
      label = fromCatalog;
    }
  }
  const lateral = Number(row.lateralTrack) === 1;
  if (isBtechCourseName(label)) {
    return formatBtechCourseDisplayName(label, lateral) || label;
  }
  return label;
};

const syncLinkedJoiningCourseInfo = async (pool, joiningId, courseInfo, userId) => {
  if (!joiningId || !courseInfo || typeof courseInfo !== 'object') return;
  const { fkCourseId, fkBranchId } = await resolvePrimaryCourseBranchFkIds(
    pool,
    courseInfo.courseId,
    courseInfo.branchId
  );
  await pool.execute(
    `UPDATE joinings SET
      course_id = ?,
      branch_id = ?,
      managed_course_id = ?,
      managed_branch_id = ?,
      course = ?,
      branch = ?,
      quota = COALESCE(?, quota),
      updated_by = ?,
      updated_at = NOW()
    WHERE id = ?`,
    [
      fkCourseId,
      fkBranchId,
      normalizeManagedIdForDb(courseInfo.courseId),
      normalizeManagedIdForDb(courseInfo.branchId),
      courseInfo.course || '',
      courseInfo.branch || '',
      courseInfo.quota !== undefined ? courseInfo.quota || '' : null,
      userId || null,
      joiningId,
    ]
  );
};

/** Dedicated UPDATE for managed course/branch — never skipped by the generic dynamic UPDATE guard. */
export const persistAdmissionCourseBranchUpdate = async (
  pool,
  admissionId,
  courseInfo,
  userId,
  joiningId = null
) => {
  const courseFields = [];
  const courseParams = [];
  await applyAdmissionCourseInfoUpdates(pool, courseInfo, courseFields, courseParams);
  if (courseFields.length === 0) return;
  courseFields.push('updated_by = ?', 'updated_at = NOW()');
  courseParams.push(userId || null, admissionId);
  await pool.execute(
    `UPDATE admissions SET ${courseFields.join(', ')} WHERE id = ?`,
    courseParams
  );
  await persistAdmissionManagedIdsInLeadData(pool, admissionId, courseInfo);
  if (joiningId) {
    await syncLinkedJoiningCourseInfo(pool, joiningId, courseInfo, userId);
  }
};

const resolveAdmissionRowByRouteParam = async (pool, paramId) => {
  const [byLead] = await pool.execute('SELECT * FROM admissions WHERE lead_id = ? LIMIT 1', [paramId]);
  if (byLead.length > 0) return byLead[0];
  const [byJoining] = await pool.execute(
    'SELECT * FROM admissions WHERE joining_id = ? ORDER BY updated_at DESC LIMIT 1',
    [paramId]
  );
  if (byJoining.length > 0) return byJoining[0];
  const [byId] = await pool.execute('SELECT * FROM admissions WHERE id = ? LIMIT 1', [paramId]);
  return byId[0] || null;
};

/** Valid JSON object for lead_data on admissions (alias `a`). */
const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
/** Excel / student Reference 1 from lead_data. */
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
/** Joining / lead fallbacks for reports (requires LEFT JOIN j, l on admissions queries). */
const SQL_J_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA_JSON}, '$.reference1'))), '')`;
const SQL_L_DYNAMIC_JSON = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_L_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_L_DYNAMIC_JSON}, '$.reference1'))), '')`;
/** Resolved Reference 1 for an admission row (admission → joining → CRM lead). */
const SQL_A_EFFECTIVE_REFERENCE1 = `COALESCE(${SQL_A_REFERENCE1}, ${SQL_J_REFERENCE1}, ${SQL_L_REFERENCE1})`;
const SQL_ADMISSION_PIVOT_JOINS = `LEFT JOIN joinings j ON j.id = a.joining_id LEFT JOIN leads l ON l.id = a.lead_id`;
/** Business admission date; falls back to record created_at when not set. */
const SQL_A_EFFECTIVE_ADMISSION_DATE = `COALESCE(a.admission_date, a.created_at)`;

const normalizeManagedIdForDb = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

const parseAdmissionLeadData = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
};

/**
 * Persist Excel "Reference 1" on admission + linked joining + CRM lead (same as import script).
 * Stored at lead_data.reference1 (admissions/joinings) and dynamic_fields.reference1 (leads).
 */
export const persistAdmissionReference1 = async (pool, admissionId, reference1, userId) => {
  const ref = String(reference1 ?? '').trim();
  const [admRows] = await pool.execute(
    'SELECT id, lead_id, joining_id FROM admissions WHERE id = ? LIMIT 1',
    [admissionId]
  );
  if (!admRows.length) {
    const err = new Error('Admission record not found');
    err.statusCode = 404;
    throw err;
  }
  const row = admRows[0];

  await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_by = ?,
       updated_at = NOW()
     WHERE id = ?`,
    [ref, userId, admissionId]
  );

  if (row.joining_id) {
    await pool.execute(
      `UPDATE joinings SET
         lead_data = JSON_SET(
           COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
           '$.reference1', ?
         ),
         updated_by = ?,
         updated_at = NOW()
       WHERE id = ?`,
      [ref, userId, row.joining_id]
    );
  }

  if (row.lead_id) {
    await pool.execute(
      `UPDATE leads SET
         dynamic_fields = JSON_SET(
           COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
           '$.reference1', ?
         ),
         updated_at = NOW()
       WHERE id = ?`,
      [ref, row.lead_id]
    );
  }
};

const qualificationMeritFromSql = (value) => {
  if (value === 1 || value === true) return true;
  return false;
};

const qualificationMeritToSql = (merit) => {
  if (merit === true) return 1;
  return 0;
};

function pickFromRegistrationFormData(registrationFormData, keys) {
  if (!registrationFormData || typeof registrationFormData !== 'object') return '';
  const want = new Set(keys.map((k) => String(k).toLowerCase()));
  for (const [k, v] of Object.entries(registrationFormData)) {
    if (!want.has(String(k).toLowerCase())) continue;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

const parseLeadDynamicFieldsColumn = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
};

// Helper function to format lead data from SQL
const formatLead = (leadData) => {
  if (!leadData) return null;
  const dynamicFields = parseLeadDynamicFieldsColumn(leadData.dynamic_fields);
  const reference1 = readReference1FromDynamicFields(dynamicFields);
  return {
    _id: leadData.id,
    id: leadData.id,
    enquiryNumber: leadData.enquiry_number,
    name: leadData.name,
    phone: leadData.phone,
    fatherName: leadData.father_name,
    fatherPhone: leadData.father_phone,
    leadStatus: leadData.lead_status,
    admissionNumber: leadData.admission_number,
    dynamicFields,
    ...(reference1 ? { reference1 } : {}),
  };
};

// Helper function to format admission data from SQL (exported for one-off resync scripts)
export const formatAdmission = async (admissionData, pool) => {
  if (!admissionData) return null;

  const admissionId = admissionData.id;

  // Fetch related data in parallel (detail view).
  const [relativesResult, educationHistoryResult, siblingsResult] = await Promise.all([
    pool.execute('SELECT * FROM admission_relatives WHERE admission_id = ?', [admissionId]),
    pool.execute(
      'SELECT * FROM admission_education_history WHERE admission_id = ? ORDER BY created_at ASC',
      [admissionId]
    ),
    pool.execute(
      'SELECT * FROM admission_siblings WHERE admission_id = ? ORDER BY created_at ASC',
      [admissionId]
    ),
  ]);
  const relatives = relativesResult[0];
  const educationHistory = educationHistoryResult[0];
  const siblings = siblingsResult[0];

  // Parse JSON fields
  const leadDataRaw = typeof admissionData.lead_data === 'string'
    ? JSON.parse(admissionData.lead_data)
    : admissionData.lead_data || {};
  let registrationFormData =
    leadDataRaw &&
    typeof leadDataRaw === 'object' &&
    leadDataRaw._joiningRegistrationExtras &&
    typeof leadDataRaw._joiningRegistrationExtras === 'object'
      ? { ...leadDataRaw._joiningRegistrationExtras }
      : {};
  const leadData =
    leadDataRaw && typeof leadDataRaw === 'object'
      ? (() => {
          const {
            _joiningRegistrationExtras,
            _joiningProgramLevel,
            _joiningManagedCourseId,
            _joiningManagedBranchId,
            ...rest
          } = leadDataRaw;
          return rest;
        })()
      : leadDataRaw;

  const fromRegFatherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    FATHER_PHOTO_REG_KEYS
  );
  const fromRegMotherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    MOTHER_PHOTO_REG_KEYS
  );
  const colFatherPhoto = String(admissionData.father_photo || '').trim();
  const colMotherPhoto = String(admissionData.mother_photo || '').trim();
  const fatherPortrait = (fromRegFatherPhoto || colFatherPhoto || '').trim();
  const motherPortrait = (fromRegMotherPhoto || colMotherPhoto || '').trim();
  if (colFatherPhoto && !fromRegFatherPhoto) {
    registrationFormData = { ...registrationFormData, father_photo: colFatherPhoto };
  }
  if (colMotherPhoto && !fromRegMotherPhoto) {
    registrationFormData = { ...registrationFormData, mother_photo: colMotherPhoto };
  }

  const reservationOther = typeof admissionData.reservation_other === 'string'
    ? JSON.parse(admissionData.reservation_other)
    : admissionData.reservation_other || [];

  const qualificationMediums = typeof admissionData.qualification_mediums === 'string'
    ? JSON.parse(admissionData.qualification_mediums)
    : admissionData.qualification_mediums || [];

  const referenceName = await resolveAdmissionReference1(pool, {
    leadDataRaw,
    joiningId: admissionData.joining_id,
    leadId: admissionData.lead_id,
  });
  const leadDataWithReference =
    referenceName && leadData && typeof leadData === 'object' && !String(leadData.reference1 ?? '').trim()
      ? { ...leadData, reference1: referenceName }
      : leadData;

  return {
    _id: admissionData.id,
    id: admissionData.id,
    leadId: admissionData.lead_id,
    enquiryNumber: admissionData.enquiry_number,
    referenceName,
    leadData: leadDataWithReference,
    registrationFormData,
    joiningId: admissionData.joining_id,
    admissionNumber: admissionData.admission_number,
    status: admissionData.status,
    admissionDate: admissionData.admission_date,
    courseInfo: await (async () => {
      const reconciled = await reconcileAdmissionCourseInfoFromRow(admissionData);
      return {
        courseId: reconciled.courseId,
        branchId: reconciled.branchId,
        course: resolveBtechCourseDisplayName(
          reconciled.course || admissionData.course || '',
          registrationFormData,
          admissionData.admission_number
        ),
        branch: reconciled.branch || admissionData.branch || '',
        quota: reconciled.quota || admissionData.quota || '',
      };
    })(),
    paymentSummary: {
      totalFee: Number(admissionData.payment_total_fee) || 0,
      totalPaid: Number(admissionData.payment_total_paid) || 0,
      balance: Number(admissionData.payment_balance) || 0,
      currency: admissionData.payment_currency || 'INR',
      status: admissionData.payment_status || 'not_started',
      lastPaymentAt: admissionData.payment_last_payment_at,
    },
    studentInfo: {
      name: admissionData.student_name || '',
      phone: admissionData.student_phone || '',
      preferredMobileNumber: admissionData.preferred_mobile_number || '',
      gender: admissionData.student_gender || '',
      dateOfBirth: admissionData.student_date_of_birth || '',
      notes: admissionData.student_notes || '',
      aadhaarNumber: admissionData.student_aadhaar_number || '',
    },
    parents: {
      father: {
        name: admissionData.father_name || '',
        phone: admissionData.father_phone || '',
        aadhaarNumber: admissionData.father_aadhaar_number || '',
        photo: fatherPortrait,
      },
      mother: {
        name: admissionData.mother_name || '',
        phone: admissionData.mother_phone || '',
        aadhaarNumber: admissionData.mother_aadhaar_number || '',
        photo: motherPortrait,
      },
    },
    reservation: {
      general: admissionData.reservation_general || 'oc',
      isEws: admissionData.reservation_is_ews === 1 || admissionData.reservation_is_ews === true,
      other: reservationOther,
    },
    address: {
      communication: {
        doorOrStreet: admissionData.address_door_street || '',
        landmark: admissionData.address_landmark || '',
        villageOrCity: admissionData.address_village_city || '',
        mandal: admissionData.address_mandal || '',
        district: admissionData.address_district || '',
        pinCode: admissionData.address_pin_code || '',
      },
      relatives: relatives.map((rel) => ({
        name: rel.name || '',
        relationship: rel.relationship || '',
        doorOrStreet: rel.door_street || '',
        landmark: rel.landmark || '',
        villageOrCity: rel.village_city || '',
        mandal: rel.mandal || '',
        district: rel.district || '',
        pinCode: rel.pin_code || '',
      })),
    },
    qualifications: {
      ssc: admissionData.qualification_ssc === 1 || admissionData.qualification_ssc === true,
      interOrDiploma: admissionData.qualification_inter_diploma === 1 || admissionData.qualification_inter_diploma === true,
      ug: admissionData.qualification_ug === 1 || admissionData.qualification_ug === true,
      merit: qualificationMeritFromSql(admissionData.qualification_merit),
      mediums: qualificationMediums,
      otherMediumLabel: admissionData.qualification_other_medium_label || '',
    },
    educationHistory: educationHistory.map((edu) => ({
      level: edu.level,
      otherLevelLabel: edu.other_level_label || '',
      courseOrBranch: edu.course_or_branch || '',
      yearOfPassing: edu.year_of_passing || '',
      institutionName: edu.institution_name || '',
      institutionAddress: edu.institution_address || '',
      hallTicketNumber: edu.hall_ticket_number || '',
      totalMarksOrGrade: edu.total_marks_or_grade || '',
      cetRank: edu.cet_rank || '',
    })),
    siblings: siblings.map((sib) => ({
      name: sib.name || '',
      relation: sib.relation || '',
      studyingStandard: sib.studying_standard || '',
      institutionName: sib.institution_name || '',
    })),
    documents: {
      ssc: admissionData.document_ssc || 'pending',
      inter: admissionData.document_inter || 'pending',
      ugPgCmm: admissionData.document_ug_pg_cmm || 'pending',
      transferCertificate: admissionData.document_transfer_certificate || 'pending',
      studyCertificate: admissionData.document_study_certificate || 'pending',
      aadhaarCard: admissionData.document_aadhaar_card || 'pending',
      photos: admissionData.document_photos || 'pending',
      incomeCertificate: admissionData.document_income_certificate || 'pending',
      casteCertificate: admissionData.document_caste_certificate || 'pending',
      cetRankCard: admissionData.document_cet_rank_card || 'pending',
      cetHallTicket: admissionData.document_cet_hall_ticket || 'pending',
      allotmentLetter: admissionData.document_allotment_letter || 'pending',
      joiningReport: admissionData.document_joining_report || 'pending',
      bankPassbook: admissionData.document_bank_passbook || 'pending',
      rationCard: admissionData.document_ration_card || 'pending',
    },
    createdBy: admissionData.created_by,
    updatedBy: admissionData.updated_by,
    createdAt: admissionData.created_at,
    updatedAt: admissionData.updated_at,
  };
};

const validateAdmissionPayload = (payload = {}) => {
  const errors = [];
  if (!payload.studentInfo?.name) {
    errors.push('Student name is required');
  }
  if (!payload.reservation?.general) {
    errors.push('General reservation category is required');
  }
  if (payload.courseInfo !== undefined && payload.courseInfo !== null && typeof payload.courseInfo === 'object') {
    const cid = String(payload.courseInfo.courseId ?? '').trim();
    const bid = String(payload.courseInfo.branchId ?? '').trim();
    if (!cid) {
      errors.push('Managed course selection is required');
    }
    if (!bid) {
      errors.push('Managed branch selection is required');
    }
  }
  return errors;
};

async function applyAdmissionCourseInfoUpdates(pool, courseInfo, updateFields, updateParams) {
  if (!courseInfo || typeof courseInfo !== 'object') return;

  const managedCourseId = String(courseInfo.courseId ?? '').trim();
  const managedBranchId = String(courseInfo.branchId ?? '').trim();
  if (!managedCourseId || !managedBranchId) {
    const err = new Error('Managed course and branch selection are required for admission update');
    err.statusCode = 400;
    throw err;
  }

  const enriched = await enrichAdmissionCourseInfoFromSecondary({
    courseId: managedCourseId,
    branchId: managedBranchId,
    course: courseInfo.course,
    branch: courseInfo.branch,
    quota: courseInfo.quota,
  });

  const { fkCourseId, fkBranchId } = await resolvePrimaryCourseBranchFkIds(
    pool,
    enriched.courseId,
    enriched.branchId
  );

  updateFields.push('course_id = ?');
  updateParams.push(fkCourseId);
  updateFields.push('managed_course_id = ?');
  updateParams.push(normalizeManagedIdForDb(enriched.courseId));
  updateFields.push('course = ?');
  updateParams.push(enriched.course || '');

  updateFields.push('branch_id = ?');
  updateParams.push(fkBranchId);
  updateFields.push('managed_branch_id = ?');
  updateParams.push(normalizeManagedIdForDb(enriched.branchId));
  updateFields.push('branch = ?');
  updateParams.push(enriched.branch || '');

  if (enriched.quota !== undefined) {
    updateFields.push('quota = ?');
    updateParams.push(enriched.quota || '');
  }
  Object.assign(courseInfo, enriched);
}

const persistAdmissionManagedIdsInLeadData = async (pool, admissionId, courseInfo) => {
  const mc = normalizeManagedIdForDb(courseInfo?.courseId);
  const mb = normalizeManagedIdForDb(courseInfo?.branchId);
  await pool.execute(
    `UPDATE admissions SET lead_data = JSON_SET(
      COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
      '$._joiningManagedCourseId', ?,
      '$._joiningManagedBranchId', ?
    ), updated_at = NOW() WHERE id = ?`,
    [mc, mb, admissionId]
  );
};

const parseReferenceFromJsonBlob = (raw) => {
  try {
    const text =
      Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : null;
    const ld =
      text != null
        ? JSON.parse(text || '{}')
        : raw && typeof raw === 'object'
          ? raw
          : {};
    return String(ld.reference1 ?? ld.referenceName ?? '').trim();
  } catch {
    return '';
  }
};

const parseReferenceNameFromRow = (row) => {
  const direct = String(row.reference_name ?? '').trim();
  if (direct) return direct;

  const fromAdmExtracted = String(
    row.lead_data_reference1 ?? row.lead_data_reference_name ?? ''
  ).trim();
  if (fromAdmExtracted) return fromAdmExtracted;

  const fromAdm = parseReferenceFromJsonBlob(row.lead_data);
  if (fromAdm) return fromAdm;

  const fromJoinExtracted = String(
    row.joining_lead_reference1 ?? row.joining_lead_reference_name ?? ''
  ).trim();
  if (fromJoinExtracted) return fromJoinExtracted;

  const fromJoin = parseReferenceFromJsonBlob(row.joining_lead_data);
  if (fromJoin) return fromJoin;
  try {
    const rawDyn = row.lead_dynamic_fields;
    const dyn =
      Buffer.isBuffer(rawDyn)
        ? JSON.parse(rawDyn.toString('utf8') || '{}')
        : typeof rawDyn === 'string'
          ? JSON.parse(rawDyn || '{}')
          : rawDyn && typeof rawDyn === 'object'
            ? rawDyn
            : {};
    return readReference1FromDynamicFields(dyn);
  } catch {
    return '';
  }
};

const registrationExtrasFromLeadDataRaw = (leadDataRaw) => {
  if (!leadDataRaw || typeof leadDataRaw !== 'object') return {};
  const ex = leadDataRaw._joiningRegistrationExtras;
  return ex && typeof ex === 'object' ? ex : {};
};

const registrationExtrasFromListRow = (row) => {
  const raw = row.lead_data_registration_extras;
  if (!raw) return registrationExtrasFromLeadDataRaw(parseListRowLeadDataRaw(row));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
};

const parseListRowLeadDataRaw = (row) => {
  if (!row?.lead_data) return {};
  try {
    const raw = row.lead_data;
    const text =
      Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : null;
    return text != null
      ? JSON.parse(text || '{}')
      : raw && typeof raw === 'object'
        ? raw
        : {};
  } catch {
    return {};
  }
};

const leadDataStubFromListRow = (row) => {
  const fromExtract =
    row.lead_data_source != null ||
    row.lead_data_utm_source != null ||
    row.lead_data_lead_source != null;
  if (fromExtract) {
    return {
      source: row.lead_data_source,
      utmSource: row.lead_data_utm_source,
      leadSource: row.lead_data_lead_source,
    };
  }
  return parseListRowLeadDataRaw(row);
};

const isQuotaLikeLeadSource = (value) => {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return false;
  return (
    s === 'conv' ||
    s === 'convenor' ||
    s === 'convener' ||
    s === 'cq' ||
    s === 'mq' ||
    s === 'management' ||
    s === 'mang' ||
    s.includes('management quota') ||
    s.includes('convenor quota') ||
    s.includes('spot') ||
    s === 'lateral entry' ||
    s.includes('lateral')
  );
};

/** Resolved lead source for list rows and source-wise pivot (matches admissions UI). */
const normalizeAdmissionLeadSource = (row) => {
  const leadDataRaw = leadDataStubFromListRow(row);
  const raw = String(row.lead_source ?? '').trim();
  if (raw && !isQuotaLikeLeadSource(raw)) return raw;

  const fromLeadData = String(
    leadDataRaw?.source ?? leadDataRaw?.utmSource ?? leadDataRaw?.leadSource ?? ''
  ).trim();
  if (fromLeadData && !isQuotaLikeLeadSource(fromLeadData)) return fromLeadData;

  const uploadBatchId = String(row.upload_batch_id ?? '').trim();
  if (uploadBatchId) return 'Bulk Upload';

  const dynamicFields = parseLeadDynamicFieldsColumn(row.lead_dynamic_fields);
  const createdFrom = String(dynamicFields?.createdFrom ?? '').trim();
  if (createdFrom === 'self_registration') {
    return 'Self Registration';
  }
  if (createdFrom === 'send_joining_form' || createdFrom === 'joining_form_link') {
    return 'Joining Form Link';
  }

  return 'Manual Form';
};

const formatAdmissionListItem = (row) => {
  const effectiveIds = effectiveAdmissionCourseBranchIds(row);
  const courseLabel = resolveBtechCourseDisplayName(
    row.course || '',
    registrationExtrasFromListRow(row),
    row.admission_number
  );
  return {
  _id: row.id,
  id: row.id,
  leadId: row.lead_id,
  joiningId: row.joining_id,
  admissionNumber: row.admission_number,
  status: row.status,
  courseInfo: {
    ...effectiveIds,
    course: courseLabel,
    branch: row.branch || '',
    quota: row.quota || '',
  },
  studentInfo: {
    name: row.student_name || row.lead_name || '',
    phone: row.student_phone || row.lead_phone || '',
  },
  reservation: {
    general: row.reservation_general || 'oc',
    isEws: row.reservation_is_ews === 1 || row.reservation_is_ews === true,
    other: row.reservation_other ? (typeof row.reservation_other === 'string' ? JSON.parse(row.reservation_other) : row.reservation_other) : [],
  },
  qualifications: {
    merit:
      row.qualification_merit === 1 || row.qualification_merit === true
        ? true
        : row.qualification_merit === 0 || row.qualification_merit === false
          ? false
          : null,
  },
  paymentSummary: {
    totalPaid: Number(row.payment_total_paid) || 0,
  },
  documents: {
    ssc: row.document_ssc,
    inter: row.document_inter,
    ugPgCmm: row.document_ug_pg_cmm,
    transferCertificate: row.document_transfer_certificate,
    studyCertificate: row.document_study_certificate,
    aadhaarCard: row.document_aadhaar_card,
    photos: row.document_photos,
    incomeCertificate: row.document_income_certificate,
    casteCertificate: row.document_caste_certificate,
    cetRankCard: row.document_cet_rank_card,
    cetHallTicket: row.document_cet_hall_ticket,
    allotmentLetter: row.document_allotment_letter,
    joiningReport: row.document_joining_report,
    bankPassbook: row.document_bank_passbook,
    rationCard: row.document_ration_card,
  },
  leadSource: normalizeAdmissionLeadSource(row),
  referenceName: parseReferenceNameFromRow(row),
  updatedAt: row.updated_at,
  createdAt: row.created_at,
  };
};

// Helper function to save admission related tables
const saveAdmissionRelatedTables = async (pool, admissionId, payload) => {

  // Delete existing related records
  await pool.execute('DELETE FROM admission_relatives WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_education_history WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_siblings WHERE admission_id = ?', [admissionId]);

  // Insert relatives
  if (Array.isArray(payload.address?.relatives)) {
    for (const relative of payload.address.relatives) {
      const relativeId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_relatives (id, admission_id, name, relationship, door_street, landmark,
         village_city, mandal, district, pin_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          relativeId,
          admissionId,
          relative.name || '',
          relative.relationship || '',
          relative.doorOrStreet || '',
          relative.landmark || '',
          relative.villageOrCity || '',
          relative.mandal || '',
          relative.district || '',
          relative.pinCode || '',
        ]
      );
    }
  }

  // Insert education history
  if (Array.isArray(payload.educationHistory)) {
    for (const edu of payload.educationHistory) {
      const eduId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_education_history (id, admission_id, level, other_level_label,
         course_or_branch, year_of_passing, institution_name, institution_address,
         hall_ticket_number, total_marks_or_grade, cet_rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eduId,
          admissionId,
          edu.level,
          edu.otherLevelLabel || '',
          edu.courseOrBranch || '',
          edu.yearOfPassing || '',
          edu.institutionName || '',
          edu.institutionAddress || '',
          edu.hallTicketNumber || '',
          edu.totalMarksOrGrade || '',
          edu.cetRank || '',
        ]
      );
    }
  }

  // Insert siblings
  if (Array.isArray(payload.siblings)) {
    for (const sib of payload.siblings) {
      const sibId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_siblings (id, admission_id, name, relation, studying_standard,
         institution_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          sibId,
          admissionId,
          sib.name || '',
          sib.relation || '',
          sib.studyingStandard || '',
          sib.institutionName || '',
        ]
      );
    }
  }
};

export const listAdmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status,
      startDate,
      endDate,
      collegeId,
      courseId,
      branchId,
      courseName,
      branchName,
    } = req.query;

    const pool = getPool();
    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Number(page) - 1) * paginationLimit;

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Status filtering
    if (status) {
      conditions.push('a.status = ?');
      params.push(status);
    }
    const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
    appendManagedCollegeCourseFilter(
      conditions,
      params,
      SQL_A_EFF_COURSE_ID,
      collegeCourseIds
    );
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    if (startDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
      params.push(String(startDate).slice(0, 10));
    }
    if (endDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
      params.push(String(endDate).slice(0, 10));
    }

    // Search filtering
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(`(
        a.admission_number LIKE ? OR
        l.name LIKE ? OR l.phone LIKE ? OR l.hall_ticket_number LIKE ? OR l.enquiry_number LIKE ?
        OR JSON_EXTRACT(a.lead_data, "$.name") LIKE ? OR JSON_EXTRACT(a.lead_data, "$.phone") LIKE ?
        OR JSON_EXTRACT(a.lead_data, "$.hallTicketNumber") LIKE ? OR JSON_EXTRACT(a.lead_data, "$.enquiryNumber") LIKE ?
        OR a.student_name LIKE ? OR a.student_phone LIKE ?
      )`);
      params.push(
        searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern
      );
    }

    const needsLeadJoin = Boolean(search);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = needsLeadJoin
      ? 'FROM admissions a LEFT JOIN leads l ON a.lead_id = l.id'
      : 'FROM admissions a';

    // Get total count (brief cache — pagination/filter toggles hit this often).
    const total = await getAdmissionCachedCount(
      pool,
      `SELECT COUNT(*) as total ${fromClause} ${whereClause}`,
      params,
      ADMISSION_CACHE_TTL.listCountMs,
      'list-admissions'
    );

    // Phase 1: paginate ids only — no lead join unless search needs it; no wide row payload in sort.
    const [idRowsResult] = await pool.execute(
      `SELECT a.id ${fromClause} ${whereClause}
       ORDER BY a.admission_number DESC, a.updated_at DESC
       LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`,
      params
    );
    const idRows = idRowsResult;

    let admissions = [];
    if (idRows.length > 0) {
      const pageIds = idRows.map((row) => row.id);
      const inMarks = pageIds.map(() => '?').join(',');
      const orderIndex = new Map(pageIds.map((id, index) => [String(id), index]));

      // Phase 2: fetch page rows by primary key (no ORDER BY — reorder in app to avoid sort buffer).
      const [pageRows] = await pool.execute(
        `SELECT a.id, a.lead_id, a.joining_id, a.admission_number, a.status,
                a.course_id, a.branch_id, a.managed_course_id, a.managed_branch_id, a.course, a.branch, a.quota,
                a.student_name, a.student_phone, a.created_at, a.updated_at,
                a.reservation_general, a.reservation_is_ews, a.reservation_other, a.payment_total_paid,
                a.qualification_merit,
                a.document_ssc, a.document_inter, a.document_ug_pg_cmm, a.document_transfer_certificate,
                a.document_study_certificate, a.document_aadhaar_card, a.document_photos,
                a.document_income_certificate, a.document_caste_certificate, a.document_cet_rank_card,
                a.document_cet_hall_ticket, a.document_allotment_letter, a.document_joining_report,
                a.document_bank_passbook, a.document_ration_card,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.reference1')) AS lead_data_reference1,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.referenceName')) AS lead_data_reference_name,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.source')) AS lead_data_source,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.utmSource')) AS lead_data_utm_source,
                JSON_UNQUOTE(JSON_EXTRACT(a.lead_data, '$.leadSource')) AS lead_data_lead_source,
                JSON_EXTRACT(a.lead_data, '$._joiningRegistrationExtras') AS lead_data_registration_extras,
                JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.reference1')) AS joining_lead_reference1,
                JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.referenceName')) AS joining_lead_reference_name,
                l.name as lead_name, l.phone as lead_phone, l.source as lead_source,
                l.upload_batch_id as upload_batch_id,
                l.dynamic_fields as lead_dynamic_fields
         FROM admissions a
         LEFT JOIN joinings j ON j.id = a.joining_id
         LEFT JOIN leads l ON a.lead_id = l.id
         WHERE a.id IN (${inMarks})`,
        pageIds
      );
      admissions = pageRows.sort(
        (a, b) => (orderIndex.get(String(a.id)) ?? 0) - (orderIndex.get(String(b.id)) ?? 0)
      );
    }

    const formattedAdmissions = admissions.map(formatAdmissionListItem);

    return successResponse(
      res,
      {
        admissions: formattedAdmissions,
        pagination: {
          page: Number(page),
          limit: paginationLimit,
          total,
          pages: Math.ceil(total / paginationLimit) || 1,
        },
      },
      'Admissions retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing admissions:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list admissions',
      error.statusCode || 500
    );
  }
};

export const getAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number, dynamic_fields
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByJoiningId = async (req, res) => {
  try {
    const { joiningId } = req.params;
    if (!joiningId || typeof joiningId !== 'string' || joiningId.length !== 36) {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    const pool = getPool();

    // Fetch admission by joining_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE joining_id = ?',
      [joiningId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this joining', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number, dynamic_fields
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    // Fetch admission by lead_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ?',
      [leadId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead
    const [leads] = await pool.execute(
      `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number, dynamic_fields
       FROM leads WHERE id = ?`,
      [leadId]
    );

    const lead = leads.length > 0 ? formatLead(leads[0]) : null;

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const cancelAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const reason = String(req.body?.reason || '').trim();
    const approvedBy = String(req.body?.approvedBy || '').trim();

    if (!reason) {
      return errorResponse(res, 'Reason for cancellation is required', 400);
    }

    if (!approvedBy) {
      return errorResponse(res, 'Approved by is required', 400);
    }

    const pool = getPool();
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const existingLeadData = parseAdmissionLeadData(admissionData.lead_data);
    const cancellation = {
      reason,
      approvedBy,
      cancelledAt: new Date().toISOString(),
      cancelledBy: req.user.id,
    };
    const nextLeadData = {
      ...existingLeadData,
      _admissionCancellation: cancellation,
    };

    await pool.execute(
      `UPDATE admissions
       SET status = ?, lead_data = ?, updated_by = ?, updated_at = NOW()
       WHERE id = ?`,
      [ADMISSION_CANCELLED_STATUS, JSON.stringify(nextLeadData), req.user.id, admissionId]
    );

    if (admissionData.lead_id) {
      await pool.execute(
        `UPDATE leads
         SET application_status = ?, updated_at = NOW()
         WHERE id = ?`,
        [ADMISSION_CANCELLED_STATUS, admissionData.lead_id]
      );
    }

    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    warnIfSecondaryStudentSyncMissed(
      'cancelAdmissionById',
      { admissionId, admissionNumber: formattedAdmission.admissionNumber },
      await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
        leadId: formattedAdmission.leadId,
        joiningId: formattedAdmission.joiningId,
        email: formattedAdmission.leadData?.email || ''
      })
    );

    clearAdmissionQueryCache();

    return successResponse(
      res,
      formattedAdmission,
      'Admission cancelled successfully',
      200
    );
  } catch (error) {
    console.error('Error cancelling admission:', error);
    return errorResponse(
      res,
      error.message || 'Failed to cancel admission',
      error.statusCode || 500
    );
  }
};

/**
 * Send the DLT-approved admission confirmation SMS to the student on demand.
 *
 * Wired to "Send Admission SMS" on the admission detail page so staff can
 * (re)trigger the message for any admission that already exists in the DB —
 * including ones approved before the auto-send was wired into `approveJoining`.
 *
 * The send is fully synchronous so the UI can surface success / failure /
 * skip reasons via toast. We never throw on gateway errors; instead we return
 * a structured payload that the frontend can show to the user.
 */
export const sendAdmissionConfirmationSmsById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, status, admission_number, student_name, student_phone, lead_id, lead_data
       FROM admissions WHERE id = ?`,
      [admissionId]
    );

    if (rows.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admission = rows[0];
    if (admission.status === ADMISSION_CANCELLED_STATUS) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — admission is cancelled.',
        400
      );
    }

    const admissionNumber = String(admission.admission_number || '').trim();
    if (!admissionNumber) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — admission number is missing on this record.',
        400
      );
    }

    // Fall back to the lead row if studentInfo on the admission is sparse.
    let studentName = String(admission.student_name || '').trim();
    let studentPhone = String(admission.student_phone || '').trim();
    if ((!studentName || !studentPhone) && admission.lead_id) {
      const [leadRows] = await pool.execute(
        'SELECT name, phone FROM leads WHERE id = ? LIMIT 1',
        [admission.lead_id]
      );
      if (leadRows.length > 0) {
        if (!studentName) studentName = String(leadRows[0].name || '').trim();
        if (!studentPhone) studentPhone = String(leadRows[0].phone || '').trim();
      }
    }

    if (!studentPhone) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — student phone is not on file for this admission.',
        400
      );
    }

    const result = await smsService.sendAdmissionConfirmation(
      studentPhone,
      studentName || 'Student',
      admissionNumber
    );

    if (!result?.success) {
      const reasonMap = {
        template_not_found:
          'Confirmation SMS template is not registered. Run `npm run migrate:admission-confirmation-sms-template` and try again.',
        invalid_mobile_number: 'Cannot send confirmation SMS — student phone is not a valid 10-digit number.',
        missing_admission_number: 'Cannot send confirmation SMS — admission number is missing.',
        gateway_rejected:
          `SMS gateway rejected the request${result?.gatewayMessage ? `: ${result.gatewayMessage}` : ''}. ` +
          'Verify that DLT template id is whitelisted on the BulkSMSApps account and that sender id matches.',
      };
      const message =
        reasonMap[result?.error] ||
        `Failed to send confirmation SMS${result?.error ? `: ${result.error}` : ''}.`;
      return errorResponse(res, message, 502);
    }

    return successResponse(
      res,
      {
        sentTo: studentPhone.replace(/\D/g, '').slice(-10),
        admissionNumber,
        gateway: result.data ?? null,
      },
      'Admission confirmation SMS sent.',
      200
    );
  } catch (error) {
    console.error('Error sending admission confirmation SMS:', error);
    return errorResponse(
      res,
      error.message || 'Failed to send admission confirmation SMS',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };
    const linkedJoiningId = admissions[0].joining_id || null;

    if (payload.courseInfo !== undefined) {
      await persistAdmissionCourseBranchUpdate(
        pool,
        admissionId,
        payload.courseInfo,
        req.user?.id,
        linkedJoiningId
      );
      delete payload.courseInfo;
    }

    // Build dynamic UPDATE query
    const updateFields = [];
    const updateParams = [];

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(payload.studentInfo.dateOfBirth || '');
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
      if (payload.studentInfo.preferredMobileNumber !== undefined) {
        updateFields.push('preferred_mobile_number = ?');
        const preferred = String(payload.studentInfo.preferredMobileNumber || '')
          .replace(/\D/g, '')
          .slice(-10);
        updateParams.push(preferred.length === 10 ? preferred : '');
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
        if (payload.parents.father.photo !== undefined) {
          updateFields.push('father_photo = ?');
          const p = String(payload.parents.father.photo || '').trim();
          updateParams.push(p || null);
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
        if (payload.parents.mother.photo !== undefined) {
          updateFields.push('mother_photo = ?');
          const p = String(payload.parents.mother.photo || '').trim();
          updateParams.push(p || null);
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || 'oc');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
      if (payload.reservation.isEws !== undefined) {
        updateFields.push('reservation_is_ews = ?');
        updateParams.push(payload.reservation.isEws === true ? 1 : 0);
      }
    }

    if (payload.address?.communication !== undefined) {
      const comm = payload.address.communication;
      if (comm.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (comm.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (comm.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (comm.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (comm.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (comm.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.merit !== undefined) {
        updateFields.push('qualification_merit = ?');
        updateParams.push(qualificationMeritToSql(payload.qualifications.merit));
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    if (payload.reference1 !== undefined) {
      await persistAdmissionReference1(pool, admissionId, payload.reference1, req.user.id);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    warnIfSecondaryStudentSyncMissed(
      'updateAdmissionById',
      { admissionId, admissionNumber: formattedAdmission.admissionNumber },
      await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
        leadId: formattedAdmission.leadId,
        joiningId: formattedAdmission.joiningId,
        email: formattedAdmission.leadData?.email || ''
      })
    );

    return successResponse(
      res,
      formattedAdmission,
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    const admissionRow = await resolveAdmissionRowByRouteParam(pool, leadId);
    if (!admissionRow) {
      return errorResponse(res, 'Admission record not found for this lead or joining', 404);
    }

    const admissionId = admissionRow.id;
    const linkedJoiningId = admissionRow.joining_id || null;

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };

    if (payload.courseInfo !== undefined) {
      await persistAdmissionCourseBranchUpdate(
        pool,
        admissionId,
        payload.courseInfo,
        req.user?.id,
        linkedJoiningId
      );
      delete payload.courseInfo;
    }

    // Build dynamic UPDATE query (same as updateAdmissionById)
    const updateFields = [];
    const updateParams = [];

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(payload.studentInfo.dateOfBirth || '');
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
      if (payload.studentInfo.preferredMobileNumber !== undefined) {
        updateFields.push('preferred_mobile_number = ?');
        const preferred = String(payload.studentInfo.preferredMobileNumber || '')
          .replace(/\D/g, '')
          .slice(-10);
        updateParams.push(preferred.length === 10 ? preferred : '');
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
        if (payload.parents.father.photo !== undefined) {
          updateFields.push('father_photo = ?');
          const p = String(payload.parents.father.photo || '').trim();
          updateParams.push(p || null);
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
        if (payload.parents.mother.photo !== undefined) {
          updateFields.push('mother_photo = ?');
          const p = String(payload.parents.mother.photo || '').trim();
          updateParams.push(p || null);
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || 'oc');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
      if (payload.reservation.isEws !== undefined) {
        updateFields.push('reservation_is_ews = ?');
        updateParams.push(payload.reservation.isEws === true ? 1 : 0);
      }
    }

    if (payload.address?.communication !== undefined) {
      const comm = payload.address.communication;
      if (comm.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (comm.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (comm.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (comm.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (comm.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (comm.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.merit !== undefined) {
        updateFields.push('qualification_merit = ?');
        updateParams.push(qualificationMeritToSql(payload.qualifications.merit));
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    if (payload.reference1 !== undefined) {
      await persistAdmissionReference1(pool, admissionId, payload.reference1, req.user.id);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    warnIfSecondaryStudentSyncMissed(
      'updateAdmissionByLead',
      { leadId, admissionId, admissionNumber: formattedAdmission.admissionNumber },
      await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
        leadId: formattedAdmission.leadId,
        joiningId: formattedAdmission.joiningId,
        email: formattedAdmission.leadData?.email || ''
      })
    );

    return successResponse(
      res,
      formattedAdmission,
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Update Reference 1 only (admissions.lead_data.reference1 + joining + lead mirrors)
 * @route   PATCH /api/admissions/id/:admissionId/reference
 */
export const patchAdmissionReferenceById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    if (req.body?.reference1 === undefined) {
      return errorResponse(res, 'reference1 is required', 400);
    }

    const pool = getPool();
    await persistAdmissionReference1(pool, admissionId, req.body.reference1, req.user.id);

    const [updated] = await pool.execute('SELECT * FROM admissions WHERE id = ?', [admissionId]);
    const formattedAdmission = await formatAdmission(updated[0], pool);

    return successResponse(res, formattedAdmission, 'Reference updated successfully', 200);
  } catch (error) {
    console.error('Error updating admission reference:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update reference',
      error.statusCode || 500
    );
  }
};

export const getAdmissionStats = async (req, res) => {
  try {
    const { startDate, endDate, collegeId, courseId, branchId, courseName, branchName } =
      req.query;
    const pool = getPool();
    const conditions = [];
    const params = [];
    const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
    appendManagedCollegeCourseFilter(
      conditions,
      params,
      SQL_EFF_COURSE_ID,
      collegeCourseIds
    );
    if (startDate) {
      conditions.push('DATE(COALESCE(admission_date, created_at)) >= ?');
      params.push(String(startDate).slice(0, 10));
    }
    if (endDate) {
      conditions.push('DATE(COALESCE(admission_date, created_at)) <= ?');
      params.push(String(endDate).slice(0, 10));
    }
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_EFF_COURSE_ID} = ? OR course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_EFF_COURSE_ID} = ? OR course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_EFF_BRANCH_ID} = ? OR branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_EFF_BRANCH_ID} = ? OR branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const query = `
      SELECT 
        ${SQL_EFF_COURSE_ID} as courseId, 
        ${SQL_BTECH_LATERAL_TRACK} as lateralTrack,
        ${SQL_COURSE_DISPLAY_NAME} as courseName,
        COUNT(CASE WHEN status != 'Admission Cancelled' THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN status = 'Admission Cancelled' THEN 1 END) as totalCancelled
      FROM admissions
      ${whereClause}
      GROUP BY ${SQL_EFF_COURSE_ID}, ${SQL_BTECH_LATERAL_TRACK}
      ORDER BY totalAdmissions DESC
    `;
    const queryBranches = `
      SELECT 
        ${SQL_EFF_COURSE_ID} as courseId,
        ${SQL_EFF_BRANCH_ID} as branchId,
        ${SQL_BTECH_LATERAL_TRACK} as lateralTrack,
        ${SQL_COURSE_DISPLAY_NAME} as courseName,
        MAX(branch) as branchName,
        COUNT(CASE WHEN ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as totalCancelled,
        COUNT(CASE WHEN ${SQL_IS_CONV_QUOTA} AND ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as cqAdmitted,
        COUNT(CASE WHEN ${SQL_IS_CONV_QUOTA} AND ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as cqCancelled,
        COUNT(CASE WHEN ${SQL_IS_MANG_QUOTA} AND ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as mqAdmitted,
        COUNT(CASE WHEN ${SQL_IS_MANG_QUOTA} AND ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as mqCancelled,
        COUNT(CASE WHEN ${SQL_IS_SPOT_QUOTA} AND ${SQL_IS_ACTIVE_ADMISSION} THEN 1 END) as spotAdmitted,
        COUNT(CASE WHEN ${SQL_IS_SPOT_QUOTA} AND ${SQL_IS_CANCELLED_ADMISSION} THEN 1 END) as spotCancelled,
        COUNT(CASE WHEN ${SQL_IS_MERIT_YES} THEN 1 END) as meritYes,
        COUNT(CASE WHEN ${SQL_IS_MERIT_NO} THEN 1 END) as meritNo
      FROM admissions
      ${whereClause}
      GROUP BY ${SQL_EFF_COURSE_ID}, ${SQL_EFF_BRANCH_ID}, ${SQL_BTECH_LATERAL_TRACK}
      ORDER BY courseName, branchName
    `;

    const [statsResult, branchStatsResult, branchIntakeMap, secondaryLabels, intakeBranchLabels] =
      await Promise.all([
        pool.execute(query, params),
        pool.execute(queryBranches, params),
        loadBranchIntakeMap(),
        loadSecondaryCourseBranchLabelMaps(),
        loadAdmissionBranchIntakeLabelMap(pool),
      ]);
    const stats = statsResult[0];
    const branchStats = branchStatsResult[0];
    const courseStats = stats.map((course) => {
      const courseName = resolveStatsCourseDisplayName(course, secondaryLabels);
      return {
      ...course,
      courseName: courseName || course.courseName,
      branches: branchStats
        .filter(
          (b) =>
            b.courseId === course.courseId &&
            Number(b.lateralTrack) === Number(course.lateralTrack)
        )
        .map((b) => {
          const intake = resolveBranchIntakeFromMap(branchIntakeMap, b.courseId, b.branchId);
          const branchName = resolveStatsBranchDisplayName(
            b,
            secondaryLabels,
            intakeBranchLabels
          );
          const branchCourseName = resolveStatsCourseDisplayName(b, secondaryLabels);
          return {
            ...b,
            courseName: branchCourseName || courseName || b.courseName,
            branchName: branchName || b.branchName,
            cqIntake: intake.cqIntake ?? null,
            mqIntake: intake.mqIntake ?? null,
            cqAdmitted: Number(b.cqAdmitted) || 0,
            cqCancelled: Number(b.cqCancelled) || 0,
            mqAdmitted: Number(b.mqAdmitted) || 0,
            mqCancelled: Number(b.mqCancelled) || 0,
            spotAdmitted: Number(b.spotAdmitted) || 0,
            spotCancelled: Number(b.spotCancelled) || 0,
            meritYes: Number(b.meritYes) || 0,
            meritNo: Number(b.meritNo) || 0,
          };
        }),
    };
    });
    return successResponse(res, { stats: courseStats }, 'Admission stats retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting admission stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission stats', 500);
  }
};

/** Save CQ / MQ intake seats for a course + branch row on the admissions abstract. */
export const upsertAdmissionBranchIntake = async (req, res) => {
  try {
    const courseId = String(req.body?.courseId ?? '').trim();
    const branchId = String(req.body?.branchId ?? '').trim();
    if (!courseId || !branchId) {
      return errorResponse(res, 'courseId and branchId are required', 400);
    }
    const cqIntake = parseIntakeInput(req.body?.cqIntake);
    const mqIntake = parseIntakeInput(req.body?.mqIntake);
    if (req.body?.cqIntake != null && req.body?.cqIntake !== '' && cqIntake === null) {
      return errorResponse(res, 'cqIntake must be a whole number ≥ 0', 400);
    }
    if (req.body?.mqIntake != null && req.body?.mqIntake !== '' && mqIntake === null) {
      return errorResponse(res, 'mqIntake must be a whole number ≥ 0', 400);
    }

    const pool = getPool();
    await ensureAdmissionBranchIntakeTable(pool);
    await pool.execute(
      `INSERT INTO admission_branch_intake (
        id, course_id, branch_id, course_name, branch_name, cq_intake, mq_intake, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        course_name = VALUES(course_name),
        branch_name = VALUES(branch_name),
        cq_intake = VALUES(cq_intake),
        mq_intake = VALUES(mq_intake),
        updated_by = VALUES(updated_by)`,
      [
        uuidv4(),
        courseId,
        branchId,
        String(req.body?.courseName ?? '').trim(),
        String(req.body?.branchName ?? '').trim(),
        cqIntake,
        mqIntake,
        req.user?.id || null,
      ]
    );

    clearAdmissionQueryCache();

    return successResponse(
      res,
      { courseId, branchId, cqIntake, mqIntake },
      'Branch intake saved successfully',
      200
    );
  } catch (error) {
    console.error('Error saving branch intake:', error);
    return errorResponse(res, error.message || 'Failed to save branch intake', 500);
  }
};

/**
 * Shared filters for admission pivot reports (alias `a`).
 * When status is omitted or `all`, excludes "Admission Cancelled" to match course-wise stats.
 */
const buildAdmissionPivotFilters = async (query) => {
  const {
    startDate,
    endDate,
    collegeId,
    courseId,
    branchId,
    courseName,
    branchName,
    status,
  } = query;
  const conditions = [];
  const params = [];
  const c = (field) => `a.${field}`;

  const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
  appendManagedCollegeCourseFilter(
    conditions,
    params,
    SQL_A_EFF_COURSE_ID,
    collegeCourseIds
  );

  if (startDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
    params.push(String(startDate).slice(0, 10));
  }
  if (endDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
    params.push(String(endDate).slice(0, 10));
  }
  if (courseId || courseName) {
    if (courseId && courseName) {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR ${c('course')} = ?)`);
      params.push(courseId, courseName);
    } else {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR ${c('course')} = ?)`);
      const val = courseId || courseName;
      params.push(val, val);
    }
  }
  if (branchId || branchName) {
    if (branchId && branchName) {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR ${c('branch')} = ?)`);
      params.push(branchId, branchName);
    } else {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR ${c('branch')} = ?)`);
      const val = branchId || branchName;
      params.push(val, val);
    }
  }
  if (status && status !== 'all') {
    conditions.push(`${c('status')} = ?`);
    params.push(status);
  } else {
    conditions.push(`${c('status')} != ?`);
    params.push(ADMISSION_CANCELLED_STATUS);
  }
  return { conditions, params };
};

/** Normalize course header text so "B.Tech", "B.TECH", "b.tech " map to one bucket. */
const normalizeAdmissionCourseColumnName = (name) =>
  String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

const stripLateralCourseSuffix = (name) =>
  String(name ?? '')
    .replace(/\s*\(lateral\)\s*/gi, '')
    .trim();

/** Pivot count key: course id(s) + B.Tech lateral track (0 = regular, 1 = lateral entry). */
const admissionPivotCountKey = (courseId, lateralTrack = 0) => {
  if (courseId === undefined || courseId === null) return '__none__';
  const s = String(courseId).trim();
  if (s === '' || s === '__none__') return '__none__';
  const lat = Number(lateralTrack) === 1 ? 1 : 0;
  return `${s}::${lat}`;
};

const admissionPivotBucketKey = (label, catalogName, idStr, lateralTrack = 0) => {
  if (idStr === '__none__') return '__none__';
  const base = stripLateralCourseSuffix(label || catalogName);
  const norm = normalizeAdmissionCourseColumnName(base);
  if (isBtechCourseName(base) || isBtechCourseName(catalogName) || isBtechCourseName(label)) {
    return `${norm}::${Number(lateralTrack) === 1 ? 1 : 0}`;
  }
  return norm;
};

const parsePivotBucketLateral = (bucketKey) => {
  const m = String(bucketKey).match(/::([01])$/);
  return m ? Number(m[1]) : 0;
};

const admissionPivotColumnKey = (col) => {
  const ids = col.courseIds?.length
    ? col.courseIds
    : String(col.courseId || '')
        .split('|')
        .map((id) => id.trim())
        .filter(Boolean);
  const idPart = ids.length > 0 ? ids.join('|') : '__none__';
  return admissionPivotCountKey(idPart, col.lateralTrack ?? 0);
};

const sumCountsForCourseColumn = (countsRaw, col) => {
  const lateral = Number(col.lateralTrack) || 0;
  const ids = col.courseIds || [col.courseId];
  let sum = 0;
  for (const rawId of ids) {
    const id = String(rawId).trim();
    if (!id || id === '__none__') continue;
    const keys = [admissionPivotCountKey(id, lateral), id];
    for (const key of keys) {
      let v = countsRaw[key];
      if (v === undefined && /^\d+$/.test(key)) {
        const n = Number(key);
        if (Number.isSafeInteger(n)) v = countsRaw[n];
      }
      if (v !== undefined && v !== null) {
        sum += Number(v) || 0;
        break;
      }
    }
  }
  return sum;
};

/**
 * Build pivot columns aligned with how admissions store data:
 * - `admissions.course_id` (primary catalog FK when present) or `admissions.managed_course_id`
 *   (student DB id, no FK) plus denormalized `admissions.course` text.
 * - Secondary `courses` may list multiple ids or different ids than stored on older rows.
 *
 * We bucket by **normalized label** derived from admission `MAX(course)` when present, else
 * secondary name for that id. All ids that share the same bucket get merged so counts sum
 * into one column (fixes duplicate "DIPLOMA" / B.TECH showing 0).
 */
const getAdmissionReportCourses = async (primaryPool, whereClause, params) => {
  let activeCourses = [];
  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      'SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC'
    );
    activeCourses = rows || [];
  } catch (err) {
    console.error(
      'getAdmissionReportCourses: secondary courses query failed, using primary:',
      err?.message || err
    );
    const [rows] = await primaryPool.execute(
      'SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC'
    );
    activeCourses = rows || [];
  }

  const [distinctCourseRows] = await primaryPool.execute(
    `SELECT ${SQL_A_EFF_COURSE_ID} AS courseId,
            ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack,
            MAX(a.course) AS courseName
     FROM admissions a
     ${whereClause}
     GROUP BY ${SQL_A_EFF_COURSE_ID}, ${SQL_A_BTECH_LATERAL_TRACK}`,
    params
  );

  const idToSecondaryName = new Map(
    activeCourses.map((r) => [String(r.id), String(r.name || '').trim()])
  );

  const buckets = new Map();

  const addToBucket = (bucketKey, displayLabel, idStr) => {
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        courseName: String(displayLabel || '').trim() || '—',
        mergeIds: new Set(),
      });
    }
    const b = buckets.get(bucketKey);
    b.mergeIds.add(String(idStr));
    const next = String(displayLabel || '').trim();
    if (next.length > String(b.courseName || '').trim().length) {
      b.courseName = next;
    }
  };

  /** Each course id must map to one pivot column (avoids double-count when catalog id ≠ admission label). */
  const assignedCourseIds = new Set();

  for (const row of distinctCourseRows) {
    const rawId = row.courseId;
    const idStr =
      rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : '__none__';
    const lateralTrack = Number(row.lateralTrack) === 1 ? 1 : 0;
    const fromAdmissionText = String(row.courseName || '').trim();
    const catalogName = idToSecondaryName.get(idStr) || '';
    let label =
      idStr === '__none__'
        ? '—'
        : isGenericImportCourseLabel(fromAdmissionText) && catalogName
          ? catalogName
          : fromAdmissionText || catalogName || 'Unknown';
    label = stripLateralCourseSuffix(label);
    if (isBtechCourseName(label) || isBtechCourseName(catalogName)) {
      label = formatBtechCourseDisplayName(catalogName || label, lateralTrack === 1);
    }
    const k = admissionPivotBucketKey(label, catalogName, idStr, lateralTrack);
    addToBucket(k, label, idStr);
    if (idStr !== '__none__') assignedCourseIds.add(idStr);
  }

  for (const r of activeCourses) {
    const id = String(r.id);
    const nm = String(r.name || '').trim() || 'Unknown';
    if (isBtechCourseName(nm)) {
      const norm = normalizeAdmissionCourseColumnName(stripLateralCourseSuffix(nm));
      for (const lateralTrack of [0, 1]) {
        const k = `${norm}::${lateralTrack}`;
        if (!buckets.has(k)) {
          addToBucket(k, formatBtechCourseDisplayName(nm, lateralTrack === 1), id);
        }
      }
      continue;
    }
    if (assignedCourseIds.has(id)) continue;
    const k = normalizeAdmissionCourseColumnName(nm);
    addToBucket(k, nm, id);
  }

  const orderedKeys = [...buckets.keys()].filter((key) => key !== '__none__');
  orderedKeys.sort((a, b) => {
    const na = buckets.get(a).courseName;
    const nb = buckets.get(b).courseName;
    return String(na).localeCompare(String(nb), undefined, { sensitivity: 'base' });
  });

  const out = [];
  for (const k of orderedKeys) {
    const b = buckets.get(k);
    const ids = [...b.mergeIds]
      .filter((id) => id !== '__none__')
      .sort((x, y) => String(x).localeCompare(String(y)));
    if (ids.length === 0) continue;
    const lateralTrack = parsePivotBucketLateral(k);
    const courseId = ids.length === 1 ? ids[0] : ids.join('|');
    out.push({
      courseId,
      courseName: b.courseName,
      courseIds: ids,
      lateralTrack,
      pivotKey: admissionPivotCountKey(courseId, lateralTrack),
    });
  }

  if (buckets.has('__none__')) {
    const b = buckets.get('__none__');
    const ids = [...b.mergeIds].sort((x, y) => String(x).localeCompare(String(y)));
    const courseId = ids.length === 1 ? ids[0] : ids.join('|');
    out.push({
      courseId,
      courseName: b.courseName,
      courseIds: ids,
      lateralTrack: 0,
      pivotKey: admissionPivotCountKey(courseId, 0),
    });
  }

  return out;
};

/**
 * @desc    Distinct Reference 1 names used on admissions, joinings, and leads (for picker suggestions)
 * @route   GET /api/admissions/reference-names
 */
export const listDistinctReferenceNames = async (req, res) => {
  try {
    const pool = getPool();
    const sqlJoiningLeadData = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
    const sqlJoiningRef1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningLeadData}, '$.reference1'))), '')`;
    const sqlJoiningRefLegacy = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${sqlJoiningLeadData}, '$.referenceName'))), '')`;
    const sqlLeadDynamic = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
    const sqlLeadRef1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${sqlLeadDynamic}, '$.reference1'))), '')`;

    let hiddenKeys = [];
    try {
      const [hiddenRows] = await pool.execute(
        'SELECT name_normalized FROM reference_picker_hidden'
      );
      hiddenKeys = hiddenRows
        .map((r) => String(r.name_normalized ?? '').trim())
        .filter(Boolean);
    } catch {
      /* reference_picker_hidden table may not exist until migration runs */
    }

    const hiddenClause =
      hiddenKeys.length > 0
        ? ` AND LOWER(TRIM(name)) NOT IN (${hiddenKeys.map(() => '?').join(', ')})`
        : '';

    const [rows] = await pool.execute(
      `SELECT DISTINCT TRIM(name) AS name FROM (
         SELECT ${SQL_A_REFERENCE1} AS name FROM admissions a
         WHERE ${SQL_A_REFERENCE1} IS NOT NULL
         UNION
         SELECT ${sqlJoiningRef1} AS name FROM joinings j
         WHERE ${sqlJoiningRef1} IS NOT NULL
         UNION
         SELECT ${sqlJoiningRefLegacy} AS name FROM joinings j
         WHERE ${sqlJoiningRefLegacy} IS NOT NULL
         UNION
         SELECT ${sqlLeadRef1} AS name FROM leads l
         WHERE ${sqlLeadRef1} IS NOT NULL
       ) refs
       WHERE name IS NOT NULL AND name != ''${hiddenClause}
       ORDER BY name ASC
       LIMIT 500`,
      hiddenKeys
    );

    const names = rows
      .map((row) => String(row.name ?? '').trim())
      .filter((n) => n.length > 0);

    return successResponse(res, { names }, 'Reference names retrieved successfully', 200);
  } catch (error) {
    console.error('Error listing distinct reference names:', error);
    return errorResponse(res, error.message || 'Failed to list reference names', 500);
  }
};

/**
 * @desc    Usage stats + sample admissions for a reference name (manage dialog)
 * @route   GET /api/admissions/reference-names/usage
 */
export const getDistinctReferenceNameUsage = async (req, res) => {
  try {
    const name = String(req.query?.name ?? '').trim();
    if (!name) {
      return errorResponse(res, 'name query parameter is required', 400);
    }
    const pool = getPool();
    const usage = await getReferenceNameUsage(pool, name);
    return successResponse(res, usage, 'Reference usage retrieved successfully', 200);
  } catch (error) {
    console.error('Error fetching reference name usage:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch reference usage',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Rename a saved reference everywhere it appears (admissions, joinings, leads)
 * @route   PATCH /api/admissions/reference-names/rename
 */
export const renameDistinctReferenceName = async (req, res) => {
  try {
    const oldName = String(req.body?.oldName ?? req.body?.name ?? '').trim();
    const newName = String(req.body?.newName ?? '').trim();
    if (!oldName) {
      return errorResponse(res, 'oldName is required', 400);
    }
    if (!newName) {
      return errorResponse(res, 'newName is required', 400);
    }

    const pool = getPool();
    const result = await renameReferenceNameGlobally(pool, oldName, newName);

    return successResponse(
      res,
      { oldName, newName, ...result },
      result.renamed === false
        ? 'Reference name unchanged'
        : 'Reference renamed on all matching records',
      200
    );
  } catch (error) {
    console.error('Error renaming reference name:', error);
    return errorResponse(
      res,
      error.message || 'Failed to rename reference',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Hide a reference name from the picker (does not clear existing admissions)
 * @route   POST /api/admissions/reference-names/hide
 */
export const hideDistinctReferenceName = async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) {
      return errorResponse(res, 'name is required', 400);
    }
    const clearRecords = Boolean(req.body?.clearRecords);

    const pool = getPool();
    let clearResult = null;
    if (clearRecords) {
      clearResult = await clearReferenceNameGlobally(pool, name);
    }
    const result = await hideReferenceNameFromPicker(pool, name, req.user?.id);

    return successResponse(
      res,
      { ...result, clearRecords, ...(clearResult || {}) },
      clearRecords
        ? 'Reference removed from list and cleared on matching records'
        : 'Reference removed from picker list',
      200
    );
  } catch (error) {
    console.error('Error hiding reference name:', error);
    return errorResponse(
      res,
      error.message || 'Failed to remove reference from list',
      error.statusCode || 500
    );
  }
};

/**
 * @desc    Admissions counts by student Reference 1 (lead_data.reference1) × course
 * @route   GET /api/admissions/stats/by-reference
 */
export const getAdmissionStatsByReference = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const pivotFrom = `FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}`;
    const [agg] = await pool.execute(
      `SELECT
         COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__') AS referenceKey,
         MAX(${SQL_A_EFFECTIVE_REFERENCE1}) AS referenceName,
         ${SQL_A_EFF_COURSE_ID} AS courseId,
         ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack,
         COUNT(*) AS cnt
       ${pivotFrom}
       ${whereClause}
       GROUP BY COALESCE(${SQL_A_EFFECTIVE_REFERENCE1}, '__none__'), ${SQL_A_EFF_COURSE_ID}, ${SQL_A_BTECH_LATERAL_TRACK}`,
      params
    );

    const byReference = new Map();
    for (const row of agg) {
      const refKey = String(row.referenceKey || '__none__');
      if (!byReference.has(refKey)) {
        byReference.set(refKey, {
          displayName:
            refKey === '__none__'
              ? '(Not specified)'
              : String(row.referenceName || refKey).trim() || '(Not specified)',
        });
      }
      const bucket = byReference.get(refKey);
      if (!bucket.counts) bucket.counts = {};
      const ck = admissionPivotCountKey(row.courseId, row.lateralTrack);
      bucket.counts[ck] = (bucket.counts[ck] || 0) + (Number(row.cnt) || 0);
    }

    const rows = [...byReference.entries()]
      .sort((a, b) => {
        if (a[0] === '__none__') return 1;
        if (b[0] === '__none__') return -1;
        return String(a[1].displayName).localeCompare(String(b[1].displayName));
      })
      .map(([refKey, bucket]) => {
        const countsRaw = bucket.counts || {};
        const counts = {};
        for (const c of courses) {
          counts[admissionPivotColumnKey(c)] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return {
          referenceKey: refKey === '__none__' ? null : refKey,
          name: bucket.displayName,
          counts,
          total,
        };
      });

    return successResponse(
      res,
      { courses, rows },
      'Admission reference stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission reference stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission reference stats', 500);
  }
};

/**
 * @desc    Admissions counts by lead source × course
 * @route   GET /api/admissions/stats/by-source
 */
export const getAdmissionStatsBySource = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const pivotFrom = `FROM admissions a ${SQL_ADMISSION_PIVOT_JOINS}`;
    const [rows] = await pool.execute(
      `SELECT
         l.source AS lead_source,
         JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.source')) AS lead_data_source,
         JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.utmSource')) AS lead_data_utm_source,
         JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.leadSource')) AS lead_data_lead_source,
         l.upload_batch_id AS upload_batch_id,
         l.dynamic_fields AS lead_dynamic_fields,
         ${SQL_A_EFF_COURSE_ID} AS courseId,
         ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack
       ${pivotFrom}
       ${whereClause}`,
      params
    );

    const bySource = new Map();
    for (const row of rows) {
      const sourceName = normalizeAdmissionLeadSource(row);
      const sourceKey = sourceName.toLowerCase();
      if (!bySource.has(sourceKey)) {
        bySource.set(sourceKey, { displayName: sourceName, counts: {} });
      }
      const bucket = bySource.get(sourceKey);
      const ck = admissionPivotCountKey(row.courseId, row.lateralTrack);
      bucket.counts[ck] = (bucket.counts[ck] || 0) + 1;
    }

    const pivotRows = [...bySource.entries()]
      .sort((a, b) => String(a[1].displayName).localeCompare(String(b[1].displayName)))
      .map(([sourceKey, bucket]) => {
        const countsRaw = bucket.counts || {};
        const counts = {};
        for (const c of courses) {
          counts[admissionPivotColumnKey(c)] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return {
          sourceKey,
          name: bucket.displayName,
          counts,
          total,
        };
      });

    return successResponse(
      res,
      { courses, rows: pivotRows },
      'Admission source stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission source stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission source stats', 500);
  }
};

/**
 * @desc    Admissions counts by calendar date × course
 * @route   GET /api/admissions/stats/by-date
 */
export const getAdmissionStatsByDate = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = await buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const [agg] = await pool.execute(
      `SELECT DATE_FORMAT(${SQL_A_EFFECTIVE_ADMISSION_DATE}, '%Y-%m-%d') AS d,
              ${SQL_A_EFF_COURSE_ID} AS courseId,
              ${SQL_A_BTECH_LATERAL_TRACK} AS lateralTrack,
              COUNT(*) AS cnt
       FROM admissions a
       ${whereClause}
       GROUP BY DATE_FORMAT(${SQL_A_EFFECTIVE_ADMISSION_DATE}, '%Y-%m-%d'), ${SQL_A_EFF_COURSE_ID}, ${SQL_A_BTECH_LATERAL_TRACK}`,
      params
    );

    const byDate = new Map();
    for (const row of agg) {
      const dateStr = row.d ? String(row.d).slice(0, 10) : '';
      if (!dateStr) continue;
      if (!byDate.has(dateStr)) byDate.set(dateStr, {});
      const ck = admissionPivotCountKey(row.courseId, row.lateralTrack);
      const cur = byDate.get(dateStr);
      cur[ck] = (cur[ck] || 0) + (Number(row.cnt) || 0);
    }

    const rows = [...byDate.keys()]
      .sort((a, b) => b.localeCompare(a))
      .map((date) => {
        const countsRaw = byDate.get(date) || {};
        const counts = {};
        for (const c of courses) {
          counts[admissionPivotColumnKey(c)] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return { date, counts, total };
      });

    return successResponse(
      res,
      { courses, rows },
      'Admission date-wise stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission date-wise stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission date-wise stats', 500);
  }
};

/**
 * @desc    Export admissions to Excel
 * @route   GET /api/admissions/export
 * @access  Private (Super Admin)
 */
export const exportAdmissions = async (req, res) => {
  try {
    const pool = getPool();
    const {
      search,
      status,
      collegeId,
      startDate,
      endDate,
      courseId,
      branchId,
      courseName,
      branchName,
    } = req.query;

    const conditions = [];
    const params = [];

    if (status && status !== 'all') {
      conditions.push('a.status = ?');
      params.push(status);
    }

    const collegeCourseIds = await loadManagedCourseIdsForCollege(collegeId);
    appendManagedCollegeCourseFilter(
      conditions,
      params,
      SQL_A_EFF_COURSE_ID,
      collegeCourseIds
    );

    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }

    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    if (startDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
      params.push(String(startDate).slice(0, 10));
    }

    if (endDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
      params.push(String(endDate).slice(0, 10));
    }

    if (search) {
      const searchTerm = `%${search.trim()}%`;
      conditions.push('(a.student_name LIKE ? OR a.admission_number LIKE ? OR a.student_phone LIKE ?)');
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT a.* 
      FROM admissions a
      ${whereClause}
      ORDER BY a.admission_number DESC, a.updated_at DESC
    `;

    // Increase sort buffer for this session to handle large rows (e.g., 1MB+)
    await pool.execute('SET SESSION sort_buffer_size = 4194304'); // 4MB

    const [rows] = await pool.execute(query, params);

    // Format all admissions
    const formattedAdmissions = await Promise.all(
      rows.map(row => formatAdmission(row, pool))
    );

    // Create Excel Workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Admissions');

    // Define Columns
    worksheet.columns = [
      { header: 'Admission #', key: 'admissionNumber', width: 15 },
      { header: 'Timestamp', key: 'createdAt', width: 20 },
      { header: 'Student Name', key: 'studentName', width: 25 },
      { header: 'Contact No', key: 'studentPhone', width: 15 },
      { header: 'Course', key: 'course', width: 20 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Quota', key: 'quota', width: 15 },
      { header: 'Reservation (General)', key: 'reservationGeneral', width: 20 },
      { header: 'Reservation (Other)', key: 'reservationOther', width: 20 },
      { header: 'EWS', key: 'isEws', width: 10 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total Fee', key: 'totalFee', width: 15 },
      { header: 'Total Paid', key: 'totalPaid', width: 15 },
      { header: 'Balance', key: 'balance', width: 15 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Reference', key: 'reference', width: 22 },
      { header: 'SSC Result', key: 'sscResult', width: 10 },
      { header: 'SSC Passed Year', key: 'sscPassedYear', width: 15 },
      { header: 'Intermediate Passed Year', key: 'interPassedYear', width: 15 },
    ];

    // Add Rows
    formattedAdmissions.forEach(record => {
      const reservationOther = Array.isArray(record.reservation?.other) 
        ? record.reservation.other.join(', ') 
        : (record.reservation?.other || '');

      worksheet.addRow({
        admissionNumber: record.admissionNumber,
        createdAt: record.createdAt ? new Date(record.createdAt).toLocaleString() : '',
        studentName: record.studentInfo?.name || '',
        studentPhone: record.studentInfo?.phone || '',
        course: record.courseInfo?.course || '',
        branch: record.courseInfo?.branch || '',
        quota: record.courseInfo?.quota || '',
        reservationGeneral: record.reservation?.general || 'OC',
        reservationOther: reservationOther,
        isEws: record.reservation?.isEws ? 'Yes' : 'No',
        status: record.status || '',
        totalFee: record.paymentSummary?.totalFee || 0,
        totalPaid: record.paymentSummary?.totalPaid || 0,
        balance: (record.paymentSummary?.totalFee || 0) - (record.paymentSummary?.totalPaid || 0),
        source: record.leadData?.source || 'Direct',
        reference:
          record.leadData?.reference1 ||
          record.leadData?.referenceName ||
          record.registrationFormData?.reference1 ||
          '',
        sscResult: record.educationHistory?.[0]?.gradeOrPercentage || '',
        sscPassedYear: record.educationHistory?.[0]?.yearOfPassing || '',
        interPassedYear: record.educationHistory?.[1]?.yearOfPassing || '',
      });
    });

    // Style the header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Set Response Headers
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=admissions_export.xlsx'
    );

    // Write to stream
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error exporting admissions:', error);
    if (!res.headersSent) {
      return errorResponse(res, error.message || 'Failed to export admissions', 500);
    }
  }
};
