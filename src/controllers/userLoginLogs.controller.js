import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Get current user's login/logout logs
// @route   GET /api/users/me/login-logs
// @access  Private (User, Student Counselor, Manager)
export const getMyLoginLogs = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT id, event_type, ip_address, user_agent, created_at
       FROM user_login_logs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [userId]
    );

    const [countRows] = await pool.execute(
      'SELECT COUNT(*) as total FROM user_login_logs WHERE user_id = ?',
      [userId]
    );
    const total = countRows[0]?.total ?? 0;

    const logs = rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      ipAddress: r.ip_address || null,
      userAgent: r.user_agent || null,
      createdAt: r.created_at,
    }));

    return successResponse(
      res,
      {
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'Login logs retrieved',
      200
    );
  } catch (error) {
    console.error('Get my login logs error:', error);
    return errorResponse(res, error.message || 'Failed to get login logs', 500);
  }
};

// @desc    Get all users' time tracking logs (Super Admin only)
// @route   GET /api/users/all/login-logs
// @access  Private (Super Admin only)
export const getAllUserLoginLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const userId = req.query.userId ? String(req.query.userId).trim() : null;
    const eventType = req.query.eventType || null; // 'tracking_enabled' | 'tracking_disabled' | null for both
    const startDate = req.query.startDate ? String(req.query.startDate).trim() : null;
    const endDate = req.query.endDate ? String(req.query.endDate).trim() : null;
    const pool = getPool();

    const params = [];
    const whereClauses = [`ull.event_type IN ('tracking_enabled', 'tracking_disabled')`];
    if (userId) {
      whereClauses.push('ull.user_id = ?');
      params.push(userId);
    }
    if (eventType && (eventType === 'tracking_enabled' || eventType === 'tracking_disabled')) {
      whereClauses.push('ull.event_type = ?');
      params.push(eventType);
    }
    if (startDate) {
      whereClauses.push('DATE(ull.created_at) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      whereClauses.push('DATE(ull.created_at) <= ?');
      params.push(endDate);
    }
    const whereSQL = whereClauses.join(' AND ');

    // Use interpolated LIMIT/OFFSET (already sanitized as integers) - mysql2 prepared statements mishandle them
    const [rows] = await pool.execute(
      `SELECT ull.id, ull.user_id, ull.event_type, ull.created_at, u.name as user_name, u.email as user_email, u.role_name as user_role
       FROM user_login_logs ull
       JOIN users u ON u.id = ull.user_id
       WHERE ${whereSQL}
       ORDER BY ull.created_at DESC
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      params
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total
       FROM user_login_logs ull
       WHERE ${whereSQL}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    const logs = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      userRole: r.user_role,
      eventType: r.event_type,
      createdAt: r.created_at,
    }));

    return successResponse(
      res,
      {
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'All user activity logs retrieved',
      200
    );
  } catch (error) {
    console.error('Get all user login logs error:', error);
    return errorResponse(res, error.message || 'Failed to get activity logs', 500);
  }
};
