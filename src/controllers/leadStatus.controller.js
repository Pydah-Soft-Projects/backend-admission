import Lead from '../models/Lead.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Update lead status with comment
// @route   PUT /api/leads/:id/status
// @access  Private
export const updateLeadStatus = async (req, res) => {
  try {
    const { status, comment } = req.body;
    const leadId = req.params.id;

    // Validate status
    const validStatuses = ['New', 'Interested', 'Not Interested', 'Partial'];
    if (!status || !validStatuses.includes(status)) {
      return errorResponse(res, 'Invalid status. Must be one of: New, Interested, Not Interested, Partial', 400);
    }

    // Find lead
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Check if user has access
    if (req.user.roleName !== 'Super Admin' && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get old status
    const oldStatus = lead.leadStatus;

    // Update status
    lead.leadStatus = status;
    lead.lastConfirmed = new Date();

    // Add to status logs
    if (!lead.statusLogs) {
      lead.statusLogs = [];
    }

    lead.statusLogs.push({
      status,
      comment: comment || '',
      changedBy: req.user._id,
      changedAt: new Date(),
    });

    await lead.save();

    // Populate the changedBy field for response
    await lead.populate('statusLogs.changedBy', 'name email');

    return successResponse(
      res,
      {
        lead,
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

    const lead = await Lead.findById(leadId)
      .populate('statusLogs.changedBy', 'name email')
      .select('statusLogs');

    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Check if user has access
    if (req.user.roleName !== 'Super Admin' && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    return successResponse(
      res,
      {
        statusLogs: lead.statusLogs || [],
      },
      'Status logs retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting status logs:', error);
    return errorResponse(res, error.message || 'Failed to get status logs', 500);
  }
};

