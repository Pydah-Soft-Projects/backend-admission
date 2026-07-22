import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const formatAuditRow = (row) => {
  let changes = row.changes_json;
  if (typeof changes === 'string') {
    try {
      changes = JSON.parse(changes);
    } catch {
      changes = {};
    }
  }
  return {
    id: row.id,
    targetUserId: row.target_user_id,
    targetUserName: row.target_user_name,
    targetUserEmail: row.target_user_email,
    action: row.action,
    changedBy: row.changed_by,
    changedByName: row.changed_by_name,
    changes: changes || {},
    ipAddress: row.ip_address || null,
    userAgent: row.user_agent || null,
    createdAt: row.created_at,
  };
};

// @desc    Get audit history for one user
// @route   GET /api/users/:id/audit-logs
// @access  Private (Super Admin)
export const getUserAuditLogs = async (req, res) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const userId = req.params.id;

    const [countRows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM user_audit_logs WHERE target_user_id = ?',
      [userId]
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.execute(
      `SELECT id, target_user_id, target_user_name, target_user_email, action,
              changed_by, changed_by_name, changes_json, ip_address, user_agent, created_at
       FROM user_audit_logs
       WHERE target_user_id = ?
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [userId]
    );

    return successResponse(
      res,
      {
        logs: (rows || []).map(formatAuditRow),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      },
      'User audit logs retrieved successfully'
    );
  } catch (error) {
    console.error('Get user audit logs error:', error);
    return errorResponse(res, error.message || 'Failed to get user audit logs', 500);
  }
};

// @desc    Get all user-management audit logs (optional filters)
// @route   GET /api/users/all/audit-logs
// @access  Private (Super Admin)
export const getAllUserAuditLogs = async (req, res) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const { userId, changedBy, action, startDate, endDate } = req.query;

    const where = [];
    const params = [];

    if (userId) {
      where.push('target_user_id = ?');
      params.push(userId);
    }
    if (changedBy) {
      where.push('changed_by = ?');
      params.push(changedBy);
    }
    if (action && ['create', 'update', 'delete'].includes(action)) {
      where.push('action = ?');
      params.push(action);
    }
    if (startDate) {
      where.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('created_at <= ?');
      params.push(endDate);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM user_audit_logs ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.execute(
      `SELECT id, target_user_id, target_user_name, target_user_email, action,
              changed_by, changed_by_name, changes_json, ip_address, user_agent, created_at
       FROM user_audit_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return successResponse(
      res,
      {
        logs: (rows || []).map(formatAuditRow),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
      },
      'User audit logs retrieved successfully'
    );
  } catch (error) {
    console.error('Get all user audit logs error:', error);
    return errorResponse(res, error.message || 'Failed to get user audit logs', 500);
  }
};
