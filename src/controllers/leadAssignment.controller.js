import mongoose from 'mongoose';
import Lead from '../models/Lead.model.js';
import User from '../models/User.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Assign leads to users based on mandal/state
// @route   POST /api/leads/assign
// @access  Private (Super Admin only)
export const assignLeads = async (req, res) => {
  try {
    const { userId, mandal, state, count, assignNow = true } = req.body;

    // Validate required fields
    if (!userId || !count) {
      return errorResponse(res, 'User ID and count are required', 400);
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Build filter for unassigned leads
    // Unassigned means: assignedTo is null or doesn't exist
    const filter = {
      $or: [
        { assignedTo: { $exists: false } },
        { assignedTo: null },
      ],
    };

    // Add mandal filter if provided
    if (mandal) {
      filter.mandal = mandal;
    }

    // Add state filter if provided
    if (state) {
      filter.state = state;
    }

    // Get available unassigned leads matching criteria
    const availableLeads = await Lead.find(filter)
      .select('_id')
      .limit(parseInt(count))
      .lean();

    if (availableLeads.length === 0) {
      return successResponse(
        res,
        {
          assigned: 0,
          requested: parseInt(count),
          message: 'No unassigned leads found matching the criteria',
        },
        'No leads available for assignment',
        200
      );
    }

    // Assign leads to user
    const leadIds = availableLeads.map((lead) => lead._id);
    const result = await Lead.updateMany(
      { _id: { $in: leadIds } },
      {
        $set: {
          assignedTo: userId,
          assignedAt: new Date(),
          assignedBy: req.user._id,
        },
      }
    );

    return successResponse(
      res,
      {
        assigned: result.modifiedCount,
        requested: parseInt(count),
        userId,
        userName: user.name,
        mandal: mandal || 'All',
        state: state || 'All',
      },
      `Successfully assigned ${result.modifiedCount} leads to ${user.name}`,
      200
    );
  } catch (error) {
    console.error('Error assigning leads:', error);
    return errorResponse(res, error.message || 'Failed to assign leads', 500);
  }
};

// @desc    Get user lead analytics
// @route   GET /api/leads/analytics/:userId
// @access  Private
export const getUserLeadAnalytics = async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserId = req.user._id;

    // Users can only view their own analytics, Super Admin can view any user's analytics
    if (req.user.roleName !== 'Super Admin' && userId !== requestingUserId.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get total leads assigned to user
    const totalLeads = await Lead.countDocuments({ assignedTo: userId });

    // Get leads by status
    const statusBreakdown = await Lead.aggregate([
      { $match: { assignedTo: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Get leads by mandal
    const mandalBreakdown = await Lead.aggregate([
      { $match: { assignedTo: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: '$mandal',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 }, // Top 10 mandals
    ]);

    // Get leads by state
    const stateBreakdown = await Lead.aggregate([
      { $match: { assignedTo: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: '$state',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Convert status breakdown to object
    const statusCounts = {};
    statusBreakdown.forEach((item) => {
      statusCounts[item._id || 'New'] = item.count;
    });

    // Get recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentLeads = await Lead.countDocuments({
      assignedTo: userId,
      updatedAt: { $gte: sevenDaysAgo },
    });

    return successResponse(
      res,
      {
        totalLeads,
        statusBreakdown: statusCounts,
        mandalBreakdown: mandalBreakdown.map((item) => ({
          mandal: item._id,
          count: item.count,
        })),
        stateBreakdown: stateBreakdown.map((item) => ({
          state: item._id,
          count: item.count,
        })),
        recentActivity: {
          leadsUpdatedLast7Days: recentLeads,
        },
      },
      'Analytics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get analytics', 500);
  }
};

