import mongoose from 'mongoose';
import Notification from '../models/Notification.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Get user's notifications
// @route   GET /api/notifications
// @access  Private
export const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const unreadOnly = req.query.unreadOnly === 'true';

    const skip = (page - 1) * limit;

    const filter = { userId: new mongoose.Types.ObjectId(userId) };
    if (unreadOnly) {
      filter.read = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .populate('leadId', 'name enquiryNumber phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId: new mongoose.Types.ObjectId(userId), read: false }),
    ]);

    return successResponse(
      res,
      {
        notifications: notifications || [],
        pagination: {
          page,
          limit,
          total: total || 0,
          pages: Math.ceil((total || 0) / limit) || 1,
        },
        unreadCount: unreadCount || 0,
      },
      'Notifications retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting notifications:', error);
    return errorResponse(res, error.message || 'Failed to get notifications', 500);
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
export const markNotificationAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid notification ID', 400);
    }

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), userId: new mongoose.Types.ObjectId(userId) },
      { read: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return errorResponse(res, 'Notification not found or access denied', 404);
    }

    return successResponse(res, notification, 'Notification marked as read', 200);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    if (error.name === 'CastError') {
      return errorResponse(res, 'Invalid notification ID format', 400);
    }
    return errorResponse(res, error.message || 'Failed to mark notification as read', 500);
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
export const markAllNotificationsAsRead = async (req, res) => {
  try {
    const userId = req.user._id;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const result = await Notification.updateMany(
      { userId: new mongoose.Types.ObjectId(userId), read: false },
      { read: true, readAt: new Date() }
    );

    return successResponse(
      res,
      { updated: result.modifiedCount || 0 },
      `Marked ${result.modifiedCount || 0} notification(s) as read`,
      200
    );
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    return errorResponse(res, error.message || 'Failed to mark all notifications as read', 500);
  }
};

// @desc    Delete notification
// @route   DELETE /api/notifications/:id
// @access  Private
export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return errorResponse(res, 'Invalid notification ID', 400);
    }

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const notification = await Notification.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!notification) {
      return errorResponse(res, 'Notification not found or access denied', 404);
    }

    return successResponse(res, {}, 'Notification deleted successfully', 200);
  } catch (error) {
    console.error('Error deleting notification:', error);
    if (error.name === 'CastError') {
      return errorResponse(res, 'Invalid notification ID format', 400);
    }
    return errorResponse(res, error.message || 'Failed to delete notification', 500);
  }
};

