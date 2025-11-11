import ActivityLog from '../models/ActivityLog.model.js';
import Lead from '../models/Lead.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Add comment and/or update status for a lead
// @route   POST /api/leads/:id/activity
// @access  Private
export const addActivity = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { comment, newStatus, newQuota, type = 'comment' } = req.body;

    // Validate lead exists
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Check if user has access
    if (req.user.roleName !== 'Super Admin' && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    const activityData = {
      leadId: lead._id,
      type: type === 'status_change' ? 'status_change' : comment ? 'comment' : 'follow_up',
      performedBy: req.user._id,
    };
    const metadata = {};
    let leadModified = false;

    // If status is being changed
    if (newStatus && newStatus !== lead.leadStatus) {
      activityData.oldStatus = lead.leadStatus;
      activityData.newStatus = newStatus;
      activityData.type = 'status_change';
      lead.leadStatus = newStatus;
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
        lead.quota = quotaValue;
        leadModified = true;
        if (activityData.type !== 'status_change') {
          activityData.type = 'quota_change';
        }
      }
    }

    // If comment is provided
    if (comment && comment.trim()) {
      activityData.comment = comment.trim();
      if (activityData.type === 'status_change') {
        // If both status change and comment, store as status_change with comment
        activityData.comment = comment.trim();
      } else {
        activityData.type = 'comment';
      }
    }

    if (Object.keys(metadata).length > 0) {
      activityData.metadata = metadata;
    }

    if (leadModified) {
      await lead.save();
    }

    // Create activity log
    const activityLog = await ActivityLog.create(activityData);

    // Populate user info
    await activityLog.populate('performedBy', 'name email');

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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Validate lead exists
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Check if user has access
    if (req.user.roleName !== 'Super Admin' && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get activity logs
    const logs = await ActivityLog.find({ leadId: lead._id })
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ActivityLog.countDocuments({ leadId: lead._id });

    return successResponse(res, {
      logs,
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

