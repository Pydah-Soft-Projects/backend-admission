import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';

// Helper function to format lead data (reuse from lead.controller.js pattern)
const formatLead = (leadData, assignedToUser = null) => {
  if (!leadData) return null;
  return {
    id: leadData.id,
    _id: leadData.id,
    enquiryNumber: leadData.enquiry_number,
    name: leadData.name,
    phone: leadData.phone,
    email: leadData.email,
    fatherName: leadData.father_name,
    motherName: leadData.mother_name || '',
    fatherPhone: leadData.father_phone,
    hallTicketNumber: leadData.hall_ticket_number || '',
    village: leadData.village,
    courseInterested: leadData.course_interested,
    district: leadData.district,
    mandal: leadData.mandal,
    state: leadData.state || '',
    isNRI: leadData.is_nri === 1 || leadData.is_nri === true,
    gender: leadData.gender || 'Not Specified',
    rank: leadData.rank,
    interCollege: leadData.inter_college || '',
    quota: leadData.quota || 'Not Applicable',
    applicationStatus: leadData.application_status || 'Not Provided',
    dynamicFields: typeof leadData.dynamic_fields === 'string' 
      ? JSON.parse(leadData.dynamic_fields) 
      : leadData.dynamic_fields || {},
    leadStatus: leadData.lead_status || 'New',
    admissionNumber: leadData.admission_number,
    assignedTo: assignedToUser || leadData.assigned_to,
    assignedAt: leadData.assigned_at,
    assignedBy: leadData.assigned_by,
    source: leadData.source,
    lastFollowUp: leadData.last_follow_up,
    nextScheduledCall: leadData.next_scheduled_call,
    academicYear: leadData.academic_year != null ? leadData.academic_year : undefined,
    studentGroup: leadData.student_group || undefined,
    notes: leadData.notes,
    createdAt: leadData.created_at,
    updatedAt: leadData.updated_at,
  };
};

// @desc    Get manager's team members
// @route   GET /api/manager/team
// @access  Private (Manager only)
export const getTeamMembers = async (req, res) => {
  try {
    const managerId = req.user.id || req.user._id;
    const pool = getPool();

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get all team members (users managed by this manager)
    const [teamMembers] = await pool.execute(
      `SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at
       FROM users 
       WHERE managed_by = ?
       ORDER BY name ASC`,
      [managerId]
    );

    const formattedMembers = teamMembers.map(member => ({
      id: member.id,
      _id: member.id,
      name: member.name,
      email: member.email,
      roleName: member.role_name,
      managedBy: member.managed_by,
      isManager: member.is_manager === 1 || member.is_manager === true,
      designation: member.designation,
      permissions: typeof member.permissions === 'string' 
        ? JSON.parse(member.permissions) 
        : member.permissions || {},
      isActive: member.is_active === 1 || member.is_active === true,
      createdAt: member.created_at,
      updatedAt: member.updated_at,
    }));

    return successResponse(res, formattedMembers, 'Team members retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting team members:', error);
    return errorResponse(res, error.message || 'Failed to get team members', 500);
  }
};

// @desc    Get all leads for manager (manager's leads + team members' leads)
// @route   GET /api/manager/leads
// @access  Private (Manager only)
export const getManagerLeads = async (req, res) => {
  try {
    const managerId = req.user.id || req.user._id;
    const pool = getPool();

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get team member IDs
    const [teamMembers] = await pool.execute(
      'SELECT id FROM users WHERE managed_by = ?',
      [managerId]
    );
    const teamMemberIds = teamMembers.map((member) => member.id);

    // Include manager's own ID in the list
    const allUserIds = [managerId, ...teamMemberIds];

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Assigned to manager or team members (using table alias for JOIN query)
    const placeholders = allUserIds.map(() => '?').join(',');
    conditions.push(`l.assigned_to IN (${placeholders})`);
    params.push(...allUserIds);

    // Apply additional filters from query params (using table alias for JOIN query)
    if (req.query.mandal) {
      conditions.push('l.mandal = ?');
      params.push(req.query.mandal);
    }
    if (req.query.state) {
      conditions.push('l.state = ?');
      params.push(req.query.state);
    }
    if (req.query.district) {
      conditions.push('l.district = ?');
      params.push(req.query.district);
    }
    if (req.query.leadStatus) {
      conditions.push('l.lead_status = ?');
      params.push(req.query.leadStatus);
    }
    if (req.query.applicationStatus) {
      conditions.push('l.application_status = ?');
      params.push(req.query.applicationStatus);
    }
    if (req.query.courseInterested) {
      conditions.push('l.course_interested = ?');
      params.push(req.query.courseInterested);
    }
    if (req.query.source) {
      conditions.push('l.source = ?');
      params.push(req.query.source);
    }

    // Date filtering (using table alias for JOIN query)
    if (req.query.startDate) {
      const start = new Date(req.query.startDate);
      start.setHours(0, 0, 0, 0);
      conditions.push('l.created_at >= ?');
      params.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.endDate) {
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      conditions.push('l.created_at <= ?');
      params.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }

    // Search functionality (using table alias for JOIN query)
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      conditions.push(`(
        MATCH(l.enquiry_number, l.name, l.phone, l.email, l.father_name, l.mother_name, l.course_interested, l.district, l.mandal, l.state, l.application_status, l.hall_ticket_number, l.inter_college) 
        AGAINST(? IN NATURAL LANGUAGE MODE)
        OR l.name LIKE ?
        OR l.phone LIKE ?
        OR l.email LIKE ?
      )`);
      params.push(searchTerm, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
    }

    if (req.query.enquiryNumber) {
      const searchTerm = req.query.enquiryNumber.trim();
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        conditions.push('l.enquiry_number LIKE ?');
        params.push(`${searchTerm}%`);
      } else {
        conditions.push('l.enquiry_number LIKE ?');
        params.push(`%${searchTerm}%`);
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;

    // Get total count (build WHERE clause without table alias for simple count query)
    const countConditions = [];
    const countParams = [];
    
    // Assigned to manager or team members
    const countPlaceholders = allUserIds.map(() => '?').join(',');
    countConditions.push(`assigned_to IN (${countPlaceholders})`);
    countParams.push(...allUserIds);
    
    // Apply same filters but without table alias
    if (req.query.mandal) {
      countConditions.push('mandal = ?');
      countParams.push(req.query.mandal);
    }
    if (req.query.state) {
      countConditions.push('state = ?');
      countParams.push(req.query.state);
    }
    if (req.query.district) {
      countConditions.push('district = ?');
      countParams.push(req.query.district);
    }
    if (req.query.leadStatus) {
      countConditions.push('lead_status = ?');
      countParams.push(req.query.leadStatus);
    }
    if (req.query.applicationStatus) {
      countConditions.push('application_status = ?');
      countParams.push(req.query.applicationStatus);
    }
    if (req.query.courseInterested) {
      countConditions.push('course_interested = ?');
      countParams.push(req.query.courseInterested);
    }
    if (req.query.source) {
      countConditions.push('source = ?');
      countParams.push(req.query.source);
    }
    if (req.query.startDate) {
      const start = new Date(req.query.startDate);
      start.setHours(0, 0, 0, 0);
      countConditions.push('created_at >= ?');
      countParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.endDate) {
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      countConditions.push('created_at <= ?');
      countParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      countConditions.push(`(
        MATCH(enquiry_number, name, phone, email, father_name, mother_name, course_interested, district, mandal, state, application_status, hall_ticket_number, inter_college) 
        AGAINST(? IN NATURAL LANGUAGE MODE)
        OR name LIKE ?
        OR phone LIKE ?
        OR email LIKE ?
      )`);
      countParams.push(searchTerm, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
    }
    if (req.query.enquiryNumber) {
      const searchTerm = req.query.enquiryNumber.trim();
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        countConditions.push('enquiry_number LIKE ?');
        countParams.push(`${searchTerm}%`);
      } else {
        countConditions.push('enquiry_number LIKE ?');
        countParams.push(`%${searchTerm}%`);
      }
    }
    
    const countWhereClause = `WHERE ${countConditions.join(' AND ')}`;
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${countWhereClause}`,
      countParams
    );
    const total = countResult[0].total;

    const needsUpdateConditions = [...countConditions, 'needs_manual_update = 1'];
    const needsUpdateWhereClause = `WHERE ${needsUpdateConditions.join(' AND ')}`;
    const [needsUpdateResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${needsUpdateWhereClause}`,
      countParams
    );
    const needsUpdateCount = needsUpdateResult[0]?.total ?? 0;

    // Get leads with user info
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [leads] = await pool.execute(
      `SELECT 
        l.*,
        u.id as assigned_to_id, u.name as assigned_to_name, u.email as assigned_to_email, u.role_name as assigned_to_role_name
       FROM leads l
       LEFT JOIN users u ON l.assigned_to = u.id
       ${whereClause}
       ORDER BY l.created_at DESC
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      params
    );

    const formattedLeads = leads.map(lead => {
      const assignedToUser = lead.assigned_to_id ? {
        id: lead.assigned_to_id,
        _id: lead.assigned_to_id,
        name: lead.assigned_to_name,
        email: lead.assigned_to_email,
        roleName: lead.assigned_to_role_name,
      } : null;
      return formatLead(lead, assignedToUser);
    });

    return successResponse(
      res,
      {
        leads: formattedLeads,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
        needsUpdateCount,
      },
      'Leads retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting manager leads:', error);
    return errorResponse(res, error.message || 'Failed to get leads', 500);
  }
};

// @desc    Get manager dashboard analytics
// @route   GET /api/manager/analytics
// @access  Private (Manager only)
export const getManagerAnalytics = async (req, res) => {
  try {
    const managerId = req.user.id || req.user._id;
    const pool = getPool();

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get team member IDs
    const [teamMembers] = await pool.execute(
      'SELECT id, name, email, role_name FROM users WHERE managed_by = ?',
      [managerId]
    );
    const teamMemberIds = teamMembers.map((member) => member.id);
    const allUserIds = [managerId, ...teamMemberIds];

    // Date filtering
    let leadDateConditions = [];
    let leadDateParams = [];
    if (req.query.startDate) {
      const start = new Date(req.query.startDate);
      start.setHours(0, 0, 0, 0);
      leadDateConditions.push('created_at >= ?');
      leadDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.endDate) {
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      leadDateConditions.push('created_at <= ?');
      leadDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }

    // Get all leads assigned to manager and team
    const placeholders = allUserIds.map(() => '?').join(',');
    let leadWhereClause = `WHERE assigned_to IN (${placeholders})`;
    const leadParams = [...allUserIds];
    
    if (leadDateConditions.length > 0) {
      leadWhereClause += ` AND ${leadDateConditions.join(' AND ')}`;
      leadParams.push(...leadDateParams);
    }

    const [allLeads] = await pool.execute(
      `SELECT id FROM leads ${leadWhereClause}`,
      leadParams
    );
    const leadIds = allLeads.map((lead) => lead.id);

    // Total leads
    const totalLeads = allLeads.length;

    // Status breakdown
    const [statusBreakdown] = await pool.execute(
      `SELECT lead_status, COUNT(*) as count 
       FROM leads ${leadWhereClause}
       GROUP BY lead_status 
       ORDER BY count DESC`,
      leadParams
    );

    const statusMap = {};
    statusBreakdown.forEach((item) => {
      statusMap[item.lead_status || 'Not Provided'] = item.count;
    });

    // Confirmed leads
    const [confirmedLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total 
       FROM leads 
       WHERE assigned_to IN (${placeholders}) AND lead_status = 'Confirmed'${leadDateConditions.length > 0 ? ` AND ${leadDateConditions.join(' AND ')}` : ''}`,
      [...allUserIds, ...leadDateParams]
    );
    const confirmedLeads = confirmedLeadsResult[0].total;

    // Get today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const todayStartStr = todayStart.toISOString().slice(0, 19).replace('T', ' ');
    const todayEndStr = todayEnd.toISOString().slice(0, 19).replace('T', ' ');

    // Get team member analytics
    const teamAnalytics = await Promise.all(
      teamMembers.map(async (member) => {
        const memberId = member.id;

        // Get member's leads
        const [memberLeads] = await pool.execute(
          'SELECT id FROM leads WHERE assigned_to = ?',
          [memberId]
        );
        const memberLeadIds = memberLeads.map((lead) => lead.id);

        // Get today's calls made by this member
        const [todayCallsResult] = await pool.execute(
          'SELECT COUNT(*) as total FROM communications WHERE sent_by = ? AND type = ? AND sent_at >= ? AND sent_at <= ?',
          [memberId, 'call', todayStartStr, todayEndStr]
        );
        const todayCalls = todayCallsResult[0].total;

        // Get today's SMS sent by this member
        const [todaySMSResult] = await pool.execute(
          'SELECT COUNT(*) as total FROM communications WHERE sent_by = ? AND type = ? AND sent_at >= ? AND sent_at <= ?',
          [memberId, 'sms', todayStartStr, todayEndStr]
        );
        const todaySMS = todaySMSResult[0].total;

        // Get today's activity logs performed by this member
        const [todayActivitiesResult] = await pool.execute(
          'SELECT COUNT(*) as total FROM activity_logs WHERE performed_by = ? AND created_at >= ? AND created_at <= ?',
          [memberId, todayStartStr, todayEndStr]
        );
        const todayActivities = todayActivitiesResult[0].total;

        // Get status conversions performed by this member
        const [statusChanges] = await pool.execute(
          `SELECT a.old_status, a.new_status, l.name, l.phone, l.enquiry_number
           FROM activity_logs a
           LEFT JOIN leads l ON a.lead_id = l.id
           WHERE a.performed_by = ? AND a.type = 'status_change'
           ORDER BY a.created_at DESC
           LIMIT 100`,
          [memberId]
        );

        const conversions = {};
        statusChanges.forEach((change) => {
          const conversion = `${change.old_status || 'Unknown'} → ${change.new_status || 'Unknown'}`;
          if (!conversions[conversion]) {
            conversions[conversion] = 0;
          }
          conversions[conversion] += 1;
        });

        // Confirmed leads for this member
        const [memberConfirmedResult] = await pool.execute(
          "SELECT COUNT(*) as total FROM leads WHERE assigned_to = ? AND lead_status = 'Confirmed'",
          [memberId]
        );
        const memberConfirmed = memberConfirmedResult[0].total;

        return {
          userId: memberId,
          name: member.name,
          email: member.email,
          roleName: member.role_name,
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
    const [managerLeads] = await pool.execute(
      'SELECT id FROM leads WHERE assigned_to = ?',
      [managerId]
    );
    const managerLeadIds = managerLeads.map((lead) => lead.id);

    // Get today's calls made by manager
    const [managerTodayCallsResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM communications WHERE sent_by = ? AND type = ? AND sent_at >= ? AND sent_at <= ?',
      [managerId, 'call', todayStartStr, todayEndStr]
    );
    const managerTodayCalls = managerTodayCallsResult[0].total;

    // Get today's SMS sent by manager
    const [managerTodaySMSResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM communications WHERE sent_by = ? AND type = ? AND sent_at >= ? AND sent_at <= ?',
      [managerId, 'sms', todayStartStr, todayEndStr]
    );
    const managerTodaySMS = managerTodaySMSResult[0].total;

    // Get today's activity logs performed by manager
    const [managerTodayActivitiesResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM activity_logs WHERE performed_by = ? AND created_at >= ? AND created_at <= ?',
      [managerId, todayStartStr, todayEndStr]
    );
    const managerTodayActivities = managerTodayActivitiesResult[0].total;

    const [managerConfirmedResult] = await pool.execute(
      "SELECT COUNT(*) as total FROM leads WHERE assigned_to = ? AND lead_status = 'Confirmed'",
      [managerId]
    );
    const managerConfirmed = managerConfirmedResult[0].total;

    // Find unfollowed leads
    // A lead is unfollowed if the assigned user has:
    // - No calls for that lead
    // - No SMS for that lead
    // - No activity logs (except status_change to "Assigned")
    const unfollowedLeadIds = [];
    
    for (const leadId of leadIds) {
      // Get assigned user for this lead
      const [leadData] = await pool.execute(
        'SELECT assigned_to FROM leads WHERE id = ?',
        [leadId]
      );
      
      if (leadData.length === 0 || !leadData[0].assigned_to) continue;
      const assignedUserId = leadData[0].assigned_to;

      // Check for calls from assigned user for this lead
      const [hasCallsResult] = await pool.execute(
        'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
        [leadId, assignedUserId, 'call']
      );
      const hasCalls = hasCallsResult[0].total > 0;

      // Check for SMS from assigned user for this lead
      const [hasSMSResult] = await pool.execute(
        'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
        [leadId, assignedUserId, 'sms']
      );
      const hasSMS = hasSMSResult[0].total > 0;

      // Check for activity logs from assigned user for this lead
      // Exclude status_change to "Assigned" with null oldStatus (initial assignment)
      const [hasActivityResult] = await pool.execute(
        `SELECT COUNT(*) as total 
         FROM activity_logs 
         WHERE lead_id = ? AND performed_by = ? AND (
           type != 'status_change' 
           OR (type = 'status_change' AND (new_status != 'Assigned' OR old_status IS NOT NULL))
         )`,
        [leadId, assignedUserId]
      );
      const hasActivity = hasActivityResult[0].total > 0;

      // If no calls, no SMS, and no activity (except assignment), it's unfollowed
      if (!hasCalls && !hasSMS && !hasActivity) {
        unfollowedLeadIds.push(leadId);
      }
    }

    // Get unfollowed leads with user info (limit to 100)
    let populatedUnfollowedLeads = [];
    if (unfollowedLeadIds.length > 0) {
      const unfollowedPlaceholders = unfollowedLeadIds.slice(0, 100).map(() => '?').join(',');
      const [unfollowedLeads] = await pool.execute(
        `SELECT l.*, u.id as assigned_to_id, u.name as assigned_to_name, u.email as assigned_to_email
         FROM leads l
         LEFT JOIN users u ON l.assigned_to = u.id
         WHERE l.id IN (${unfollowedPlaceholders})
         ORDER BY l.created_at DESC`,
        unfollowedLeadIds.slice(0, 100)
      );
      
      populatedUnfollowedLeads = unfollowedLeads.map(lead => {
        const assignedToUser = lead.assigned_to_id ? {
          id: lead.assigned_to_id,
          _id: lead.assigned_to_id,
          name: lead.assigned_to_name,
          email: lead.assigned_to_email,
        } : null;
        return formatLead(lead, assignedToUser);
      });
    }

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
          _id: lead.id,
          id: lead.id,
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
    const managerId = req.user.id || req.user._id;
    const pool = getPool();

    // Verify user is a manager
    if (!req.user.isManager) {
      return errorResponse(res, 'Only managers can access this endpoint', 403);
    }

    // Get team member IDs
    const [teamMembers] = await pool.execute(
      'SELECT id FROM users WHERE managed_by = ?',
      [managerId]
    );
    const teamMemberIds = teamMembers.map((member) => member.id);
    const allUserIds = [managerId, ...teamMemberIds];

    // Get all leads
    const placeholders = allUserIds.map(() => '?').join(',');
    const [allLeads] = await pool.execute(
      `SELECT id, assigned_to FROM leads WHERE assigned_to IN (${placeholders})`,
      allUserIds
    );
    const allLeadIds = allLeads.map((lead) => lead.id);

    // Find unfollowed leads
    const unfollowedLeadIds = [];
    
    for (const lead of allLeads) {
      const assignedUserId = lead.assigned_to;
      if (!assignedUserId) continue;

      // Check for calls from assigned user for this lead
      const [hasCallsResult] = await pool.execute(
        'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
        [lead.id, assignedUserId, 'call']
      );
      const hasCalls = hasCallsResult[0].total > 0;

      // Check for SMS from assigned user for this lead
      const [hasSMSResult] = await pool.execute(
        'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
        [lead.id, assignedUserId, 'sms']
      );
      const hasSMS = hasSMSResult[0].total > 0;

      // Check for activity logs from assigned user for this lead
      const [hasActivityResult] = await pool.execute(
        `SELECT COUNT(*) as total 
         FROM activity_logs 
         WHERE lead_id = ? AND performed_by = ? AND (
           type != 'status_change' 
           OR (type = 'status_change' AND (new_status != 'Assigned' OR old_status IS NOT NULL))
         )`,
        [lead.id, assignedUserId]
      );
      const hasActivity = hasActivityResult[0].total > 0;

      // If no calls, no SMS, and no activity (except assignment), it's unfollowed
      if (!hasCalls && !hasSMS && !hasActivity) {
        unfollowedLeadIds.push(lead.id);
      }
    }

    // Get unfollowed leads with user info (limit to 500)
    let populatedLeads = [];
    if (unfollowedLeadIds.length > 0) {
      const unfollowedPlaceholders = unfollowedLeadIds.slice(0, 500).map(() => '?').join(',');
      const [leads] = await pool.execute(
        `SELECT l.*, u.id as assigned_to_id, u.name as assigned_to_name, u.email as assigned_to_email, u.role_name as assigned_to_role_name
         FROM leads l
         LEFT JOIN users u ON l.assigned_to = u.id
         WHERE l.id IN (${unfollowedPlaceholders})
         ORDER BY l.created_at DESC`,
        unfollowedLeadIds.slice(0, 500)
      );
      
      populatedLeads = leads.map(lead => {
        const assignedToUser = lead.assigned_to_id ? {
          id: lead.assigned_to_id,
          _id: lead.assigned_to_id,
          name: lead.assigned_to_name,
          email: lead.assigned_to_email,
          roleName: lead.assigned_to_role_name,
        } : null;
        return formatLead(lead, assignedToUser);
      });
    }

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
    console.error('Error getting unfollowed leads:', error);
    return errorResponse(res, error.message || 'Failed to get unfollowed leads', 500);
  }
};

// @desc    Send notifications to team members
// @route   POST /api/manager/notify-team
// @access  Private (Manager only)
export const notifyTeam = async (req, res) => {
  try {
    const managerId = req.user.id || req.user._id;
    const pool = getPool();

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
    const [teamMembers] = await pool.execute(
      'SELECT id FROM users WHERE managed_by = ?',
      [managerId]
    );
    const teamMemberIds = teamMembers.map((member) => member.id);

    const invalidUsers = userIds.filter((userId) => !teamMemberIds.includes(userId));
    if (invalidUsers.length > 0) {
      return errorResponse(res, 'Some users are not part of your team', 400);
    }

    // Get user details
    const userPlaceholders = userIds.map(() => '?').join(',');
    const [usersToNotify] = await pool.execute(
      `SELECT id, name, email FROM users WHERE id IN (${userPlaceholders})`,
      userIds
    );

    // TODO: Implement actual notification sending
    // This would integrate with your notification service
    // For now, we'll just return success

    return successResponse(
      res,
      {
        notified: usersToNotify.length,
        users: usersToNotify.map((user) => ({
          id: user.id,
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
    console.error('Error sending notifications:', error);
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
    const pool = getPool();

    // Verify manager exists and is actually a manager
    const [managers] = await pool.execute(
      'SELECT id, name, email, role_name, is_manager FROM users WHERE id = ?',
      [managerId]
    );
    
    if (managers.length === 0) {
      return errorResponse(res, 'Manager not found', 404);
    }
    
    const manager = managers[0];
    if (manager.is_manager !== 1 && manager.is_manager !== true) {
      return errorResponse(res, 'User is not a manager', 400);
    }

    // Get team member IDs
    const [teamMembers] = await pool.execute(
      'SELECT id, name, email, role_name FROM users WHERE managed_by = ?',
      [managerId]
    );
    const teamMemberIds = teamMembers.map((member) => member.id);
    const allUserIds = [managerId, ...teamMemberIds];

    // Date filtering for activities (calls, SMS, status changes)
    let activityDateConditions = [];
    let activityDateParams = [];
    if (req.query.startDate) {
      const start = new Date(req.query.startDate);
      start.setHours(0, 0, 0, 0);
      activityDateConditions.push('>= ?');
      activityDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.endDate) {
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      activityDateConditions.push('<= ?');
      activityDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    const activityDateClause = activityDateConditions.length > 0
      ? `AND ${activityDateConditions.map((c, i) => `sent_at ${c}`).join(' AND ')}`
      : '';

    // Get all leads assigned to manager and team (no date filter on leads - show all assigned)
    const placeholders = allUserIds.map(() => '?').join(',');
    const [allLeads] = await pool.execute(
      `SELECT id FROM leads WHERE assigned_to IN (${placeholders})`,
      allUserIds
    );
    const allLeadIds = allLeads.map((lead) => lead.id);

    // Total leads
    const totalLeads = allLeads.length;

    // Team status breakdown
    const [statusBreakdown] = await pool.execute(
      `SELECT lead_status, COUNT(*) as count 
       FROM leads 
       WHERE assigned_to IN (${placeholders})
       GROUP BY lead_status 
       ORDER BY count DESC`,
      allUserIds
    );

    const statusMap = {};
    statusBreakdown.forEach((item) => {
      statusMap[item.lead_status || 'Not Provided'] = item.count;
    });

    // Confirmed leads
    const [confirmedLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total 
       FROM leads 
       WHERE assigned_to IN (${placeholders}) AND lead_status = 'Confirmed'`,
      allUserIds
    );
    const confirmedLeads = confirmedLeadsResult[0].total;

    // Team calls and SMS (within date range)
    let teamCalls = 0;
    let teamSMS = 0;
    if (activityDateConditions.length > 0) {
      const callDateClause = activityDateConditions.map((c, i) => `sent_at ${c}`).join(' AND ');
      const [teamCallsResult] = await pool.execute(
        `SELECT COUNT(*) as total 
         FROM communications 
         WHERE sent_by IN (${placeholders}) AND type = 'call' AND ${callDateClause}`,
        [...allUserIds, ...activityDateParams]
      );
      teamCalls = teamCallsResult[0].total;

      const [teamSMSResult] = await pool.execute(
        `SELECT COUNT(*) as total 
         FROM communications 
         WHERE sent_by IN (${placeholders}) AND type = 'sms' AND ${callDateClause}`,
        [...allUserIds, ...activityDateParams]
      );
      teamSMS = teamSMSResult[0].total;
    }

    // Team status changes (within date range)
    let teamStatusChanges = 0;
    if (activityDateConditions.length > 0) {
      const statusChangeDateClause = activityDateConditions.map((c, i) => `created_at ${c}`).join(' AND ');
      const [teamStatusChangesResult] = await pool.execute(
        `SELECT COUNT(*) as total 
         FROM activity_logs 
         WHERE performed_by IN (${placeholders}) AND type = 'status_change' AND ${statusChangeDateClause}`,
        [...allUserIds, ...activityDateParams]
      );
      teamStatusChanges = teamStatusChangesResult[0].total;
    }

    // Calculate total unfollowed leads across all team members
    let totalUnfollowedLeads = 0;
    for (const userId of allUserIds) {
      const [userLeads] = await pool.execute(
        'SELECT id FROM leads WHERE assigned_to = ?',
        [userId]
      );
      const userLeadIds = userLeads.map((lead) => lead.id);

      for (const leadId of userLeadIds) {
        // Check for calls from this user for this lead
        const [hasCallsResult] = await pool.execute(
          'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
          [leadId, userId, 'call']
        );
        const hasCalls = hasCallsResult[0].total > 0;

        // Check for SMS from this user for this lead
        const [hasSMSResult] = await pool.execute(
          'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
          [leadId, userId, 'sms']
        );
        const hasSMS = hasSMSResult[0].total > 0;

        // Check for activity logs from this user for this lead
        const [hasActivityResult] = await pool.execute(
          `SELECT COUNT(*) as total 
           FROM activity_logs 
           WHERE lead_id = ? AND performed_by = ? AND (
             type != 'status_change' 
             OR (type = 'status_change' AND (new_status != 'Assigned' OR old_status IS NOT NULL))
           )`,
          [leadId, userId]
        );
        const hasActivity = hasActivityResult[0].total > 0;

        // If no calls, no SMS, and no activity (except assignment), it's unfollowed
        if (!hasCalls && !hasSMS && !hasActivity) {
          totalUnfollowedLeads++;
        }
      }
    }

    // Get per-user analytics
    const userAnalytics = await Promise.all(
      allUserIds.map(async (userId) => {
        const user = userId === managerId 
          ? manager 
          : teamMembers.find(m => m.id === userId);
        
        if (!user) return null;

        const [userLeads] = await pool.execute(
          'SELECT id FROM leads WHERE assigned_to = ?',
          [userId]
        );
        const userLeadIds = userLeads.map((lead) => lead.id);

        // User status breakdown
        const [userStatusBreakdown] = await pool.execute(
          `SELECT lead_status, COUNT(*) as count 
           FROM leads 
           WHERE assigned_to = ?
           GROUP BY lead_status`,
          [userId]
        );

        const userStatusMap = {};
        userStatusBreakdown.forEach((item) => {
          userStatusMap[item.lead_status || 'Not Provided'] = item.count;
        });

        // User calls and SMS (within date range)
        let userCalls = 0;
        let userSMS = 0;
        if (activityDateConditions.length > 0) {
          const callDateClause = activityDateConditions.map((c, i) => `sent_at ${c}`).join(' AND ');
          const [userCallsResult] = await pool.execute(
            `SELECT COUNT(*) as total 
             FROM communications 
             WHERE sent_by = ? AND type = 'call' AND ${callDateClause}`,
            [userId, ...activityDateParams]
          );
          userCalls = userCallsResult[0].total;

          const [userSMSResult] = await pool.execute(
            `SELECT COUNT(*) as total 
             FROM communications 
             WHERE sent_by = ? AND type = 'sms' AND ${callDateClause}`,
            [userId, ...activityDateParams]
          );
          userSMS = userSMSResult[0].total;
        }

        // User unfollowed leads count
        const userUnfollowedLeadIds = [];
        for (const leadId of userLeadIds) {
          // Check for calls from this user for this lead
          const [hasCallsResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
            [leadId, userId, 'call']
          );
          const hasCalls = hasCallsResult[0].total > 0;

          // Check for SMS from this user for this lead
          const [hasSMSResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM communications WHERE lead_id = ? AND sent_by = ? AND type = ?',
            [leadId, userId, 'sms']
          );
          const hasSMS = hasSMSResult[0].total > 0;

          // Check for activity logs from this user for this lead
          const [hasActivityResult] = await pool.execute(
            `SELECT COUNT(*) as total 
             FROM activity_logs 
             WHERE lead_id = ? AND performed_by = ? AND (
               type != 'status_change' 
               OR (type = 'status_change' AND (new_status != 'Assigned' OR old_status IS NOT NULL))
             )`,
            [leadId, userId]
          );
          const hasActivity = hasActivityResult[0].total > 0;

          // If no calls, no SMS, and no activity (except assignment), it's unfollowed
          if (!hasCalls && !hasSMS && !hasActivity) {
            userUnfollowedLeadIds.push(leadId);
          }
        }

        return {
          userId: userId,
          name: user.name,
          email: user.email,
          roleName: user.role_name,
          isManager: userId === managerId,
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
          _id: manager.id,
          id: manager.id,
          name: manager.name,
          email: manager.email,
        },
        teamMembers: teamMembers.map(m => ({
          _id: m.id,
          id: m.id,
          name: m.name,
          email: m.email,
          roleName: m.role_name,
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

