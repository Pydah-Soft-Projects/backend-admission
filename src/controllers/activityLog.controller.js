import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { v4 as uuidv4 } from 'uuid';

// Helper function to format activity log data
const formatActivityLog = (logData, performedByUser = null) => {
  if (!logData) return null;
  return {
    id: logData.id,
    _id: logData.id,
    leadId: logData.lead_id,
    type: logData.type,
    oldStatus: logData.old_status,
    newStatus: logData.new_status,
    comment: logData.comment,
    performedBy: performedByUser || logData.performed_by,
    metadata: typeof logData.metadata === 'string' 
      ? JSON.parse(logData.metadata) 
      : logData.metadata || {},
    createdAt: logData.created_at,
    updatedAt: logData.updated_at,
  };
};

// @desc    Add comment and/or update status for a lead
// @route   POST /api/leads/:id/activity
// @access  Private
export const addActivity = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { comment, newStatus, newQuota, type = 'comment' } = req.body;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Validate lead exists
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const lead = leads[0];

    // Check if user has access
    if (!hasElevatedAdminPrivileges(req.user.roleName) && lead.assigned_to !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    let activityType = type === 'status_change' ? 'status_change' : comment ? 'comment' : 'follow_up';
    let oldStatus = lead.lead_status;
    let newStatusValue = newStatus;
    let commentValue = comment ? comment.trim() : null;
    const metadata = {};
    let leadModified = false;
    const updateFields = [];
    const updateValues = [];

    // If status is being changed
    if (newStatus && newStatus !== lead.lead_status) {
      oldStatus = lead.lead_status;
      newStatusValue = newStatus;
      activityType = 'status_change';
      updateFields.push('lead_status = ?');
      updateValues.push(newStatus);
      leadModified = true;
    }

    // If quota is being changed
    if (newQuota !== undefined) {
      const normalizedQuota = typeof newQuota === 'string' ? newQuota.trim() : newQuota;
      const quotaValue = normalizedQuota && normalizedQuota.length > 0 ? normalizedQuota : 'Not Applicable';
      if (quotaValue !== lead.quota) {
        metadata.quotaChange = {
          oldQuota: lead.quota || 'Not Applicable',
          newQuota: quotaValue,
        };
        updateFields.push('quota = ?');
        updateValues.push(quotaValue);
        leadModified = true;
        if (activityType !== 'status_change') {
          activityType = 'quota_change';
        }
      }
    }

    // If comment is provided
    if (comment && comment.trim()) {
      commentValue = comment.trim();
      if (activityType === 'status_change') {
        // If both status change and comment, store as status_change with comment
        commentValue = comment.trim();
      } else {
        activityType = 'comment';
      }
    }

    // Update lead if modified
    if (leadModified) {
      updateFields.push('updated_at = NOW()');
      updateValues.push(leadId);
      await pool.execute(
        `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // Create activity log
    const activityLogId = uuidv4();
    await pool.execute(
      `INSERT INTO activity_logs (
        id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        activityLogId,
        leadId,
        activityType,
        oldStatus || null,
        newStatusValue || null,
        commentValue,
        userId,
        JSON.stringify(metadata),
      ]
    );

    // Fetch created activity log with user info
    const [activityLogs] = await pool.execute(
      `SELECT a.*, u.id as performed_by_id, u.name as performed_by_name, u.email as performed_by_email
       FROM activity_logs a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.id = ?`,
      [activityLogId]
    );

    const performedByUser = activityLogs[0].performed_by_id ? {
      id: activityLogs[0].performed_by_id,
      _id: activityLogs[0].performed_by_id,
      name: activityLogs[0].performed_by_name,
      email: activityLogs[0].performed_by_email,
    } : null;

    const activityLog = formatActivityLog(activityLogs[0], performedByUser);

    return successResponse(res, activityLog, 'Activity logged successfully', 201);
  } catch (error) {
    console.error('Error adding activity:', error);
    return errorResponse(res, error.message || 'Failed to add activity', 500);
  }
};

// @desc    Get activity logs for a lead
// @route   GET /api/leads/:id/activity
// @access  Private
export const getActivityLogs = async (req, res) => {
  try {
    const { leadId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Validate lead exists
    const [leads] = await pool.execute(
      'SELECT assigned_to FROM leads WHERE id = ?',
      [leadId]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const lead = leads[0];

    // Check if user has access
    if (!hasElevatedAdminPrivileges(req.user.roleName) && lead.assigned_to !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get total count
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM activity_logs WHERE lead_id = ?',
      [leadId]
    );
    const total = countResult[0].total;

    // Get activity logs with user info
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [logs] = await pool.execute(
      `SELECT a.*, u.id as performed_by_id, u.name as performed_by_name, u.email as performed_by_email
       FROM activity_logs a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.lead_id = ?
       ORDER BY a.created_at DESC
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      [leadId]
    );

    const formattedLogs = logs.map(log => {
      const performedByUser = log.performed_by_id ? {
        id: log.performed_by_id,
        _id: log.performed_by_id,
        name: log.performed_by_name,
        email: log.performed_by_email,
      } : null;
      return formatActivityLog(log, performedByUser);
    });

    return successResponse(res, {
      logs: formattedLogs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    }, 'Activity logs retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting activity logs:', error);
    return errorResponse(res, error.message || 'Failed to get activity logs', 500);
  }
};

