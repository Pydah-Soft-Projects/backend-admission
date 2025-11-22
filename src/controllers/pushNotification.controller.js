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
    return errorResponse(res, error.message || 'Failed to get VAPID key', 500);
  }
};

// @desc    Subscribe user to push notifications
// @route   POST /api/notifications/push/subscribe
// @access  Private
export const subscribeToPush = async (req, res) => {
  try {
    const { subscription } = req.body;
    const userId = req.user._id;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return errorResponse(res, 'Valid push subscription is required', 400);
    }

    const savedSubscription = await savePushSubscription(userId, subscription);

    return successResponse(
      res,
      { subscriptionId: savedSubscription._id },
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
    const userId = req.user._id;

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
    const userId = req.user._id;

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

