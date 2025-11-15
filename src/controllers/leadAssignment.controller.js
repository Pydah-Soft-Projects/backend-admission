import mongoose from 'mongoose';
import Lead from '../models/Lead.model.js';
import User from '../models/User.model.js';
import Joining from '../models/Joining.model.js';
import Admission from '../models/Admission.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';

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
  if (!hasElevatedAdminPrivileges(req.user.roleName) && userId !== requestingUserId.toString()) {
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

export const getOverviewAnalytics = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const rangeInDays = Number.parseInt(req.query.days, 10) || 14;
    const timezone = req.query.tz || 'Asia/Kolkata';

    // Get today's date in the specified timezone
    const today = new Date();
    // Set to end of today in the timezone
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);
    
    // Calculate start date: go back (rangeInDays - 1) days to include today
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (rangeInDays - 1));
    startDate.setHours(0, 0, 0, 0);
    
    // Helper to format date in timezone for key matching
    const formatDateKey = (date) => {
      // Use the same format as $dateToString in aggregation
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const [
      totalLeads,
      confirmedLeads,
      admittedLeads,
      assignedLeads,
      unassignedLeads,
      leadStatusAgg,
      joiningStatusAgg,
      admissionStatusAgg,
      admissionsTotal,
      leadsCreatedAgg,
      statusChangesAgg,
      joiningTrendAgg,
      admissionsAgg,
    ] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ leadStatus: 'Confirmed' }),
      Lead.countDocuments({ leadStatus: 'Admitted' }),
      Lead.countDocuments({ assignedTo: { $exists: true, $ne: null } }),
      Lead.countDocuments({ $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }] }),
      Lead.aggregate([
        {
          $group: {
            _id: '$leadStatus',
            count: { $sum: 1 },
          },
        },
      ]),
      Joining.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Admission.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Admission.countDocuments(),
      Lead.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone,
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ActivityLog.aggregate([
        {
          $match: {
            type: 'status_change',
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              date: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt',
                  timezone,
                },
              },
              status: '$newStatus',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),
      Joining.aggregate([
        {
          $match: {
            updatedAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              date: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$updatedAt',
                  timezone,
                },
              },
              status: '$status',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),
      Admission.aggregate([
        {
          $match: {
            admissionDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$admissionDate',
                timezone,
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const leadStatusBreakdown = leadStatusAgg.reduce((acc, item) => {
      const key = item._id || 'Unknown';
      acc[key] = item.count;
      return acc;
    }, {});

    const joiningStatusBreakdown = joiningStatusAgg.reduce((acc, item) => {
      const key = item._id || 'draft';
      acc[key] = item.count;
      return acc;
    }, {});

    const admissionStatusBreakdown = admissionStatusAgg.reduce((acc, item) => {
      const key = item._id || 'active';
      acc[key] = item.count;
      return acc;
    }, {});

    const initDailySeries = () => {
      const series = new Map();
      for (let i = 0; i < rangeInDays; i += 1) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        const key = formatDateKey(date);
        series.set(key, { date: key, count: 0 });
      }
      // Ensure today is included
      const todayKey = formatDateKey(today);
      if (!series.has(todayKey)) {
        series.set(todayKey, { date: todayKey, count: 0 });
      }
      return series;
    };

    const leadsCreatedSeries = initDailySeries();
    leadsCreatedAgg.forEach((item) => {
      const entry = leadsCreatedSeries.get(item._id);
      if (entry) {
        entry.count = item.count;
      }
    });

    const statusChangeSeries = new Map();
    statusChangesAgg.forEach((item) => {
      const dateKey = item._id.date;
      if (!statusChangeSeries.has(dateKey)) {
        statusChangeSeries.set(dateKey, {
          date: dateKey,
          total: 0,
          statuses: {},
        });
      }
      const bucket = statusChangeSeries.get(dateKey);
      bucket.total += item.count;
      if (item._id.status) {
        bucket.statuses[item._id.status] = (bucket.statuses[item._id.status] || 0) + item.count;
      }
    });
    for (const [dateKey, entry] of statusChangeSeries) {
      if (!entry.statuses.total) {
        entry.statuses.total = entry.total;
      }
    }

    const joiningSeries = new Map();
    joiningTrendAgg.forEach((item) => {
      const dateKey = item._id.date;
      if (!joiningSeries.has(dateKey)) {
        joiningSeries.set(dateKey, {
          date: dateKey,
          draft: 0,
          pending_approval: 0,
          approved: 0,
        });
      }
      const bucket = joiningSeries.get(dateKey);
      bucket[item._id.status] = (bucket[item._id.status] || 0) + item.count;
    });

    const admissionsSeries = initDailySeries();
    admissionsAgg.forEach((item) => {
      const entry = admissionsSeries.get(item._id);
      if (entry) {
        entry.count = item.count;
      }
    });

    const serializeSeries = (seriesMap, defaults = {}) => {
      const buildDefaults = () => {
        const clone = {};
        Object.entries(defaults).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            clone[key] = [...value];
          } else if (value && typeof value === 'object') {
            clone[key] = { ...value };
          } else {
            clone[key] = value;
          }
        });
        return clone;
      };

      const results = [];
      const todayKey = formatDateKey(today);
      
      // Generate all date keys in the range, ensuring today is included
      const allDateKeys = [];
      for (let i = 0; i < rangeInDays; i += 1) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        const key = formatDateKey(date);
        allDateKeys.push(key);
      }
      
      // Ensure today is in the list
      if (!allDateKeys.includes(todayKey)) {
        allDateKeys.push(todayKey);
      }
      
      // Sort to maintain chronological order
      allDateKeys.sort();
      
      // Build results
      for (const key of allDateKeys) {
        if (seriesMap instanceof Map) {
          if (seriesMap.has(key)) {
            results.push(seriesMap.get(key));
          } else {
            results.push({ date: key, ...buildDefaults() });
          }
        } else if (seriesMap[key]) {
          results.push(seriesMap[key]);
        } else {
          results.push({ date: key, ...buildDefaults() });
        }
      }
      return results;
    };

    const overview = {
      totals: {
        leads: totalLeads,
        confirmedLeads,
        admittedLeads,
        assignedLeads,
        unassignedLeads,
        joinings: {
          draft: joiningStatusBreakdown.draft || 0,
          pendingApproval: joiningStatusBreakdown.pending_approval || 0,
          approved: joiningStatusBreakdown.approved || 0,
        },
        admissions: admissionsTotal,
      },
      leadStatusBreakdown,
      joiningStatusBreakdown,
      admissionStatusBreakdown,
      daily: {
        leadsCreated: serializeSeries(leadsCreatedSeries),
        statusChanges: serializeSeries(statusChangeSeries, { total: 0, statuses: {} }),
        joiningProgress: serializeSeries(joiningSeries, {
          draft: 0,
          pending_approval: 0,
          approved: 0,
        }),
        admissions: serializeSeries(admissionsSeries),
      },
    };

    return successResponse(res, overview, 'Overview analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting overview analytics:', error);
    return errorResponse(res, error.message || 'Failed to get overview analytics', 500);
  }
};

// @desc    Get user-specific analytics (assigned leads and status breakdown)
// @route   GET /api/leads/analytics/users
// @access  Private (Super Admin)
export const getUserAnalytics = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Get all users except Super Admin and Sub Super Admin
    const users = await User.find({
      roleName: { $nin: ['Super Admin', 'Sub Super Admin'] },
    })
      .select('_id name email roleName isActive')
      .lean();

    // Get analytics for each user
    const userAnalytics = await Promise.all(
      users.map(async (user) => {
        const userId = user._id;

        // Count total assigned leads
        const totalAssigned = await Lead.countDocuments({ assignedTo: userId });

        // Get status breakdown for assigned leads
        const statusBreakdown = await Lead.aggregate([
          { $match: { assignedTo: userId } },
          {
            $group: {
              _id: '$leadStatus',
              count: { $sum: 1 },
            },
          },
        ]);

        const statusMap = {};
        statusBreakdown.forEach((item) => {
          statusMap[item._id || 'Unknown'] = item.count;
        });

        return {
          userId: userId.toString(),
          name: user.name,
          email: user.email,
          roleName: user.roleName,
          isActive: user.isActive,
          totalAssigned,
          statusBreakdown: statusMap,
        };
      }),
    );

    return successResponse(res, { users: userAnalytics }, 'User analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get user analytics', 500);
  }
};

