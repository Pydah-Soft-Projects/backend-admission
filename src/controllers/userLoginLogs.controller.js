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

// @desc    Get aggregated user activity logs (Time Tracking Duration)
// @route   GET /api/users/all/login-logs
// @access  Private (Super Admin only)
export const getAllUserLoginLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const userId = req.query.userId ? String(req.query.userId).trim() : null;
    const startDate = req.query.startDate ? String(req.query.startDate).trim() : null;
    const endDate = req.query.endDate ? String(req.query.endDate).trim() : null;
    const pool = getPool();

    const params = [];
    // We only care about tracking events for duration calculation
    const whereClauses = [`ull.event_type IN ('tracking_enabled', 'tracking_disabled')`];

    if (userId) {
      whereClauses.push('ull.user_id = ?');
      params.push(userId);
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

    // Fetch ALL matching raw logs to calculate duration accurately
    // We sort by user_id and then created_at ASC to process chronologically
    const [rows] = await pool.execute(
      `SELECT ull.id, ull.user_id, ull.event_type, ull.created_at, u.name as user_name, u.email as user_email, u.role_name as user_role
       FROM user_login_logs ull
       JOIN users u ON u.id = ull.user_id
       WHERE ${whereSQL}
       ORDER BY ull.user_id, ull.created_at ASC`,
      params
    );

    // Aggregate logs by User + Date
    const aggregatedMap = new Map();

    const getDayKey = (dateStr) => {
      const d = new Date(dateStr);
      return d.toISOString().split('T')[0]; // YYYY-MM-DD
    };

    // Helper to process a user's logs for a specific day
    // We'll process the flat list, identifying boundaries when user or day changes
    let currentUser = null;
    let currentDate = null;
    let sessionStart = null;
    let currentRecord = null;
    
    // To handle "currently active" or "forgot to logout"
    // If we hit END of a user/day block and sessionStart is not null:
    // 1. If day is TODAY: duration += (NOW - sessionStart)
    // 2. If day is PAST: duration += (EndOfDay - sessionStart)
    
    // We'll traverse the rows and build aggregated records
    for (const row of rows) {
      const rowDate = getDayKey(row.created_at);
      const key = `${row.user_id}_${rowDate}`;

      // If user or day changed, finalize the previous record
      if (!currentRecord || currentRecord.key !== key) {
        // Finalize previous record if pending session
        if (currentRecord && sessionStart) {
            const dateObj = new Date(currentRecord.date); // This is UTC date from key YYYY-MM-DD
            const now = new Date();
            const todayStr = getDayKey(now);
            
            let endTime;
            if (currentRecord.date === todayStr) {
                endTime = now; // Still running today
                currentRecord.isActive = true;
            } else {
                // End of that day (23:59:59)
                endTime = new Date(currentRecord.date);
                endTime.setHours(23, 59, 59, 999);
            }
            
            const duration = Math.max(0, endTime - sessionStart);
            currentRecord.totalDuration += duration;
            // Add session detail
            currentRecord.sessions.push({
                startTime: sessionStart,
                endTime: currentRecord.isActive ? null : endTime,
                duration
            });
            sessionStart = null; // Reset for next group
        }

        // Initialize new record
        if (!aggregatedMap.has(key)) {
            aggregatedMap.set(key, {
                id: key,
                key,
                userId: row.user_id,
                userName: row.user_name,
                userEmail: row.user_email,
                userRole: row.user_role,
                date: rowDate,
                totalDuration: 0, // in milliseconds
                sessionCount: 0,
                isActive: false,
                firstLogin: null,
                lastLogout: null,
                sessions: [] // Array of { startTime, endTime, duration }
            });
        }
        currentRecord = aggregatedMap.get(key);
      }

      const eventTime = new Date(row.created_at);

      if (row.event_type === 'tracking_enabled') {
        if (!sessionStart) {
            sessionStart = eventTime;
            currentRecord.sessionCount++;
            if (!currentRecord.firstLogin) currentRecord.firstLogin = row.created_at;
        }
        // If sessionStart already exists (double ON?), we ignore the second ON or treat as continuation
        // Standard logic: ON ... OFF. If ON ... ON, just keep the first ON.
      } else if (row.event_type === 'tracking_disabled') {
        if (sessionStart) {
            const duration = Math.max(0, eventTime - sessionStart);
            currentRecord.totalDuration += duration;
            // Add session detail
            currentRecord.sessions.push({
                startTime: sessionStart,
                endTime: eventTime,
                duration
            });
            sessionStart = null;
            currentRecord.lastLogout = row.created_at;
        }
        // If OFF without ON, ignore (orphan event)
      }
    }

    // Finalize the very last record after loop
    if (currentRecord && sessionStart) {
        const now = new Date();
        const todayStr = getDayKey(now);
        
        let endTime;
        if (currentRecord.date === todayStr) {
            endTime = now;
            currentRecord.isActive = true;
        } else {
            // End of that day
            endTime = new Date(currentRecord.date);
            endTime.setHours(23, 59, 59, 999);
        }
        
        const duration = Math.max(0, endTime - sessionStart);
        currentRecord.totalDuration += duration;
        // Add session detail
        currentRecord.sessions.push({
            startTime: sessionStart,
            endTime: currentRecord.isActive ? null : endTime,
            duration
        });
    }

    // Convert map to array
    const allAggregatedLogs = Array.from(aggregatedMap.values());

    // Sorting: Most recent date first, then by User Name
    allAggregatedLogs.sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return a.userName.localeCompare(b.userName);
    });

    // Pagination on the aggregated list
    const total = allAggregatedLogs.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedLogs = allAggregatedLogs.slice(startIndex, endIndex);

    return successResponse(
      res,
      {
        logs: paginatedLogs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'Aggregated user activity logs retrieved',
      200
    );
  } catch (error) {
    console.error('Get all user login logs error:', error);
    return errorResponse(res, error.message || 'Failed to get activity logs', 500);
  }
};
