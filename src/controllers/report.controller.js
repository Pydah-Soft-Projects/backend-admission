import mongoose from 'mongoose';
import Communication from '../models/Communication.model.js';
import Lead from '../models/Lead.model.js';
import Admission from '../models/Admission.model.js';
import User from '../models/User.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';

// @desc    Get daily call reports per user
// @route   GET /api/reports/calls/daily
// @access  Private (Super Admin only)
export const getDailyCallReports = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const { startDate, endDate, userId } = req.query;

    // Validate and parse dates
    let start, end;
    try {
      end = endDate ? new Date(endDate) : new Date();
      start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return errorResponse(res, 'Invalid date format', 400);
      }

      if (start > end) {
        return errorResponse(res, 'Start date must be before end date', 400);
      }

      // Limit date range to max 1 year
      const maxRange = 365 * 24 * 60 * 60 * 1000;
      if (end.getTime() - start.getTime() > maxRange) {
        return errorResponse(res, 'Date range cannot exceed 365 days', 400);
      }

      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    } catch (error) {
      return errorResponse(res, 'Invalid date format', 400);
    }

    // Build filter
    const filter = {
      type: 'call',
      sentAt: { $gte: start, $lte: end },
    };

    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return errorResponse(res, 'Invalid user ID', 400);
      }
      filter.sentBy = new mongoose.Types.ObjectId(userId);
    }

    // Aggregate calls by user and date
    const callReports = await Communication.aggregate([
      { $match: filter },
      {
        $group: {
          _id: {
            userId: '$sentBy',
            date: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$sentAt',
                timezone: 'Asia/Kolkata',
              },
            },
          },
          callCount: { $sum: 1 },
          totalDuration: { $sum: { $ifNull: ['$durationSeconds', 0] } },
        },
      },
      { $sort: { '_id.date': -1, '_id.userId': 1 } },
    ]);

    // Get user details
    const userIds = [...new Set(callReports.map((r) => r._id?.userId?.toString()).filter(Boolean))];
    const users = userIds.length > 0
      ? await User.find({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } })
          .select('_id name email roleName')
          .lean()
      : [];

    const userMap = {};
    users.forEach((user) => {
      if (user && user._id) {
        userMap[user._id.toString()] = user;
      }
    });

    // Format response
    const formattedReports = (callReports || []).map((report) => {
      const userId = report._id?.userId?.toString() || 'unknown';
      return {
        date: report._id?.date || '',
        userId,
        userName: userMap[userId]?.name || 'Unknown',
        userEmail: userMap[userId]?.email || '',
        callCount: report.callCount || 0,
        totalDuration: report.totalDuration || 0,
        averageDuration: (report.callCount || 0) > 0 ? Math.round((report.totalDuration || 0) / report.callCount) : 0,
      };
    });

    // Group by user for summary
    const userSummary = {};
    (formattedReports || []).forEach((report) => {
      if (report && report.userId) {
        if (!userSummary[report.userId]) {
          userSummary[report.userId] = {
            userId: report.userId,
            userName: report.userName || 'Unknown',
            userEmail: report.userEmail || '',
            totalCalls: 0,
            totalDuration: 0,
            days: 0,
          };
        }
        userSummary[report.userId].totalCalls += report.callCount || 0;
        userSummary[report.userId].totalDuration += report.totalDuration || 0;
        userSummary[report.userId].days += 1;
      }
    });

    // Convert to array and calculate averages
    const userSummaryArray = Object.values(userSummary).map((summary) => ({
      ...summary,
      averageCallsPerDay: summary.days > 0 ? parseFloat((summary.totalCalls / summary.days).toFixed(2)) : 0,
      averageDuration: summary.totalCalls > 0 ? Math.round(summary.totalDuration / summary.totalCalls) : 0,
    }));

    return successResponse(
      res,
      {
        reports: formattedReports || [],
        summary: userSummaryArray || [],
        dateRange: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
      },
      'Daily call reports retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting daily call reports:', error);
    return errorResponse(res, error.message || 'Failed to get call reports', 500);
  }
};

// @desc    Get lead conversion to admissions reports (counsellor-wise)
// @route   GET /api/reports/conversions
// @access  Private (Super Admin only)
export const getConversionReports = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const { startDate, endDate, userId, period = 'custom' } = req.query;

    let start, end;

    // Calculate date range based on period
    try {
      const now = new Date();
      switch (period) {
        case 'weekly':
          start = new Date(now);
          start.setDate(start.getDate() - 7);
          end = new Date(now);
          break;
        case 'monthly':
          start = new Date(now.getFullYear(), now.getMonth(), 1);
          end = new Date(now);
          break;
        case 'custom':
        default:
          end = endDate ? new Date(endDate) : new Date();
          start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          break;
      }

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return errorResponse(res, 'Invalid date format', 400);
      }

      if (start > end) {
        return errorResponse(res, 'Start date must be before end date', 400);
      }

      // Limit date range to max 1 year
      const maxRange = 365 * 24 * 60 * 60 * 1000;
      if (end.getTime() - start.getTime() > maxRange) {
        return errorResponse(res, 'Date range cannot exceed 365 days', 400);
      }

      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    } catch (error) {
      return errorResponse(res, 'Invalid date format', 400);
    }

    // Build filter for leads
    const leadFilter = {
      assignedTo: { $exists: true, $ne: null },
      createdAt: { $gte: start, $lte: end },
    };

    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return errorResponse(res, 'Invalid user ID', 400);
      }
      leadFilter.assignedTo = new mongoose.Types.ObjectId(userId);
    }

    // Get all assigned leads in the period
    const assignedLeads = await Lead.find(leadFilter)
      .select('_id assignedTo enquiryNumber name createdAt')
      .populate('assignedTo', 'name email roleName')
      .lean()
      .catch((error) => {
        console.error('Error fetching assigned leads:', error);
        return [];
      });

    // Get all admissions
    const admissionFilter = {
      admissionDate: { $gte: start, $lte: end },
    };

    const admissions = await Admission.find(admissionFilter)
      .select('_id leadId admissionDate')
      .populate('leadId', 'assignedTo enquiryNumber name')
      .lean()
      .catch((error) => {
        console.error('Error fetching admissions:', error);
        return [];
      });

    // Create a map of leadId to admission
    const leadToAdmissionMap = {};
    (admissions || []).forEach((admission) => {
      if (admission && admission.leadId && admission.leadId.assignedTo) {
        const assignedToId = admission.leadId.assignedTo.toString();
        if (assignedToId) {
          if (!leadToAdmissionMap[assignedToId]) {
            leadToAdmissionMap[assignedToId] = [];
          }
          leadToAdmissionMap[assignedToId].push(admission);
        }
      }
    });

    // Group leads by assigned user
    const userLeadMap = {};
    (assignedLeads || []).forEach((lead) => {
      if (lead && lead.assignedTo) {
        const userId = lead.assignedTo._id?.toString() || lead.assignedTo.toString();
        if (userId) {
          if (!userLeadMap[userId]) {
            userLeadMap[userId] = {
              userId,
              userName: lead.assignedTo.name || 'Unknown',
              userEmail: lead.assignedTo.email || '',
              roleName: lead.assignedTo.roleName || 'User',
              leads: [],
            };
          }
          userLeadMap[userId].leads.push(lead);
        }
      }
    });

    // Calculate conversions for each user
    const conversionReports = Object.values(userLeadMap).map((userData) => {
      if (!userData || !userData.leads) {
        return null;
      }
      const totalLeads = userData.leads.length || 0;
      const admissionsForUser = leadToAdmissionMap[userData.userId] || [];
      const convertedLeads = admissionsForUser.length || 0;
      const conversionRate = totalLeads > 0 ? parseFloat(((convertedLeads / totalLeads) * 100).toFixed(2)) : 0;

      return {
        userId: userData.userId || 'unknown',
        userName: userData.userName || 'Unknown',
        userEmail: userData.userEmail || '',
        roleName: userData.roleName || 'User',
        totalLeads,
        convertedLeads,
        conversionRate,
        admissions: (admissionsForUser || []).map((adm) => ({
          admissionId: adm?._id?.toString() || 'N/A',
          admissionDate: adm?.admissionDate || null,
          leadEnquiryNumber: adm?.leadId?.enquiryNumber || 'N/A',
          leadName: adm?.leadId?.name || 'N/A',
        })),
      };
    }).filter(Boolean);

    // Sort by conversion rate (descending)
    conversionReports.sort((a, b) => (b?.conversionRate || 0) - (a?.conversionRate || 0));

    // Calculate overall statistics
    const totalLeads = (assignedLeads || []).length;
    const totalAdmissions = (admissions || []).length;
    const overallConversionRate = totalLeads > 0 ? parseFloat(((totalAdmissions / totalLeads) * 100).toFixed(2)) : 0;

    return successResponse(
      res,
      {
        reports: conversionReports || [],
        summary: {
          totalLeads: totalLeads || 0,
          totalAdmissions: totalAdmissions || 0,
          overallConversionRate: overallConversionRate || 0,
          totalCounsellors: conversionReports.length || 0,
        },
        dateRange: {
          start: start.toISOString(),
          end: end.toISOString(),
          period: period || 'custom',
        },
      },
      'Conversion reports retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting conversion reports:', error);
    return errorResponse(res, error.message || 'Failed to get conversion reports', 500);
  }
};

