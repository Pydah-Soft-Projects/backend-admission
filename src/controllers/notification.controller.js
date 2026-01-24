import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// Helper function to format notification data
const formatNotification = (notifData, leadData = null) => {
  if (!notifData) return null;
  return {
    id: notifData.id,
    _id: notifData.id,
    userId: notifData.user_id,
    type: notifData.type,
    title: notifData.title,
    message: notifData.message,
    data: typeof notifData.data === 'string' 
      ? JSON.parse(notifData.data) 
      : notifData.data || {},
    read: notifData.read === 1 || notifData.read === true,
    readAt: notifData.read_at,
    channelPush: notifData.channel_push === 1 || notifData.channel_push === true,
    channelEmail: notifData.channel_email === 1 || notifData.channel_email === true,
    channelSms: notifData.channel_sms === 1 || notifData.channel_sms === true,
    leadId: notifData.lead_id,
    lead: leadData,
    actionUrl: notifData.action_url,
    createdAt: notifData.created_at,
    updatedAt: notifData.updated_at,
  };
};

// @desc    Get user's notifications
// @route   GET /api/notifications
// @access  Private
export const getUserNotifications = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    if (!userId || typeof userId !== 'string' || userId.length !== 36) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const unreadOnly = req.query.unreadOnly === 'true';
    const pool = getPool();

    const offset = (page - 1) * limit;

    // Build WHERE conditions with table alias for JOIN query
    const conditions = ['n.user_id = ?'];
    const params = [userId];

    if (unreadOnly) {
      conditions.push('n.`read` = ?');
      params.push(false);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count (no alias needed for simple count query)
    const [totalResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM notifications WHERE user_id = ?${unreadOnly ? ' AND `read` = ?' : ''}`,
      unreadOnly ? [userId, false] : [userId]
    );
    const total = totalResult[0].total;

    // Get unread count
    const [unreadCountResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM notifications WHERE user_id = ? AND `read` = ?',
      [userId, false]
    );
    const unreadCount = unreadCountResult[0].total;

    // Get notifications with lead info
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [notifications] = await pool.execute(
      `SELECT n.*, l.id as lead_id_full, l.name as lead_name, l.enquiry_number as lead_enquiry_number, l.phone as lead_phone
       FROM notifications n
       LEFT JOIN leads l ON n.lead_id = l.id
       ${whereClause}
       ORDER BY n.created_at DESC
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      params
    );

    const formattedNotifications = notifications.map(notif => {
      const leadData = notif.lead_id_full ? {
        _id: notif.lead_id_full,
        id: notif.lead_id_full,
        name: notif.lead_name,
        enquiryNumber: notif.lead_enquiry_number,
        phone: notif.lead_phone,
      } : null;
      return formatNotification(notif, leadData);
    });

    return successResponse(
      res,
      {
        notifications: formattedNotifications || [],
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
    const userId = req.user.id || req.user._id;
    const pool = getPool();

    if (!id || typeof id !== 'string' || id.length !== 36) {
      return errorResponse(res, 'Invalid notification ID', 400);
    }

    if (!userId || typeof userId !== 'string' || userId.length !== 36) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    // Check if notification exists and belongs to user
    const [notifications] = await pool.execute(
      'SELECT * FROM notifications WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (notifications.length === 0) {
      return errorResponse(res, 'Notification not found or access denied', 404);
    }

    // Update notification
    await pool.execute(
      'UPDATE notifications SET `read` = ?, read_at = NOW(), updated_at = NOW() WHERE id = ?',
      [true, id]
    );

    // Fetch updated notification
    const [updated] = await pool.execute(
      `SELECT n.*, l.id as lead_id_full, l.name as lead_name, l.enquiry_number as lead_enquiry_number, l.phone as lead_phone
       FROM notifications n
       LEFT JOIN leads l ON n.lead_id = l.id
       WHERE n.id = ?`,
      [id]
    );

    const leadData = updated[0].lead_id_full ? {
      _id: updated[0].lead_id_full,
      id: updated[0].lead_id_full,
      name: updated[0].lead_name,
      enquiryNumber: updated[0].lead_enquiry_number,
      phone: updated[0].lead_phone,
    } : null;

    const notification = formatNotification(updated[0], leadData);

    return successResponse(res, notification, 'Notification marked as read', 200);
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return errorResponse(res, error.message || 'Failed to mark notification as read', 500);
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
export const markAllNotificationsAsRead = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const pool = getPool();

    if (!userId || typeof userId !== 'string' || userId.length !== 36) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    const [result] = await pool.execute(
      'UPDATE notifications SET `read` = ?, read_at = NOW(), updated_at = NOW() WHERE user_id = ? AND `read` = ?',
      [true, userId, false]
    );

    return successResponse(
      res,
      { updated: result.affectedRows || 0 },
      `Marked ${result.affectedRows || 0} notification(s) as read`,
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
    const userId = req.user.id || req.user._id;
    const pool = getPool();

    if (!id || typeof id !== 'string' || id.length !== 36) {
      return errorResponse(res, 'Invalid notification ID', 400);
    }

    if (!userId || typeof userId !== 'string' || userId.length !== 36) {
      return errorResponse(res, 'Invalid user ID', 400);
    }

    // Check if notification exists and belongs to user
    const [notifications] = await pool.execute(
      'SELECT id FROM notifications WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (notifications.length === 0) {
      return errorResponse(res, 'Notification not found or access denied', 404);
    }

    // Delete notification
    await pool.execute(
      'DELETE FROM notifications WHERE id = ?',
      [id]
    );

    return successResponse(res, {}, 'Notification deleted successfully', 200);
  } catch (error) {
    console.error('Error deleting notification:', error);
    return errorResponse(res, error.message || 'Failed to delete notification', 500);
  }
};

