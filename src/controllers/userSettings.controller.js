import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { recordUserLoginLog } from '../utils/recordUserLoginLog.js';

// @desc    Get current user's settings
// @route   GET /api/users/me/settings
// @access  Private (User, Student Counselor, Manager)
export const getMySettings = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const pool = getPool();

    const [rows] = await pool.execute(
      'SELECT time_tracking_enabled, auto_calling_enabled FROM users WHERE id = ?',
      [userId]
    );

    if (rows.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const timeTrackingEnabled = rows[0].time_tracking_enabled === 1 || rows[0].time_tracking_enabled === true;
    const autoCallingEnabled = rows[0].auto_calling_enabled === 1 || rows[0].auto_calling_enabled === true;

    return successResponse(res, { timeTrackingEnabled, autoCallingEnabled }, 'Settings retrieved', 200);
  } catch (error) {
    console.error('Get my settings error:', error);
    return errorResponse(res, error.message || 'Failed to get settings', 500);
  }
};

// @desc    Update current user's settings
// @route   PUT /api/users/me/settings
// @access  Private (User, Student Counselor, Manager)
export const updateMySettings = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { timeTrackingEnabled, autoCallingEnabled } = req.body;
    const pool = getPool();

    // Validate inputs if provided
    if (timeTrackingEnabled !== undefined && typeof timeTrackingEnabled !== 'boolean') {
      return errorResponse(res, 'timeTrackingEnabled must be a boolean', 400);
    }
    if (autoCallingEnabled !== undefined && typeof autoCallingEnabled !== 'boolean') {
      return errorResponse(res, 'autoCallingEnabled must be a boolean', 400);
    }

    // Get current values
    const [rows] = await pool.execute(
      'SELECT time_tracking_enabled, auto_calling_enabled FROM users WHERE id = ?',
      [userId]
    );
    
    if (rows.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const currentTracking = rows[0].time_tracking_enabled === 1 || rows[0].time_tracking_enabled === true;
    const currentAutoCall = rows[0].auto_calling_enabled === 1 || rows[0].auto_calling_enabled === true;

    // Determine new values (use existing if not provided)
    const newTracking = timeTrackingEnabled !== undefined ? timeTrackingEnabled : currentTracking;
    const newAutoCall = autoCallingEnabled !== undefined ? autoCallingEnabled : currentAutoCall;

    await pool.execute(
      'UPDATE users SET time_tracking_enabled = ?, auto_calling_enabled = ?, updated_at = NOW() WHERE id = ?',
      [newTracking, newAutoCall, userId]
    );

    // Record when the time tracking toggle is turned ON or OFF
    if (timeTrackingEnabled !== undefined && currentTracking !== timeTrackingEnabled) {
      const eventType = timeTrackingEnabled ? 'tracking_enabled' : 'tracking_disabled';
      const ipAddress = req.ip || req.connection?.remoteAddress || null;
      const userAgent = req.get('User-Agent') || null;
      await recordUserLoginLog(userId, eventType, { ipAddress, userAgent });
    }

    return successResponse(res, { timeTrackingEnabled: newTracking, autoCallingEnabled: newAutoCall }, 'Settings updated', 200);
  } catch (error) {
    console.error('Update my settings error:', error);
    return errorResponse(res, error.message || 'Failed to update settings', 500);
  }
};
