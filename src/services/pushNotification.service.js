import webpush from 'web-push';
import PushSubscription from '../models/PushSubscription.model.js';

// VAPID keys - should be set in environment variables
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:team@pydasoft.in';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn(
    '[PushNotification] Missing VAPID keys. Push notifications will fail until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set in environment variables.'
  );
} else {
  // Set VAPID details
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/**
 * Get VAPID public key for client registration
 * @returns {string} VAPID public key
 */
export const getVapidPublicKey = () => {
  if (!VAPID_PUBLIC_KEY) {
    throw new Error('VAPID public key is not configured');
  }
  return VAPID_PUBLIC_KEY;
};

/**
 * Send push notification to a specific user
 * @param {string} userId - User ID
 * @param {Object} notification - Notification payload
 * @param {string} notification.title - Notification title
 * @param {string} notification.body - Notification body
 * @param {string} [notification.icon] - Notification icon URL
 * @param {string} [notification.badge] - Notification badge URL
 * @param {string} [notification.url] - URL to open when notification is clicked
 * @param {Object} [notification.data] - Additional data
 * @returns {Promise<Object>} Result with success count and failures
 */
export const sendPushNotificationToUser = async (userId, notification) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('VAPID keys are not configured');
  }

  if (!userId) {
    throw new Error('User ID is required');
  }

  if (!notification || !notification.title || !notification.body) {
    throw new Error('Notification title and body are required');
  }

  try {
    // Get all active subscriptions for the user
    const subscriptions = await PushSubscription.find({
      userId,
      isActive: true,
    }).lean();

    if (subscriptions.length === 0) {
      return {
        success: true,
        sent: 0,
        failed: 0,
        message: 'No active push subscriptions found for user',
      };
    }

    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      icon: notification.icon || '/icon-192x192.png',
      badge: notification.badge || '/icon-192x192.png',
      url: notification.url || '/',
      data: {
        ...(notification.data || {}),
        url: notification.url || '/',
      },
      actions: notification.actions || [], // Include action buttons
      timestamp: Date.now(),
    });

    console.log(`[PushNotification] Sending to ${subscriptions.length} subscription(s) for user ${userId}`);

    const results = {
      sent: 0,
      failed: 0,
      errors: [],
    };

    // Send to all subscriptions
    const sendPromises = subscriptions.map(async (subscription) => {
      try {
        const pushSubscription = {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
          },
        };

        console.log(`[PushNotification] Attempting to send to subscription ${subscription._id}, endpoint: ${subscription.endpoint.substring(0, 50)}...`);
        
        await webpush.sendNotification(pushSubscription, payload);
        
        console.log(`[PushNotification] Successfully sent to subscription ${subscription._id}`);
        results.sent++;
        return { success: true, subscriptionId: subscription._id };
      } catch (error) {
        results.failed++;
        const errorMessage = error.message || 'Unknown error';
        const statusCode = error.statusCode || error.code;
        
        console.error(`[PushNotification] Failed to send to subscription ${subscription._id}:`, {
          error: errorMessage,
          statusCode,
          endpoint: subscription.endpoint?.substring(0, 50),
        });
        
        results.errors.push({
          subscriptionId: subscription._id,
          error: errorMessage,
          statusCode,
        });

        // If subscription is invalid (410 Gone), mark it as inactive
        if (statusCode === 410 || errorMessage.includes('410') || errorMessage.includes('Gone')) {
          console.log(`[PushNotification] Marking subscription ${subscription._id} as inactive (410 Gone)`);
          await PushSubscription.findByIdAndUpdate(subscription._id, {
            isActive: false,
            deactivatedAt: new Date(),
            deactivationReason: 'Subscription expired (410 Gone)',
          });
        }

        return { success: false, subscriptionId: subscription._id, error: errorMessage };
      }
    });

    await Promise.allSettled(sendPromises);

    return {
      success: results.sent > 0,
      sent: results.sent,
      failed: results.failed,
      total: subscriptions.length,
      errors: results.errors,
    };
  } catch (error) {
    console.error('[PushNotification] Error sending push notification:', error);
    throw new Error(error.message || 'Failed to send push notification');
  }
};

/**
 * Send push notification to multiple users
 * @param {string[]} userIds - Array of user IDs
 * @param {Object} notification - Notification payload
 * @returns {Promise<Object>} Result with success count and failures
 */
export const sendPushNotificationToUsers = async (userIds, notification) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new Error('User IDs array is required');
  }

  const results = {
    sent: 0,
    failed: 0,
    userResults: {},
  };

  // Send to each user
  const sendPromises = userIds.map(async (userId) => {
    try {
      const result = await sendPushNotificationToUser(userId, notification);
      results.sent += result.sent;
      results.failed += result.failed;
      results.userResults[userId] = result;
      return { userId, success: result.success, sent: result.sent, failed: result.failed };
    } catch (error) {
      results.failed++;
      results.userResults[userId] = { success: false, error: error.message };
      return { userId, success: false, error: error.message };
    }
  });

  await Promise.allSettled(sendPromises);

  return {
    success: results.sent > 0,
    sent: results.sent,
    failed: results.failed,
    totalUsers: userIds.length,
    userResults: results.userResults,
  };
};

/**
 * Save push subscription for a user
 * @param {string} userId - User ID
 * @param {Object} subscription - Push subscription object
 * @param {string} subscription.endpoint - Subscription endpoint
 * @param {Object} subscription.keys - Subscription keys
 * @param {string} subscription.keys.p256dh - P256DH key
 * @param {string} subscription.keys.auth - Auth key
 * @returns {Promise<Object>} Saved subscription
 */
export const savePushSubscription = async (userId, subscription) => {
  if (!userId) {
    throw new Error('User ID is required');
  }

  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Valid push subscription is required');
  }

  try {
    console.log(`[PushNotification] Saving subscription for user ${userId}, endpoint: ${subscription.endpoint.substring(0, 50)}...`);
    
    // Check if subscription already exists for this endpoint
    const existing = await PushSubscription.findOne({
      userId,
      endpoint: subscription.endpoint,
    });

    if (existing) {
      // Update existing subscription
      console.log(`[PushNotification] Updating existing subscription ${existing._id}`);
      existing.keys = subscription.keys;
      existing.isActive = true;
      existing.updatedAt = new Date();
      await existing.save();
      console.log(`[PushNotification] Subscription ${existing._id} updated successfully`);
      return existing;
    }

    // Create new subscription
    console.log(`[PushNotification] Creating new subscription for user ${userId}`);
    const newSubscription = await PushSubscription.create({
      userId,
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      isActive: true,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });

    console.log(`[PushNotification] New subscription ${newSubscription._id} created successfully`);
    return newSubscription;
  } catch (error) {
    console.error('[PushNotification] Error saving subscription:', error);
    throw new Error(error.message || 'Failed to save push subscription');
  }
};

/**
 * Remove push subscription for a user
 * @param {string} userId - User ID
 * @param {string} endpoint - Subscription endpoint
 * @returns {Promise<boolean>} Success status
 */
export const removePushSubscription = async (userId, endpoint) => {
  if (!userId || !endpoint) {
    throw new Error('User ID and endpoint are required');
  }

  try {
    const result = await PushSubscription.updateOne(
      { userId, endpoint },
      { isActive: false, deactivatedAt: new Date(), deactivationReason: 'User unsubscribed' }
    );
    return result.modifiedCount > 0;
  } catch (error) {
    console.error('[PushNotification] Error removing subscription:', error);
    throw new Error(error.message || 'Failed to remove push subscription');
  }
};

