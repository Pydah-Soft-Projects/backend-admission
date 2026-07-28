import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

let minimumFeeConfigTableReady = false;

const columnExists = async (pool, tableName, columnName) => {
  const [rows] = await pool.execute(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return Array.isArray(rows) && rows.length > 0;
};

const indexExists = async (pool, tableName, indexName) => {
  const [rows] = await pool.execute(
    `SELECT 1
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [tableName, indexName]
  );
  return Array.isArray(rows) && rows.length > 0;
};

const ensureMinimumFeeConfigTable = async (pool) => {
  if (minimumFeeConfigTableReady) return;
  const tableName = 'admission_minimum_fee_configs';
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admission_minimum_fee_configs (
      id CHAR(36) PRIMARY KEY,
      college_id VARCHAR(64) NOT NULL,
      college_name VARCHAR(255) NOT NULL DEFAULT '',
      course_id VARCHAR(64) NOT NULL,
      course_name VARCHAR(255) NOT NULL DEFAULT '',
      branch_id VARCHAR(64) NOT NULL DEFAULT '',
      branch_name VARCHAR(255) NOT NULL DEFAULT '',
      quota VARCHAR(255) NOT NULL,
      amount DECIMAL(12, 2) NOT NULL,
      created_by CHAR(36) NULL,
      updated_by CHAR(36) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_min_fee_college_course_branch_quota (college_id, course_id, branch_id, quota),
      INDEX idx_min_fee_college (college_id),
      INDEX idx_min_fee_course (course_id),
      INDEX idx_min_fee_branch (branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // MySQL on this RDS does not support ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
  // Use information_schema checks so existing course-level rows keep loading in the UI.
  if (!(await columnExists(pool, tableName, 'branch_id'))) {
    await pool.execute(
      `ALTER TABLE admission_minimum_fee_configs
       ADD COLUMN branch_id VARCHAR(64) NOT NULL DEFAULT '' AFTER course_name`
    );
  }
  if (!(await columnExists(pool, tableName, 'branch_name'))) {
    await pool.execute(
      `ALTER TABLE admission_minimum_fee_configs
       ADD COLUMN branch_name VARCHAR(255) NOT NULL DEFAULT '' AFTER branch_id`
    );
  }
  if (!(await indexExists(pool, tableName, 'idx_min_fee_branch'))) {
    await pool.execute(
      `CREATE INDEX idx_min_fee_branch ON admission_minimum_fee_configs (branch_id)`
    );
  }
  if (await indexExists(pool, tableName, 'uq_min_fee_college_course_quota')) {
    await pool.execute(
      `ALTER TABLE admission_minimum_fee_configs
       DROP INDEX uq_min_fee_college_course_quota`
    );
  }
  if (!(await indexExists(pool, tableName, 'uq_min_fee_college_course_branch_quota'))) {
    await pool.execute(
      `ALTER TABLE admission_minimum_fee_configs
       ADD UNIQUE KEY uq_min_fee_college_course_branch_quota (college_id, course_id, branch_id, quota)`
    );
  }
  minimumFeeConfigTableReady = true;
};

const formatConfigRow = (row) => ({
  id: row.id,
  collegeId: String(row.college_id || ''),
  collegeName: String(row.college_name || ''),
  courseId: String(row.course_id || ''),
  courseName: String(row.course_name || ''),
  branchId: String(row.branch_id || ''),
  branchName: String(row.branch_name || ''),
  quota: String(row.quota || ''),
  amount: Number(row.amount) || 0,
  createdBy: row.created_by || null,
  updatedBy: row.updated_by || null,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
});

const parseAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
};

/** GET /admissions/minimum-fee-configs */
export const listMinimumFeeConfigs = async (req, res) => {
  try {
    const pool = getPool();
    await ensureMinimumFeeConfigTable(pool);

    const collegeId = String(req.query.collegeId || '').trim();
    const courseId = String(req.query.courseId || '').trim();
    const branchId = String(req.query.branchId || '').trim();
    const params = [];
    const where = [];

    if (collegeId) {
      where.push('college_id = ?');
      params.push(collegeId);
    }
    if (courseId) {
      where.push('course_id = ?');
      params.push(courseId);
    }
    if (branchId) {
      where.push('branch_id = ?');
      params.push(branchId);
    }

    const sql = `
      SELECT id, college_id, college_name, course_id, course_name, branch_id, branch_name, quota, amount,
             created_by, updated_by, created_at, updated_at
      FROM admission_minimum_fee_configs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY college_name ASC, course_name ASC, branch_name ASC, quota ASC
    `;
    const [rows] = await pool.execute(sql, params);
    const configs = (rows || []).map(formatConfigRow);

    return successResponse(
      res,
      { configs, total: configs.length },
      'Minimum fee configs retrieved successfully'
    );
  } catch (error) {
    console.error('Error listing minimum fee configs:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list minimum fee configs',
      error.statusCode || 500
    );
  }
};

/**
 * PUT /admissions/minimum-fee-configs/course
 * Replace all quota amounts for one college + course.
 * Body: { collegeId, collegeName, courseId, courseName, branches?: [{ branchId, branchName }], entries: [{ quota, amount }] }
 * Entries with amount <= 0 are omitted (cleared).
 */
export const upsertMinimumFeeConfigsForCourse = async (req, res) => {
  try {
    const pool = getPool();
    await ensureMinimumFeeConfigTable(pool);

    const collegeId = String(req.body?.collegeId || '').trim();
    const collegeName = String(req.body?.collegeName || '').trim();
    const courseId = String(req.body?.courseId || '').trim();
    const courseName = String(req.body?.courseName || '').trim();
    const branches = Array.isArray(req.body?.branches) ? req.body.branches : [];
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const actorId = req.user?.id || req.user?._id || null;

    if (!collegeId) return errorResponse(res, 'collegeId is required', 400);
    if (!courseId) return errorResponse(res, 'courseId is required', 400);

    const normalizedBranches = [];
    const seenBranches = new Set();
    for (const branch of branches) {
      const branchId = String(branch?.branchId || '').trim();
      const branchName = String(branch?.branchName || '').trim();
      if (!branchId) continue;
      if (seenBranches.has(branchId)) continue;
      seenBranches.add(branchId);
      normalizedBranches.push({ branchId, branchName });
    }
    const branchScopeEnabled = normalizedBranches.length > 0;

    const normalized = [];
    const seenQuotas = new Set();
    for (const entry of entries) {
      const quota = String(entry?.quota || '').trim();
      const amount = parseAmount(entry?.amount);
      if (!quota || amount == null) continue;
      const key = quota.toLowerCase();
      if (seenQuotas.has(key)) continue;
      seenQuotas.add(key);
      normalized.push({ quota, amount });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const branchTargets = branchScopeEnabled
        ? normalizedBranches
        : [{ branchId: '', branchName: '' }];
      for (const { branchId, branchName } of branchTargets) {
        await connection.execute(
          `DELETE FROM admission_minimum_fee_configs
           WHERE college_id = ? AND course_id = ? AND branch_id = ?`,
          [collegeId, courseId, branchId]
        );

        for (const { quota, amount } of normalized) {
          await connection.execute(
            `INSERT INTO admission_minimum_fee_configs
              (id, college_id, college_name, course_id, course_name, branch_id, branch_name, quota, amount, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              collegeId,
              collegeName,
              courseId,
              courseName,
              branchId,
              branchName,
              quota,
              amount,
              actorId,
              actorId,
            ]
          );
        }
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const [rows] = await pool.execute(
      `SELECT id, college_id, college_name, course_id, course_name, branch_id, branch_name, quota, amount,
              created_by, updated_by, created_at, updated_at
       FROM admission_minimum_fee_configs
       WHERE college_id = ? AND course_id = ?
       ORDER BY branch_name ASC, quota ASC`,
      [collegeId, courseId]
    );
    const configs = (rows || []).map(formatConfigRow);

    return successResponse(
      res,
      { configs, total: configs.length },
      branchScopeEnabled
        ? `Saved ${configs.length} minimum fee config(s) for selected branches`
        : `Saved ${configs.length} course-level minimum fee config(s)`
    );
  } catch (error) {
    console.error('Error upserting minimum fee configs:', error);
    return errorResponse(
      res,
      error.message || 'Failed to save minimum fee configs',
      error.statusCode || 500
    );
  }
};

/** DELETE /admissions/minimum-fee-configs/course?collegeId=&courseId= */
export const clearMinimumFeeConfigsForCourse = async (req, res) => {
  try {
    const pool = getPool();
    await ensureMinimumFeeConfigTable(pool);

    const collegeId = String(req.query.collegeId || req.body?.collegeId || '').trim();
    const courseId = String(req.query.courseId || req.body?.courseId || '').trim();
    const branchIdsRaw = req.body?.branchIds ?? req.query.branchIds;
    const branchIds = Array.isArray(branchIdsRaw)
      ? branchIdsRaw.map((id) => String(id || '').trim()).filter(Boolean)
      : String(branchIdsRaw || '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
    if (!collegeId || !courseId) {
      return errorResponse(res, 'collegeId and courseId are required', 400);
    }
    const hasBranchScope = branchIds.length > 0;
    const [result] = hasBranchScope
      ? await pool.execute(
          `DELETE FROM admission_minimum_fee_configs
           WHERE college_id = ? AND course_id = ? AND branch_id IN (${branchIds
             .map(() => '?')
             .join(',')})`,
          [collegeId, courseId, ...branchIds]
        )
      : await pool.execute(
          `DELETE FROM admission_minimum_fee_configs
           WHERE college_id = ? AND course_id = ? AND (branch_id = '' OR branch_id IS NULL)`,
          [collegeId, courseId]
        );

    return successResponse(
      res,
      { deleted: result?.affectedRows || 0 },
      hasBranchScope ? 'Selected branch minimum fee configs cleared' : 'Course minimum fee configs cleared'
    );
  } catch (error) {
    console.error('Error clearing course minimum fee configs:', error);
    return errorResponse(
      res,
      error.message || 'Failed to clear course minimum fee configs',
      error.statusCode || 500
    );
  }
};

/** DELETE /admissions/minimum-fee-configs/college/:collegeId */
export const clearMinimumFeeConfigsForCollege = async (req, res) => {
  try {
    const pool = getPool();
    await ensureMinimumFeeConfigTable(pool);

    const collegeId = String(req.params.collegeId || '').trim();
    if (!collegeId) return errorResponse(res, 'collegeId is required', 400);

    const [result] = await pool.execute(
      `DELETE FROM admission_minimum_fee_configs WHERE college_id = ?`,
      [collegeId]
    );

    return successResponse(
      res,
      { deleted: result?.affectedRows || 0 },
      'College minimum fee configs cleared'
    );
  } catch (error) {
    console.error('Error clearing college minimum fee configs:', error);
    return errorResponse(
      res,
      error.message || 'Failed to clear college minimum fee configs',
      error.statusCode || 500
    );
  }
};
