import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { findBestMatch } from '../utils/fuzzyMatch.util.js';
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
    const hasDates = startDate && endDate;
    
    try {
      if (hasDates) {
        end = new Date(endDate);
        start = new Date(startDate);
        
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
      }
    } catch (error) {
      return errorResponse(res, 'Invalid date format', 400);
    }

    const pool = getPool();
    
    // Build WHERE conditions
    const conditions = ['type = ?'];
    const params = ['call'];

    if (hasDates) {
      const startStr = start.toISOString().slice(0, 19).replace('T', ' ');
      const endStr = end.toISOString().slice(0, 19).replace('T', ' ');
      conditions.push('sent_at >= ?', 'sent_at <= ?');
      params.push(startStr, endStr);
    }

    if (userId) {
      if (!userId || typeof userId !== 'string' || userId.length !== 36) {
        return errorResponse(res, 'Invalid user ID', 400);
      }
      conditions.push('sent_by = ?');
      params.push(userId);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Aggregate calls by user and date
    const [callReports] = await pool.execute(
      `SELECT 
        sent_by as user_id,
        DATE(sent_at) as date,
        COUNT(*) as call_count,
        SUM(COALESCE(duration_seconds, 0)) as total_duration
       FROM communications
       ${whereClause}
       GROUP BY sent_by, DATE(sent_at)
       ORDER BY date DESC, sent_by ASC`,
      params
    );

    // Get user details
    const userIds = [...new Set(callReports.map((r) => r.user_id).filter(Boolean))];
    let userMap = {};
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      const [users] = await pool.execute(
        `SELECT id, name, email, role_name FROM users WHERE id IN (${userPlaceholders})`,
        userIds
      );
      
      users.forEach((user) => {
        if (user && user.id) {
          userMap[user.id] = user;
        }
      });
    }

    // Format response
    const formattedReports = (callReports || []).map((report) => {
      const userId = report.user_id || 'unknown';
      const dateStr = report.date instanceof Date 
        ? report.date.toISOString().slice(0, 10) 
        : report.date;
      return {
        date: dateStr || '',
        userId,
        userName: userMap[userId]?.name || 'Unknown',
        userEmail: userMap[userId]?.email || '',
        callCount: report.call_count || 0,
        totalDuration: report.total_duration || 0,
        averageDuration: (report.call_count || 0) > 0 ? Math.round((report.total_duration || 0) / report.call_count) : 0,
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
          start: hasDates ? start.toISOString() : null,
          end: hasDates ? end.toISOString() : null,
          isOverall: !hasDates,
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

    // Calculate date range based on period
    let start, end;
    const hasDates = (startDate && endDate) || (period && period !== 'custom');

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
          if (startDate && endDate) {
            end = new Date(endDate);
            start = new Date(startDate);
          }
          break;
      }

      if (hasDates) {
        if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
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
      }
    } catch (error) {
      return errorResponse(res, 'Invalid date format', 400);
    }

    const pool = getPool();
    
    // Build filter for leads
    let leadConditions = ['assigned_to IS NOT NULL'];
    let leadParams = [];

    if (hasDates) {
      const startStr = start.toISOString().slice(0, 19).replace('T', ' ');
      const endStr = end.toISOString().slice(0, 19).replace('T', ' ');
      leadConditions.push('created_at >= ?', 'created_at <= ?');
      leadParams.push(startStr, endStr);
    }

    if (userId) {
      if (!userId || typeof userId !== 'string' || userId.length !== 36) {
        return errorResponse(res, 'Invalid user ID', 400);
      }
      leadConditions.push('assigned_to = ?');
      leadParams.push(userId);
    }

    const leadWhereClause = `WHERE ${leadConditions.join(' AND ')}`;

    // Get all assigned leads in the period
    const [assignedLeads] = await pool.execute(
      `SELECT l.id, l.assigned_to, l.enquiry_number, l.name, l.created_at,
       u.id as assigned_to_id, u.name as assigned_to_name, u.email as assigned_to_email, u.role_name as assigned_to_role_name
       FROM leads l
       LEFT JOIN users u ON l.assigned_to = u.id
       ${leadWhereClause}`,
      leadParams
    ).catch((error) => {
      console.error('Error fetching assigned leads:', error);
      return [[], []];
    });

    // Get all admissions - NOTE: Requires admissions table (will be updated when admission controller is migrated)
    const [admissions] = await pool.execute(
      `SELECT a.id, a.lead_id, a.admission_date,
       l.assigned_to, l.enquiry_number, l.name as lead_name
       FROM admissions a
       LEFT JOIN leads l ON a.lead_id = l.id
       WHERE a.admission_date >= ? AND a.admission_date <= ?`,
      [startStr, endStr]
    ).catch((error) => {
      console.error('Error fetching admissions:', error);
      return [[], []];
    });

    // Create a map of leadId to admission
    const leadToAdmissionMap = {};
    (admissions || []).forEach((admission) => {
      if (admission && admission.lead_id && admission.assigned_to) {
        const assignedToId = admission.assigned_to;
        if (assignedToId) {
          if (!leadToAdmissionMap[assignedToId]) {
            leadToAdmissionMap[assignedToId] = [];
          }
          leadToAdmissionMap[assignedToId].push({
            id: admission.id,
            _id: admission.id,
            leadId: admission.lead_id,
            admissionDate: admission.admission_date,
            leadEnquiryNumber: admission.enquiry_number,
            leadName: admission.lead_name,
          });
        }
      }
    });

    // Group leads by assigned user
    const userLeadMap = {};
    (assignedLeads || []).forEach((lead) => {
      if (lead && lead.assigned_to) {
        const userId = lead.assigned_to;
        if (userId) {
          if (!userLeadMap[userId]) {
            userLeadMap[userId] = {
              userId,
              userName: lead.assigned_to_name || 'Unknown',
              userEmail: lead.assigned_to_email || '',
              roleName: lead.assigned_to_role_name || 'User',
              leads: [],
            };
          }
          userLeadMap[userId].leads.push({
            id: lead.id,
            _id: lead.id,
            enquiryNumber: lead.enquiry_number,
            name: lead.name,
            createdAt: lead.created_at,
          });
        }
      }
    });

    // Get status conversions from activity logs for the period
    const [statusChanges] = await pool.execute(
      `SELECT a.lead_id, a.old_status, a.new_status, a.performed_by, a.created_at,
       l.assigned_to, l.name as lead_name, l.enquiry_number,
       u.name as performed_by_name, u.email as performed_by_email
       FROM activity_logs a
       LEFT JOIN leads l ON a.lead_id = l.id
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.type = 'status_change' AND a.created_at >= ? AND a.created_at <= ?`,
      [startStr, endStr]
    );

    // Group status changes by user
    const userStatusChanges = {};
    statusChanges.forEach((change) => {
      if (change.lead_id && change.assigned_to) {
        const userId = change.assigned_to;
        if (!userStatusChanges[userId]) {
          userStatusChanges[userId] = [];
        }
        userStatusChanges[userId].push({
          leadId: change.lead_id,
          leadName: change.lead_name || 'Unknown',
          enquiryNumber: change.enquiry_number || '',
          from: change.old_status || 'Unknown',
          to: change.new_status || 'Unknown',
          performedBy: change.performed_by_name || 'Unknown',
          date: change.created_at,
        });
      }
    });

    // Pre-calculate confirmed leads count for all users
    const userIds = Object.keys(userLeadMap);
    const confirmedLeadsMap = {};
    
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      const [confirmedLeadsAggregation] = await pool.execute(
        `SELECT assigned_to, COUNT(*) as count 
         FROM leads 
         WHERE assigned_to IN (${userPlaceholders}) AND lead_status = 'Confirmed' AND created_at >= ? AND created_at <= ?
         GROUP BY assigned_to`,
        [...userIds, startStr, endStr]
      );

      confirmedLeadsAggregation.forEach((item) => {
        confirmedLeadsMap[item.assigned_to] = item.count || 0;
      });
    }

    // Calculate conversions for each user with status change data
    const conversionReports = Object.values(userLeadMap).map((userData) => {
      if (!userData || !userData.leads) {
        return null;
      }
      const totalLeads = userData.leads.length || 0;
      const admissionsForUser = leadToAdmissionMap[userData.userId] || [];
      const convertedLeads = admissionsForUser.length || 0;
      const conversionRate = totalLeads > 0 ? parseFloat(((convertedLeads / totalLeads) * 100).toFixed(2)) : 0;

      // Get status changes for this user's leads
      const userStatusChangesList = userStatusChanges[userData.userId] || [];
      
      // Count status conversions (e.g., New → Interested, Interested → Confirmed)
      const statusConversionCounts = {};
      userStatusChangesList.forEach((change) => {
        const conversion = `${change.from} → ${change.to}`;
        statusConversionCounts[conversion] = (statusConversionCounts[conversion] || 0) + 1;
      });

      // Get confirmed leads count from pre-calculated map
      const confirmedLeads = confirmedLeadsMap[userData.userId] || 0;

      return {
        userId: userData.userId || 'unknown',
        userName: userData.userName || 'Unknown',
        userEmail: userData.userEmail || '',
        roleName: userData.roleName || 'User',
        totalLeads,
        convertedLeads,
        confirmedLeads,
        conversionRate,
        statusConversions: statusConversionCounts,
        statusChangeCount: userStatusChangesList.length,
        admissions: (admissionsForUser || []).map((adm) => ({
          admissionId: adm?.id || 'N/A',
          admissionDate: adm?.admission_date || null,
          leadEnquiryNumber: adm?.lead_enquiry_number || 'N/A',
          leadName: adm?.lead_name || 'N/A',
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
          start: hasDates ? start.toISOString() : null,
          end: hasDates ? end.toISOString() : null,
          period: period || 'custom',
          isOverall: !hasDates,
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

// Helper: normalize string for case-insensitive matching (leads store names with possible variations)
const norm = (s) => (s == null || s === '' ? '' : String(s).toLowerCase().trim());

// @desc    Get leads abstract (district, mandal breakdown) for an academic year
// Optimized: pre-aggregate leads with GROUP BY (index-friendly), map to master in app
// Mandal query runs ONLY when districtId is provided to avoid heavy full-state mandal scan
// @route   GET /api/reports/leads-abstract
// @access  Private (Super Admin only)
export const getLeadsAbstract = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const { academicYear, studentGroup, stateId, districtId } = req.query;
    const pool = getPool();

    if (!academicYear || academicYear === '') {
      return errorResponse(res, 'Academic year is required', 400);
    }

    const yearNum = parseInt(academicYear, 10);
    if (Number.isNaN(yearNum)) {
      return errorResponse(res, 'Invalid academic year', 400);
    }

    let leadWhere = 'academic_year = ?';
    const leadParams = [yearNum];
    if (studentGroup && studentGroup !== '') {
      if (studentGroup === 'Inter') {
        leadWhere += " AND (student_group = 'Inter' OR student_group LIKE 'Inter-%')";
      } else {
        leadWhere += ' AND student_group = ?';
        leadParams.push(studentGroup);
      }
    }

    // 1) Pre-aggregate leads by district - single scan, uses idx_leads_academic_year
    const [leadDistrictAgg] = await pool.execute(
      `SELECT TRIM(district) AS district, COUNT(*) AS cnt
       FROM leads
       WHERE ${leadWhere} AND district IS NOT NULL AND district != ''
       GROUP BY TRIM(district)`,
      leadParams
    ).catch(() => [[]]);

    const districtCountMap = new Map();
    (leadDistrictAgg || []).forEach((r) => {
      const key = norm(r.district);
      if (key) districtCountMap.set(key, (districtCountMap.get(key) || 0) + Number(r.cnt || 0));
    });

    // 2) Fetch districts for state (or all if no state)
    const districtWhere = stateId && stateId !== ''
      ? 'state_id = ? AND is_active = 1'
      : 'is_active = 1';
    const districtQueryParams = stateId && stateId !== '' ? [stateId] : [];
    const [districtRows] = await pool.execute(
      `SELECT id, name FROM districts WHERE ${districtWhere} ORDER BY name ASC`,
      districtQueryParams
    ).catch(() => [[]]);

    const masterDistrictNamesNorm = (districtRows || []).map((d) => norm(d.name));
    const districtTotals = new Map();
    (districtRows || []).forEach((d) => districtTotals.set(norm(d.name), 0));
    for (const [leadKey, cnt] of districtCountMap) {
      const best = findBestMatch(leadKey, masterDistrictNamesNorm, 0.85);
      if (best && districtTotals.has(best)) {
        districtTotals.set(best, districtTotals.get(best) + cnt);
      }
    }
    const districtBreakdown = (districtRows || []).map((d) => {
      const name = d.name || '';
      const count = districtTotals.get(norm(name)) || 0;
      return { id: d.id, name, count: Number(count) };
    }).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

    const maxDistrict = districtBreakdown.length > 0 ? districtBreakdown[0].name : null;

    let mandalBreakdown = [];
    let maxMandal = null;

    // 3) Mandal stats ONLY when district is selected - avoids 600+ mandals × leads scan
    if (districtId && districtId !== '') {
      const [districtNameRow] = await pool.execute(
        'SELECT name FROM districts WHERE id = ? AND is_active = 1',
        [districtId]
      ).catch(() => [[]]);

      const districtName = districtNameRow?.[0]?.name || '';
      if (districtName) {
        const mandalLeadParams = [...leadParams, districtName];
        const mandalLeadWhere = `${leadWhere} AND district = ? AND mandal IS NOT NULL AND mandal != ''`;
        const [leadMandalAgg] = await pool.execute(
          `SELECT TRIM(mandal) AS mandal, COUNT(*) AS cnt
           FROM leads
           WHERE ${mandalLeadWhere}
           GROUP BY TRIM(mandal)`,
          mandalLeadParams
        ).catch(() => [[]]);

        const mandalCountMap = new Map();
        (leadMandalAgg || []).forEach((r) => {
          const key = norm(r.mandal);
          if (key) mandalCountMap.set(key, (mandalCountMap.get(key) || 0) + Number(r.cnt || 0));
        });

        const [mandalRows] = await pool.execute(
          'SELECT id, name FROM mandals WHERE district_id = ? AND is_active = 1 ORDER BY name ASC',
          [districtId]
        ).catch(() => [[]]);

        const masterMandalNamesNorm = (mandalRows || []).map((m) => norm(m.name));
        const mandalTotals = new Map();
        (mandalRows || []).forEach((m) => mandalTotals.set(norm(m.name), 0));
        for (const [leadKey, cnt] of mandalCountMap) {
          const best = findBestMatch(leadKey, masterMandalNamesNorm, 0.85);
          if (best && mandalTotals.has(best)) {
            mandalTotals.set(best, mandalTotals.get(best) + cnt);
          }
        }
        mandalBreakdown = (mandalRows || []).map((m) => {
          const name = m.name || '';
          const count = mandalTotals.get(norm(name)) || 0;
          return { id: m.id, name, count: Number(count) };
        }).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

        maxMandal = mandalBreakdown.length > 0 ? mandalBreakdown[0].name : null;
      }
    }

    return successResponse(
      res,
      {
        academicYear: yearNum,
        studentGroup: studentGroup || null,
        districtBreakdown,
        maxDistrict,
        mandalBreakdown,
        maxMandal,
      },
      'Leads abstract retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting leads abstract:', error);
    return errorResponse(res, error.message || 'Failed to get leads abstract', 500);
  }
};

