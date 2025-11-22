import NotificationConfig from '../models/NotificationConfig.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';

// @desc    Get notification configuration
// @route   GET /api/notifications/config
// @access  Private (Super Admin only)
export const getNotificationConfig = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const configs = await NotificationConfig.find().lean();

    // Format response with defaults
    const formattedConfigs = {
      email_channel: 'brevo', // Default
      sms_channel: 'bulksms', // Default
      push_enabled: 'true', // Default
    };

    configs.forEach((config) => {
      formattedConfigs[config.type] = config.value;
    });

    return successResponse(res, formattedConfigs, 'Notification configuration retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting notification config:', error);
    return errorResponse(res, error.message || 'Failed to get notification configuration', 500);
  }
};

// @desc    Update notification configuration
// @route   PUT /api/notifications/config
// @access  Private (Super Admin only)
export const updateNotificationConfig = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const { email_channel, sms_channel, push_enabled } = req.body;

    const updates = [];

    // Update email channel
    if (email_channel !== undefined) {
      if (!['brevo', 'nodemailer', 'both'].includes(email_channel)) {
        return errorResponse(res, 'Invalid email_channel. Must be "brevo", "nodemailer", or "both"', 400);
      }

      const emailConfig = await NotificationConfig.findOneAndUpdate(
        { type: 'email_channel' },
        {
          type: 'email_channel',
          value: email_channel,
          description: 'Email sending channel preference: brevo, nodemailer, or both',
          updatedBy: req.user._id,
        },
        { upsert: true, new: true }
      );
      updates.push(emailConfig);
    }

    // Update SMS channel (for future use)
    if (sms_channel !== undefined) {
      const smsConfig = await NotificationConfig.findOneAndUpdate(
        { type: 'sms_channel' },
        {
          type: 'sms_channel',
          value: sms_channel,
          description: 'SMS sending channel preference',
          updatedBy: req.user._id,
        },
        { upsert: true, new: true }
      );
      updates.push(smsConfig);
    }

    // Update push enabled
    if (push_enabled !== undefined) {
      const pushConfig = await NotificationConfig.findOneAndUpdate(
        { type: 'push_enabled' },
        {
          type: 'push_enabled',
          value: String(push_enabled),
          description: 'Enable or disable push notifications',
          updatedBy: req.user._id,
        },
        { upsert: true, new: true }
      );
      updates.push(pushConfig);
    }

    // Format response
    const formattedConfigs = {
      email_channel: 'brevo',
      sms_channel: 'bulksms',
      push_enabled: 'true',
    };

    updates.forEach((config) => {
      formattedConfigs[config.type] = config.value;
    });

    return successResponse(res, formattedConfigs, 'Notification configuration updated successfully', 200);
  } catch (error) {
    console.error('Error updating notification config:', error);
    return errorResponse(res, error.message || 'Failed to update notification configuration', 500);
  }
};

// @desc    Test email channels
// @route   POST /api/notifications/config/test-email
// @access  Private (Super Admin only)
export const testEmailChannels = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const { testEmail } = req.body;

    if (!testEmail || !testEmail.trim()) {
      return errorResponse(res, 'Test email address is required', 400);
    }

    const { testEmailChannels: testChannels } = await import('../services/unifiedEmail.service.js');
    const results = await testChannels(testEmail.trim());

    return successResponse(
      res,
      results,
      `Email channel test completed. Brevo: ${results.brevo.success ? 'Success' : 'Failed'}, NodeMailer: ${results.nodemailer.success ? 'Success' : 'Failed'}`,
      200
    );
  } catch (error) {
    console.error('Error testing email channels:', error);
    return errorResponse(res, error.message || 'Failed to test email channels', 500);
  }
};

