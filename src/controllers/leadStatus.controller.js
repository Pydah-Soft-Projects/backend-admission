import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { v4 as uuidv4 } from 'uuid';

// Helper function to format lead status log
const formatStatusLog = (logData, changedByUser = null) => {
  if (!logData) return null;
  return {
    id: logData.id,
    _id: logData.id,
    status: logData.status,
    comment: logData.comment,
    changedBy: changedByUser || logData.changed_by,
    changedAt: logData.changed_at,
  };
};

// @desc    Update lead status with comment
// @route   PUT /api/leads/:id/status
// @access  Private
export const updateLeadStatus = async (req, res) => {
  try {
    const { status, comment } = req.body;
    const leadId = req.params.id;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Validate status
    const validStatuses = ['New', 'Interested', 'Not Interested', 'Partial'];
    if (!status || !validStatuses.includes(status)) {
      return errorResponse(res, 'Invalid status. Must be one of: New, Interested, Not Interested, Partial', 400);
    }

    // Find lead
    const [leads] = await pool.execute(
      'SELECT lead_status FROM leads WHERE id = ?',
      [leadId]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const lead = leads[0];

    // Check if user has access
    const [leadAccess] = await pool.execute(
      'SELECT assigned_to FROM leads WHERE id = ?',
      [leadId]
    );
    
    if (!hasElevatedAdminPrivileges(req.user.roleName) && leadAccess[0].assigned_to !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get old status
    const oldStatus = lead.lead_status;

    // Update lead status
    await pool.execute(
      'UPDATE leads SET lead_status = ?, last_follow_up = NOW(), updated_at = NOW() WHERE id = ?',
      [status, leadId]
    );

    // Add to status logs
    const statusLogId = uuidv4();
    await pool.execute(
      `INSERT INTO lead_status_logs (id, lead_id, status, comment, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [statusLogId, leadId, status, comment || '', userId]
    );

    // Fetch updated lead with status logs
    const [updatedLeads] = await pool.execute(
      `SELECT l.*, 
       GROUP_CONCAT(
         CONCAT(ls.id, ':', ls.status, ':', COALESCE(ls.comment, ''), ':', ls.changed_by, ':', ls.changed_at)
         ORDER BY ls.changed_at DESC
         SEPARATOR '|'
       ) as status_logs_data
       FROM leads l
       LEFT JOIN lead_status_logs ls ON l.id = ls.lead_id
       WHERE l.id = ?
       GROUP BY l.id`,
      [leadId]
    );

    // For simplicity, fetch status logs separately with user info
    const [statusLogs] = await pool.execute(
      `SELECT ls.*, u.id as changed_by_id, u.name as changed_by_name, u.email as changed_by_email
       FROM lead_status_logs ls
       LEFT JOIN users u ON ls.changed_by = u.id
       WHERE ls.lead_id = ?
       ORDER BY ls.changed_at DESC`,
      [leadId]
    );

    const formattedStatusLogs = statusLogs.map(log => {
      const changedByUser = log.changed_by_id ? {
        id: log.changed_by_id,
        _id: log.changed_by_id,
        name: log.changed_by_name,
        email: log.changed_by_email,
      } : null;
      return formatStatusLog(log, changedByUser);
    });

    // Fetch full lead data
    const [fullLead] = await pool.execute('SELECT * FROM leads WHERE id = ?', [leadId]);
    const formattedLead = {
      id: fullLead[0].id,
      _id: fullLead[0].id,
      leadStatus: fullLead[0].lead_status,
      statusLogs: formattedStatusLogs,
    };

    return successResponse(
      res,
      {
        lead: formattedLead,
        statusChanged: oldStatus !== status,
        oldStatus,
        newStatus: status,
      },
      'Status updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating lead status:', error);
    return errorResponse(res, error.message || 'Failed to update lead status', 500);
  }
};

// @desc    Get lead status logs
// @route   GET /api/leads/:id/status-logs
// @access  Private
export const getLeadStatusLogs = async (req, res) => {
  try {
    const leadId = req.params.id;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Check if lead exists and user has access
    const [leads] = await pool.execute(
      'SELECT assigned_to FROM leads WHERE id = ?',
      [leadId]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    if (!hasElevatedAdminPrivileges(req.user.roleName) && leads[0].assigned_to !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get status logs with user info
    const [statusLogs] = await pool.execute(
      `SELECT ls.*, u.id as changed_by_id, u.name as changed_by_name, u.email as changed_by_email
       FROM lead_status_logs ls
       LEFT JOIN users u ON ls.changed_by = u.id
       WHERE ls.lead_id = ?
       ORDER BY ls.changed_at DESC`,
      [leadId]
    );

    const formattedStatusLogs = statusLogs.map(log => {
      const changedByUser = log.changed_by_id ? {
        id: log.changed_by_id,
        _id: log.changed_by_id,
        name: log.changed_by_name,
        email: log.changed_by_email,
      } : null;
      return formatStatusLog(log, changedByUser);
    });

    return successResponse(
      res,
      {
        statusLogs: formattedStatusLogs,
      },
      'Status logs retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting status logs:', error);
    return errorResponse(res, error.message || 'Failed to get status logs', 500);
  }
};

