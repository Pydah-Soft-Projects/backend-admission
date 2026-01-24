import webpush from 'web-push';
import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

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
    const pool = getPool();
    
    // Get all active subscriptions for the user
    const [subscriptions] = await pool.execute(
      'SELECT * FROM push_subscriptions WHERE user_id = ? AND is_active = ?',
      [userId, true]
    );

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
        const keys = typeof subscription.key_p256dh === 'string' && typeof subscription.key_auth === 'string'
          ? {
              p256dh: subscription.key_p256dh,
              auth: subscription.key_auth,
            }
          : JSON.parse(subscription.key_p256dh || '{}'); // Fallback if stored as JSON

        const pushSubscription = {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: keys.p256dh || subscription.key_p256dh,
            auth: keys.auth || subscription.key_auth,
          },
        };

        console.log(`[PushNotification] Attempting to send to subscription ${subscription.id}, endpoint: ${subscription.endpoint.substring(0, 50)}...`);
        
        await webpush.sendNotification(pushSubscription, payload);
        
        console.log(`[PushNotification] Successfully sent to subscription ${subscription.id}`);
        results.sent++;
        return { success: true, subscriptionId: subscription.id };
      } catch (error) {
        results.failed++;
        const errorMessage = error.message || 'Unknown error';
        const statusCode = error.statusCode || error.code;
        
        console.error(`[PushNotification] Failed to send to subscription ${subscription.id}:`, {
          error: errorMessage,
          statusCode,
          endpoint: subscription.endpoint?.substring(0, 50),
        });
        
        results.errors.push({
          subscriptionId: subscription.id,
          error: errorMessage,
          statusCode,
        });

        // If subscription is invalid (410 Gone), mark it as inactive
        if (statusCode === 410 || errorMessage.includes('410') || errorMessage.includes('Gone')) {
          console.log(`[PushNotification] Marking subscription ${subscription.id} as inactive (410 Gone)`);
          const pool = getPool();
          await pool.execute(
            'UPDATE push_subscriptions SET is_active = ?, deactivated_at = NOW(), deactivation_reason = ? WHERE id = ?',
            [false, 'Subscription expired (410 Gone)', subscription.id]
          );
        }

        return { success: false, subscriptionId: subscription.id, error: errorMessage };
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
    const pool = getPool();
    console.log(`[PushNotification] Saving subscription for user ${userId}, endpoint: ${subscription.endpoint.substring(0, 50)}...`);
    
    // Check if subscription already exists for this endpoint
    const [existing] = await pool.execute(
      'SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
      [userId, subscription.endpoint]
    );

    if (existing.length > 0) {
      // Update existing subscription
      const existingSub = existing[0];
      console.log(`[PushNotification] Updating existing subscription ${existingSub.id}`);
      await pool.execute(
        `UPDATE push_subscriptions SET 
          key_p256dh = ?, key_auth = ?, is_active = ?, deactivated_at = NULL, 
          deactivation_reason = NULL, updated_at = NOW()
         WHERE id = ?`,
        [
          subscription.keys.p256dh,
          subscription.keys.auth,
          true,
          existingSub.id,
        ]
      );
      console.log(`[PushNotification] Subscription ${existingSub.id} updated successfully`);
      
      // Fetch updated subscription
      const [updated] = await pool.execute(
        'SELECT * FROM push_subscriptions WHERE id = ?',
        [existingSub.id]
      );
      return updated[0];
    }

    // Create new subscription
    console.log(`[PushNotification] Creating new subscription for user ${userId}`);
    const subscriptionId = uuidv4();
    await pool.execute(
      `INSERT INTO push_subscriptions (
        id, user_id, endpoint, key_p256dh, key_auth, is_active, user_agent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        subscriptionId,
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        true,
        typeof navigator !== 'undefined' ? navigator.userAgent : null,
      ]
    );

    console.log(`[PushNotification] New subscription ${subscriptionId} created successfully`);
    
    // Fetch created subscription
    const [newSubscription] = await pool.execute(
      'SELECT * FROM push_subscriptions WHERE id = ?',
      [subscriptionId]
    );
    return newSubscription[0];
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
    const pool = getPool();
    const [result] = await pool.execute(
      `UPDATE push_subscriptions SET 
        is_active = ?, deactivated_at = NOW(), deactivation_reason = ?, updated_at = NOW()
       WHERE user_id = ? AND endpoint = ?`,
      [false, 'User unsubscribed', userId, endpoint]
    );
    return result.affectedRows > 0;
  } catch (error) {
    console.error('[PushNotification] Error removing subscription:', error);
    throw new Error(error.message || 'Failed to remove push subscription');
  }
};

