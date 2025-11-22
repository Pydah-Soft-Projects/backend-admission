import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  getVapidKey,
  subscribeToPush,
  unsubscribeFromPush,
  sendTestPush,
  sendTestNotificationsToAll,
  getUserSubscriptions,
} from '../controllers/pushNotification.controller.js';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} from '../controllers/notification.controller.js';
import {
  getNotificationConfig,
  updateNotificationConfig,
  testEmailChannels,
} from '../controllers/notificationConfig.controller.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

// In-app notification routes
router.get('/', getUserNotifications);
router.put('/:id/read', markNotificationAsRead);
router.put('/read-all', markAllNotificationsAsRead);
router.delete('/:id', deleteNotification);

// Push notification routes
router.get('/push/vapid-key', getVapidKey);
router.get('/push/subscriptions', getUserSubscriptions);
router.post('/push/subscribe', subscribeToPush);
router.post('/push/unsubscribe', unsubscribeFromPush);
router.post('/push/test', sendTestPush);

// Test notifications to all users (Super Admin only)
router.post('/test-all', sendTestNotificationsToAll);

// Notification configuration routes (Super Admin only)
router.get('/config', getNotificationConfig);
router.put('/config', updateNotificationConfig);
router.post('/config/test-email', testEmailChannels);

export default router;

