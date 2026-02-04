import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadAssignment } from '../services/notification.service.js';
import { v4 as uuidv4 } from 'uuid';

// @desc    Assign leads to users based on mandal/state (bulk) or specific lead IDs (single)
// @route   POST /api/leads/assign
// @access  Private (Super Admin only)
export const assignLeads = async (req, res) => {
  try {
    const { userId, mandal, state, academicYear, count, leadIds, assignNow = true } = req.body;
    const pool = getPool();
    const currentUserId = req.user.id || req.user._id;

    // Validate required fields
    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    // Check if user exists and is assignable
    const [users] = await pool.execute(
      'SELECT id, name, role_name, is_active FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];

    // Validate that user can receive assignments
    if (user.role_name === 'Super Admin') {
      return errorResponse(res, 'Cannot assign leads to Super Admin', 400);
    }

    if (user.is_active !== 1 && user.is_active !== true) {
      return errorResponse(res, 'Cannot assign leads to inactive user', 400);
    }

    let leadIdsToAssign = [];

    // Single assignment mode: assign specific lead IDs
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      // Validate lead IDs (UUID format)
      const validLeadIds = leadIds.filter((id) => id && typeof id === 'string' && id.length === 36);

      if (validLeadIds.length === 0) {
        return errorResponse(res, 'No valid lead IDs provided', 400);
      }

      // Check if leads exist
      const placeholders = validLeadIds.map(() => '?').join(',');
      const [existingLeads] = await pool.execute(
        `SELECT id, assigned_to FROM leads WHERE id IN (${placeholders})`,
        validLeadIds
      );

      if (existingLeads.length === 0) {
        return errorResponse(res, 'No leads found with the provided IDs', 404);
      }

      leadIdsToAssign = existingLeads.map((lead) => lead.id);
    } else {
      // Bulk assignment mode: assign based on filters and count
      if (!count || count <= 0) {
        return errorResponse(res, 'Count is required for bulk assignment', 400);
      }
      const yearNum = academicYear != null && academicYear !== '' ? parseInt(academicYear, 10) : NaN;
      if (Number.isNaN(yearNum)) {
        return errorResponse(res, 'Academic year is required for bulk assignment', 400);
      }

      // Build filter for unassigned leads
      const conditions = ['(assigned_to IS NULL)', 'academic_year = ?'];
      const params = [yearNum];

      // Add mandal filter if provided
      if (mandal) {
        conditions.push('mandal = ?');
        params.push(mandal);
      }

      // Add state filter if provided
      if (state) {
        conditions.push('state = ?');
        params.push(state);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const limitNum = Math.min(Math.max(parseInt(count, 10) || 0, 1), 10000);

      // Get available unassigned leads matching criteria (LIMIT must be literal, not placeholder)
      const [availableLeads] = await pool.execute(
        `SELECT id FROM leads ${whereClause} LIMIT ${limitNum}`,
        params
      );

      if (availableLeads.length === 0) {
        return successResponse(
          res,
          {
            assigned: 0,
            requested: parseInt(count),
            message: 'No unassigned leads found matching the criteria',
          },
          'No leads available for assignment',
          200
        );
      }

      leadIdsToAssign = availableLeads.map((lead) => lead.id);
    }

    // Get leads before update to check status
    const placeholders = leadIdsToAssign.map(() => '?').join(',');
    const [leadsToAssign] = await pool.execute(
      `SELECT id, lead_status FROM leads WHERE id IN (${placeholders})`,
      leadIdsToAssign
    );
    
    // Update leads and create activity logs
    const now = new Date();
    let modifiedCount = 0;
    
    for (const lead of leadsToAssign) {
      const oldStatus = lead.lead_status || 'New';
      const newStatus = oldStatus === 'New' ? 'Assigned' : oldStatus;
      
      // Update lead
      await pool.execute(
        `UPDATE leads SET 
          assigned_to = ?, assigned_at = NOW(), assigned_by = ?, lead_status = ?, updated_at = NOW()
         WHERE id = ?`,
        [userId, currentUserId, newStatus, lead.id]
      );
      
      // Create activity log
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'status_change',
          oldStatus,
          newStatus,
          `Assigned to ${user.role_name === 'Sub Super Admin' ? 'sub-admin' : 'counsellor'} ${user.name}`,
          currentUserId,
          JSON.stringify({
            assignment: {
              assignedTo: userId,
              assignedBy: currentUserId,
            },
          }),
        ]
      );
      
      modifiedCount++;
    }

    // Send notifications (async, don't wait for it)
    const isBulk = !leadIds || leadIds.length === 0;
    
    // Get full lead details for notification (limit to 50 for email display)
    const [leadsForNotification] = await pool.execute(
      `SELECT id, name, phone, enquiry_number FROM leads WHERE id IN (${placeholders}) LIMIT 50`,
      leadIdsToAssign
    );
    
    const formattedLeads = leadsForNotification.map(l => ({
      _id: l.id,
      id: l.id,
      name: l.name,
      phone: l.phone,
      enquiryNumber: l.enquiry_number,
    }));
    
    notifyLeadAssignment({
      userId,
      leadCount: modifiedCount,
      leads: formattedLeads,
      isBulk,
      allLeadIds: leadIdsToAssign,
    }).catch((error) => {
      console.error('[LeadAssignment] Error sending notifications:', error);
    });

    return successResponse(
      res,
      {
        assigned: modifiedCount,
        requested: leadIds ? leadIds.length : parseInt(count),
        userId,
        userName: user.name,
        mandal: mandal || 'All',
        state: state || 'All',
        mode: leadIds ? 'single' : 'bulk',
      },
      `Successfully assigned ${modifiedCount} lead${modifiedCount !== 1 ? 's' : ''} to ${user.name}`,
      200
    );
  } catch (error) {
    console.error('Error assigning leads:', error);
    return errorResponse(res, error.message || 'Failed to assign leads', 500);
  }
};

// @desc    Get assignment statistics (unassigned leads count, etc.)
// @route   GET /api/leads/assign/stats
// @access  Private (Super Admin only)
export const getAssignmentStats = async (req, res) => {
  try {
    const { mandal, state, academicYear } = req.query;
    const pool = getPool();

    // Build filter for unassigned leads
    const conditions = ['assigned_to IS NULL'];
    const params = [];

    // Academic year filter (optional; when set, stats are for that year only)
    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        conditions.push('academic_year = ?');
        params.push(year);
      }
    }

    // Add mandal filter if provided
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }

    // Add state filter if provided
    if (state) {
      conditions.push('state = ?');
      params.push(state);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Base filter for total/assigned in same scope (when academic year is selected)
    const baseConditions = [];
    const baseParams = [];
    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        baseConditions.push('academic_year = ?');
        baseParams.push(year);
      }
    }
    const baseWhere = baseConditions.length ? `WHERE ${baseConditions.join(' AND ')}` : '';

    // Get unassigned leads count
    const [unassignedCountResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${whereClause}`,
      params
    );
    const unassignedCount = unassignedCountResult[0].total;

    // Get total leads count (optionally scoped by academic year)
    const [totalLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${baseWhere}`,
      baseParams
    );
    const totalLeads = totalLeadsResult[0].total;

    // Get assigned leads count (in same academic year scope when filter applied)
    const assignedCount = totalLeads - unassignedCount;

    // Get breakdown by mandal (for unassigned leads with same filters)
    const [mandalBreakdown] = await pool.execute(
      `SELECT mandal, COUNT(*) as count 
       FROM leads ${whereClause}
       GROUP BY mandal 
       ORDER BY count DESC 
       LIMIT 20`,
      [...params]
    );

    // Get breakdown by state (for unassigned leads with same filters)
    const [stateBreakdown] = await pool.execute(
      `SELECT state, COUNT(*) as count 
       FROM leads ${whereClause}
       GROUP BY state 
       ORDER BY count DESC`,
      [...params]
    );

    return successResponse(
      res,
      {
        totalLeads,
        assignedCount,
        unassignedCount,
        mandalBreakdown: mandalBreakdown.map((item) => ({
          mandal: item.mandal || 'Unknown',
          count: item.count,
        })),
        stateBreakdown: stateBreakdown.map((item) => ({
          state: item.state || 'Unknown',
          count: item.count,
        })),
      },
      'Assignment statistics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting assignment stats:', error);
    return errorResponse(res, error.message || 'Failed to get assignment statistics', 500);
  }
};

// @desc    Get count of leads assigned to a specific user (optional mandal/state filter)
// @route   GET /api/leads/assign/assigned-count
// @access  Private (Super Admin only)
export const getAssignedCountForUser = async (req, res) => {
  try {
    const { userId, mandal, state, academicYear } = req.query;
    const pool = getPool();

    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    const conditions = ['assigned_to = ?'];
    const params = [userId];

    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        conditions.push('academic_year = ?');
        params.push(year);
      }
    }
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }
    if (state) {
      conditions.push('state = ?');
      params.push(state);
    }

    const [result] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads WHERE ${conditions.join(' AND ')}`,
      params
    );

    const count = result[0]?.total ?? 0;

    return successResponse(
      res,
      { count },
      'Assigned count retrieved',
      200
    );
  } catch (error) {
    console.error('Error getting assigned count for user:', error);
    return errorResponse(res, error.message || 'Failed to get assigned count', 500);
  }
};

// @desc    Remove assignments from a user (bulk unassign)
// @route   POST /api/leads/assign/remove
// @access  Private (Super Admin only)
export const removeAssignments = async (req, res) => {
  try {
    const { userId, mandal, state, academicYear, count } = req.body;
    const pool = getPool();
    const currentUserId = req.user.id || req.user._id;

    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    if (!count || count <= 0) {
      return errorResponse(res, 'Count must be greater than zero', 400);
    }

    // Check user exists
    const [users] = await pool.execute(
      'SELECT id, name FROM users WHERE id = ?',
      [userId]
    );
    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }
    const user = users[0];

    const conditions = ['assigned_to = ?'];
    const params = [userId];
    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        conditions.push('academic_year = ?');
        params.push(year);
      }
    }
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }
    if (state) {
      conditions.push('state = ?');
      params.push(state);
    }

    const limitNum = Math.min(Math.max(parseInt(count, 10) || 0, 1), 10000);

    const [leadsToUnassign] = await pool.execute(
      `SELECT id, lead_status FROM leads WHERE ${conditions.join(' AND ')} LIMIT ${limitNum}`,
      params
    );

    if (leadsToUnassign.length === 0) {
      return successResponse(
        res,
        { removed: 0, requested: limitNum, userName: user.name },
        'No assigned leads found matching the criteria',
        200
      );
    }

    const leadIds = leadsToUnassign.map((l) => l.id);
    const placeholders = leadIds.map(() => '?').join(',');

    await pool.execute(
      `UPDATE leads SET assigned_to = NULL, assigned_at = NULL, assigned_by = NULL, lead_status = 'New', updated_at = NOW() WHERE id IN (${placeholders})`,
      leadIds
    );

    for (const lead of leadsToUnassign) {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'status_change',
          lead.lead_status || 'Assigned',
          'New',
          `Assignment removed from ${user.name}`,
          currentUserId,
          JSON.stringify({
            unassignment: {
              removedFrom: userId,
              removedBy: currentUserId,
            },
          }),
        ]
      );
    }

    return successResponse(
      res,
      {
        removed: leadsToUnassign.length,
        requested: limitNum,
        userId,
        userName: user.name,
      },
      `Successfully removed assignment for ${leadsToUnassign.length} lead${leadsToUnassign.length !== 1 ? 's' : ''} from ${user.name}`,
      200
    );
  } catch (error) {
    console.error('Error removing assignments:', error);
    return errorResponse(res, error.message || 'Failed to remove assignments', 500);
  }
};

// @desc    Get user lead analytics
// @route   GET /api/leads/analytics/:userId
// @access  Private
export const getUserLeadAnalytics = async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserId = req.user.id || req.user._id;
    const pool = getPool();

    // Users can only view their own analytics, Super Admin can view any user's analytics
    if (!hasElevatedAdminPrivileges(req.user.roleName) && userId !== requestingUserId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get total leads assigned to user
    const [totalLeadsResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM leads WHERE assigned_to = ?',
      [userId]
    );
    const totalLeads = totalLeadsResult[0].total;

    // Get leads by status
    const [statusBreakdown] = await pool.execute(
      `SELECT lead_status, COUNT(*) as count 
       FROM leads 
       WHERE assigned_to = ? 
       GROUP BY lead_status 
       ORDER BY count DESC`,
      [userId]
    );

    // Get leads by mandal
    const [mandalBreakdown] = await pool.execute(
      `SELECT mandal, COUNT(*) as count 
       FROM leads 
       WHERE assigned_to = ? 
       GROUP BY mandal 
       ORDER BY count DESC 
       LIMIT 10`,
      [userId]
    );

    // Get leads by state
    const [stateBreakdown] = await pool.execute(
      `SELECT state, COUNT(*) as count 
       FROM leads 
       WHERE assigned_to = ? 
       GROUP BY state 
       ORDER BY count DESC`,
      [userId]
    );

    // Convert status breakdown to object
    const statusCounts = {};
    statusBreakdown.forEach((item) => {
      statusCounts[item.lead_status || 'New'] = item.count;
    });

    // Get recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [recentLeadsResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM leads WHERE assigned_to = ? AND updated_at >= ?',
      [userId, sevenDaysAgo.toISOString().slice(0, 19).replace('T', ' ')]
    );
    const recentLeads = recentLeadsResult[0].total;

    return successResponse(
      res,
      {
        totalLeads,
        statusBreakdown: statusCounts,
        mandalBreakdown: mandalBreakdown.map((item) => ({
          mandal: item.mandal,
          count: item.count,
        })),
        stateBreakdown: stateBreakdown.map((item) => ({
          state: item.state,
          count: item.count,
        })),
        recentActivity: {
          leadsUpdatedLast7Days: recentLeads,
        },
      },
      'Analytics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get analytics', 500);
  }
};

export const getOverviewAnalytics = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const rangeInDays = Number.parseInt(req.query.days, 10) || 14;
    const pool = getPool();

    // Get today's date
    const today = new Date();
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);
    
    // Calculate start date: go back (rangeInDays - 1) days to include today
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (rangeInDays - 1));
    startDate.setHours(0, 0, 0, 0);
    
    // Helper to format date for key matching
    const formatDateKey = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const startDateStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endDateStr = endDate.toISOString().slice(0, 19).replace('T', ' ');

    const leadFilters = [];
    const leadParams = [];
    if (req.query.academicYear != null && req.query.academicYear !== '') {
      leadFilters.push('academic_year = ?');
      leadParams.push(Number(req.query.academicYear));
    }
    if (req.query.studentGroup) {
      leadFilters.push('student_group = ?');
      leadParams.push(req.query.studentGroup);
    }
    const leadWhere = leadFilters.length > 0 ? `WHERE ${leadFilters.join(' AND ')}` : '';
    const leadWhereAnd = (suffix) =>
      leadFilters.length > 0 ? `WHERE ${leadFilters.join(' AND ')} AND ${suffix}` : `WHERE ${suffix}`;

    // Get basic counts
    const [totalLeadsResult] = await pool.execute(`SELECT COUNT(*) as total FROM leads ${leadWhere}`, leadParams);
    const totalLeads = totalLeadsResult[0].total;

    const [confirmedLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${leadWhereAnd("lead_status = 'Confirmed'")}`,
      leadParams
    );
    const confirmedLeads = confirmedLeadsResult[0].total;

    const [admittedLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${leadWhereAnd("lead_status = 'Admitted'")}`,
      leadParams
    );
    const admittedLeads = admittedLeadsResult[0].total;

    const [assignedLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${leadWhereAnd('assigned_to IS NOT NULL')}`,
      leadParams
    );
    const assignedLeads = assignedLeadsResult[0].total;

    const [unassignedLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${leadWhereAnd('assigned_to IS NULL')}`,
      leadParams
    );
    const unassignedLeads = unassignedLeadsResult[0].total;

    // Get lead status breakdown
    const [leadStatusAgg] = await pool.execute(
      `SELECT lead_status, COUNT(*) as count FROM leads ${leadWhere} GROUP BY lead_status`,
      leadParams
    );

    // Get joining status breakdown (NOTE: Requires joinings table - will be updated when joining controller is migrated)
    const [joiningStatusAgg] = await pool.execute(
      'SELECT status, COUNT(*) as count FROM joinings GROUP BY status'
    ).catch(() => [[{ status: 'draft', count: 0 }]]); // Fallback if table doesn't exist yet

    // Get admission status breakdown (NOTE: Requires admissions table - will be updated when admission controller is migrated)
    const [admissionStatusAgg] = await pool.execute(
      'SELECT status, COUNT(*) as count FROM admissions GROUP BY status'
    ).catch(() => [[{ status: 'active', count: 0 }]]); // Fallback if table doesn't exist yet

    const [admissionsTotalResult] = await pool.execute('SELECT COUNT(*) as total FROM admissions')
      .catch(() => [{ total: 0 }]);
    const admissionsTotal = admissionsTotalResult[0].total;

    // Get leads created by date
    const leadsCreatedWhere = leadFilters.length > 0
      ? `${leadWhere} AND created_at >= ? AND created_at <= ?`
      : 'WHERE created_at >= ? AND created_at <= ?';
    const [leadsCreatedAgg] = await pool.execute(
      `SELECT DATE(created_at) as date, COUNT(*) as count 
       FROM leads 
       ${leadsCreatedWhere}
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [...leadParams, startDateStr, endDateStr]
    );

    // Get status changes by date
    const [statusChangesAgg] = await pool.execute(
      `SELECT DATE(created_at) as date, new_status as status, COUNT(*) as count
       FROM activity_logs
       WHERE type = 'status_change' AND created_at >= ? AND created_at <= ?
       GROUP BY DATE(created_at), new_status
       ORDER BY date ASC`,
      [startDateStr, endDateStr]
    );

    // Get joining trends (NOTE: Requires joinings table)
    const [joiningTrendAgg] = await pool.execute(
      `SELECT DATE(updated_at) as date, status, COUNT(*) as count
       FROM joinings
       WHERE updated_at >= ? AND updated_at <= ?
       GROUP BY DATE(updated_at), status
       ORDER BY date ASC`,
      [startDateStr, endDateStr]
    ).catch(() => [[]]); // Fallback if table doesn't exist yet

    // Get admissions by date (NOTE: Requires admissions table)
    const [admissionsAgg] = await pool.execute(
      `SELECT DATE(admission_date) as date, COUNT(*) as count
       FROM admissions
       WHERE admission_date >= ? AND admission_date <= ?
       GROUP BY DATE(admission_date)
       ORDER BY date ASC`,
      [startDateStr, endDateStr]
    ).catch(() => [[]]); // Fallback if table doesn't exist yet

    const leadStatusBreakdown = leadStatusAgg.reduce((acc, item) => {
      const key = item.lead_status || 'Unknown';
      acc[key] = item.count;
      return acc;
    }, {});

    const joiningStatusBreakdown = joiningStatusAgg.reduce((acc, item) => {
      const key = item.status || 'draft';
      acc[key] = item.count;
      return acc;
    }, {});

    const admissionStatusBreakdown = admissionStatusAgg.reduce((acc, item) => {
      const key = item.status || 'active';
      acc[key] = item.count;
      return acc;
    }, {});

    const initDailySeries = () => {
      const series = new Map();
      for (let i = 0; i < rangeInDays; i += 1) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        const key = formatDateKey(date);
        series.set(key, { date: key, count: 0 });
      }
      // Ensure today is included
      const todayKey = formatDateKey(today);
      if (!series.has(todayKey)) {
        series.set(todayKey, { date: todayKey, count: 0 });
      }
      return series;
    };

    const leadsCreatedSeries = initDailySeries();
    leadsCreatedAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      const entry = leadsCreatedSeries.get(dateKey);
      if (entry) {
        entry.count = item.count;
      }
    });

    const statusChangeSeries = new Map();
    statusChangesAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      if (!statusChangeSeries.has(dateKey)) {
        statusChangeSeries.set(dateKey, {
          date: dateKey,
          total: 0,
          statuses: {},
        });
      }
      const bucket = statusChangeSeries.get(dateKey);
      bucket.total += item.count;
      if (item.status) {
        bucket.statuses[item.status] = (bucket.statuses[item.status] || 0) + item.count;
      }
    });
    for (const [dateKey, entry] of statusChangeSeries) {
      if (!entry.statuses.total) {
        entry.statuses.total = entry.total;
      }
    }

    const joiningSeries = new Map();
    joiningTrendAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      if (!joiningSeries.has(dateKey)) {
        joiningSeries.set(dateKey, {
          date: dateKey,
          draft: 0,
          pending_approval: 0,
          approved: 0,
        });
      }
      const bucket = joiningSeries.get(dateKey);
      bucket[item.status] = (bucket[item.status] || 0) + item.count;
    });

    const admissionsSeries = initDailySeries();
    admissionsAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      const entry = admissionsSeries.get(dateKey);
      if (entry) {
        entry.count = item.count;
      }
    });

    const serializeSeries = (seriesMap, defaults = {}) => {
      const buildDefaults = () => {
        const clone = {};
        Object.entries(defaults).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            clone[key] = [...value];
          } else if (value && typeof value === 'object') {
            clone[key] = { ...value };
          } else {
            clone[key] = value;
          }
        });
        return clone;
      };

      const results = [];
      const todayKey = formatDateKey(today);
      
      // Generate all date keys in the range, ensuring today is included
      const allDateKeys = [];
      for (let i = 0; i < rangeInDays; i += 1) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        const key = formatDateKey(date);
        allDateKeys.push(key);
      }
      
      // Ensure today is in the list
      if (!allDateKeys.includes(todayKey)) {
        allDateKeys.push(todayKey);
      }
      
      // Sort to maintain chronological order
      allDateKeys.sort();
      
      // Build results
      for (const key of allDateKeys) {
        if (seriesMap instanceof Map) {
          if (seriesMap.has(key)) {
            results.push(seriesMap.get(key));
          } else {
            results.push({ date: key, ...buildDefaults() });
          }
        } else if (seriesMap[key]) {
          results.push(seriesMap[key]);
        } else {
          results.push({ date: key, ...buildDefaults() });
        }
      }
      return results;
    };

    const overview = {
      totals: {
        leads: totalLeads,
        confirmedLeads,
        admittedLeads,
        assignedLeads,
        unassignedLeads,
        joinings: {
          draft: joiningStatusBreakdown.draft || 0,
          pendingApproval: joiningStatusBreakdown.pending_approval || 0,
          approved: joiningStatusBreakdown.approved || 0,
        },
        admissions: admissionsTotal,
      },
      leadStatusBreakdown,
      joiningStatusBreakdown,
      admissionStatusBreakdown,
      daily: {
        leadsCreated: serializeSeries(leadsCreatedSeries),
        statusChanges: serializeSeries(statusChangeSeries, { total: 0, statuses: {} }),
        joiningProgress: serializeSeries(joiningSeries, {
          draft: 0,
          pending_approval: 0,
          approved: 0,
        }),
        admissions: serializeSeries(admissionsSeries),
      },
    };

    return successResponse(res, overview, 'Overview analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting overview analytics:', error);
    return errorResponse(res, error.message || 'Failed to get overview analytics', 500);
  }
};

// @desc    Get user-specific analytics (assigned leads and status breakdown)
// @route   GET /api/leads/analytics/users
// @access  Private (Super Admin)
export const getUserAnalytics = async (req, res) => {
  try {
    // Allow Super Admin, Sub Super Admin, and Managers
    const isAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    const isManager = req.user.isManager === true;
    const pool = getPool();
    const currentUserId = req.user.id || req.user._id;
    
    if (!isAdmin && !isManager) {
      return errorResponse(res, 'Access denied', 403);
    }

    const { startDate, endDate, userId } = req.query;
    
    // Set date range for filtering activities
    let activityDateConditions = [];
    let activityDateParams = [];
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      activityDateConditions.push('>= ?');
      activityDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      activityDateConditions.push('<= ?');
      activityDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    const activityDateClause = activityDateConditions.length > 0 
      ? `AND ${activityDateConditions.map((c, i) => `sent_at ${c}`).join(' AND ')}`
      : '';

    // Build user filter
    let userConditions = ["role_name NOT IN ('Super Admin', 'Sub Super Admin')"];
    let userParams = [];

    // If manager, only show their team members
    if (isManager && !isAdmin) {
      userConditions.push('managed_by = ?');
      userParams.push(currentUserId);
    }

    // If userId is provided, filter to that specific user
    if (userId) {
      userConditions = ['id = ?'];
      userParams = [userId];
    }

    const userWhereClause = `WHERE ${userConditions.join(' AND ')}`;

    // Get users based on filter
    const [users] = await pool.execute(
      `SELECT id, name, email, role_name, is_active FROM users ${userWhereClause}`,
      userParams
    );

    // Get analytics for each user with comprehensive data including activity logs
    const userAnalytics = await Promise.all(
      users.map(async (user) => {
        const userId = user.id;

        // Count total assigned leads
        const [totalAssignedResult] = await pool.execute(
          'SELECT COUNT(*) as total FROM leads WHERE assigned_to = ?',
          [userId]
        );
        const totalAssigned = totalAssignedResult[0].total;

        // Get status breakdown for assigned leads
        const [statusBreakdown] = await pool.execute(
          `SELECT lead_status, COUNT(*) as count 
           FROM leads 
           WHERE assigned_to = ? 
           GROUP BY lead_status`,
          [userId]
        );

        const statusMap = {};
        statusBreakdown.forEach((item) => {
          statusMap[item.lead_status || 'Unknown'] = item.count;
        });

        // Get active leads (leads with status not 'Admitted' or 'Closed')
        const [activeLeadsResult] = await pool.execute(
          `SELECT COUNT(*) as total 
           FROM leads 
           WHERE assigned_to = ? AND lead_status NOT IN ('Admitted', 'Closed', 'Cancelled')`,
          [userId]
        );
        const activeLeads = activeLeadsResult[0].total;

        // Get converted leads (leads that have admissions) - NOTE: Requires admissions table
        const [convertedLeadsResult] = await pool.execute(
          `SELECT COUNT(DISTINCT a.lead_id) as total
           FROM admissions a
           INNER JOIN leads l ON a.lead_id = l.id
           WHERE l.assigned_to = ?`,
          [userId]
        ).catch(() => [{ total: 0 }]);
        const convertedLeads = convertedLeadsResult[0].total;

        // Get user's leads for activity tracking
        const [userLeads] = await pool.execute(
          'SELECT id, name, phone, enquiry_number FROM leads WHERE assigned_to = ?',
          [userId]
        );
        const leadIds = userLeads.map((lead) => lead.id);
        
        // Get calls made by this user in the period - NOTE: Requires communications table
        const callDateClause = activityDateConditions.length > 0
          ? `AND sent_at ${activityDateConditions.map((c, i) => c).join(' AND ')}`
          : '';
        
        const [calls] = await pool.execute(
          `SELECT c.*, l.id as lead_id, l.name as lead_name, l.phone as lead_phone, l.enquiry_number
           FROM communications c
           LEFT JOIN leads l ON c.lead_id = l.id
           WHERE c.sent_by = ? AND c.type = 'call' ${callDateClause}
           ORDER BY c.sent_at DESC`,
          [userId, ...activityDateParams]
        ).catch(() => [[]]);

        const totalCalls = calls.length;
        const totalCallDuration = calls.reduce((sum, call) => sum + (call.duration_seconds || 0), 0);
        const callsByLead = {};
        calls.forEach((call) => {
          const leadId = call.lead_id || 'unknown';
          if (!callsByLead[leadId]) {
            callsByLead[leadId] = {
              leadId,
              leadName: call.lead_name || 'Unknown',
              leadPhone: call.lead_phone || call.contact_number,
              enquiryNumber: call.enquiry_number || '',
              callCount: 0,
              totalDuration: 0,
              calls: [],
            };
          }
          callsByLead[leadId].callCount += 1;
          callsByLead[leadId].totalDuration += call.duration_seconds || 0;
          callsByLead[leadId].calls.push({
            date: call.sent_at,
            duration: call.duration_seconds || 0,
            outcome: call.call_outcome || 'N/A',
            remarks: call.remarks || '',
          });
        });

        // Get SMS/texts sent by this user in the period - NOTE: Requires communications table
        const smsDateClause = activityDateConditions.length > 0
          ? `AND sent_at ${activityDateConditions.map((c, i) => c).join(' AND ')}`
          : '';
        
        const [smsMessages] = await pool.execute(
          `SELECT c.*, l.id as lead_id, l.name as lead_name, l.phone as lead_phone, l.enquiry_number,
           t.name as template_name
           FROM communications c
           LEFT JOIN leads l ON c.lead_id = l.id
           LEFT JOIN message_templates t ON c.template_id = t.id
           WHERE c.sent_by = ? AND c.type = 'sms' ${smsDateClause}
           ORDER BY c.sent_at DESC`,
          [userId, ...activityDateParams]
        ).catch(() => [[]]);

        const totalSMS = smsMessages.length;
        const smsByLead = {};
        const templateUsage = {};

        smsMessages.forEach((sms) => {
          const leadId = sms.lead_id || 'unknown';
          if (!smsByLead[leadId]) {
            smsByLead[leadId] = {
              leadId,
              leadName: sms.lead_name || 'Unknown',
              leadPhone: sms.lead_phone || sms.contact_number,
              enquiryNumber: sms.enquiry_number || '',
              smsCount: 0,
              messages: [],
            };
          }
          smsByLead[leadId].smsCount += 1;
          smsByLead[leadId].messages.push({
            date: sms.sent_at,
            template: sms.template_name || 'Custom',
            status: sms.status || 'unknown',
          });

          // Track template usage
          const templateName = sms.template_name || 'Custom';
          if (!templateUsage[templateName]) {
            templateUsage[templateName] = {
              name: templateName,
              count: 0,
              leads: new Set(),
            };
          }
          templateUsage[templateName].count += 1;
          if (leadId !== 'unknown') {
            templateUsage[templateName].leads.add(leadId);
          }
        });

        // Convert template usage Set to count
        const templateUsageArray = Object.values(templateUsage).map((t) => ({
          name: t.name,
          count: t.count,
          uniqueLeads: t.leads.size,
        }));

        // Get status conversions made by this user in the period
        const statusChangeDateClause = activityDateConditions.length > 0
          ? `AND created_at ${activityDateConditions.map((c, i) => c).join(' AND ')}`
          : '';
        
        const [statusChanges] = await pool.execute(
          `SELECT a.*, l.id as lead_id, l.name as lead_name, l.phone as lead_phone, l.enquiry_number
           FROM activity_logs a
           LEFT JOIN leads l ON a.lead_id = l.id
           WHERE a.performed_by = ? AND a.type = 'status_change' ${statusChangeDateClause}
           ORDER BY a.created_at DESC`,
          [userId, ...activityDateParams]
        );

        const totalStatusChanges = statusChanges.length;
        const statusConversions = {};
        const conversionsByLead = {};

        statusChanges.forEach((change) => {
          const conversion = `${change.old_status || 'Unknown'} → ${change.new_status || 'Unknown'}`;
          if (!statusConversions[conversion]) {
            statusConversions[conversion] = 0;
          }
          statusConversions[conversion] += 1;

          const leadId = change.lead_id || 'unknown';
          if (!conversionsByLead[leadId]) {
            conversionsByLead[leadId] = {
              leadId,
              leadName: change.lead_name || 'Unknown',
              leadPhone: change.lead_phone || '',
              enquiryNumber: change.enquiry_number || '',
              conversions: [],
            };
          }
          conversionsByLead[leadId].conversions.push({
            from: change.old_status || 'Unknown',
            to: change.new_status || 'Unknown',
            date: change.created_at,
          });
        });

        // Get activity logs count for this user's leads
        let activityLogsCount = 0;
        if (leadIds.length > 0) {
          const placeholders = leadIds.map(() => '?').join(',');
          const [activityLogsCountResult] = await pool.execute(
            `SELECT COUNT(*) as total FROM activity_logs WHERE lead_id IN (${placeholders})`,
            leadIds
          );
          activityLogsCount = activityLogsCountResult[0].total;
        }

        // Get recent activity (last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        let recentActivityCount = 0;
        if (leadIds.length > 0) {
          const placeholders = leadIds.map(() => '?').join(',');
          const [recentActivityCountResult] = await pool.execute(
            `SELECT COUNT(*) as total 
             FROM activity_logs 
             WHERE lead_id IN (${placeholders}) AND created_at >= ?`,
            [...leadIds, sevenDaysAgo.toISOString().slice(0, 19).replace('T', ' ')]
          );
          recentActivityCount = recentActivityCountResult[0].total;
        }

        // Get source breakdown for assigned leads
        const [sourceBreakdown] = await pool.execute(
          `SELECT source, COUNT(*) as count 
           FROM leads 
           WHERE assigned_to = ? 
           GROUP BY source 
           ORDER BY count DESC 
           LIMIT 10`,
          [userId]
        );

        const sourceMap = {};
        sourceBreakdown.forEach((item) => {
          sourceMap[item.source || 'Unknown'] = item.count;
        });

        // Get course breakdown
        const [courseBreakdown] = await pool.execute(
          `SELECT course_interested, COUNT(*) as count 
           FROM leads 
           WHERE assigned_to = ? 
           GROUP BY course_interested 
           ORDER BY count DESC 
           LIMIT 10`,
          [userId]
        );

        const courseMap = {};
        courseBreakdown.forEach((item) => {
          courseMap[item.course_interested || 'Unknown'] = item.count;
        });

        return {
          userId: userId,
          userName: user.name,
          name: user.name,
          email: user.email,
          roleName: user.role_name,
          isActive: user.is_active === 1 || user.is_active === true,
          totalAssigned,
          activeLeads,
          convertedLeads,
          conversionRate: totalAssigned > 0 ? parseFloat(((convertedLeads / totalAssigned) * 100).toFixed(2)) : 0,
          statusBreakdown: statusMap,
          sourceBreakdown: sourceMap,
          courseBreakdown: courseMap,
          activityLogsCount,
          recentActivityCount,
          // Detailed communication and activity data
          calls: {
            total: totalCalls,
            totalDuration: totalCallDuration,
            averageDuration: totalCalls > 0 ? Math.round(totalCallDuration / totalCalls) : 0,
            byLead: Object.values(callsByLead),
          },
          sms: {
            total: totalSMS,
            byLead: Object.values(smsByLead),
            templateUsage: templateUsageArray.sort((a, b) => b.count - a.count),
          },
          statusConversions: {
            total: totalStatusChanges,
            breakdown: statusConversions,
            byLead: Object.values(conversionsByLead),
          },
        };
      }),
    );

    return successResponse(res, { users: userAnalytics }, 'User analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get user analytics', 500);
  }
};

