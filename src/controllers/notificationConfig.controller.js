import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { v4 as uuidv4 } from 'uuid';

// @desc    Get notification configuration
// @route   GET /api/notifications/config
// @access  Private (Super Admin only)
export const getNotificationConfig = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const pool = getPool();

    // Get all notification configs
    const [configs] = await pool.execute(
      'SELECT type, value FROM notification_configs'
    );

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
    const pool = getPool();
    const userId = req.user?.id || req.user?._id;
    const updates = [];

    // Update email channel
    if (email_channel !== undefined) {
      if (!['brevo', 'nodemailer', 'both'].includes(email_channel)) {
        return errorResponse(res, 'Invalid email_channel. Must be "brevo", "nodemailer", or "both"', 400);
      }

      // Check if config exists
      const [existing] = await pool.execute(
        'SELECT id FROM notification_configs WHERE type = ?',
        ['email_channel']
      );

      if (existing.length > 0) {
        await pool.execute(
          'UPDATE notification_configs SET value = ?, description = ?, updated_by = ?, updated_at = NOW() WHERE type = ?',
          [email_channel, 'Email sending channel preference: brevo, nodemailer, or both', userId, 'email_channel']
        );
      } else {
        const configId = uuidv4();
        await pool.execute(
          'INSERT INTO notification_configs (id, type, value, description, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
          [configId, 'email_channel', email_channel, 'Email sending channel preference: brevo, nodemailer, or both', userId]
        );
      }
      updates.push({ type: 'email_channel', value: email_channel });
    }

    // Update SMS channel (for future use)
    if (sms_channel !== undefined) {
      const [existing] = await pool.execute(
        'SELECT id FROM notification_configs WHERE type = ?',
        ['sms_channel']
      );

      if (existing.length > 0) {
        await pool.execute(
          'UPDATE notification_configs SET value = ?, description = ?, updated_by = ?, updated_at = NOW() WHERE type = ?',
          [sms_channel, 'SMS sending channel preference', userId, 'sms_channel']
        );
      } else {
        const configId = uuidv4();
        await pool.execute(
          'INSERT INTO notification_configs (id, type, value, description, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
          [configId, 'sms_channel', sms_channel, 'SMS sending channel preference', userId]
        );
      }
      updates.push({ type: 'sms_channel', value: sms_channel });
    }

    // Update push enabled
    if (push_enabled !== undefined) {
      const [existing] = await pool.execute(
        'SELECT id FROM notification_configs WHERE type = ?',
        ['push_enabled']
      );

      if (existing.length > 0) {
        await pool.execute(
          'UPDATE notification_configs SET value = ?, description = ?, updated_by = ?, updated_at = NOW() WHERE type = ?',
          [String(push_enabled), 'Enable or disable push notifications', userId, 'push_enabled']
        );
      } else {
        const configId = uuidv4();
        await pool.execute(
          'INSERT INTO notification_configs (id, type, value, description, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
          [configId, 'push_enabled', String(push_enabled), 'Enable or disable push notifications', userId]
        );
      }
      updates.push({ type: 'push_enabled', value: String(push_enabled) });
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

