import mongoose from 'mongoose';
import Lead from '../models/Lead.model.js';
import User from '../models/User.model.js';
import Joining from '../models/Joining.model.js';
import Admission from '../models/Admission.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import Communication from '../models/Communication.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadAssignment } from '../services/notification.service.js';

// @desc    Assign leads to users based on mandal/state (bulk) or specific lead IDs (single)
// @route   POST /api/leads/assign
// @access  Private (Super Admin only)
export const assignLeads = async (req, res) => {
  try {
    const { userId, mandal, state, count, leadIds, assignNow = true } = req.body;

    // Validate required fields
    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    // Check if user exists and is assignable (User or Sub Super Admin, not Super Admin)
    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Validate that user can receive assignments (User or Sub Super Admin only)
    if (user.roleName === 'Super Admin') {
      return errorResponse(res, 'Cannot assign leads to Super Admin', 400);
    }

    if (!user.isActive) {
      return errorResponse(res, 'Cannot assign leads to inactive user', 400);
    }

    let leadIdsToAssign = [];
    let filter = {};

    // Single assignment mode: assign specific lead IDs
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      // Validate lead IDs
      const validLeadIds = leadIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (validLeadIds.length === 0) {
        return errorResponse(res, 'No valid lead IDs provided', 400);
      }

      // Check if leads exist
      const existingLeads = await Lead.find({
        _id: { $in: validLeadIds },
      }).select('_id assignedTo').lean();

      if (existingLeads.length === 0) {
        return errorResponse(res, 'No leads found with the provided IDs', 404);
      }

      leadIdsToAssign = existingLeads.map((lead) => lead._id);
    } else {
      // Bulk assignment mode: assign based on filters and count
      if (!count || count <= 0) {
        return errorResponse(res, 'Count is required for bulk assignment', 400);
      }

      // Build filter for unassigned leads
      // Unassigned means: assignedTo is null or doesn't exist
      filter = {
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

      leadIdsToAssign = availableLeads.map((lead) => lead._id);
    }

    // Get leads before update to check status
    const leadsToAssign = await Lead.find({ _id: { $in: leadIdsToAssign } }).lean();
    
    // Update leads and create activity logs
    const activityLogs = [];
    const now = new Date();
    
    for (const lead of leadsToAssign) {
      const oldStatus = lead.leadStatus || 'New';
      const newStatus = oldStatus === 'New' ? 'Assigned' : oldStatus;
      
      // Update lead
      await Lead.findByIdAndUpdate(lead._id, {
        $set: {
          assignedTo: userId,
          assignedAt: now,
          assignedBy: req.user._id,
          leadStatus: newStatus,
        },
      });
      
      // Create activity log
      activityLogs.push({
        leadId: lead._id,
        type: 'status_change',
        oldStatus: oldStatus,
        newStatus: newStatus,
        comment: `Assigned to ${user.roleName === 'Sub Super Admin' ? 'sub-admin' : 'counsellor'} ${user.name}`,
        performedBy: req.user._id,
        metadata: {
          assignment: {
            assignedTo: userId.toString(),
            assignedBy: req.user._id.toString(),
          },
        },
        createdAt: now,
        updatedAt: now,
      });
    }
    
    if (activityLogs.length > 0) {
      await ActivityLog.insertMany(activityLogs);
    }
    
    const result = { modifiedCount: activityLogs.length };

    // Send notifications (async, don't wait for it)
    const isBulk = !leadIds || leadIds.length === 0;
    const assignedLeadCount = result.modifiedCount;
    
    // Get full lead details for notification (limit to 50 for email display, but send SMS to all)
    const leadsForNotification = leadsToAssign.slice(0, 50);
    
    notifyLeadAssignment({
      userId,
      leadCount: assignedLeadCount,
      leads: leadsForNotification,
      isBulk,
      allLeadIds: leadIdsToAssign, // Pass all lead IDs for SMS sending
    }).catch((error) => {
      console.error('[LeadAssignment] Error sending notifications:', error);
    });

    return successResponse(
      res,
      {
        assigned: result.modifiedCount,
        requested: leadIds ? leadIds.length : parseInt(count),
        userId,
        userName: user.name,
        mandal: mandal || 'All',
        state: state || 'All',
        mode: leadIds ? 'single' : 'bulk',
      },
      `Successfully assigned ${result.modifiedCount} lead${result.modifiedCount !== 1 ? 's' : ''} to ${user.name}`,
      200
    );
  } catch (error) {
    console.error('Error assigning leads:', error);
    return errorResponse(res, error.message || 'Failed to assign leads', 500);
  }
};

// @desc    Get assignment statistics (unassigned leads count, etc.)
// @route   GET /api/leads/assign/stats
// @access  Private (Super Admin only)
export const getAssignmentStats = async (req, res) => {
  try {
    const { mandal, state } = req.query;

    // Build filter for unassigned leads
    const unassignedFilter = {
      $or: [
        { assignedTo: { $exists: false } },
        { assignedTo: null },
      ],
    };

    // Add mandal filter if provided
    if (mandal) {
      unassignedFilter.mandal = mandal;
    }

    // Add state filter if provided
    if (state) {
      unassignedFilter.state = state;
    }

    // Get unassigned leads count
    const unassignedCount = await Lead.countDocuments(unassignedFilter);

    // Get total leads count
    const totalLeads = await Lead.countDocuments();

    // Get assigned leads count
    const assignedCount = totalLeads - unassignedCount;

    // Get breakdown by mandal (for unassigned leads)
    const mandalBreakdown = await Lead.aggregate([
      { $match: unassignedFilter },
      {
        $group: {
          _id: '$mandal',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    // Get breakdown by state (for unassigned leads)
    const stateBreakdown = await Lead.aggregate([
      { $match: unassignedFilter },
      {
        $group: {
          _id: '$state',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    return successResponse(
      res,
      {
        totalLeads,
        assignedCount,
        unassignedCount,
        mandalBreakdown: mandalBreakdown.map((item) => ({
          mandal: item._id || 'Unknown',
          count: item.count,
        })),
        stateBreakdown: stateBreakdown.map((item) => ({
          state: item._id || 'Unknown',
          count: item.count,
        })),
      },
      'Assignment statistics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting assignment stats:', error);
    return errorResponse(res, error.message || 'Failed to get assignment statistics', 500);
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

    const { startDate, endDate } = req.query;
    
    // Set date range for filtering activities (calls, SMS, status changes)
    // NOTE: We don't filter leads by createdAt because we want to show all leads
    // assigned to the user, but only count activities within the date range
    let activityDateFilter = {};
    if (startDate || endDate) {
      activityDateFilter = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        activityDateFilter.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        activityDateFilter.$lte = end;
      }
    }

    // Get all users except Super Admin and Sub Super Admin
    const users = await User.find({
      roleName: { $nin: ['Super Admin', 'Sub Super Admin'] },
    })
      .select('_id name email roleName isActive')
      .lean();

    // Get analytics for each user with comprehensive data including activity logs
    const userAnalytics = await Promise.all(
      users.map(async (user) => {
        const userId = user._id;

        // Build lead filter WITHOUT date range - show all assigned leads
        // We'll filter activities by date instead
        const leadFilter = { assignedTo: userId };

        // Count total assigned leads
        const totalAssigned = await Lead.countDocuments(leadFilter);

        // Get status breakdown for assigned leads
        const statusBreakdown = await Lead.aggregate([
          { $match: leadFilter },
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

        // Get active leads (leads with status not 'Admitted' or 'Closed')
        const activeLeads = await Lead.countDocuments({
          ...leadFilter,
          leadStatus: { $nin: ['Admitted', 'Closed', 'Cancelled'] },
        });

        // Get converted leads (leads that have admissions)
        const convertedLeads = await Admission.countDocuments({
          leadId: { $in: await Lead.find(leadFilter).distinct('_id') },
        });

        // Get user's leads for activity tracking
        const userLeads = await Lead.find(leadFilter).select('_id name phone enquiryNumber').lean();
        const leadIds = userLeads.map((lead) => lead._id);
        
        // Get calls made by this user in the period
        const callFilter = {
          sentBy: userId,
          type: 'call',
        };
        if (Object.keys(activityDateFilter).length > 0) {
          callFilter.sentAt = activityDateFilter;
        }

        const calls = await Communication.find(callFilter)
          .populate('leadId', 'name phone enquiryNumber')
          .select('leadId contactNumber durationSeconds callOutcome remarks sentAt')
          .lean();

        const totalCalls = calls.length;
        const totalCallDuration = calls.reduce((sum, call) => sum + (call.durationSeconds || 0), 0);
        const callsByLead = {};
        calls.forEach((call) => {
          const leadId = call.leadId?._id?.toString() || 'unknown';
          if (!callsByLead[leadId]) {
            callsByLead[leadId] = {
              leadId,
              leadName: call.leadId?.name || 'Unknown',
              leadPhone: call.leadId?.phone || call.contactNumber,
              enquiryNumber: call.leadId?.enquiryNumber || '',
              callCount: 0,
              totalDuration: 0,
              calls: [],
            };
          }
          callsByLead[leadId].callCount += 1;
          callsByLead[leadId].totalDuration += call.durationSeconds || 0;
          callsByLead[leadId].calls.push({
            date: call.sentAt,
            duration: call.durationSeconds || 0,
            outcome: call.callOutcome || 'N/A',
            remarks: call.remarks || '',
          });
        });

        // Get SMS/texts sent by this user in the period
        const smsFilter = {
          sentBy: userId,
          type: 'sms',
        };
        if (Object.keys(activityDateFilter).length > 0) {
          smsFilter.sentAt = activityDateFilter;
        }

        const smsMessages = await Communication.find(smsFilter)
          .populate('leadId', 'name phone enquiryNumber')
          .select('leadId contactNumber template sentAt status')
          .lean();

        const totalSMS = smsMessages.length;
        const smsByLead = {};
        const templateUsage = {};

        smsMessages.forEach((sms) => {
          const leadId = sms.leadId?._id?.toString() || 'unknown';
          if (!smsByLead[leadId]) {
            smsByLead[leadId] = {
              leadId,
              leadName: sms.leadId?.name || 'Unknown',
              leadPhone: sms.leadId?.phone || sms.contactNumber,
              enquiryNumber: sms.leadId?.enquiryNumber || '',
              smsCount: 0,
              messages: [],
            };
          }
          smsByLead[leadId].smsCount += 1;
          smsByLead[leadId].messages.push({
            date: sms.sentAt,
            template: sms.template?.name || 'Custom',
            status: sms.status || 'unknown',
          });

          // Track template usage
          const templateName = sms.template?.name || 'Custom';
          if (!templateUsage[templateName]) {
            templateUsage[templateName] = {
              name: templateName,
              count: 0,
              leads: new Set(),
            };
          }
          templateUsage[templateName].count += 1;
          if (leadId !== 'unknown') {
            templateUsage[templateName].leads.add(leadId);
          }
        });

        // Convert template usage Set to count
        const templateUsageArray = Object.values(templateUsage).map((t) => ({
          name: t.name,
          count: t.count,
          uniqueLeads: t.leads.size,
        }));

        // Get status conversions made by this user in the period
        const statusChangeFilter = {
          performedBy: userId,
          type: 'status_change',
        };
        if (Object.keys(activityDateFilter).length > 0) {
          statusChangeFilter.createdAt = activityDateFilter;
        }

        const statusChanges = await ActivityLog.find(statusChangeFilter)
          .populate('leadId', 'name phone enquiryNumber')
          .select('leadId oldStatus newStatus createdAt')
          .lean();

        const totalStatusChanges = statusChanges.length;
        const statusConversions = {};
        const conversionsByLead = {};

        statusChanges.forEach((change) => {
          const conversion = `${change.oldStatus || 'Unknown'} → ${change.newStatus || 'Unknown'}`;
          if (!statusConversions[conversion]) {
            statusConversions[conversion] = 0;
          }
          statusConversions[conversion] += 1;

          const leadId = change.leadId?._id?.toString() || 'unknown';
          if (!conversionsByLead[leadId]) {
            conversionsByLead[leadId] = {
              leadId,
              leadName: change.leadId?.name || 'Unknown',
              leadPhone: change.leadId?.phone || '',
              enquiryNumber: change.leadId?.enquiryNumber || '',
              conversions: [],
            };
          }
          conversionsByLead[leadId].conversions.push({
            from: change.oldStatus || 'Unknown',
            to: change.newStatus || 'Unknown',
            date: change.createdAt,
          });
        });

        // Get activity logs count for this user's leads
        const activityLogsCount = leadIds.length > 0
          ? await ActivityLog.countDocuments({
              leadId: { $in: leadIds },
            })
          : 0;

        // Get recent activity (last 7 days)
        const recentActivityFilter = {
          leadId: { $in: leadIds },
          createdAt: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        };
        const recentActivityCount = leadIds.length > 0
          ? await ActivityLog.countDocuments(recentActivityFilter)
          : 0;

        // Get source breakdown for assigned leads
        const sourceBreakdown = await Lead.aggregate([
          { $match: leadFilter },
          {
            $group: {
              _id: '$source',
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]);

        const sourceMap = {};
        sourceBreakdown.forEach((item) => {
          sourceMap[item._id || 'Unknown'] = item.count;
        });

        // Get course breakdown
        const courseBreakdown = await Lead.aggregate([
          { $match: leadFilter },
          {
            $group: {
              _id: '$courseInterested',
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ]);

        const courseMap = {};
        courseBreakdown.forEach((item) => {
          courseMap[item._id || 'Unknown'] = item.count;
        });

        return {
          userId: userId.toString(),
          userName: user.name,
          name: user.name,
          email: user.email,
          roleName: user.roleName,
          isActive: user.isActive,
          totalAssigned,
          activeLeads,
          convertedLeads,
          conversionRate: totalAssigned > 0 ? parseFloat(((convertedLeads / totalAssigned) * 100).toFixed(2)) : 0,
          statusBreakdown: statusMap,
          sourceBreakdown: sourceMap,
          courseBreakdown: courseMap,
          activityLogsCount,
          recentActivityCount,
          // Detailed communication and activity data
          calls: {
            total: totalCalls,
            totalDuration: totalCallDuration,
            averageDuration: totalCalls > 0 ? Math.round(totalCallDuration / totalCalls) : 0,
            byLead: Object.values(callsByLead),
          },
          sms: {
            total: totalSMS,
            byLead: Object.values(smsByLead),
            templateUsage: templateUsageArray.sort((a, b) => b.count - a.count),
          },
          statusConversions: {
            total: totalStatusChanges,
            breakdown: statusConversions,
            byLead: Object.values(conversionsByLead),
          },
        };
      }),
    );

    return successResponse(res, { users: userAnalytics }, 'User analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get user analytics', 500);
  }
};

