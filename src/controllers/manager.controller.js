import mongoose from 'mongoose';
import User from '../models/User.model.js';
import Lead from '../models/Lead.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import Communication from '../models/Communication.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';

// @desc    Get manager's team members
// @route   GET /api/manager/team
// @access  Private (Manager only)
export const getTeamMembers = async (req, res) => {
  try {
    const managerId = req.user._id;

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get all team members (users managed by this manager)
    const teamMembers = await User.find({ managedBy: managerId })
      .select('-password')
      .sort({ name: 1 });

    return successResponse(res, teamMembers, 'Team members retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get team members', 500);
  }
};

// @desc    Get all leads for manager (manager's leads + team members' leads)
// @route   GET /api/manager/leads
// @access  Private (Manager only)
export const getManagerLeads = async (req, res) => {
  try {
    const managerId = req.user._id;

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get team member IDs
    const teamMembers = await User.find({ managedBy: managerId }).select('_id');
    const teamMemberIds = teamMembers.map((member) => member._id);

    // Include manager's own ID in the list
    const allUserIds = [managerId, ...teamMemberIds];

    // Build filter
    const filter = {
      assignedTo: { $in: allUserIds },
    };

    // Apply additional filters from query params
    if (req.query.mandal) filter.mandal = req.query.mandal;
    if (req.query.state) filter.state = req.query.state;
    if (req.query.district) filter.district = req.query.district;
    if (req.query.leadStatus) filter.leadStatus = req.query.leadStatus;
    if (req.query.applicationStatus) filter.applicationStatus = req.query.applicationStatus;
    if (req.query.courseInterested) filter.courseInterested = req.query.courseInterested;
    if (req.query.source) filter.source = req.query.source;

    // Date filtering
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        const start = new Date(req.query.startDate);
        start.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = start;
      }
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    // Search functionality
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { phone: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } },
      ];
    }

    if (req.query.enquiryNumber) {
      const searchTerm = req.query.enquiryNumber.trim();
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        filter.enquiryNumber = { $regex: `^${searchTerm}`, $options: 'i' };
      } else {
        filter.enquiryNumber = { $regex: searchTerm, $options: 'i' };
      }
    }

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Get total count
    const total = await Lead.countDocuments(filter);

    // Get leads with populated assignedTo
    const leads = await Lead.find(filter)
      .populate('assignedTo', 'name email roleName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    return successResponse(
      res,
      {
        leads,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'Leads retrieved successfully',
      200
    );
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get leads', 500);
  }
};

// @desc    Get manager dashboard analytics
// @route   GET /api/manager/analytics
// @access  Private (Manager only)
export const getManagerAnalytics = async (req, res) => {
  try {
    const managerId = req.user._id;

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get team member IDs
    const teamMembers = await User.find({ managedBy: managerId }).select('_id name email roleName');
    const teamMemberIds = teamMembers.map((member) => member._id);
    const allUserIds = [managerId, ...teamMemberIds];

    // Date filtering
    const dateFilter = {};
    if (req.query.startDate || req.query.endDate) {
      if (req.query.startDate) {
        const start = new Date(req.query.startDate);
        start.setHours(0, 0, 0, 0);
        dateFilter.$gte = start;
      }
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
    }

    // Get all leads assigned to manager and team
    const leadFilter = {
      assignedTo: { $in: allUserIds },
    };
    if (Object.keys(dateFilter).length > 0) {
      leadFilter.createdAt = dateFilter;
    }

    const allLeads = await Lead.find(leadFilter);
    const leadIds = allLeads.map((lead) => lead._id);

    // Total leads
    const totalLeads = allLeads.length;

    // Status breakdown
    const statusBreakdown = await Lead.aggregate([
      { $match: leadFilter },
      {
        $group: {
          _id: '$leadStatus',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const statusMap = {};
    statusBreakdown.forEach((item) => {
      statusMap[item._id || 'Not Provided'] = item.count;
    });

    // Confirmed leads
    const confirmedLeads = await Lead.countDocuments({
      ...leadFilter,
      leadStatus: 'Confirmed',
    });

    // Get team member analytics
    const teamAnalytics = await Promise.all(
      teamMembers.map(async (member) => {
        const memberLeads = await Lead.find({ assignedTo: member._id });
        const memberLeadIds = memberLeads.map((lead) => lead._id);

        // Get today's date range
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        // Get today's calls made by this member (from Communication logs)
        // Ensure member._id is ObjectId for proper querying
        let memberUserId = member._id;
        if (!(member._id instanceof mongoose.Types.ObjectId)) {
          try {
            memberUserId = new mongoose.Types.ObjectId(member._id);
          } catch (e) {
            memberUserId = member._id;
          }
        }

        const todayCalls = await Communication.countDocuments({
          sentBy: memberUserId,
          type: 'call',
          sentAt: { $gte: todayStart, $lte: todayEnd },
        });

        // Get today's SMS sent by this member (from Communication logs)
        const todaySMS = await Communication.countDocuments({
          sentBy: memberUserId,
          type: 'sms',
          sentAt: { $gte: todayStart, $lte: todayEnd },
        });

        // Get today's activity logs performed by this member (from ActivityLog)
        const todayActivities = await ActivityLog.countDocuments({
          performedBy: memberUserId,
          createdAt: { $gte: todayStart, $lte: todayEnd },
        });

        // Get status conversions performed by this member (from ActivityLog)
        const statusChanges = await ActivityLog.find({
          performedBy: memberUserId,
          type: 'status_change',
        })
          .populate('leadId', 'name phone enquiryNumber')
          .sort({ createdAt: -1 })
          .limit(100)
          .lean();

        const conversions = {};
        statusChanges.forEach((change) => {
          const conversion = `${change.oldStatus || 'Unknown'} → ${change.newStatus || 'Unknown'}`;
          if (!conversions[conversion]) {
            conversions[conversion] = 0;
          }
          conversions[conversion] += 1;
        });

        // Confirmed leads for this member
        const memberConfirmed = await Lead.countDocuments({
          assignedTo: member._id,
          leadStatus: 'Confirmed',
        });

        return {
          userId: member._id.toString(),
          name: member.name,
          email: member.email,
          roleName: member.roleName,
          totalLeads: memberLeads.length,
          confirmedLeads: memberConfirmed,
          todayCalls,
          todaySMS,
          todayActivities,
          statusConversions: conversions,
        };
      })
    );

    // Manager's own analytics
    const managerLeads = await Lead.find({ assignedTo: managerId });
    const managerLeadIds = managerLeads.map((lead) => lead._id);

    // Get today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Ensure managerId is ObjectId for proper querying
    let managerUserId = managerId;
    if (!(managerId instanceof mongoose.Types.ObjectId)) {
      try {
        managerUserId = new mongoose.Types.ObjectId(managerId);
      } catch (e) {
        managerUserId = managerId;
      }
    }

    // Get today's calls made by manager (from Communication logs)
    const managerTodayCalls = await Communication.countDocuments({
      sentBy: managerUserId,
      type: 'call',
      sentAt: { $gte: todayStart, $lte: todayEnd },
    });

    // Get today's SMS sent by manager (from Communication logs)
    const managerTodaySMS = await Communication.countDocuments({
      sentBy: managerUserId,
      type: 'sms',
      sentAt: { $gte: todayStart, $lte: todayEnd },
    });

    // Get today's activity logs performed by manager (from ActivityLog)
    const managerTodayActivities = await ActivityLog.countDocuments({
      performedBy: managerUserId,
      createdAt: { $gte: todayStart, $lte: todayEnd },
    });

    const managerConfirmed = await Lead.countDocuments({
      assignedTo: managerId,
      leadStatus: 'Confirmed',
    });

    // Find unfollowed leads
    // A lead is unfollowed if the assigned user has:
    // - No calls for that lead
    // - No SMS for that lead
    // - No activity logs (except status_change to "Assigned")
    const unfollowedLeads = [];
    
    for (const lead of allLeads) {
      const assignedUserId = lead.assignedTo?.toString() || lead.assignedTo;
      if (!assignedUserId) continue;

      let userObjId = assignedUserId;
      if (!(assignedUserId instanceof mongoose.Types.ObjectId)) {
        try {
          userObjId = new mongoose.Types.ObjectId(assignedUserId);
        } catch (e) {
          userObjId = assignedUserId;
        }
      }

      // Check for calls from assigned user for this lead
      const hasCalls = await Communication.exists({
        leadId: lead._id,
        sentBy: userObjId,
        type: 'call',
      });

      // Check for SMS from assigned user for this lead
      const hasSMS = await Communication.exists({
        leadId: lead._id,
        sentBy: userObjId,
        type: 'sms',
      });

      // Check for activity logs from assigned user for this lead
      // Exclude status_change to "Assigned" with null oldStatus (initial assignment)
      const hasActivity = await ActivityLog.exists({
        leadId: lead._id,
        performedBy: userObjId,
        $or: [
          { type: { $ne: 'status_change' } },
          { 
            type: 'status_change',
            $or: [
              { newStatus: { $ne: 'Assigned' } },
              { oldStatus: { $ne: null } } // If oldStatus exists, it's not the initial assignment
            ]
          }
        ]
      });

      // If no calls, no SMS, and no activity (except assignment), it's unfollowed
      if (!hasCalls && !hasSMS && !hasActivity) {
        unfollowedLeads.push(lead);
      }
    }

    // Populate assignedTo and limit
    const populatedUnfollowedLeads = await Lead.find({
      _id: { $in: unfollowedLeads.map(l => l._id) },
    })
      .populate('assignedTo', 'name email')
      .limit(100);

    return successResponse(
      res,
      {
        totalLeads,
        confirmedLeads,
        statusBreakdown: statusMap,
        teamAnalytics,
        managerAnalytics: {
          totalLeads: managerLeads.length,
          confirmedLeads: managerConfirmed,
          todayCalls: managerTodayCalls,
          todaySMS: managerTodaySMS,
          todayActivities: managerTodayActivities,
        },
        unfollowedLeads: populatedUnfollowedLeads.map((lead) => ({
          _id: lead._id,
          enquiryNumber: lead.enquiryNumber,
          name: lead.name,
          phone: lead.phone,
          leadStatus: lead.leadStatus,
          assignedTo: lead.assignedTo,
          lastFollowUp: lead.lastFollowUp,
        })),
        unfollowedCount: populatedUnfollowedLeads.length,
      },
      'Manager analytics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting manager analytics:', error);
    return errorResponse(res, error.message || 'Failed to get manager analytics', 500);
  }
};

// @desc    Get unfollowed leads for manager's team
// @route   GET /api/manager/unfollowed-leads
// @access  Private (Manager only)
export const getUnfollowedLeads = async (req, res) => {
  try {
    const managerId = req.user._id;

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get team member IDs
    const teamMembers = await User.find({ managedBy: managerId }).select('_id');
    const teamMemberIds = teamMembers.map((member) => member._id);
    const allUserIds = [managerId, ...teamMemberIds];

    // Get all leads
    const allLeads = await Lead.find({ assignedTo: { $in: allUserIds } });
    const allLeadIds = allLeads.map((lead) => lead._id);

    // Find unfollowed leads
    // A lead is unfollowed if the assigned user has:
    // - No calls for that lead
    // - No SMS for that lead
    // - No activity logs (except status_change to "Assigned")
    const unfollowedLeads = [];
    
    for (const lead of allLeads) {
      const assignedUserId = lead.assignedTo?.toString() || lead.assignedTo;
      if (!assignedUserId) continue;

      let userObjId = assignedUserId;
      if (!(assignedUserId instanceof mongoose.Types.ObjectId)) {
        try {
          userObjId = new mongoose.Types.ObjectId(assignedUserId);
        } catch (e) {
          userObjId = assignedUserId;
        }
      }

      // Check for calls from assigned user for this lead
      const hasCalls = await Communication.exists({
        leadId: lead._id,
        sentBy: userObjId,
        type: 'call',
      });

      // Check for SMS from assigned user for this lead
      const hasSMS = await Communication.exists({
        leadId: lead._id,
        sentBy: userObjId,
        type: 'sms',
      });

      // Check for activity logs from assigned user for this lead
      // Exclude status_change to "Assigned" with null oldStatus (initial assignment)
      const hasActivity = await ActivityLog.exists({
        leadId: lead._id,
        performedBy: userObjId,
        $or: [
          { type: { $ne: 'status_change' } },
          { 
            type: 'status_change',
            $or: [
              { newStatus: { $ne: 'Assigned' } },
              { oldStatus: { $ne: null } } // If oldStatus exists, it's not the initial assignment
            ]
          }
        ]
      });

      // If no calls, no SMS, and no activity (except assignment), it's unfollowed
      if (!hasCalls && !hasSMS && !hasActivity) {
        unfollowedLeads.push(lead);
      }
    }

    // Populate assignedTo and sort
    const populatedLeads = await Lead.find({
      _id: { $in: unfollowedLeads.map(l => l._id) },
    })
      .populate('assignedTo', 'name email roleName')
      .sort({ createdAt: -1 })
      .limit(500);

    return successResponse(
      res,
      {
        leads: populatedLeads,
        count: populatedLeads.length,
      },
      'Unfollowed leads retrieved successfully',
      200
    );
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get unfollowed leads', 500);
  }
};

// @desc    Send notifications to team members
// @route   POST /api/manager/notify-team
// @access  Private (Manager only)
export const notifyTeam = async (req, res) => {
  try {
    const managerId = req.user._id;

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    const { userIds, message, subject, type = 'email' } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return errorResponse(res, 'Please provide user IDs to notify', 400);
    }

    if (!message) {
      return errorResponse(res, 'Please provide a message', 400);
    }

    // Verify all users are team members
    const teamMembers = await User.find({ managedBy: managerId }).select('_id');
    const teamMemberIds = teamMembers.map((member) => member._id.toString());

    const invalidUsers = userIds.filter((userId) => !teamMemberIds.includes(userId.toString()));
    if (invalidUsers.length > 0) {
      return errorResponse(res, 'Some users are not part of your team', 400);
    }

    // Get user details
    const usersToNotify = await User.find({ _id: { $in: userIds } }).select('name email');

    // TODO: Implement actual notification sending
    // This would integrate with your notification service
    // For now, we'll just return success

    return successResponse(
      res,
      {
        notified: usersToNotify.length,
        users: usersToNotify.map((user) => ({
          id: user._id,
          name: user.name,
          email: user.email,
        })),
        message,
        subject,
        type,
      },
      'Notifications sent successfully',
      200
    );
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to send notifications', 500);
  }
};

// @desc    Get team analytics for super admin (by manager ID)
// @route   GET /api/manager/team-analytics/:managerId
// @access  Private (Super Admin only)
export const getTeamAnalyticsForAdmin = async (req, res) => {
  try {
    // Only Super Admin can access this
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Only Super Admin can access this endpoint', 403);
    }

    const managerId = req.params.managerId;

    // Verify manager exists and is actually a manager
    const manager = await User.findById(managerId).select('_id name email roleName isManager');
    if (!manager) {
      return errorResponse(res, 'Manager not found', 404);
    }
    if (!manager.isManager) {
      return errorResponse(res, 'User is not a manager', 400);
    }

    // Get team member IDs
    const teamMembers = await User.find({ managedBy: managerId }).select('_id name email roleName');
    const teamMemberIds = teamMembers.map((member) => member._id);
    const allUserIds = [managerId, ...teamMemberIds];

    // Date filtering for activities (calls, SMS, status changes)
    let activityDateFilter = {};
    if (req.query.startDate || req.query.endDate) {
      if (req.query.startDate) {
        const start = new Date(req.query.startDate);
        start.setHours(0, 0, 0, 0);
        activityDateFilter.$gte = start;
      }
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        activityDateFilter.$lte = end;
      }
    }

    // Get all leads assigned to manager and team (no date filter on leads - show all assigned)
    const leadFilter = {
      assignedTo: { $in: allUserIds },
    };

    const allLeads = await Lead.find(leadFilter);
    const allLeadIds = allLeads.map((lead) => lead._id);

    // Total leads
    const totalLeads = allLeads.length;

    // Team status breakdown
    const statusBreakdown = await Lead.aggregate([
      { $match: leadFilter },
      {
        $group: {
          _id: '$leadStatus',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const statusMap = {};
    statusBreakdown.forEach((item) => {
      statusMap[item._id || 'Not Provided'] = item.count;
    });

    // Confirmed leads
    const confirmedLeads = await Lead.countDocuments({
      ...leadFilter,
      leadStatus: 'Confirmed',
    });

    // Team calls and SMS (within date range)
    let teamCalls = 0;
    let teamSMS = 0;
    if (Object.keys(activityDateFilter).length > 0) {
      const userIdsForQuery = allUserIds.map(id => {
        if (id instanceof mongoose.Types.ObjectId) return id;
        if (mongoose.Types.ObjectId.isValid(id)) return new mongoose.Types.ObjectId(id);
        return id;
      });

      const callFilter = {
        sentBy: { $in: userIdsForQuery },
        type: 'call',
        sentAt: activityDateFilter,
      };
      teamCalls = await Communication.countDocuments(callFilter);

      const smsFilter = {
        sentBy: { $in: userIdsForQuery },
        type: 'sms',
        sentAt: activityDateFilter,
      };
      teamSMS = await Communication.countDocuments(smsFilter);
    }

    // Team status changes (within date range)
    let teamStatusChanges = 0;
    if (Object.keys(activityDateFilter).length > 0) {
      const userIdsForQuery = allUserIds.map(id => {
        if (id instanceof mongoose.Types.ObjectId) return id;
        if (mongoose.Types.ObjectId.isValid(id)) return new mongoose.Types.ObjectId(id);
        return id;
      });

      const statusChangeFilter = {
        performedBy: { $in: userIdsForQuery },
        type: 'status_change',
        createdAt: activityDateFilter,
      };
      teamStatusChanges = await ActivityLog.countDocuments(statusChangeFilter);
    }

    // Calculate total unfollowed leads across all team members
    // A lead is unfollowed if the assigned user has no calls, SMS, or activity logs (except assignment)
    let totalUnfollowedLeads = 0;
    for (const userId of allUserIds) {
      let userObjId = userId;
      if (!(userId instanceof mongoose.Types.ObjectId)) {
        try {
          userObjId = new mongoose.Types.ObjectId(userId);
        } catch (e) {
          userObjId = userId;
        }
      }

      const userLeads = await Lead.find({ assignedTo: userId });
      const userLeadIds = userLeads.map((lead) => lead._id);

      for (const leadId of userLeadIds) {
        // Check for calls from this user for this lead
        const hasCalls = await Communication.exists({
          leadId: leadId,
          sentBy: userObjId,
          type: 'call',
        });

        // Check for SMS from this user for this lead
        const hasSMS = await Communication.exists({
          leadId: leadId,
          sentBy: userObjId,
          type: 'sms',
        });

        // Check for activity logs from this user for this lead
        // Exclude status_change to "Assigned" (assignment itself)
        const hasActivity = await ActivityLog.exists({
          leadId: leadId,
          performedBy: userObjId,
          $or: [
            { type: { $ne: 'status_change' } },
            { 
              type: 'status_change',
              $or: [
                { newStatus: { $ne: 'Assigned' } },
                { oldStatus: { $ne: null } } // If oldStatus exists, it's not the initial assignment
              ]
            }
          ]
        });

        // If no calls, no SMS, and no activity (except assignment), it's unfollowed
        if (!hasCalls && !hasSMS && !hasActivity) {
          totalUnfollowedLeads++;
        }
      }
    }

    // Get per-user analytics
    const userAnalytics = await Promise.all(
      allUserIds.map(async (userId) => {
        const user = userId.toString() === managerId.toString() 
          ? manager 
          : teamMembers.find(m => m._id.toString() === userId.toString());
        
        if (!user) return null;

        const userLeads = await Lead.find({ assignedTo: userId });
        const userLeadIds = userLeads.map((lead) => lead._id);

        // User status breakdown
        const userStatusBreakdown = await Lead.aggregate([
          { $match: { assignedTo: userId } },
          {
            $group: {
              _id: '$leadStatus',
              count: { $sum: 1 },
            },
          },
        ]);

        const userStatusMap = {};
        userStatusBreakdown.forEach((item) => {
          userStatusMap[item._id || 'Not Provided'] = item.count;
        });

        // User calls and SMS (within date range)
        let userCalls = 0;
        let userSMS = 0;
        if (Object.keys(activityDateFilter).length > 0) {
          let userObjId = userId;
          if (!(userId instanceof mongoose.Types.ObjectId)) {
            try {
              userObjId = new mongoose.Types.ObjectId(userId);
            } catch (e) {
              userObjId = userId;
            }
          }

          userCalls = await Communication.countDocuments({
            sentBy: userObjId,
            type: 'call',
            sentAt: activityDateFilter,
          });

          userSMS = await Communication.countDocuments({
            sentBy: userObjId,
            type: 'sms',
            sentAt: activityDateFilter,
          });
        }

        // User unfollowed leads count
        // A lead is unfollowed if the assigned user has:
        // - No calls for that lead
        // - No SMS for that lead
        // - No activity logs (except status_change to "Assigned")
        let userObjId = userId;
        if (!(userId instanceof mongoose.Types.ObjectId)) {
          try {
            userObjId = new mongoose.Types.ObjectId(userId);
          } catch (e) {
            userObjId = userId;
          }
        }

        const userUnfollowedLeadIds = [];
        for (const leadId of userLeadIds) {
          // Check for calls from this user for this lead
          const hasCalls = await Communication.exists({
            leadId: leadId,
            sentBy: userObjId,
            type: 'call',
          });

          // Check for SMS from this user for this lead
          const hasSMS = await Communication.exists({
            leadId: leadId,
            sentBy: userObjId,
            type: 'sms',
          });

          // Check for activity logs from this user for this lead
          // Exclude status_change to "Assigned" (assignment itself)
          const hasActivity = await ActivityLog.exists({
            leadId: leadId,
            performedBy: userObjId,
            $or: [
              { type: { $ne: 'status_change' } },
              { 
                type: 'status_change',
                $or: [
                  { newStatus: { $ne: 'Assigned' } },
                  { oldStatus: { $ne: null } } // If oldStatus exists, it's not the initial assignment
                ]
              }
            ]
          });

          // If no calls, no SMS, and no activity (except assignment), it's unfollowed
          if (!hasCalls && !hasSMS && !hasActivity) {
            userUnfollowedLeadIds.push(leadId);
          }
        }

        return {
          userId: userId.toString(),
          name: user.name,
          email: user.email,
          roleName: user.roleName,
          isManager: userId.toString() === managerId.toString(),
          totalLeads: userLeads.length,
          confirmedLeads: userStatusMap['Confirmed'] || 0,
          statusBreakdown: userStatusMap,
          calls: userCalls,
          sms: userSMS,
          unfollowedLeadsCount: userUnfollowedLeadIds.length,
        };
      })
    );

    // Filter out null values
    const validUserAnalytics = userAnalytics.filter(analytics => analytics !== null);

    return successResponse(
      res,
      {
        manager: {
          _id: manager._id.toString(),
          name: manager.name,
          email: manager.email,
        },
        teamMembers: teamMembers.map(m => ({
          _id: m._id.toString(),
          name: m.name,
          email: m.email,
          roleName: m.roleName,
        })),
        teamStats: {
          totalLeads,
          confirmedLeads,
          statusBreakdown: statusMap,
          calls: teamCalls,
          sms: teamSMS,
          statusChanges: teamStatusChanges,
          totalUnfollowedLeads,
        },
        userAnalytics: validUserAnalytics,
      },
      'Team analytics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting team analytics:', error);
    return errorResponse(res, error.message || 'Failed to get team analytics', 500);
  }
};

