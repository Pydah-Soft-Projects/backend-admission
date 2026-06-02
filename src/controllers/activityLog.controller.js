import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import {
  resolveLeadStatus,
  resolveLeadStatusAfterChannelWrite,
  defaultActivityStatusChannel,
} from '../utils/leadChannelStatus.util.js';
import { applyReference1OnCallStatusConfirm, isCallStatusConfirmedValue } from '../utils/joiningReference.util.js';
import { managerCanAccessLead } from '../utils/managerLeadAccess.util.js';
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
    const { comment, newStatus, newQuota, statusChannel, type = 'comment', visitDate } = req.body;
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
    const isSuperAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    const isAdmin = req.user.roleName === 'Admin';
    const isPro = req.user.roleName === 'PRO';
    const isStudentCounselor = req.user.roleName === 'Student Counselor';
    const isAssigned = lead.assigned_to === userId || lead.assigned_to_pro === userId;
    const managerHasLeadAccess =
      req.user.isManager === true && (await managerCanAccessLead(pool, userId, lead));

    if (!isSuperAdmin && !isAdmin && !isPro && !isAssigned && !managerHasLeadAccess) {
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

    // If a specific visit date is provided (YYYY-MM-DD), store it so the analytics layer
    // can group this diary entry under the PRO-selected date rather than NOW().
    if (visitDate && typeof visitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(visitDate.trim())) {
      metadata.visitDate = visitDate.trim();
    }

    const nextCallBase = lead.call_status ?? null;
    const nextVisitBase = lead.visit_status ?? null;

    if (newStatus) {
      // Determine which channel to update. 
      // Defaults: PRO -> visit_status, Student Counselor -> call_status, Others -> lead_status.
      // Can be overridden by statusChannel in request body.
      const requestedChannel = defaultActivityStatusChannel({
        statusChannel,
        isManager: req.user.isManager === true,
        roleName: req.user.roleName,
        newStatus,
      });
      
      if (
        isSuperAdmin ||
        isAdmin ||
        managerHasLeadAccess ||
        (isStudentCounselor && lead.assigned_to === userId) ||
        (isPro && lead.assigned_to_pro === userId) ||
        (isAssigned && !isPro && !isStudentCounselor)
      ) {
        
        if (requestedChannel === 'visit_status') {
          // Guard: Visit Diary entries must never set visit_status to "Assigned".
          // "Assigned" is reserved for assignment workflow, not outcomes.
          if (metadata.visitDate && String(newStatus).trim() === 'Assigned') {
            return errorResponse(res, 'Visit Diary outcome cannot be "Assigned". Please choose an actual visit outcome.', 400);
          }
          const resolved = resolveLeadStatusAfterChannelWrite(
            'visit_status',
            newStatus,
            nextCallBase,
            lead.lead_status
          );
          oldStatus = lead.lead_status;
          newStatusValue = resolved;
          activityType = 'status_change';
          metadata.statusChannel = 'visit_status';
          metadata.visitStatus = newStatus;
          
          updateFields.push('visit_status = ?');
          updateValues.push(newStatus);

          const visitUnchanged =
            String(lead.visit_status ?? '').trim() === String(newStatus).trim();
          if (visitUnchanged && resolved !== lead.lead_status) {
            metadata.pipelineResync = true;
          }

          updateFields.push('lead_status = ?');
          updateValues.push(resolved);
          leadModified = true;
        } else if (requestedChannel === 'call_status') {
          const resolved = resolveLeadStatusAfterChannelWrite(
            'call_status',
            newStatus,
            nextVisitBase,
            lead.lead_status
          );
          oldStatus = lead.lead_status;
          newStatusValue = resolved;
          activityType = 'status_change';
          metadata.statusChannel = 'call_status';
          metadata.callStatus = newStatus;

          const callUnchanged =
            String(lead.call_status ?? '').trim() === String(newStatus).trim();
          if (callUnchanged && resolved !== lead.lead_status) {
            metadata.pipelineResync = true;
          }

          updateFields.push('call_status = ?');
          updateValues.push(newStatus);

          updateFields.push('lead_status = ?');
          updateValues.push(resolved);
          leadModified = true;
        } else {
          // Default to lead_status update
          const resolved = resolveLeadStatus(newStatus, nextCallBase, nextVisitBase);
          if (resolved !== lead.lead_status) {
            oldStatus = lead.lead_status;
            newStatusValue = resolved;
            activityType = 'status_change';
            metadata.statusChannel = 'lead_status';
            updateFields.push('lead_status = ?');
            updateValues.push(resolved);
            leadModified = true;
          }
        }
      }
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

    // Counsellor touched lead while a PRO is assigned → queue field visit as "Assigned" for PRO
    if (
      isStudentCounselor &&
      lead.assigned_to === userId &&
      lead.assigned_to_pro &&
      !updateFields.some((f) => String(f).startsWith('visit_status')) &&
      (leadModified || (comment && comment.trim()))
    ) {
      updateFields.push('visit_status = ?');
      updateValues.push('Assigned');
      leadModified = true;
    }

    // Update lead if modified
    if (leadModified) {
      const callMarkedConfirmed =
        metadata.statusChannel === 'call_status' &&
        isCallStatusConfirmedValue(metadata.callStatus ?? newStatus);
      if (callMarkedConfirmed) {
        await applyReference1OnCallStatusConfirm(pool, lead, updateFields, updateValues, null, userId);
      }
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
      `SELECT a.*, u.id as performed_by_id, u.name as performed_by_name, u.email as performed_by_email, u.role_name as performed_by_role_name
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
      roleName: activityLogs[0].performed_by_role_name,
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
      'SELECT assigned_to, assigned_to_pro FROM leads WHERE id = ?',
      [leadId]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const lead = leads[0];

    // Check if user has access
    const isSuperAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    const isAdmin = req.user.roleName === 'Admin';
    const isProViewer = req.user.roleName === 'PRO';
    const isStudentCounselorViewer = req.user.roleName === 'Student Counselor';
    const managerHasLeadAccess =
      req.user.isManager === true && (await managerCanAccessLead(pool, userId, lead));
    const isElevatedViewer = isSuperAdmin || isAdmin || managerHasLeadAccess;
    const isAssigned = lead.assigned_to === userId || lead.assigned_to_pro === userId;

    if (!isSuperAdmin && !isAdmin && !isProViewer && !isAssigned && !managerHasLeadAccess) {
      return errorResponse(res, 'Access denied', 403);
    }

    let roleFilterSql = '';
    if (!isElevatedViewer && isProViewer) {
      roleFilterSql = ` AND (
        u.role_name = 'PRO'
        OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.statusChannel')) = 'visit_status'
        OR JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')) = 'PRO'
      )`;
    } else if (!isElevatedViewer && isStudentCounselorViewer) {
      roleFilterSql = ` AND (
        (u.role_name IS NULL OR u.role_name != 'PRO')
        AND IFNULL(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.statusChannel')), '') != 'visit_status'
        AND IFNULL(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')), '') != 'PRO'
      )`;
    }

    // Get total count (same role filter as list)
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM activity_logs a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.lead_id = ?${roleFilterSql}`,
      [leadId]
    );
    const total = countResult[0].total;

    // Get activity logs with user info
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [logs] = await pool.execute(
      `SELECT a.*, u.id as performed_by_id, u.name as performed_by_name, u.email as performed_by_email, u.role_name as performed_by_role_name
       FROM activity_logs a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.lead_id = ?${roleFilterSql}
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
        roleName: log.performed_by_role_name,
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

