import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Record a time-tracking event for a user.
 * @param {string} userId - User ID
 * @param {string} eventType - 'login' | 'logout' | 'tracking_enabled' | 'tracking_disabled'
 * @param {object} meta - Optional { ipAddress, userAgent }
 */
export const recordUserLoginLog = async (userId, eventType, meta = {}) => {
  try {
    const pool = getPool();
    const id = uuidv4();
    const { ipAddress = null, userAgent = null } = meta;
    await pool.execute(
      'INSERT INTO user_login_logs (id, user_id, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
      [id, userId, eventType, ipAddress, userAgent]
    );
  } catch (err) {
    console.error('Failed to record user login log:', err.message);
    // Non-fatal: don't throw, login/logout should still succeed
  }
};
