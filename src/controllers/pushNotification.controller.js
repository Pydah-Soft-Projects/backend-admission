import { successResponse, errorResponse } from '../utils/response.util.js';
import {
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
  sendPushNotificationToUser,
} from '../services/pushNotification.service.js';
import { protect } from '../middleware/auth.middleware.js';

// @desc    Get VAPID public key for client registration
// @route   GET /api/notifications/push/vapid-key
// @access  Private
export const getVapidKey = async (req, res) => {
  try {
    const publicKey = getVapidPublicKey();
    return successResponse(res, { publicKey }, 'VAPID public key retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting VAPID key:', error);
    // Return a more helpful error message
    return errorResponse(
      res,
      'VAPID keys are not configured. Please set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your environment variables. Run: npm run generate:vapid-keys',
      503 // Service Unavailable - configuration issue
    );
  }
};

// @desc    Subscribe user to push notifications
// @route   POST /api/notifications/push/subscribe
// @access  Private
export const subscribeToPush = async (req, res) => {
  try {
    const { subscription } = req.body;
    const userId = req.user.id || req.user._id;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return errorResponse(res, 'Valid push subscription is required', 400);
    }

    const savedSubscription = await savePushSubscription(userId, subscription);

    return successResponse(
      res,
      { subscriptionId: savedSubscription.id },
      'Successfully subscribed to push notifications',
      200
    );
  } catch (error) {
    console.error('Error subscribing to push:', error);
    return errorResponse(res, error.message || 'Failed to subscribe to push notifications', 500);
  }
};

// @desc    Unsubscribe user from push notifications
// @route   POST /api/notifications/push/unsubscribe
// @access  Private
export const unsubscribeFromPush = async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userId = req.user.id || req.user._id;

    if (!endpoint) {
      return errorResponse(res, 'Subscription endpoint is required', 400);
    }

    const removed = await removePushSubscription(userId, endpoint);

    if (!removed) {
      return errorResponse(res, 'Subscription not found', 404);
    }

    return successResponse(res, {}, 'Successfully unsubscribed from push notifications', 200);
  } catch (error) {
    console.error('Error unsubscribing from push:', error);
    return errorResponse(res, error.message || 'Failed to unsubscribe from push notifications', 500);
  }
};

// @desc    Send test push notification to current user
// @route   POST /api/notifications/push/test
// @access  Private
export const sendTestPush = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    const result = await sendPushNotificationToUser(userId, {
      title: 'Test Notification',
      body: 'This is a test push notification from CRM Admissions',
      url: '/superadmin/dashboard',
      data: {
        type: 'test',
        timestamp: Date.now(),
      },
    });

    return successResponse(
      res,
      {
        sent: result.sent,
        failed: result.failed,
        total: result.total,
      },
      `Test notification sent. ${result.sent} delivered, ${result.failed} failed`,
      200
    );
  } catch (error) {
    console.error('Error sending test push:', error);
    return errorResponse(res, error.message || 'Failed to send test notification', 500);
  }
};

// @desc    Get user's push subscriptions (for debugging)
// @route   GET /api/notifications/push/subscriptions
// @access  Private
export const getUserSubscriptions = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const pool = getPool();

    const [subscriptions] = await pool.execute(
      'SELECT id, endpoint, is_active, created_at, updated_at FROM push_subscriptions WHERE user_id = ? AND is_active = ?',
      [userId, true]
    );

    return successResponse(
      res,
      {
        userId,
        count: subscriptions.length,
        subscriptions: subscriptions.map((sub) => ({
          id: sub.id,
          endpoint: sub.endpoint.substring(0, 50) + '...',
          isActive: sub.is_active === 1 || sub.is_active === true,
          createdAt: sub.created_at,
          updatedAt: sub.updated_at,
        })),
      },
      `Found ${subscriptions.length} active subscription(s)`,
      200
    );
  } catch (error) {
    console.error('Error getting user subscriptions:', error);
    return errorResponse(res, error.message || 'Failed to get subscriptions', 500);
  }
};

// @desc    Send test notifications (push and email) to all users
// @route   POST /api/notifications/test-all
// @access  Private (Super Admin only)
export const sendTestNotificationsToAll = async (req, res) => {
  try {
    const { hasElevatedAdminPrivileges } = await import('../utils/role.util.js');
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const { getPool } = await import('../config-sql/database.js');
    const { sendPushNotificationToUsers } = await import('../services/pushNotification.service.js');
    const { sendEmail } = await import('../services/unifiedEmail.service.js');
    const pool = getPool();

    // Get all active users
    const [users] = await pool.execute(
      'SELECT id, name, email FROM users WHERE is_active = ?',
      [true]
    );

    if (users.length === 0) {
      return errorResponse(res, 'No active users found', 404);
    }

    const results = {
      push: { sent: 0, failed: 0, total: 0 },
      email: { sent: 0, failed: 0, total: 0 },
    };

    // Send personalized push notifications to all users
    try {
      const pushPromises = users.map(async (user) => {
        try {
          const pushResult = await sendPushNotificationToUser(user.id, {
            title: `Hello ${user.name}! 👋`,
            body: `This is a personalized test notification. The notification system is working correctly!`,
            icon: '/icon-192x192.png',
            badge: '/icon-192x192.png',
            url: '/superadmin/dashboard',
            data: {
              type: 'test_all',
              userId: user.id,
              userName: user.name,
              timestamp: Date.now(),
            },
            // Action buttons for push notifications
            actions: [
              {
                action: 'view-dashboard',
                title: '📊 View Dashboard',
                icon: '/icon-192x192.png',
              },
              {
                action: 'view-leads',
                title: '👥 View Leads',
                icon: '/icon-192x192.png',
              },
            ],
          });
          return { userId: user.id, result: pushResult };
        } catch (error) {
          console.error(`Error sending push to user ${user.id}:`, error);
          return { userId: user.id, result: { sent: 0, failed: 1 } };
        }
      });

      const pushResults = await Promise.allSettled(pushPromises);
      
      pushResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.result) {
          results.push.sent += result.value.result.sent || 0;
          results.push.failed += result.value.result.failed || 0;
        } else {
          results.push.failed++;
        }
      });
      
      results.push.total = users.length;
    } catch (error) {
      console.error('Error sending push notifications:', error);
      results.push.failed = users.length;
      results.push.total = users.length;
    }

    // Send email notifications to all users with email addresses
    const usersWithEmail = users.filter((u) => u.email && u.email.trim());
    if (usersWithEmail.length > 0) {
      const emailPromises = usersWithEmail.map(async (user) => {
        try {
            const emailResult = await sendEmail({
              to: user.email,
              subject: `Hello ${user.name}! Test Notification - CRM Admissions`,
              htmlContent: `
              <!DOCTYPE html>
              <html>
                <head>
                  <meta charset="utf-8">
                  <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
                    .greeting { font-size: 18px; font-weight: bold; color: #4F46E5; margin-bottom: 15px; }
                    .button { display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px; margin: 10px 5px; }
                    .button:hover { background-color: #4338CA; }
                    .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 12px; }
                    .info-box { background-color: #EFF6FF; border-left: 4px solid #4F46E5; padding: 15px; margin: 20px 0; border-radius: 4px; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="header">
                      <h1>👋 Hello ${user.name}!</h1>
                      <p style="margin: 0; opacity: 0.9;">Test Notification from CRM Admissions</p>
                    </div>
                    <div class="content">
                      <div class="greeting">Hello ${user.name},</div>
                      <p>This is a <strong>personalized test notification</strong> sent to verify that our notification system is working correctly.</p>
                      
                      <div class="info-box">
                        <p style="margin: 0;"><strong>✅ Notification Status:</strong> Working correctly!</p>
                        <p style="margin: 5px 0 0 0;"><strong>📧 Email Channel:</strong> Active</p>
                        <p style="margin: 5px 0 0 0;"><strong>🔔 Push Channel:</strong> Active</p>
                      </div>
                      
                      <p>You can use the buttons below to navigate to different sections:</p>
                      <div style="text-align: center; margin: 20px 0;">
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/superadmin/dashboard" class="button">📊 View Dashboard</a>
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/superadmin/leads" class="button">👥 View Leads</a>
                      </div>
                      
                      <p style="margin-top: 30px;">If you received this email, the email notification system is working correctly!</p>
                      <p style="margin-top: 20px;">Best regards,<br><strong>CRM Admissions Team</strong></p>
                    </div>
                    <div class="footer">
                      <p>This is an automated test notification. Please do not reply to this email.</p>
                      <p style="margin-top: 5px;">© ${new Date().getFullYear()} CRM Admissions. All rights reserved.</p>
                    </div>
                  </div>
                </body>
              </html>
            `,
            });
          
          // Check if email was actually sent (success=true)
          if (emailResult.success) {
            results.email.sent++;
          } else {
            // Email failed but didn't throw - count as failed
            results.email.failed++;
            console.warn(`Email failed for ${user.email}:`, emailResult.channels);
          }
        } catch (error) {
          console.error(`Error sending email to ${user.email}:`, error.message);
          results.email.failed++;
        }
      });

      await Promise.allSettled(emailPromises);
      results.email.total = usersWithEmail.length;
    }

    const totalSent = results.push.sent + results.email.sent;
    const totalFailed = results.push.failed + results.email.failed;

    return successResponse(
      res,
      {
        push: results.push,
        email: results.email,
        summary: {
          totalUsers: users.length,
          pushSent: results.push.sent,
          pushFailed: results.push.failed,
          emailSent: results.email.sent,
          emailFailed: results.email.failed,
          totalSent,
          totalFailed,
        },
      },
      `Test notifications sent. Push: ${results.push.sent}/${results.push.total} sent, Email: ${results.email.sent}/${results.email.total} sent`,
      200
    );
  } catch (error) {
    console.error('Error sending test notifications to all users:', error);
    return errorResponse(res, error.message || 'Failed to send test notifications', 500);
  }
};

