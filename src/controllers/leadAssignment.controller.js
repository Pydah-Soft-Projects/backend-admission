import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadAssignment } from '../services/notification.service.js';
import { v4 as uuidv4 } from 'uuid';

// @desc    Assign leads to users based on mandal/state (bulk) or specific lead IDs (single)
// @route   POST /api/leads/assign
// @access  Private (Super Admin only)
export const assignLeads = async (req, res) => {
  try {
    const { userId, mandal, district, state, academicYear, studentGroup, count, leadIds, assignNow = true, institutionName, targetDate } = req.body;
    const pool = getPool();
    const currentUserId = req.user.id || req.user._id;

    // Validate required fields
    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    // Check if user exists and is assignable
    const [users] = await pool.execute(
      'SELECT id, name, role_name, is_active FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];

    // Validate that user can receive assignments
    if (user.role_name === 'Super Admin') {
      return errorResponse(res, 'Cannot assign leads to Super Admin', 400);
    }

    if (user.is_active !== 1 && user.is_active !== true) {
      return errorResponse(res, 'Cannot assign leads to inactive user', 400);
    }

    const isProRole = user.role_name && String(user.role_name).trim().toUpperCase() === 'PRO';

    let leadIdsToAssign = [];

    // Single assignment mode: assign specific lead IDs
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      // Validate lead IDs (UUID format)
      const validLeadIds = leadIds.filter((id) => id && typeof id === 'string' && id.length === 36);

      if (validLeadIds.length === 0) {
        return errorResponse(res, 'No valid lead IDs provided', 400);
      }

      // Check if leads exist
      const placeholders = validLeadIds.map(() => '?').join(',');
      const [existingLeads] = await pool.execute(
        `SELECT id, assigned_to FROM leads WHERE id IN (${placeholders})`,
        validLeadIds
      );

      if (existingLeads.length === 0) {
        return errorResponse(res, 'No leads found with the provided IDs', 404);
      }

      leadIdsToAssign = existingLeads.map((lead) => lead.id);
    } else {
      // Bulk assignment mode: assign based on filters and count
      if (!count || count <= 0) {
        return errorResponse(res, 'Count is required for bulk assignment', 400);
      }
      const yearNum = academicYear != null && academicYear !== '' ? parseInt(academicYear, 10) : NaN;
      if (Number.isNaN(yearNum)) {
        return errorResponse(res, 'Academic year is required for bulk assignment', 400);
      }

      // Build filter for leads available to this user
      // For PRO role, we can assign any leads (even if already assigned to someone else)
      const assignmentCondition = isProRole ? '1=1' : '(assigned_to IS NULL)';
      const conditions = [assignmentCondition, 'academic_year = ?'];
      const params = [yearNum];

      // Add mandal filter if provided
      if (mandal) {
        conditions.push('mandal = ?');
        params.push(mandal);
      }

      // Add district filter if provided
      if (district) {
        conditions.push('district = ?');
        params.push(district);
      }

      // Add state filter if provided
      if (state) {
        conditions.push('state = ?');
        params.push(state);
      }

      // Add student group filter if provided
      if (studentGroup) {
        conditions.push('student_group = ?');
        params.push(studentGroup);
      }

      // Add school/college (institution) filter if provided – match lead's dynamic_fields school_or_college_name
      if (institutionName && typeof institutionName === 'string' && institutionName.trim()) {
        const instParam = institutionName.trim();
        conditions.push(
          "LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.school_or_college_name')), JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.schoolOrCollegeName')), ''))) = LOWER(?)"
        );
        params.push(instParam);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const limitNum = Math.min(Math.max(parseInt(count, 10) || 0, 1), 10000);

      // Get available unassigned leads matching criteria (LIMIT must be literal, not placeholder)
      const [availableLeads] = await pool.execute(
        `SELECT id FROM leads ${whereClause} LIMIT ${limitNum}`,
        params
      );

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

      leadIdsToAssign = availableLeads.map((lead) => lead.id);
    }

    // Get leads before update to check status
    const placeholders = leadIdsToAssign.map(() => '?').join(',');
    const [leadsToAssign] = await pool.execute(
      `SELECT id, lead_status FROM leads WHERE id IN (${placeholders})`,
      leadIdsToAssign
    );

    // Update leads and create activity logs
    const now = new Date();
    let modifiedCount = 0;

    for (const lead of leadsToAssign) {
      const oldStatus = lead.lead_status || 'New';
      const newStatus = oldStatus === 'New' ? 'Assigned' : oldStatus;

      // Update lead
      const yearNum = academicYear != null && academicYear !== '' ? parseInt(academicYear, 10) : null;
      const setAcademicYear = yearNum != null && !Number.isNaN(yearNum)
        ? ', academic_year = ?'
        : '';

      let updateQuery;
      let updateParams;

      if (isProRole) {
        updateQuery = `UPDATE leads SET 
          assigned_to_pro = ?, pro_assigned_at = NOW(), pro_assigned_by = ?, lead_status = ?, target_date = ?${setAcademicYear}, visit_status = 'Assigned', updated_at = NOW()
         WHERE id = ?`;
      } else {
        updateQuery = `UPDATE leads SET 
          assigned_to = ?, assigned_at = NOW(), assigned_by = ?, lead_status = ?, target_date = ?${setAcademicYear}, updated_at = NOW()
         WHERE id = ?`;
      }

      updateParams = yearNum != null && !Number.isNaN(yearNum)
        ? [userId, currentUserId, newStatus, targetDate || null, yearNum, lead.id]
        : [userId, currentUserId, newStatus, targetDate || null, lead.id];

      await pool.execute(updateQuery, updateParams);

      // Create activity log
      const activityLogId = uuidv4();
      const assigneeLabel = isProRole
        ? `PRO ${user.name}`
        : `${user.role_name === 'Sub Super Admin' ? 'sub-admin' : 'counsellor'} ${user.name}`;
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'status_change',
          oldStatus,
          newStatus,
          `Assigned to ${assigneeLabel}`,
          currentUserId,
          JSON.stringify({
            assignment: {
              assignedTo: userId,
              assignedBy: currentUserId,
              targetRole: isProRole ? 'PRO' : 'counsellor',
            },
          }),
        ]
      );

      modifiedCount++;
    }

    // Send notifications (async, don't wait for it)
    const isBulk = !leadIds || leadIds.length === 0;

    // Get full lead details for notification AND response (limit to 50 for email display, but we want all for export?)
    // Verify: If we assign 1000 leads, returning 1000 objects is fine.
    const exportExtraFields = isProRole ? ', district, mandal, village, address' : '';
    const [leadsDetails] = await pool.execute(
      `SELECT id, name, phone, enquiry_number, notes${exportExtraFields} FROM leads WHERE id IN (${placeholders})`,
      leadIdsToAssign
    );

    // Format for notification (limit to 50)
    const formattedLeadsNotification = leadsDetails.slice(0, 50).map(l => ({
      _id: l.id,
      id: l.id,
      name: l.name,
      phone: l.phone,
      enquiryNumber: l.enquiry_number,
    }));

    notifyLeadAssignment({
      userId,
      leadCount: modifiedCount,
      leads: formattedLeadsNotification,
      isBulk,
      allLeadIds: leadIdsToAssign,
    }).catch((error) => {
      console.error('[LeadAssignment] Error sending notifications:', error);
    });

    // Format for response (Include all assigned leads for Excel export; PRO gets location + address for field work)
    const assignedLeadsForExport = leadsDetails.map((l) => {
      const base = {
        name: l.name,
        phone: l.phone,
        remarks: l.notes || '',
      };
      if (!isProRole) return base;
      return {
        ...base,
        district: l.district ?? '',
        mandal: l.mandal ?? '',
        village: l.village ?? '',
        address: l.address ?? '',
      };
    });

    return successResponse(
      res,
      {
        assigned: modifiedCount,
        requested: leadIds ? leadIds.length : parseInt(count),
        userId,
        userName: user.name,
        targetRole: user.role_name,
        mandal: mandal || 'All',
        district: district || 'All',
        state: state || 'All',
        mode: leadIds ? 'single' : 'bulk',
        assignedLeads: assignedLeadsForExport,
      },
      `Successfully assigned ${modifiedCount} lead${modifiedCount !== 1 ? 's' : ''} to ${user.name}`,
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
    const { mandal, district, state, academicYear, studentGroup, institutionName, forBreakdown, cycleNumber } = req.query;
    const pool = getPool();

    // Build filter for available leads
    // Use targetRole query parameter if provided (e.g. from UI when selecting a user)
    const rawTargetRole = req.query.targetRole || 'Student Counselor';
    const targetRole = String(rawTargetRole).trim().toUpperCase();
    const isProTarget = targetRole === 'PRO';
    // For PRO targets, "Available" means all leads in the scope, not just unassigned ones
    const assignmentCondition = isProTarget ? '1=1' : 'assigned_to IS NULL';

    const conditions = [assignmentCondition];
    const params = [];

    // Academic year filter (optional; when set, stats are for that year only)
    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        conditions.push('academic_year = ?');
        params.push(year);
      }
    }

    // Cycle number filter
    if (cycleNumber != null && cycleNumber !== '') {
      const cycle = parseInt(cycleNumber, 10);
      if (!Number.isNaN(cycle)) {
        conditions.push('cycle_number = ?');
        params.push(cycle);
      }
    }

    // Student group filter (optional; align with assign/remove count logic for Inter variants)
    if (studentGroup) {
      if (studentGroup === 'Inter') {
        conditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
      } else {
        conditions.push('student_group = ?');
        params.push(studentGroup);
      }
    }

    // Add mandal filter if provided
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }

    // Add district filter if provided
    if (district) {
      conditions.push('district = ?');
      params.push(district);
    }

    // Add state filter if provided
    if (state) {
      conditions.push('state = ?');
      params.push(state);
    }

    // Add school/college (institution) filter if provided
    if (institutionName && typeof institutionName === 'string' && String(institutionName).trim()) {
      const instParam = String(institutionName).trim();
      conditions.push(
        "LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.school_or_college_name')), JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.schoolOrCollegeName')), ''))) = LOWER(?)"
      );
      params.push(instParam);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Condition to check what is TRULY unassigned in this role's context (for internal counts)
    const trulyUnassignedCondition = isProTarget ? 'assigned_to_pro IS NULL' : 'assigned_to IS NULL';
    const trulyUnassignedConditions = [...conditions.filter(c => c !== assignmentCondition), trulyUnassignedCondition];
    const trulyUnassignedWhere = `WHERE ${trulyUnassignedConditions.join(' AND ')}`;

    // Base filter for total/assigned in same scope (when academic year / student group selected)
    const baseConditions = [];
    const baseParams = [];
    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        baseConditions.push('academic_year = ?');
        baseParams.push(year);
      }
    }
    if (studentGroup) {
      if (studentGroup === 'Inter') {
        baseConditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
      } else {
        baseConditions.push('student_group = ?');
        baseParams.push(studentGroup);
      }
    }
    if (cycleNumber != null && cycleNumber !== '') {
      const cycleBase = parseInt(cycleNumber, 10);
      if (!Number.isNaN(cycleBase)) {
        baseConditions.push('cycle_number = ?');
        baseParams.push(cycleBase);
      }
    }
    if (mandal) {
      baseConditions.push('mandal = ?');
      baseParams.push(mandal);
    }
    if (district) {
      baseConditions.push('district = ?');
      baseParams.push(district);
    }
    if (state) {
      baseConditions.push('state = ?');
      baseParams.push(state);
    }
    if (institutionName && typeof institutionName === 'string' && String(institutionName).trim()) {
      const instBase = String(institutionName).trim();
      baseConditions.push(
        "LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.school_or_college_name')), JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.schoolOrCollegeName')), ''))) = LOWER(?)"
      );
      baseParams.push(instBase);
    }
    const baseWhere = baseConditions.length ? `WHERE ${baseConditions.join(' AND ')}` : '';

    // Get unassigned leads count
    const [unassignedCountResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${whereClause}`,
      params
    );
    const unassignedCount = unassignedCountResult[0].total;

    // Get total leads count (optionally scoped by academic year and student group)
    const [totalLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${baseWhere}`,
      baseParams
    );
    const totalLeads = totalLeadsResult[0].total;

    // Get unassigned leads count (truly unassigned, for the "assigned" calculation)
    const [trulyUnassignedResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads ${trulyUnassignedWhere}`,
      params
    );
    const trulyUnassignedCount = trulyUnassignedResult[0].total;

    // Get assigned leads count (in same scope)
    const assignedCount = totalLeads - trulyUnassignedCount;

    // Get breakdown by mandal (for unassigned leads with same filters)
    const [mandalBreakdown] = await pool.execute(
      `SELECT mandal, COUNT(*) as count 
       FROM leads ${whereClause}
       GROUP BY mandal 
       ORDER BY count DESC 
       LIMIT 20`,
      [...params]
    );

    // Get breakdown by state (for unassigned leads with same filters)
    const [stateBreakdown] = await pool.execute(
      `SELECT state, COUNT(*) as count 
       FROM leads ${whereClause}
       GROUP BY state 
       ORDER BY count DESC`,
      [...params]
    );

    const payload = {
      totalLeads,
      assignedCount,
      unassignedCount,
      mandalBreakdown: mandalBreakdown.map((item) => ({
        mandal: item.mandal || 'Unknown',
        count: item.count,
      })),
      stateBreakdown: stateBreakdown.map((item) => ({
        state: item.state || 'Unknown',
        count: item.count,
      })),
    };

    // Optional: school-wise or college-wise unassigned breakdown (for institution allocation UI)
    if (forBreakdown === 'school' || forBreakdown === 'college') {
      const table = forBreakdown === 'school' ? 'schools' : 'colleges';
      const [institutions] = await pool.execute(
        `SELECT id, name FROM ${table} WHERE is_active = 1 ORDER BY name ASC`
      );
      const institutionBreakdown = [];
      for (const inst of institutions || []) {
        const instName = (inst.name || '').trim();
        if (!instName) continue;
        const instConditions = [...conditions];
        const instParams = [...params];
        instConditions.push(
          "LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.school_or_college_name')), JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.schoolOrCollegeName')), ''))) = LOWER(?)"
        );
        instParams.push(instName);
        const instWhere = `WHERE ${instConditions.join(' AND ')}`;
        const [countResult] = await pool.execute(
          `SELECT COUNT(*) as total FROM leads ${instWhere}`,
          instParams
        );
        const total = countResult[0].total;
        if (total > 0) {
          institutionBreakdown.push({ id: inst.id, name: instName, count: total });
        }
      }
      payload.institutionBreakdown = institutionBreakdown;
    }

    return successResponse(
      res,
      payload,
      'Assignment statistics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting assignment stats:', error);
    return errorResponse(res, error.message || 'Failed to get assignment statistics', 500);
  }
};

// @desc    Get count of leads assigned to a specific user (optional mandal/state filter)
// @route   GET /api/leads/assign/assigned-count
// @access  Private (Super Admin only)
export const getAssignedCountForUser = async (req, res) => {
  try {
    const { userId, mandal, district, state, academicYear, studentGroup, cycleNumber } = req.query;
    const pool = getPool();

    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    // Use DB role (same as removeAssignments). PRO leads use assigned_to_pro; others use assigned_to.
    // Query param targetRole was easy to omit from clients and produced wrong counts for PRO users.
    const [targetUsers] = await pool.execute(
      'SELECT id, role_name FROM users WHERE id = ?',
      [userId]
    );
    if (targetUsers.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }
    const isPro =
      targetUsers[0].role_name && String(targetUsers[0].role_name).trim().toUpperCase() === 'PRO';
    const assignmentCol = isPro ? 'assigned_to_pro' : 'assigned_to';

    const conditions = [`${assignmentCol} = ?`];
    const params = [userId];

    if (cycleNumber != null && cycleNumber !== '') {
      const cycle = parseInt(cycleNumber, 10);
      if (!Number.isNaN(cycle)) {
        conditions.push('cycle_number = ?');
        params.push(cycle);
      }
    }

    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        conditions.push('academic_year = ?');
        params.push(year);
      }
    }
    if (studentGroup) {
      if (studentGroup === 'Inter') {
        conditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
      } else {
        conditions.push('student_group = ?');
        params.push(studentGroup);
      }
    }
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }
    if (district) {
      conditions.push('district = ?');
      params.push(district);
    }
    if (state) {
      conditions.push('state = ?');
      params.push(state);
    }

    const [result] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads WHERE ${conditions.join(' AND ')}`,
      params
    );

    const rawTotal = result[0]?.total ?? 0;
    const count = typeof rawTotal === 'bigint' ? Number(rawTotal) : Number(rawTotal);
    const safeCount = Number.isFinite(count) ? count : 0;

    return successResponse(
      res,
      { count: safeCount },
      'Assigned count retrieved',
      200
    );
  } catch (error) {
    console.error('Error getting assigned count for user:', error);
    return errorResponse(res, error.message || 'Failed to get assigned count', 500);
  }
};

// @desc    Remove assignments from a user (bulk unassign)
// @route   POST /api/leads/assign/remove
// @access  Private (Super Admin only)
export const removeAssignments = async (req, res) => {
  try {
    const { userId, mandal, district, state, academicYear, studentGroup, cycleNumber, count } = req.body;
    const pool = getPool();
    const currentUserId = req.user.id || req.user._id;

    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    if (!count || count <= 0) {
      return errorResponse(res, 'Count must be greater than zero', 400);
    }

    // Check user exists
    const [users] = await pool.execute(
      'SELECT id, name, role_name FROM users WHERE id = ?',
      [userId]
    );
    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }
    const user = users[0];

    const isPro = user.role_name && String(user.role_name).trim().toUpperCase() === 'PRO';
    const assignmentCol = isPro ? 'assigned_to_pro' : 'assigned_to';
    const assignmentAtCol = isPro ? 'pro_assigned_at' : 'assigned_at';
    const assignmentByCol = isPro ? 'pro_assigned_by' : 'assigned_by';

    const conditions = [`${assignmentCol} = ?`];
    const params = [userId];
    if (cycleNumber != null && cycleNumber !== '') {
      const cycle = parseInt(cycleNumber, 10);
      if (!Number.isNaN(cycle)) {
        conditions.push('cycle_number = ?');
        params.push(cycle);
      }
    }
    if (academicYear != null && academicYear !== '') {
      const year = parseInt(academicYear, 10);
      if (!Number.isNaN(year)) {
        conditions.push('academic_year = ?');
        params.push(year);
      }
    }
    if (studentGroup) {
      if (studentGroup === 'Inter') {
        conditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
      } else {
        conditions.push('student_group = ?');
        params.push(studentGroup);
      }
    }
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }
    if (district) {
      conditions.push('district = ?');
      params.push(district);
    }
    if (state) {
      conditions.push('state = ?');
      params.push(state);
    }

    const limitNum = Math.min(Math.max(parseInt(count, 10) || 0, 1), 10000);

    const [leadsToUnassign] = await pool.execute(
      `SELECT id, lead_status FROM leads WHERE ${conditions.join(' AND ')} LIMIT ${limitNum}`,
      params
    );

    if (leadsToUnassign.length === 0) {
      return successResponse(
        res,
        { removed: 0, requested: limitNum, userName: user.name },
        'No assigned leads found matching the criteria',
        200
      );
    }

    const leadIds = leadsToUnassign.map((l) => l.id);
    const placeholders = leadIds.map(() => '?').join(',');

    await pool.execute(
      `UPDATE leads SET 
        ${assignmentCol} = NULL, 
        ${assignmentAtCol} = NULL, 
        ${assignmentByCol} = NULL, 
        lead_status = 'New', 
        target_date = NULL,
        updated_at = NOW() 
      WHERE id IN (${placeholders})`,
      leadIds
    );

    for (const lead of leadsToUnassign) {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'status_change',
          lead.lead_status || 'Assigned',
          'New',
          `Assignment removed from ${user.name}`,
          currentUserId,
          JSON.stringify({
            unassignment: {
              removedFrom: userId,
              removedBy: currentUserId,
            },
          }),
        ]
      );
    }

    return successResponse(
      res,
      {
        removed: leadsToUnassign.length,
        requested: limitNum,
        userId,
        userName: user.name,
      },
      `Successfully removed assignment for ${leadsToUnassign.length} lead${leadsToUnassign.length !== 1 ? 's' : ''} from ${user.name}`,
      200
    );
  } catch (error) {
    console.error('Error removing assignments:', error);
    return errorResponse(res, error.message || 'Failed to remove assignments', 500);
  }
};

// @desc    Get user lead analytics
// @route   GET /api/leads/analytics/:userId
// @query   academicYear (optional), studentGroup (optional), mandal (optional)
// @access  Private
export const getUserLeadAnalytics = async (req, res) => {
  try {
    const { userId } = req.params;
    const { academicYear, studentGroup, mandal } = req.query;
    const requestingUserId = req.user.id || req.user._id;
    const pool = getPool();

    // Users can only view their own analytics, Super Admin can view any user's analytics
    if (!hasElevatedAdminPrivileges(req.user.roleName) && userId !== requestingUserId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Determine the role of the user being queried
    const [usersResult] = await pool.execute(
      'SELECT role_name FROM users WHERE id = ?',
      [userId]
    );

    if (usersResult.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const queriedUser = usersResult[0];
    const isProRole =
      queriedUser.role_name && String(queriedUser.role_name).trim().toUpperCase() === 'PRO';
    const assignmentCondition = isProRole
      ? '(assigned_to_pro = ? OR assigned_to = ?)'
      : 'assigned_to = ?';

    const conditions = [assignmentCondition];
    const params = isProRole ? [userId, userId] : [userId];

    if (academicYear != null && academicYear !== '') {
      const yearNum = parseInt(academicYear, 10);
      if (!Number.isNaN(yearNum)) {
        conditions.push('academic_year = ?');
        params.push(yearNum);
      }
    }
    if (studentGroup) {
      if (studentGroup === 'Inter') {
        conditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
      } else {
        conditions.push('student_group = ?');
        params.push(studentGroup);
      }
    }
    if (mandal) {
      conditions.push('mandal = ?');
      params.push(mandal);
    }
    const whereClause = conditions.join(' AND ');

    // Get total leads assigned to user (with optional filters)
    const [totalLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads WHERE ${whereClause}`,
      params
    );
    const totalLeads = totalLeadsResult[0].total;

    // Get grand total assigned to user (without filters)
    const [overallTotalResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads WHERE ${assignmentCondition}`,
      isProRole ? [userId, userId] : [userId]
    );
    const overallTotalLeads = overallTotalResult[0].total;

    // Get leads by status
    const [statusBreakdown] = await pool.execute(
      `SELECT lead_status, COUNT(*) as count 
       FROM leads 
       WHERE ${whereClause}
       GROUP BY lead_status 
       ORDER BY count DESC`,
      params
    );

    // Get leads by mandal
    const [mandalBreakdown] = await pool.execute(
      `SELECT mandal, COUNT(*) as count 
       FROM leads 
       WHERE ${whereClause}
       GROUP BY mandal 
       ORDER BY count DESC 
       LIMIT 10`,
      params
    );

    // Get leads by state
    const [stateBreakdown] = await pool.execute(
      `SELECT state, COUNT(*) as count 
       FROM leads 
       WHERE ${whereClause}
       GROUP BY state 
       ORDER BY count DESC`,
      params
    );

    // Get leads by student group
    const [studentGroupBreakdown] = await pool.execute(
      `SELECT student_group, COUNT(*) as count 
       FROM leads 
       WHERE ${whereClause}
       GROUP BY student_group 
       ORDER BY count DESC`,
      params
    );

    // Convert status breakdown to object
    const statusCounts = {};
    statusBreakdown.forEach((item) => {
      statusCounts[item.lead_status || 'New'] = item.count;
    });

    // Get recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentParams = [...params, sevenDaysAgo.toISOString().slice(0, 19).replace('T', ' ')];
    const [recentLeadsResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads WHERE ${whereClause} AND updated_at >= ?`,
      recentParams
    );
    const recentLeads = recentLeadsResult[0].total;

    return successResponse(
      res,
      {
        totalLeads,
        overallTotalLeads,
        statusBreakdown: statusCounts,
        mandalBreakdown: mandalBreakdown.map((item) => ({
          mandal: item.mandal,
          count: item.count,
        })),
        stateBreakdown: stateBreakdown.map((item) => ({
          state: item.state,
          count: item.count,
        })),
        studentGroupBreakdown: studentGroupBreakdown.map((item) => ({
          group: item.student_group || 'Unknown',
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

// @desc    Get current user's call/SMS/status analytics (for Call Activity page)
// @route   GET /api/leads/analytics/me
// @query   startDate (optional), endDate (optional)
// @access  Private (any authenticated user for their own data)
export const getMyCallAnalytics = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { startDate: startDateQ, endDate: endDateQ } = req.query;
    const pool = getPool();

    const activityDateConditions = [];
    const activityDateParams = [];
    if (startDateQ) {
      const start = new Date(startDateQ);
      start.setHours(0, 0, 0, 0);
      activityDateConditions.push('>= ?');
      activityDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (endDateQ) {
      const end = new Date(endDateQ);
      end.setHours(23, 59, 59, 999);
      activityDateConditions.push('<= ?');
      activityDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    const callDateClause = activityDateConditions.length > 0
      ? `AND sent_at ${activityDateConditions.map((c) => c).join(' AND sent_at ')}`
      : '';
    const smsDateClause = activityDateConditions.length > 0
      ? `AND sent_at ${activityDateConditions.map((c) => c).join(' AND sent_at ')}`
      : '';
    const statusChangeDateClause = activityDateConditions.length > 0
      ? `AND a.created_at ${activityDateConditions.map((c) => c).join(' AND a.created_at ')}`
      : '';

    const isPro = req.user.roleName === 'PRO';
    const assignmentCondition = isPro
      ? '(assigned_to_pro = ? OR assigned_to = ?)'
      : 'assigned_to = ?';
    const leadWhereClause = assignmentCondition;
    const leadParams = isPro ? [userId, userId] : [userId];

    const [totalAssignedResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads WHERE ${leadWhereClause}`,
      leadParams
    );
    const totalAssigned = totalAssignedResult[0].total;

    const [calls] = await pool.execute(
      `SELECT c.*, l.id as lead_id, l.name as lead_name, l.phone as lead_phone, l.enquiry_number
       FROM communications c
       LEFT JOIN leads l ON c.lead_id = l.id
       WHERE c.sent_by = ? AND c.type = 'call' ${callDateClause}
       ORDER BY c.sent_at DESC`,
      [userId, ...activityDateParams]
    ).catch(() => [[]]);

    const totalCalls = calls.length;
    const totalCallDuration = calls.reduce((sum, call) => sum + (call.duration_seconds || 0), 0);
    const dailyCallActivityMap = {};
    calls.forEach((call) => {
      const d = call.sent_at instanceof Date
        ? call.sent_at.toISOString().slice(0, 10)
        : String(call.sent_at || '').slice(0, 10);
      if (!d) return;
      if (!dailyCallActivityMap[d]) {
        dailyCallActivityMap[d] = { date: d, callCount: 0, leads: {} };
      }
      dailyCallActivityMap[d].callCount += 1;
      const lid = call.lead_id || 'unknown';
      if (!dailyCallActivityMap[d].leads[lid]) {
        dailyCallActivityMap[d].leads[lid] = {
          leadId: lid,
          leadName: call.lead_name || 'Unknown',
          leadPhone: call.lead_phone || call.contact_number,
          enquiryNumber: call.enquiry_number || '',
          callCount: 0,
        };
      }
      dailyCallActivityMap[d].leads[lid].callCount += 1;
    });
    const dailyCallActivity = Object.keys(dailyCallActivityMap)
      .sort()
      .map((date) => ({
        date: dailyCallActivityMap[date].date,
        callCount: dailyCallActivityMap[date].callCount,
        leads: Object.values(dailyCallActivityMap[date].leads),
      }));

    const [smsMessages] = await pool.execute(
      `SELECT c.* FROM communications c
       WHERE c.sent_by = ? AND c.type = 'sms' ${smsDateClause}
       ORDER BY c.sent_at DESC`,
      [userId, ...activityDateParams]
    ).catch(() => [[]]);
    const totalSMS = smsMessages.length;

    const [statusChanges] = await pool.execute(
      `SELECT a.* FROM activity_logs a
       WHERE a.performed_by = ? AND a.type = 'status_change' ${statusChangeDateClause}
       ORDER BY a.created_at DESC`,
      [userId, ...activityDateParams]
    ).catch(() => []);
    const totalStatusChanges = statusChanges.length;

    const report = {
      totalAssigned,
      calls: {
        total: totalCalls,
        averageDuration: totalCalls > 0 ? Math.round(totalCallDuration / totalCalls) : 0,
        dailyCallActivity,
      },
      sms: { total: totalSMS },
      statusConversions: { total: totalStatusChanges },
    };

    return successResponse(res, report, 'Call analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting my call analytics:', error);
    return errorResponse(res, error.message || 'Failed to get call analytics', 500);
  }
};

export const getOverviewAnalytics = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied', 403);
    }

    const rangeInDays = Number.parseInt(req.query.days, 10) || 14;
    const pool = getPool();

    // Get today's date
    const today = new Date();
    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);

    // Calculate start date: go back (rangeInDays - 1) days to include today
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (rangeInDays - 1));
    startDate.setHours(0, 0, 0, 0);

    // Helper to format date for key matching
    const formatDateKey = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const startDateStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endDateStr = endDate.toISOString().slice(0, 19).replace('T', ' ');

    const leadFilters = [];
    const leadParams = [];
    if (req.query.academicYear != null && req.query.academicYear !== '') {
      leadFilters.push('academic_year = ?');
      leadParams.push(Number(req.query.academicYear));
    }
    if (req.query.studentGroup) {
      leadFilters.push('student_group = ?');
      leadParams.push(req.query.studentGroup);
    }
    const leadWhere = leadFilters.length > 0 ? `WHERE ${leadFilters.join(' AND ')}` : '';
    const leadWhereAnd = (suffix) =>
      leadFilters.length > 0 ? `WHERE ${leadFilters.join(' AND ')} AND ${suffix}` : `WHERE ${suffix}`;

    // Get basic counts and lead status breakdown in a single query
    const [countsResult] = await pool.execute(
      `SELECT 
        COUNT(*) as totalLeads,
        SUM(CASE WHEN lead_status = 'Confirmed' THEN 1 ELSE 0 END) as confirmedLeads,
        SUM(CASE WHEN lead_status = 'Admitted' THEN 1 ELSE 0 END) as admittedLeads,
        SUM(CASE WHEN assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL THEN 1 ELSE 0 END) as assignedLeadsTotal,
        SUM(CASE WHEN assigned_to IS NOT NULL THEN 1 ELSE 0 END) as assignedLeadsToCounselor,
        SUM(CASE WHEN assigned_to_pro IS NOT NULL THEN 1 ELSE 0 END) as assignedLeadsToPro,
        SUM(CASE WHEN assigned_to IS NULL AND assigned_to_pro IS NULL THEN 1 ELSE 0 END) as unassignedLeads
      FROM leads ${leadWhere}`,
      leadParams
    );
    const {
      totalLeads,
      confirmedLeads,
      admittedLeads,
      assignedLeadsTotal,
      assignedLeadsToCounselor,
      assignedLeadsToPro,
      unassignedLeads,
    } = countsResult[0];

    // Get user role counts
    const [userRoleCountsAgg] = await pool.execute(
      `SELECT role_name, COUNT(*) as count 
       FROM users 
       WHERE role_name IN ('Student Counselor', 'PRO', 'Data Entry User', 'Sub Super Admin')
       GROUP BY role_name`
    );
    const userRoleCounts = {
      counselors: 0,
      pros: 0,
      dataEntry: 0,
      subAdmins: 0
    };
    userRoleCountsAgg.forEach(item => {
      if (item.role_name === 'Student Counselor') userRoleCounts.counselors = item.count;
      if (item.role_name === 'PRO') userRoleCounts.pros = item.count;
      if (item.role_name === 'Data Entry User') userRoleCounts.dataEntry = item.count;
      if (item.role_name === 'Sub Super Admin') userRoleCounts.subAdmins = item.count;
    });

    // Get lead status breakdown
    const [leadStatusAgg] = await pool.execute(
      `SELECT lead_status, COUNT(*) as count FROM leads ${leadWhere} GROUP BY lead_status`,
      leadParams
    );

    // Get joining status breakdown (NOTE: Requires joinings table - will be updated when joining controller is migrated)
    const [joiningStatusAgg] = await pool.execute(
      'SELECT status, COUNT(*) as count FROM joinings GROUP BY status'
    ).catch(() => [[{ status: 'draft', count: 0 }]]); // Fallback if table doesn't exist yet

    // Get admission status breakdown (NOTE: Requires admissions table - will be updated when admission controller is migrated)
    const [admissionStatusAgg] = await pool.execute(
      'SELECT status, COUNT(*) as count FROM admissions GROUP BY status'
    ).catch(() => [[{ status: 'active', count: 0 }]]); // Fallback if table doesn't exist yet

    const [admissionsTotalResult] = await pool.execute('SELECT COUNT(*) as total FROM admissions')
      .catch(() => [{ total: 0 }]);
    const admissionsTotal = admissionsTotalResult[0].total;

    // Get leads created by date
    const leadsCreatedWhere = leadFilters.length > 0
      ? `${leadWhere} AND created_at >= ? AND created_at <= ?`
      : 'WHERE created_at >= ? AND created_at <= ?';
    const [leadsCreatedAgg] = await pool.execute(
      `SELECT DATE(created_at) as date, COUNT(*) as count 
       FROM leads 
       ${leadsCreatedWhere}
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [...leadParams, startDateStr, endDateStr]
    );

    // Get status changes by date
    const [statusChangesAgg] = await pool.execute(
      `SELECT DATE(created_at) as date, new_status as status, COUNT(*) as count
       FROM activity_logs
       WHERE type = 'status_change' AND created_at >= ? AND created_at <= ?
       GROUP BY DATE(created_at), new_status
       ORDER BY date ASC`,
      [startDateStr, endDateStr]
    );

    // Get joining trends (NOTE: Requires joinings table)
    const [joiningTrendAgg] = await pool.execute(
      `SELECT DATE(updated_at) as date, status, COUNT(*) as count
       FROM joinings
       WHERE updated_at >= ? AND updated_at <= ?
       GROUP BY DATE(updated_at), status
       ORDER BY date ASC`,
      [startDateStr, endDateStr]
    ).catch(() => [[]]); // Fallback if table doesn't exist yet

    // Get admissions by date (NOTE: Requires admissions table)
    const [admissionsAgg] = await pool.execute(
      `SELECT DATE(admission_date) as date, COUNT(*) as count
       FROM admissions
       WHERE admission_date >= ? AND admission_date <= ?
       GROUP BY DATE(admission_date)
       ORDER BY date ASC`,
      [startDateStr, endDateStr]
    ).catch(() => [[]]); // Fallback if table doesn't exist yet

    const leadStatusBreakdown = leadStatusAgg.reduce((acc, item) => {
      const key = item.lead_status || 'Unknown';
      acc[key] = item.count;
      return acc;
    }, {});

    const joiningStatusBreakdown = joiningStatusAgg.reduce((acc, item) => {
      const key = item.status || 'draft';
      acc[key] = item.count;
      return acc;
    }, {});

    const admissionStatusBreakdown = admissionStatusAgg.reduce((acc, item) => {
      const key = item.status || 'active';
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
      const dateKey = formatDateKey(new Date(item.date));
      const entry = leadsCreatedSeries.get(dateKey);
      if (entry) {
        entry.count = item.count;
      }
    });

    const statusChangeSeries = new Map();
    statusChangesAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      if (!statusChangeSeries.has(dateKey)) {
        statusChangeSeries.set(dateKey, {
          date: dateKey,
          total: 0,
          statuses: {},
        });
      }
      const bucket = statusChangeSeries.get(dateKey);
      bucket.total += item.count;
      if (item.status) {
        bucket.statuses[item.status] = (bucket.statuses[item.status] || 0) + item.count;
      }
    });
    for (const [dateKey, entry] of statusChangeSeries) {
      if (!entry.statuses.total) {
        entry.statuses.total = entry.total;
      }
    }

    const joiningSeries = new Map();
    joiningTrendAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      if (!joiningSeries.has(dateKey)) {
        joiningSeries.set(dateKey, {
          date: dateKey,
          draft: 0,
          pending_approval: 0,
          approved: 0,
        });
      }
      const bucket = joiningSeries.get(dateKey);
      bucket[item.status] = (bucket[item.status] || 0) + item.count;
    });

    const admissionsSeries = initDailySeries();
    admissionsAgg.forEach((item) => {
      const dateKey = formatDateKey(new Date(item.date));
      const entry = admissionsSeries.get(dateKey);
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
        assignedLeads: assignedLeadsTotal,
        assignedLeadsToCounselor,
        assignedLeadsToPro,
        unassignedLeads,
        joinings: {
          draft: joiningStatusBreakdown.draft || 0,
          pendingApproval: joiningStatusBreakdown.pending_approval || 0,
          approved: joiningStatusBreakdown.approved || 0,
        },
        admissions: admissionsTotal,
        userRoleCounts,
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
    // Allow Super Admin, Sub Super Admin, and Managers
    const isAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    const isManager = req.user.isManager === true;
    const pool = getPool();
    const currentUserId = req.user.id || req.user._id;

    if (!isAdmin && !isManager) {
      return errorResponse(res, 'Access denied', 403);
    }

    const { startDate, endDate, userId, academicYear } = req.query;
    const yearNum = academicYear && academicYear !== '' ? parseInt(academicYear, 10) : null;
    const useAcademicYear = yearNum != null && !Number.isNaN(yearNum);

    // Set date range for filtering activities
    let activityDateConditions = [];
    let activityDateParams = [];
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      activityDateConditions.push('>= ?');
      activityDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      activityDateConditions.push('<= ?');
      activityDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    const activityDateClause = activityDateConditions.length > 0
      ? `AND ${activityDateConditions.map((c, i) => `sent_at ${c}`).join(' AND ')}`
      : '';

    // Build user filter
    let userConditions = ["role_name NOT IN ('Super Admin', 'Sub Super Admin')"];
    let userParams = [];

    // If manager, only show their team members
    if (isManager && !isAdmin) {
      userConditions.push('managed_by = ?');
      userParams.push(currentUserId);
    }

    // If userId is provided, filter to that specific user
    if (userId) {
      userConditions = ['id = ?'];
      userParams = [userId];
    }

    const userWhereClause = `WHERE ${userConditions.join(' AND ')}`;

    // Get users based on filter
    const [users] = await pool.execute(
      `SELECT id, name, email, role_name, is_active FROM users ${userWhereClause}`,
      userParams
    );

    // Get aggregate counts for all users in one go
    const [leadCounts] = await pool.execute(
      `SELECT 
        COALESCE(assigned_to, assigned_to_pro) as user_id_combined,
        COUNT(*) as total_assigned,
        SUM(CASE WHEN lead_status NOT IN ('Admitted', 'Closed', 'Cancelled') THEN 1 ELSE 0 END) as active_leads
      FROM leads 
      ${useAcademicYear ? 'WHERE academic_year = ?' : ''}
      GROUP BY user_id_combined`,
      useAcademicYear ? [yearNum] : []
    );

    const [statusCounts] = await pool.execute(
      `SELECT 
        COALESCE(assigned_to, assigned_to_pro) as user_id_combined,
        lead_status,
        COUNT(*) as count
      FROM leads 
      ${useAcademicYear ? 'WHERE academic_year = ?' : ''}
      GROUP BY user_id_combined, lead_status`,
      useAcademicYear ? [yearNum] : []
    );

    const [conversionCounts] = await pool.execute(
      `SELECT 
        COALESCE(l.assigned_to, l.assigned_to_pro) as user_id_combined,
        COUNT(DISTINCT a.lead_id) as total_converted
      FROM admissions a
      INNER JOIN leads l ON a.lead_id = l.id
      ${useAcademicYear ? 'WHERE l.academic_year = ?' : ''}
      GROUP BY user_id_combined`,
      useAcademicYear ? [yearNum] : []
    );

    const [commCounts] = await pool.execute(
      `SELECT 
        sent_by as user_id, 
        type, 
        COUNT(*) as count,
        SUM(CASE WHEN type = 'call' THEN duration_seconds ELSE 0 END) as total_duration,
        COUNT(DISTINCT lead_id) as unique_leads
      FROM communications 
      WHERE 1=1 ${activityDateClause}
      GROUP BY sent_by, type`,
      activityDateParams
    );

    const [actLogsCountResult] = await pool.execute(
      `SELECT 
        performed_by as user_id, 
        COUNT(*) as total_logs,
        SUM(CASE WHEN type = 'status_change' THEN 1 ELSE 0 END) as status_changes
      FROM activity_logs 
      WHERE 1=1 ${activityDateClause.split('sent_at').join('created_at')}
      GROUP BY performed_by`,
      activityDateParams
    );

    // Maps for fast lookup
    const leadMap = new Map();
    leadCounts.forEach(c => leadMap.set(c.user_id_combined, c));

    const statusMapByUserId = new Map();
    statusCounts.forEach(c => {
      if (!statusMapByUserId.has(c.user_id_combined)) statusMapByUserId.set(c.user_id_combined, {});
      statusMapByUserId.get(c.user_id_combined)[c.lead_status || 'Unknown'] = c.count;
    });

    const conversionMap = new Map();
    conversionCounts.forEach(c => conversionMap.set(c.user_id_combined, c.total_converted));

    const commMap = new Map();
    commCounts.forEach(c => {
      if (!commMap.has(c.user_id)) commMap.set(c.user_id, { calls: { total: 0, duration: 0, unique: 0 }, sms: 0 });
      const entry = commMap.get(c.user_id);
      if (c.type === 'call') {
        entry.calls.total = c.count;
        entry.calls.duration = c.total_duration;
        entry.calls.unique = c.unique_leads;
      } else if (c.type === 'sms') {
        entry.sms = c.count;
      }
    });

    const logsMap = new Map();
    actLogsCountResult.forEach(c => logsMap.set(c.user_id, c));

    // Compile analytics for each user
    const userAnalytics = users.map((user) => {
      const leads = leadMap.get(user.id) || { total_assigned: 0, active_leads: 0 };
      const statusBreakdown = statusMapByUserId.get(user.id) || {};
      const convertedLeads = conversionMap.get(user.id) || 0;
      const comms = commMap.get(user.id) || { calls: { total: 0, duration: 0, unique: 0 }, sms: 0 };
      const logs = logsMap.get(user.id) || { total_logs: 0, status_changes: 0 };

      const totalAssigned = leads.total_assigned;

      return {
        userId: user.id,
        userName: user.name,
        name: user.name,
        email: user.email,
        roleName: user.role_name,
        isActive: user.is_active === 1 || user.is_active === true,
        totalAssigned,
        activeLeads: leads.active_leads,
        convertedLeads,
        interested: statusBreakdown['Interested'] || 0,
        conversionRate: totalAssigned > 0 ? parseFloat(((convertedLeads / totalAssigned) * 100).toFixed(2)) : 0,
        statusBreakdown,
        activityLogsCount: logs.total_logs,
        calls: {
          total: comms.calls.unique, // Following UI expectation of unique leads called
          totalDuration: comms.calls.duration,
          averageDuration: comms.calls.total > 0 ? Math.round(comms.calls.duration / comms.calls.total) : 0,
        },
        sms: {
          total: comms.sms,
        },
        statusConversions: {
          total: logs.status_changes,
        },
      };
    });

    return successResponse(res, { users: userAnalytics }, 'User analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get user analytics', 500);
  }
};

