import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadAssignment } from '../services/notification.service.js';
import { isPipelineNewLeadStatus } from '../utils/leadChannelStatus.util.js';
import { v4 as uuidv4 } from 'uuid';
import { connectHRMS } from '../config-mongo/hrms.js';

const assignmentStatsCache = new Map();
const ASSIGNMENT_STATS_CACHE_MS = Number(process.env.ASSIGNMENT_STATS_CACHE_MS || 20000);

const analyticsCache = new Map();
/**
 * GET /leads/analytics/users response cache (in-memory).
 * Default 10 minutes — repeat loads (same query params) return instantly. Override with USER_ANALYTICS_CACHE_MS or legacy ANALYTICS_CACHE_MS.
 */
const USER_ANALYTICS_CACHE_MS = Number(
  process.env.USER_ANALYTICS_CACHE_MS || process.env.ANALYTICS_CACHE_MS || 600000
);
const MAX_USER_ANALYTICS_CACHE_ENTRIES = Number(process.env.MAX_USER_ANALYTICS_CACHE_ENTRIES || 200);


const stableStringify = (value) => {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${k}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** Same labels as Super Admin reports `COUNSELLOR_CALL_STATUS_COLUMNS` — merge DB variants into one bucket. */
const COUNSELLOR_CALL_STATUS_CANONICAL = [
  'Assigned',
  'Interested',
  'Not Interested',
  'Not Answered',
  'Wrong Data',
  'Call Back',
  'Confirmed',
  'CET Applied',
];

const canonicalCounselorCallStatusForReports = (label) => {
  const t = String(label ?? '').trim();
  if (!t || /^not\s*set$/i.test(t)) return 'Not set';
  const lower = t.toLowerCase();
  const hit = COUNSELLOR_CALL_STATUS_CANONICAL.find((s) => s.toLowerCase() === lower);
  return hit || t;
};

const getCachedAssignmentStats = (key) => {
  const hit = assignmentStatsCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    assignmentStatsCache.delete(key);
    return null;
  }
  return hit.value;
};

const setCachedAssignmentStats = (key, value) => {
  assignmentStatsCache.set(key, {
    value,
    expiresAt: Date.now() + ASSIGNMENT_STATS_CACHE_MS,
  });
};

/**
 * Normalized institution name key for a lead row (JOIN / GROUP BY / WHERE).
 * Prefer `inter_college` (bulk upload and manual entry); then JSON dynamic_fields used by forms/API.
 */
const LEAD_INSTITUTION_KEY_SQL = `LOWER(TRIM(COALESCE(
  NULLIF(TRIM(COALESCE(inter_college, '')), ''),
  NULLIF(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.school_or_college_name')), '')), ''),
  NULLIF(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(dynamic_fields, '$.schoolOrCollegeName')), '')), ''),
  ''
)))`;

// @desc    Assign leads to users based on mandal/state (bulk) or specific lead IDs (single)
// @route   POST /api/leads/assign
// @access  Private (Super Admin only)
export const assignLeads = async (req, res) => {
  try {
    const { userId, mandal, district, state, academicYear, studentGroup, count, leadIds, assignNow = true, institutionName, targetDate, cycleNumber } = req.body;
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
    const skippedProAlreadyAssignedLeadIds = [];
    const skippedProConcurrentLeadIds = [];

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
        `SELECT id, assigned_to, assigned_to_pro FROM leads WHERE id IN (${placeholders})`,
        validLeadIds
      );

      if (existingLeads.length === 0) {
        return errorResponse(res, 'No leads found with the provided IDs', 404);
      }

      if (isProRole) {
        const assignableLeads = [];
        for (const lead of existingLeads) {
          const currentProAssignee = lead.assigned_to_pro;
          if (currentProAssignee) {
            skippedProAlreadyAssignedLeadIds.push(lead.id);
            continue;
          }
          assignableLeads.push(lead.id);
        }
        leadIdsToAssign = assignableLeads;
      } else {
        leadIdsToAssign = existingLeads.map((lead) => lead.id);
      }
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
      // For PRO role, availability means not yet assigned to any PRO.
      const assignmentCondition = isProRole ? '(assigned_to_pro IS NULL)' : '(assigned_to IS NULL)';
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
        if (studentGroup === 'Inter') {
          conditions.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
        } else {
          conditions.push('student_group = ?');
          params.push(studentGroup);
        }
      }

      if (cycleNumber != null && cycleNumber !== '') {
        const cyc = parseInt(cycleNumber, 10);
        if (!Number.isNaN(cyc)) {
          conditions.push('cycle_number = ?');
          params.push(cyc);
        }
      }

      // Add school/college (institution) filter: inter_college first, then JSON dynamic_fields
      if (institutionName && typeof institutionName === 'string' && institutionName.trim()) {
        const instParam = institutionName.trim();
        conditions.push(`${LEAD_INSTITUTION_KEY_SQL} = LOWER(?)`);
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

    if (leadIdsToAssign.length === 0) {
      if (isProRole && skippedProAlreadyAssignedLeadIds.length > 0) {
        return successResponse(
          res,
          {
            assigned: 0,
            requested: leadIds ? leadIds.length : parseInt(count),
            skippedAlreadyAssignedToAnotherPro: skippedProAlreadyAssignedLeadIds.length,
            skippedLeadIds: skippedProAlreadyAssignedLeadIds,
            userId,
            userName: user.name,
            targetRole: user.role_name,
            mode: leadIds ? 'single' : 'bulk',
            message: 'All selected leads are already assigned to another PRO',
          },
          'No leads assigned because selected leads are already assigned to another PRO',
          200
        );
      }
      return successResponse(
        res,
        {
          assigned: 0,
          requested: leadIds ? leadIds.length : parseInt(count),
          userId,
          userName: user.name,
          targetRole: user.role_name,
          mode: leadIds ? 'single' : 'bulk',
          message: 'No eligible leads found for assignment',
        },
        'No leads eligible for assignment',
        200
      );
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
    const successfullyAssignedLeadIds = [];

    for (const lead of leadsToAssign) {
      const oldStatus = lead.lead_status && String(lead.lead_status).trim() !== ''
        ? String(lead.lead_status).trim()
        : 'New';
      const newStatus = isPipelineNewLeadStatus(lead.lead_status) ? 'Assigned' : oldStatus;

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
         WHERE id = ? AND assigned_to_pro IS NULL`;
      } else {
        updateQuery = `UPDATE leads SET 
          assigned_to = ?, assigned_at = NOW(), assigned_by = ?, lead_status = ?, target_date = ?${setAcademicYear}, call_status = 'Assigned', updated_at = NOW()
         WHERE id = ?`;
      }

      if (isProRole) {
        updateParams = yearNum != null && !Number.isNaN(yearNum)
          ? [userId, currentUserId, newStatus, targetDate || null, yearNum, lead.id]
          : [userId, currentUserId, newStatus, targetDate || null, lead.id];
      } else {
        updateParams = yearNum != null && !Number.isNaN(yearNum)
          ? [userId, currentUserId, newStatus, targetDate || null, yearNum, lead.id]
          : [userId, currentUserId, newStatus, targetDate || null, lead.id];
      }

      const [updateResult] = await pool.execute(updateQuery, updateParams);
      if (isProRole && Number(updateResult?.affectedRows || 0) === 0) {
        skippedProConcurrentLeadIds.push(lead.id);
        continue;
      }

      // Create activity log
      const activityLogId = uuidv4();
      const assigneeLabel = isProRole
        ? `PRO ${user.name}`
        : `${user.role_name === 'Sub Super Admin' ? 'sub-admin' : 'counsellor'} ${user.name}`;
      const assignmentMeta = {
        assignedTo: userId,
        assignedBy: currentUserId,
        targetRole: isProRole ? 'PRO' : 'counsellor',
      };
      if (targetDate && String(targetDate).trim()) {
        const td = String(targetDate).trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(td)) {
          assignmentMeta.targetDate = td;
        }
      }
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
            assignment: assignmentMeta,
          }),
        ]
      );

      modifiedCount++;
      successfullyAssignedLeadIds.push(lead.id);
    }

    // Send notifications (async, don't wait for it)
    const isBulk = !leadIds || leadIds.length === 0;

    // Get full lead details for notification AND response (limit to 50 for email display, but we want all for export?)
    // Verify: If we assign 1000 leads, returning 1000 objects is fine.
    const exportExtraFields = isProRole ? ', district, mandal, village, address' : '';
    let leadsDetails = [];
    if (successfullyAssignedLeadIds.length > 0) {
      const successPlaceholders = successfullyAssignedLeadIds.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT id, name, phone, enquiry_number, notes${exportExtraFields} FROM leads WHERE id IN (${successPlaceholders})`,
        successfullyAssignedLeadIds
      );
      leadsDetails = rows;
    }

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
        skippedAlreadyAssignedToAnotherPro: skippedProAlreadyAssignedLeadIds.length,
        skippedDueToConcurrentProAssignment: skippedProConcurrentLeadIds.length,
        userId,
        userName: user.name,
        targetRole: user.role_name,
        mandal: mandal || 'All',
        district: district || 'All',
        state: state || 'All',
        mode: leadIds ? 'single' : 'bulk',
        skippedLeadIds: [...skippedProAlreadyAssignedLeadIds, ...skippedProConcurrentLeadIds],
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
    const includeBreakdowns = String(req.query.includeBreakdowns || 'true').toLowerCase() !== 'false';
    const summaryOnly = String(req.query.summaryOnly || 'false').toLowerCase() === 'true';
    const geoBreakdown = req.query.geoBreakdown ? String(req.query.geoBreakdown).trim().toLowerCase() : '';
    const cacheKey = stableStringify({
      mandal,
      district,
      state,
      academicYear,
      studentGroup,
      institutionName,
      forBreakdown,
      cycleNumber,
      targetRole: req.query.targetRole,
      includeBreakdowns,
      summaryOnly,
      geoBreakdown,
    });
    const cached = getCachedAssignmentStats(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Assignment statistics retrieved successfully', 200);
    }

    // Build filter for available leads
    // Use targetRole query parameter if provided (e.g. from UI when selecting a user)
    const rawTargetRole = req.query.targetRole || 'Student Counselor';
    const targetRole = String(rawTargetRole).trim().toUpperCase();
    const isProTarget = targetRole === 'PRO';
    // For PRO targets, "Available" means not yet assigned to any PRO.
    const assignmentCondition = isProTarget ? 'assigned_to_pro IS NULL' : 'assigned_to IS NULL';

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
      conditions.push(`${LEAD_INSTITUTION_KEY_SQL} = LOWER(?)`);
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
      baseConditions.push(`${LEAD_INSTITUTION_KEY_SQL} = LOWER(?)`);
      baseParams.push(instBase);
    }
    const baseWhere = baseConditions.length ? `WHERE ${baseConditions.join(' AND ')}` : '';

    const [summaryRows] = await pool.execute(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${isProTarget ? 'assigned_to_pro IS NULL' : 'assigned_to IS NULL'} THEN 1 ELSE 0 END) AS unassigned
       FROM leads ${baseWhere}`,
      baseParams
    );
    const totalLeads = Number(summaryRows?.[0]?.total || 0);
    const trulyUnassignedCount = Number(summaryRows?.[0]?.unassigned || 0);
    const unassignedCount = trulyUnassignedCount;
    const assignedCount = Math.max(totalLeads - trulyUnassignedCount, 0);

    let mandalBreakdown = [];
    let stateBreakdown = [];
    if (includeBreakdowns && !summaryOnly) {
      const [mandalRows, stateRows] = await Promise.all([
        pool.execute(
          `SELECT mandal, COUNT(*) as count 
           FROM leads ${whereClause}
           GROUP BY mandal 
           ORDER BY count DESC 
           LIMIT 20`,
          [...params]
        ),
        pool.execute(
          `SELECT state, COUNT(*) as count 
           FROM leads ${whereClause}
           GROUP BY state 
           ORDER BY count DESC`,
          [...params]
        ),
      ]);
      mandalBreakdown = mandalRows[0] || [];
      stateBreakdown = stateRows[0] || [];
    }

    // Optional: per-district or per-mandal assigned vs unassigned (bulk assign UI dropdown hints)
    const nullAssignedExpr = isProTarget ? 'assigned_to_pro IS NULL' : 'assigned_to IS NULL';

    const buildGeoScopeConditions = (opts) => {
      const { includeDistrict, districtValue } = opts;
      const gc = [];
      const gp = [];
      if (academicYear != null && academicYear !== '') {
        const year = parseInt(academicYear, 10);
        if (!Number.isNaN(year)) {
          gc.push('academic_year = ?');
          gp.push(year);
        }
      }
      if (studentGroup) {
        if (studentGroup === 'Inter') {
          gc.push("(student_group = 'Inter' OR student_group LIKE 'Inter-%')");
        } else {
          gc.push('student_group = ?');
          gp.push(studentGroup);
        }
      }
      if (cycleNumber != null && cycleNumber !== '') {
        const cyc = parseInt(cycleNumber, 10);
        if (!Number.isNaN(cyc)) {
          gc.push('cycle_number = ?');
          gp.push(cyc);
        }
      }
      if (state) {
        gc.push('state = ?');
        gp.push(state);
      }
      if (includeDistrict && districtValue) {
        gc.push('district = ?');
        gp.push(districtValue);
      }
      return { gc, gp };
    };

    let districtAssignmentBreakdown;
    let mandalAssignmentBreakdown;

    if (geoBreakdown === 'district' && state) {
      const { gc, gp } = buildGeoScopeConditions({ includeDistrict: false });
      if (gc.length > 0) {
        const [dRows] = await pool.execute(
          `SELECT COALESCE(NULLIF(TRIM(district), ''), '(Unknown)') AS district,
            SUM(CASE WHEN (${nullAssignedExpr}) THEN 1 ELSE 0 END) AS unassigned_count,
            SUM(CASE WHEN NOT (${nullAssignedExpr}) THEN 1 ELSE 0 END) AS assigned_count
           FROM leads WHERE ${gc.join(' AND ')}
           GROUP BY COALESCE(NULLIF(TRIM(district), ''), '(Unknown)')
           ORDER BY district ASC`,
          gp
        );
        districtAssignmentBreakdown = (dRows || []).map((r) => ({
          district: r.district,
          unassignedCount: Number(r.unassigned_count) || 0,
          assignedCount: Number(r.assigned_count) || 0,
        }));
      }
    }

    if (geoBreakdown === 'mandal' && state && district) {
      const { gc, gp } = buildGeoScopeConditions({ includeDistrict: true, districtValue: district });
      if (gc.length > 0) {
        const [mRows] = await pool.execute(
          `SELECT COALESCE(NULLIF(TRIM(mandal), ''), '(Unknown)') AS mandal,
            SUM(CASE WHEN (${nullAssignedExpr}) THEN 1 ELSE 0 END) AS unassigned_count,
            SUM(CASE WHEN NOT (${nullAssignedExpr}) THEN 1 ELSE 0 END) AS assigned_count
           FROM leads WHERE ${gc.join(' AND ')}
           GROUP BY COALESCE(NULLIF(TRIM(mandal), ''), '(Unknown)')
           ORDER BY mandal ASC`,
          gp
        );
        mandalAssignmentBreakdown = (mRows || []).map((r) => ({
          mandal: r.mandal,
          unassignedCount: Number(r.unassigned_count) || 0,
          assignedCount: Number(r.assigned_count) || 0,
        }));
      }
    }

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
      ...(districtAssignmentBreakdown ? { districtAssignmentBreakdown } : {}),
      ...(mandalAssignmentBreakdown ? { mandalAssignmentBreakdown } : {}),
    };

    // Optional: school-wise or college-wise unassigned breakdown (for institution allocation UI)
    if (forBreakdown === 'school' || forBreakdown === 'college') {
      const table = forBreakdown === 'school' ? 'schools' : 'colleges';
      const institutionNameExpr = LEAD_INSTITUTION_KEY_SQL;
      const institutionJoinExpr = `LOWER(TRIM(i.name))`;
      const leadAggConditions = [
        ...baseConditions,
        isProTarget ? 'assigned_to_pro IS NULL' : 'assigned_to IS NULL',
      ];
      const leadAggWhere = leadAggConditions.length > 0 ? `WHERE ${leadAggConditions.join(' AND ')}` : '';

      // Start from grouped leads (often far fewer keys than all master rows), then join catalog names.
      const [institutionRows] = await pool.execute(
        `SELECT i.id, i.name, la.count
         FROM (
           SELECT ${institutionNameExpr} AS institution_key, COUNT(*) AS count
           FROM leads
           ${leadAggWhere}
           GROUP BY institution_key
           HAVING institution_key IS NOT NULL AND institution_key <> ''
         ) la
         INNER JOIN ${table} i
           ON la.institution_key = ${institutionJoinExpr}
           AND i.is_active = 1
         ORDER BY i.name ASC`,
        [...baseParams]
      );
      payload.institutionBreakdown = (institutionRows || []).map((r) => ({
        id: r.id,
        name: r.name,
        count: Number(r.count) || 0,
      }));
    }

    setCachedAssignmentStats(cacheKey, payload);
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
    const isStudentCounselor = queriedUser.role_name === 'Student Counselor';
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

    // Dashboard breakdown: PRO -> visit_status, Student Counselor -> call_status, others -> lead_status
    const statusGroupExpr = isProRole
      ? `COALESCE(NULLIF(TRIM(visit_status), ''), 'Not set')`
      : isStudentCounselor
        ? `COALESCE(NULLIF(TRIM(call_status), ''), 'Not set')`
        : 'lead_status';

    // Get recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentThreshold = sevenDaysAgo.toISOString().slice(0, 19).replace('T', ' ');

    // Run independent analytics queries in parallel to reduce API latency.
    const [
      totalLeadsResultWrap,
      overallTotalResultWrap,
      statusBreakdownWrap,
      mandalBreakdownWrap,
      stateBreakdownWrap,
      studentGroupBreakdownWrap,
      recentLeadsResultWrap,
      upcomingTargetDatesWrap,
    ] = await Promise.all([
      pool.execute(
        `SELECT COUNT(*) as total FROM leads WHERE ${whereClause}`,
        params
      ),
      pool.execute(
        `SELECT COUNT(*) as total FROM leads WHERE ${assignmentCondition}`,
        isProRole ? [userId, userId] : [userId]
      ),
      pool.execute(
        `SELECT ${statusGroupExpr} AS lead_status, COUNT(*) as count 
         FROM leads 
         WHERE ${whereClause}
         GROUP BY ${statusGroupExpr}
         ORDER BY count DESC`,
        params
      ),
      pool.execute(
        `SELECT mandal, COUNT(*) as count 
         FROM leads 
         WHERE ${whereClause}
         GROUP BY mandal 
         ORDER BY count DESC 
         LIMIT 10`,
        params
      ),
      pool.execute(
        `SELECT state, COUNT(*) as count 
         FROM leads 
         WHERE ${whereClause}
         GROUP BY state 
         ORDER BY count DESC`,
        params
      ),
      pool.execute(
        `SELECT student_group, COUNT(*) as count 
         FROM leads 
         WHERE ${whereClause}
         GROUP BY student_group 
         ORDER BY count DESC`,
        params
      ),
      pool.execute(
        `SELECT COUNT(*) as total FROM leads WHERE ${whereClause} AND updated_at >= ?`,
        [...params, recentThreshold]
      ),
      pool.execute(
        `SELECT DATE(target_date) as target_date, COUNT(*) as count
         FROM leads
         WHERE ${whereClause}
           AND target_date IS NOT NULL
           AND DATE(target_date) >= CURDATE()
         GROUP BY DATE(target_date)
         ORDER BY DATE(target_date) ASC
         LIMIT 60`,
        params
      ),
    ]);

    const totalLeadsResult = totalLeadsResultWrap[0];
    const overallTotalResult = overallTotalResultWrap[0];
    const statusBreakdown = statusBreakdownWrap[0];
    const mandalBreakdown = mandalBreakdownWrap[0];
    const stateBreakdown = stateBreakdownWrap[0];
    const studentGroupBreakdown = studentGroupBreakdownWrap[0];
    const recentLeadsResult = recentLeadsResultWrap[0];
    const upcomingTargetDates = upcomingTargetDatesWrap[0];

    const totalLeads = totalLeadsResult[0].total;
    const overallTotalLeads = overallTotalResult[0].total;

    // Convert status breakdown to object (keys are call/visit/pipeline values per role)
    const statusCounts = {};
    statusBreakdown.forEach((item) => {
      const key = item.lead_status;
      const label =
        key === null || key === undefined || String(key).trim() === ''
          ? isProRole || isStudentCounselor
            ? 'Not set'
            : 'New'
          : String(key).trim();
      statusCounts[label] = item.count;
    });

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
        upcomingTargetDates: upcomingTargetDates.map((item) => ({
          date: item.target_date instanceof Date
            ? item.target_date.toISOString().slice(0, 10)
            : String(item.target_date || '').slice(0, 10),
          count: typeof item.count === 'bigint' ? Number(item.count) : Number(item.count || 0),
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
       WHERE c.sent_by = ? AND c.type = 'call'
         AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
         ${callDateClause}
       ORDER BY c.sent_at DESC`,
      [userId, ...activityDateParams]
    ).catch(() => [[]]);

    const distinctLeadIds = new Set((calls || []).map((row) => row.lead_id).filter(Boolean));
    const totalCallsDistinctLeads = distinctLeadIds.size;
    const totalCallAttempts = calls.length;
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
      .map((date) => {
        const bucket = dailyCallActivityMap[date];
        const leadsArr = Object.values(bucket.leads);
        return {
          date: bucket.date,
          distinctLeads: leadsArr.length,
          attempts: bucket.callCount,
          callCount: leadsArr.length,
          leads: leadsArr,
        };
      });

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
        total: totalCallsDistinctLeads,
        totalAttempts: totalCallAttempts,
        averageDuration: totalCallAttempts > 0 ? Math.round(totalCallDuration / totalCallAttempts) : 0,
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
    if (req.query.source && String(req.query.source).trim()) {
      leadFilters.push('source = ?');
      leadParams.push(String(req.query.source).trim());
    }
    if (req.query.cycleNumber != null && req.query.cycleNumber !== '') {
      const cycleNum = Number(req.query.cycleNumber);
      if (!Number.isNaN(cycleNum)) {
        leadFilters.push('cycle_number = ?');
        leadParams.push(cycleNum);
      }
    }
    const leadWhere = leadFilters.length > 0 ? `WHERE ${leadFilters.join(' AND ')}` : '';
    const leadWhereAnd = (suffix) =>
      leadFilters.length > 0 ? `WHERE ${leadFilters.join(' AND ')} AND ${suffix}` : `WHERE ${suffix}`;

    // Get basic counts, funnel metrics, and lead status breakdown in a single query
    const [countsResult] = await pool.execute(
      `SELECT 
        COUNT(*) as totalLeads,
        SUM(CASE WHEN lead_status = 'Confirmed' THEN 1 ELSE 0 END) as confirmedLeads,
        SUM(CASE WHEN lead_status = 'Admitted' THEN 1 ELSE 0 END) as admittedLeads,
        SUM(CASE WHEN assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL THEN 1 ELSE 0 END) as assignedLeadsTotal,
        SUM(CASE WHEN assigned_to IS NOT NULL THEN 1 ELSE 0 END) as assignedLeadsToCounselor,
        SUM(CASE WHEN assigned_to_pro IS NOT NULL THEN 1 ELSE 0 END) as assignedLeadsToPro,
        SUM(CASE WHEN assigned_to IS NULL AND assigned_to_pro IS NULL THEN 1 ELSE 0 END) as unassignedLeads,
        SUM(CASE WHEN 
          (assigned_to IS NOT NULL AND call_status IS NOT NULL AND TRIM(call_status) <> '' AND UPPER(TRIM(call_status)) <> 'ASSIGNED')
          OR (assigned_to_pro IS NOT NULL AND visit_status IS NOT NULL AND TRIM(visit_status) <> '' AND UPPER(TRIM(visit_status)) <> 'ASSIGNED')
        THEN 1 ELSE 0 END) as callOrVisitDone,
        SUM(CASE WHEN lead_status IN ('Interested', 'CET Applied') THEN 1 ELSE 0 END) as interestedLeads
      FROM leads ${leadWhere}`,
      leadParams
    );
    const countRow = countsResult[0];
    const toCount = (v) => {
      if (v == null) return 0;
      if (typeof v === 'bigint') return Number(v);
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const totalLeads = toCount(countRow.totalLeads);
    const confirmedLeads = toCount(countRow.confirmedLeads);
    const admittedLeads = toCount(countRow.admittedLeads);
    const assignedLeadsTotal = toCount(countRow.assignedLeadsTotal);
    const assignedLeadsToCounselor = toCount(countRow.assignedLeadsToCounselor);
    const assignedLeadsToPro = toCount(countRow.assignedLeadsToPro);
    const unassignedLeads = toCount(countRow.unassignedLeads);
    const callOrVisitDone = toCount(countRow.callOrVisitDone);
    const interestedLeads = toCount(countRow.interestedLeads);

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
        callOrVisitDone,
        interestedLeads,
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

/** Non-blocking enrichment for Super Admin reports; safe to run parallel with aggregate SQL. */
async function hydrateUserOrgFromHrms(users, pool) {
  if (!users?.length) return;
  try {
    const hrmsConn = await connectHRMS();
    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));
    const Designation = hrmsConn.models.designations || hrmsConn.model('designations', new hrmsConn.base.Schema({}, { strict: false }));

    const [usersWithEmp] = await pool.execute(
      `SELECT id, emp_no FROM users WHERE id IN (${users.map(() => '?').join(',')})`,
      users.map((u) => u.id)
    );
    const empNos = usersWithEmp.map((u) => u.emp_no).filter(Boolean);
    if (empNos.length === 0) return;

    const hrmsEmployees = await Employee.find({ emp_no: { $in: empNos } })
      .select('emp_no division_id department_id employee_group_id designation_id dynamicFields');
    const divIds = [...new Set(hrmsEmployees.map(e => e.division_id).filter(Boolean))];
    const deptIds = [...new Set(hrmsEmployees.map(e => e.department_id).filter(Boolean))];
    const groupIds = [...new Set(hrmsEmployees.map(e => e.employee_group_id).filter(Boolean))];
    const designationIds = [...new Set(hrmsEmployees.map(e => e.designation_id).filter(Boolean))];

    const [divisions, departments, groups, designations] = await Promise.all([
      Division.find({ _id: { $in: divIds } }).select('name'),
      Department.find({ _id: { $in: deptIds } }).select('name'),
      Group.find({ _id: { $in: groupIds } }).select('name'),
      Designation.find({ _id: { $in: designationIds } }).select('name'),
    ]);
    const divMap = Object.fromEntries(divisions.map((d) => [d._id.toString(), d.name]));
    const deptMap = Object.fromEntries(departments.map((d) => [d._id.toString(), d.name]));
    const groupMap = Object.fromEntries(groups.map((g) => [g._id.toString(), g.name]));
    const designationMap = Object.fromEntries(designations.map((d) => [d._id.toString(), d.name]));

    const extractDesignationName = (emp) => {
      const byId = emp.designation_id ? designationMap[emp.designation_id.toString()] : null;
      if (byId) return byId;
      const dynamicFields = emp.dynamicFields || {};
      if (typeof dynamicFields.designation_name === 'string' && dynamicFields.designation_name.trim()) {
        return dynamicFields.designation_name.trim();
      }
      const rawDesignation = dynamicFields.designation;
      if (typeof rawDesignation === 'string' && rawDesignation.trim()) {
        try {
          const parsed = JSON.parse(rawDesignation);
          if (parsed?.name && String(parsed.name).trim()) return String(parsed.name).trim();
        } catch {
          // ignore
        }
      }
      return null;
    };

    const hrmsByEmpNo = new Map(
      hrmsEmployees.map((emp) => [
        String(emp.emp_no),
        {
          division: emp.division_id ? divMap[emp.division_id.toString()] || '-' : '-',
          department: emp.department_id ? deptMap[emp.department_id.toString()] || '-' : '-',
          group: emp.employee_group_id ? groupMap[emp.employee_group_id.toString()] || '-' : '-',
          designation: extractDesignationName(emp),
        },
      ])
    );

    const empByUserId = new Map(usersWithEmp.map((u) => [u.id, String(u.emp_no || '')]));
    users.forEach((u) => {
      const empNo = empByUserId.get(u.id);
      const hrms = empNo ? hrmsByEmpNo.get(empNo) : null;
      if (hrms) {
        u.division = hrms.division;
        u.department = hrms.department;
        u.group = hrms.group;
        u.designation = hrms.designation || u.designation || null;
      }
    });
  } catch (hrmsHydrationError) {
    console.error('HRMS hydration error in getUserAnalytics:', hrmsHydrationError);
  }
}

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

    const {
      startDate,
      endDate,
      userId,
      academicYear,
      includeAssignmentDetails,
      division,
      department,
      group,
      bypassCache,
      page: pageQuery,
      limit: limitQuery,
      perfSearch,
      perfDepartment,
      perfGroup,
      perfRole,
    } = req.query;

    const cacheKey = stableStringify({
      startDate,
      endDate,
      userId,
      academicYear,
      includeAssignmentDetails,
      division,
      department,
      group,
      managedBy: isManager && !isAdmin ? currentUserId : null,
      page: pageQuery,
      limit: limitQuery,
      perfSearch,
      perfDepartment,
      perfGroup,
      perfRole,
    });

    if (String(bypassCache || '').toLowerCase() !== 'true') {
      const cached = analyticsCache.get(cacheKey);
      if (cached) {
        if (Date.now() < cached.expiresAt) {
          // Move to end of Map so LRU eviction keeps hot keys longer.
          analyticsCache.delete(cacheKey);
          analyticsCache.set(cacheKey, cached);
          return successResponse(res, cached.data, 'User analytics retrieved from cache', 200);
        }
        analyticsCache.delete(cacheKey);
      }
    }

    const yearNum = academicYear && academicYear !== '' ? parseInt(academicYear, 10) : null;
    const useAcademicYear = yearNum != null && !Number.isNaN(yearNum);
    const shouldIncludeAssignmentDetails =
      String(includeAssignmentDetails || '').toLowerCase() === 'true';
    const hasOrgFilters = Boolean(division || department || group);

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

    /** Assignment logs in the selected period (same window as date-wise expanded rows). */
    let assignmentDateConditions = [];
    let assignmentDateParams = [];
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      assignmentDateConditions.push('a.created_at >= ?');
      assignmentDateParams.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      assignmentDateConditions.push('a.created_at <= ?');
      assignmentDateParams.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (useAcademicYear) {
      assignmentDateConditions.push('l.academic_year = ?');
      assignmentDateParams.push(yearNum);
    }
    const assignmentDateWhere =
      assignmentDateConditions.length > 0 ? `AND ${assignmentDateConditions.join(' AND ')}` : '';

    /** Reclamation rows aligned with report filters (assignment previously had no date filter → “Reclaimed” looked inflated vs future target dates). */
    const reclaimLogConditions = [];
    const reclaimLogParamsSuffix = [];
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      reclaimLogConditions.push('created_at >= ?');
      reclaimLogParamsSuffix.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      reclaimLogConditions.push('created_at <= ?');
      reclaimLogParamsSuffix.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (useAcademicYear) {
      reclaimLogConditions.push(
        'EXISTS (SELECT 1 FROM leads l_r WHERE l_r.id = activity_logs.lead_id AND l_r.academic_year = ?)'
      );
      reclaimLogParamsSuffix.push(yearNum);
    }
    const reclaimLogWhere =
      reclaimLogConditions.length > 0 ? `AND ${reclaimLogConditions.join(' AND ')}` : '';

    // Build user filter
    let userConditions = ["role_name NOT IN ('Super Admin', 'Sub Super Admin')"];
    let userParams = [];

    // If manager, only show their team members
    if (isManager && !isAdmin) {
      userConditions.push('managed_by = ?');
      userParams.push(currentUserId);
    }

    // If userId is provided, filter to those specific users
    if (userId) {
      const ids = String(userId).split(',').map(id => id.trim()).filter(Boolean);
      if (ids.length > 0) {
        userConditions = [`id IN (${ids.map(() => '?').join(',')})` ];
        userParams = ids;
      }
    } else if (hasOrgFilters) {
      // Filter by HRMS organizational units
      try {
        const hrmsConn = await connectHRMS();
        const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
        const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
        const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
        const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));

        const hrmsQuery = {};
        if (division) {
          const divDoc = await Division.findOne({ name: division });
          if (divDoc) hrmsQuery.division_id = divDoc._id;
          else {
            // Division not found, return empty results
            return successResponse(res, { users: [] }, 'No users found for this division', 200);
          }
        }
        if (department) {
          const deptDoc = await Department.findOne({ name: department });
          if (deptDoc) hrmsQuery.department_id = deptDoc._id;
          else {
            return successResponse(res, { users: [] }, 'No users found for this department', 200);
          }
        }
        if (group) {
          const groupDoc = await Group.findOne({ name: group });
          if (groupDoc) hrmsQuery.employee_group_id = groupDoc._id;
          else {
            return successResponse(res, { users: [] }, 'No users found for this group', 200);
          }
        }

        const matchingEmployees = await Employee.find(hrmsQuery).select('emp_no');
        const empNos = matchingEmployees.map(e => e.emp_no).filter(Boolean);

        if (empNos.length === 0) {
          return successResponse(res, { users: [] }, 'No employees found matching organizational filters', 200);
        }

        userConditions.push(`emp_no IN (${empNos.map(() => '?').join(',')})`);
        userParams.push(...empNos);
      } catch (hrmsError) {
        console.error('HRMS filtering error in getUserAnalytics:', hrmsError);
        // Fallback: continue without HRMS filtering (or could return error)
      }
    }

    const userWhereClause = `WHERE ${userConditions.join(' AND ')}`;

    // Get users based on filter
    const [users] = await pool.execute(
      `SELECT id, name, email, role_name, designation, is_active FROM users ${userWhereClause}`,
      userParams
    );

    if (!users || users.length === 0) {
      return successResponse(res, { users: [] }, 'User analytics retrieved successfully', 200);
    }

    await hydrateUserOrgFromHrms(users, pool);

    /** Optional UI filters (reports → User Performance). Distinct from HRMS org query params division/department/group. */
    const perfSearchNorm = String(perfSearch || '').trim().toLowerCase();
    const perfDeptNorm = String(perfDepartment || '').trim();
    const perfGroupNorm = String(perfGroup || '').trim();
    const perfRoleNorm = String(perfRole || '').trim();

    let perfFilteredUsers = users;
    if (perfSearchNorm || perfDeptNorm || perfGroupNorm || perfRoleNorm) {
      perfFilteredUsers = users.filter((u) => {
        const name = String(u.name || '').toLowerCase();
        const email = String(u.email || '').toLowerCase();
        if (perfSearchNorm && !name.includes(perfSearchNorm) && !email.includes(perfSearchNorm)) return false;
        if (perfDeptNorm && String(u.department || '').trim() !== perfDeptNorm) return false;
        if (perfGroupNorm && String(u.group || '').trim() !== perfGroupNorm) return false;
        if (perfRoleNorm && String(u.role_name || '').trim() !== perfRoleNorm) return false;
        return true;
      });
    }

    perfFilteredUsers = [...perfFilteredUsers].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );

    /** When expanding rows by userId, always return full analytics for those ids (ignore pagination). */
    const explicitUserIds = userId ? String(userId).split(',').map((id) => id.trim()).filter(Boolean) : [];
    const allowPagination = explicitUserIds.length === 0;
    const pageNum =
      allowPagination && pageQuery != null && pageQuery !== ''
        ? Math.max(1, parseInt(String(pageQuery), 10) || 1)
        : null;
    const limitNum =
      allowPagination && limitQuery != null && limitQuery !== ''
        ? Math.min(100, Math.max(1, parseInt(String(limitQuery), 10) || 25))
        : null;
    const isPaginated = pageNum != null && limitNum != null;

    if (!perfFilteredUsers.length) {
      const emptyPag =
        isPaginated
          ? { page: 1, limit: limitNum, total: 0, pages: 1 }
          : null;
      return successResponse(
        res,
        { users: [], ...(emptyPag ? { pagination: emptyPag, summaryTotals: null } : {}) },
        'User analytics retrieved successfully',
        200
      );
    }

    let pagination = null;
    let pageUsers = perfFilteredUsers;
    if (isPaginated) {
      const total = perfFilteredUsers.length;
      const pages = Math.max(1, Math.ceil(total / limitNum));
      const safePage = Math.min(pageNum, pages);
      const start = (safePage - 1) * limitNum;
      pageUsers = perfFilteredUsers.slice(start, start + limitNum);
      pagination = { page: safePage, limit: limitNum, total, pages };
    }

    if (!pageUsers.length) {
      const emptyPayload = { users: [], ...(pagination ? { pagination, summaryTotals: null } : {}) };
      return successResponse(res, emptyPayload, 'User analytics retrieved successfully', 200);
    }

    const aggregateUserIds = perfFilteredUsers.map((u) => u.id).filter(Boolean);
    const cohortScopeUsers = isPaginated ? pageUsers : perfFilteredUsers;
    const cohortScopeUserIds = cohortScopeUsers.map((u) => u.id).filter(Boolean);

    if (aggregateUserIds.length === 0 || cohortScopeUserIds.length === 0) {
      return successResponse(res, { users: [], ...(pagination ? { pagination, summaryTotals: null } : {}) }, 'No users found', 200);
    }

    const filteredUserIds = aggregateUserIds;

    // Get aggregate counts for all users in one go
    // Note: If filters are applied, we only aggregate for those specific users to improve performance
    if (filteredUserIds.length === 0) {
      return successResponse(res, { users: [], ...(pagination ? { pagination, summaryTotals: null } : {}) }, 'No users found', 200);
    }
    const userIdPlaceholders = filteredUserIds.map(() => '?').join(',');

    const selectedUserIds = cohortScopeUserIds;
    const selectedUserPlaceholders = selectedUserIds.map(() => '?').join(',');

    // OPTIMIZATION: Combine Lead Counts, Status counts and Conversion counts into fewer queries
    // We use conditional aggregation to avoid multiple subquery joins
    // OPTIMIZATION: Use historical logs to get cumulative performance
    const logDateClause = activityDateClause.split('sent_at').join('a.created_at');

    const batch1Results = await Promise.all([
      // 1. Get Full Handled Portfolio (Total Leads Involved in Period)
      pool.execute(
        `SELECT user_id, COUNT(DISTINCT lead_id) as total_handled FROM (
           -- Leads newly assigned within the period
           SELECT a.target_user_id as user_id, a.lead_id
           FROM activity_logs a
           JOIN leads l ON a.lead_id = l.id
           WHERE a.type = 'status_change' AND a.target_user_id IS NOT NULL
             ${logDateClause}
             AND a.target_user_id IN (${userIdPlaceholders})
             ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
           
           UNION
           
           -- Leads where user performed ANY recorded action in period (proves they handled it)
           SELECT a.performed_by as user_id, a.lead_id
           FROM activity_logs a
           JOIN leads l ON a.lead_id = l.id
           WHERE a.type = 'status_change'
             ${logDateClause}
             AND a.performed_by IN (${userIdPlaceholders})
             ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
  
           UNION
  
           -- Leads where user made a call/sms in period
           SELECT c.sent_by as user_id, c.lead_id
           FROM communications c
           JOIN leads l ON c.lead_id = l.id
           WHERE c.sent_by IN (${userIdPlaceholders}) 
             ${activityDateClause}
             ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
         ) as full_portfolio
         GROUP BY user_id`,
        useAcademicYear 
          ? [...activityDateParams, ...filteredUserIds, yearNum, ...activityDateParams, ...filteredUserIds, yearNum, ...activityDateParams, ...filteredUserIds, yearNum]
          : [...activityDateParams, ...filteredUserIds, ...activityDateParams, ...filteredUserIds, ...activityDateParams, ...filteredUserIds]
      ),

      // 2. Get Cumulative Status Actions (every time user moved a lead to a status in period)
      pool.execute(
        `SELECT 
          a.performed_by as user_id,
          a.new_status as lead_status,
          COUNT(DISTINCT a.lead_id) as status_count
         FROM activity_logs a
         JOIN leads l ON a.lead_id = l.id
         WHERE a.type = 'status_change'
           ${logDateClause.replace('a.created_at', 'a.created_at')}
           AND a.performed_by IN (${userIdPlaceholders})
           ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
         GROUP BY a.performed_by, a.new_status`,
        useAcademicYear 
          ? [...activityDateParams, ...filteredUserIds, yearNum]
          : [...activityDateParams, ...filteredUserIds]
      ),

      // 3. Get Cumulative Conversions (leads assigned to user that converted in period)
      pool.execute(
        `SELECT 
          a.target_user_id as user_id,
          COUNT(DISTINCT adm.lead_id) as converted_count
         FROM activity_logs a
         JOIN leads l ON a.lead_id = l.id
         JOIN admissions adm ON adm.lead_id = a.lead_id
         WHERE a.type = 'status_change'
           AND a.target_user_id IS NOT NULL
           ${logDateClause}
           AND a.target_user_id IN (${userIdPlaceholders})
           ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
           AND adm.created_at >= a.created_at
         GROUP BY user_id`,
         useAcademicYear 
          ? [...activityDateParams, ...filteredUserIds, yearNum]
          : [...activityDateParams, ...filteredUserIds]
      ),

      // 4. Current Active Portfolio (subset of ever-assigned leads that are currently active)
      pool.execute(
        `SELECT 
          a.target_user_id as user_id,
          COUNT(DISTINCT a.lead_id) as active_leads
         FROM activity_logs a
         JOIN leads l ON a.lead_id = l.id
         WHERE a.type = 'status_change'
           AND a.target_user_id IS NOT NULL
           ${logDateClause}
           AND a.target_user_id IN (${userIdPlaceholders})
           ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
           AND l.lead_status NOT IN ('Admitted', 'Closed', 'Cancelled', 'Not Interested')
           AND (l.assigned_to = a.target_user_id 
                OR l.assigned_to_pro = a.target_user_id)
         GROUP BY user_id`,
         useAcademicYear 
          ? [...activityDateParams, ...filteredUserIds, yearNum]
          : [...activityDateParams, ...filteredUserIds]
      )
    ]);

    const [
      [portfolioCounts],
      [actionCounts],
      [conversionCounts],
      [activePortfolioCounts],
    ] = batch1Results;

    // Initialize statsByUserId Map with all filtered users
    const statsByUserId = new Map();
    filteredUserIds.forEach(uid => {
      statsByUserId.set(uid, {
        total_assigned: 0,
        active_leads: 0, 
        total_converted: 0,
        statusBreakdown: {}
      });
    });

    // Hydrate from query results
    portfolioCounts.forEach(row => {
      const stats = statsByUserId.get(row.user_id);
      if (stats) stats.total_assigned = row.total_handled;
    });

    actionCounts.forEach(row => {
      const stats = statsByUserId.get(row.user_id);
      if (stats && row.lead_status) {
        stats.statusBreakdown[row.lead_status] = (stats.statusBreakdown[row.lead_status] || 0) + row.status_count;
      }
    });

    conversionCounts.forEach(row => {
      const stats = statsByUserId.get(row.user_id);
      if (stats) stats.total_converted = row.converted_count;
    });

    activePortfolioCounts.forEach(row => {
      const stats = statsByUserId.get(row.user_id);
      if (stats) stats.active_leads = row.active_leads;
    });

    const numAgg = (v) => {
      const n = typeof v === 'bigint' ? Number(v) : Number(v || 0);
      return Number.isFinite(n) ? n : 0;
    };

    /** Sum call_status bucket counts excluding Assigned — same arithmetic as footer row (Interested + … + Other). */
    const sumCounselorCallStatusBucketsExcludingAssigned = (bag) => {
      if (!bag || typeof bag !== 'object') return 0;
      let s = 0;
      Object.entries(bag).forEach(([key, v]) => {
        if (canonicalCounselorCallStatusForReports(key) === 'Assigned') return;
        s += numAgg(v);
      });
      return s;
    };

    /** Cohort = leads with assignment to user in period; Calls/Visits Done = outcome calls only on that cohort (counsellor reporting). */
    const cohortAnalyticUserKey = (id) => String(id ?? '').trim().toLowerCase();
    const allottedDistinctMap = new Map();
    const allottedByCallStatusByUser = new Map();
    const callsAmongAllottedMap = new Map();
    const callsAmongAllottedByCallStatusByUser = new Map();

    const assignmentExistsWhere = assignmentDateWhere.replace(/\bl\./g, 'la.');
    const cohortUserIdPlaceholders = cohortScopeUserIds.map(() => '?').join(',');
    const cohortAssignJoinParams = [...cohortScopeUserIds, ...assignmentDateParams];
    const cohortCommSqlParams = [...cohortScopeUserIds, ...activityDateParams, ...assignmentDateParams];

    const aggregateUserPlaceholders = aggregateUserIds.map(() => '?').join(',');

    /** Comms + activity-log aggregates run together with cohort SQL (previously 3+3 sequential round-trips). */
    const batch2Promise = Promise.all([
      pool.execute(
        `SELECT 
          sent_by as user_id, 
          type, 
          COUNT(*) as count,
          SUM(CASE WHEN type = 'call' THEN duration_seconds ELSE 0 END) as total_duration,
          COUNT(DISTINCT lead_id) as unique_leads
        FROM communications 
        WHERE sent_by IN (${aggregateUserPlaceholders}) ${activityDateClause}
          AND (
            type <> 'call'
            OR (call_outcome IS NOT NULL AND TRIM(call_outcome) <> '')
          )
        GROUP BY sent_by, type`,
        [...aggregateUserIds, ...activityDateParams]
      ),
      pool.execute(
        `SELECT
          c.sent_by as user_id,
          COUNT(DISTINCT c.lead_id) as unique_current_leads_called
        FROM communications c
        INNER JOIN leads l ON l.id = c.lead_id
        WHERE c.type = 'call'
          AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
          AND c.sent_by IN (${selectedUserPlaceholders})
          ${activityDateClause}
          AND (l.assigned_to = c.sent_by OR l.assigned_to_pro = c.sent_by)
          ${useAcademicYear ? 'AND l.academic_year = ?' : ''}
        GROUP BY c.sent_by`,
        useAcademicYear
          ? [...selectedUserIds, ...activityDateParams, yearNum]
          : [...selectedUserIds, ...activityDateParams]
      ),
      pool.execute(
        `SELECT 
          performed_by as user_id, 
          COUNT(*) as total_logs,
          SUM(CASE WHEN type = 'status_change' THEN 1 ELSE 0 END) as status_changes
        FROM activity_logs 
        WHERE performed_by IN (${selectedUserPlaceholders}) ${activityDateClause.split('sent_at').join('created_at')}
        GROUP BY performed_by`,
        [...selectedUserIds, ...activityDateParams]
      ),
    ]);

    const emptyExec = [[], []];
    const cohortPromise =
      cohortScopeUserIds.length === 0
        ? Promise.resolve([emptyExec, emptyExec, emptyExec, emptyExec])
        : Promise.all([
            pool.execute(
              `SELECT a.target_user_id AS user_id, COUNT(DISTINCT a.lead_id) AS cnt
               FROM activity_logs a
               INNER JOIN leads l ON l.id = a.lead_id
               WHERE a.type = 'status_change' AND a.target_user_id IN (${cohortUserIdPlaceholders})
               ${assignmentDateWhere}`,
              cohortAssignJoinParams
            ),
            pool.execute(
              `SELECT a.target_user_id AS user_id,
                CASE WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set' ELSE TRIM(l.call_status) END AS bucket,
                COUNT(DISTINCT a.lead_id) AS cnt
               FROM activity_logs a
               INNER JOIN leads l ON l.id = a.lead_id
               WHERE a.type = 'status_change' AND a.target_user_id IN (${cohortUserIdPlaceholders})
               ${assignmentDateWhere}
               GROUP BY a.target_user_id, CASE WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set' ELSE TRIM(l.call_status) END`,
              cohortAssignJoinParams
            ),
            pool.execute(
              `SELECT c.sent_by AS user_id,
                CASE WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set' ELSE TRIM(l.call_status) END AS bucket,
                COUNT(DISTINCT c.lead_id) AS cnt
               FROM communications c
               INNER JOIN leads l ON l.id = c.lead_id
               WHERE c.sent_by IN (${cohortUserIdPlaceholders})
                 AND c.type = 'call'
                 AND c.call_outcome IS NOT NULL AND TRIM(c.call_outcome) <> ''
                 ${activityDateClause}
                 AND EXISTS (
                   SELECT 1 FROM activity_logs a
                   INNER JOIN leads la ON la.id = a.lead_id
                   WHERE a.type = 'status_change'
                     AND a.target_user_id = c.sent_by
                     AND a.lead_id = c.lead_id
                     ${assignmentExistsWhere}
                 )
               GROUP BY c.sent_by, CASE WHEN l.call_status IS NULL OR TRIM(l.call_status) = '' THEN 'Not set' ELSE TRIM(l.call_status) END`,
              cohortCommSqlParams
            ),
            pool.execute(
              `SELECT agg.user_id, SUM(agg.cnt) AS bucket_sum
               FROM (
                 SELECT
                   a.target_user_id AS user_id,
                   DATE(a.created_at) AS assigned_day,
                   COALESCE(
                     NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetDate'))), ''),
                     IF(l.target_date IS NULL, NULL, DATE_FORMAT(l.target_date, '%Y-%m-%d'))
                   ) AS eff_target,
                   COUNT(DISTINCT a.lead_id) AS cnt
                 FROM activity_logs a
                 INNER JOIN leads l ON l.id = a.lead_id
                 WHERE a.type = 'status_change'
                   AND a.target_user_id IN (${cohortUserIdPlaceholders})
                   ${assignmentDateWhere}
                 GROUP BY a.target_user_id, DATE(a.created_at), eff_target
               ) agg
               GROUP BY agg.user_id`,
              cohortAssignJoinParams
            ),
          ]);

    const [batch2Results, cohortTriple] = await Promise.all([batch2Promise, cohortPromise]);

    const [[commCounts], [currentPortfolioCallCounts], [actLogsCountResult]] = batch2Results;
    const allottedDistinctRows = cohortTriple[0][0];
    const allottedStatusRows = cohortTriple[1][0];
    const cohortOutcomeRows = cohortTriple[2][0];
    const allottedBucketSumRows = cohortTriple[3][0];

    /** Sum of date-wise “Total Allotted” cells (same lead may appear in multiple buckets). */
    const allottedBucketSumMap = new Map();
    allottedBucketSumRows.forEach((row) => {
      allottedBucketSumMap.set(cohortAnalyticUserKey(row.user_id), numAgg(row.bucket_sum));
    });

    allottedDistinctRows.forEach((row) => {
      allottedDistinctMap.set(cohortAnalyticUserKey(row.user_id), numAgg(row.cnt));
    });

    allottedStatusRows.forEach((row) => {
      const uid = cohortAnalyticUserKey(row.user_id);
      const key = canonicalCounselorCallStatusForReports(row.bucket);
      if (!allottedByCallStatusByUser.has(uid)) allottedByCallStatusByUser.set(uid, {});
      const bag = allottedByCallStatusByUser.get(uid);
      bag[key] = (bag[key] || 0) + numAgg(row.cnt);
    });

    cohortOutcomeRows.forEach((row) => {
      const uid = cohortAnalyticUserKey(row.user_id);
      const key = canonicalCounselorCallStatusForReports(row.bucket);
      if (!callsAmongAllottedByCallStatusByUser.has(uid)) callsAmongAllottedByCallStatusByUser.set(uid, {});
      const bag = callsAmongAllottedByCallStatusByUser.get(uid);
      bag[key] = (bag[key] || 0) + numAgg(row.cnt);
    });

    callsAmongAllottedByCallStatusByUser.forEach((bag, uid) => {
      let s = 0;
      Object.values(bag).forEach((v) => {
        s += Number(v) || 0;
      });
      callsAmongAllottedMap.set(uid, s);
    });

    const assignmentByDateMap = new Map();
    const reclaimedUniqueMap = new Map();

    if (shouldIncludeAssignmentDetails) {
      const [
        [rawAssignments],
        [reclamations],
        [validMandalsRows]
      ] = await Promise.all([
        pool.execute(
          `SELECT 
            a.target_user_id as user_id, 
            DATE(a.created_at) as assigned_date, 
            a.lead_id,
            l.lead_status,
            l.call_status,
            l.visit_status,
            l.student_group,
            l.mandal,
            l.target_date,
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetDate'))), '') AS log_assignment_target_date,
            l.cycle_number,
            l.assigned_to,
            l.assigned_to_pro,
            l.needs_manual_update
          FROM activity_logs a
          JOIN leads l ON l.id = a.lead_id
          WHERE a.type = 'status_change' 
            AND a.target_user_id IN (${cohortUserIdPlaceholders})
            ${assignmentDateWhere}`,
          [...cohortScopeUserIds, ...assignmentDateParams]
        ),
        pool.execute(
          `SELECT 
            lead_id, 
            source_user_id as previous_assignee, 
            JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.reclamation.oldStatus')) as old_status_meta,
            old_status,
            created_at
          FROM activity_logs
          WHERE type = 'status_change' AND source_user_id IN (${cohortUserIdPlaceholders})
          ${reclaimLogWhere}
          ORDER BY created_at DESC`,
          [...cohortScopeUserIds, ...reclaimLogParamsSuffix]
        ),
        pool.execute(
          `SELECT DISTINCT LOWER(TRIM(name)) as name FROM mandals WHERE is_active = 1`
        )
      ]);

      const validMandalsSet = new Set(validMandalsRows.map(m => String(m.name || '').trim().toLowerCase()));

      const sliceAssignmentYmd = (v) => {
        if (v == null || v === '') return null;
        const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
        if (!s || s === 'null' || s === 'Invalid Date') return null;
        const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : s.slice(0, 10);
      };

      // Latest reclamation metadata per (lead, user)
      const latestReclaimMap = new Map();
      reclamations.forEach(r => {
        const key = `${r.lead_id}-${r.previous_assignee}`;
        if (!latestReclaimMap.has(key)) latestReclaimMap.set(key, r);
      });

      rawAssignments.forEach(row => {
        const userKey = String(row.user_id).trim().toLowerCase();
        if (!userKey) return;
        
        let perDate = assignmentByDateMap.get(userKey);
        if (!perDate) {
          perDate = new Map();
          assignmentByDateMap.set(userKey, perDate);
        }

        const dateKey = row.assigned_date instanceof Date
          ? row.assigned_date.toISOString().slice(0, 10)
          : String(row.assigned_date || '').slice(0, 10);
        
        if (!dateKey || dateKey === 'null') return;

        // Prefer target date stored on the assignment log (at assign time); else current lead.target_date.
        const effectiveYmd =
          sliceAssignmentYmd(row.log_assignment_target_date) || sliceAssignmentYmd(row.target_date);
        let tDateSegment = '__NULL__';
        if (effectiveYmd) {
          tDateSegment = effectiveYmd;
        }
        // One row per (allotted calendar day, effective target date) — same SQL/fetch; split only in memory.
        const bucketKey = `${dateKey}\t${tDateSegment}`;

        if (!perDate.has(bucketKey)) {
          perDate.set(bucketKey, {
            date: dateKey,
            targetDateSortKey: tDateSegment,
            detailRowKey: bucketKey,
            totalAssigned: 0,
            leadStatusCounts: {},
            statusBeforeReclaimCounts: {}, // For backward compatibility if needed
            currentlyUnassigned: 0,
            currentlyWithSameUser: 0,
            movedToOtherUser: 0,
            reclaimedCount: 0,
            targetDateCounts: {},
            studentGroupCounts: {},
            mandalCounts: {},
            callStatusCounts: {},
            visitStatusCounts: {},
            /** Distinct students (lead_id) — materialized after rawAssignments loop */
            _allLeadIds: new Set(),
            _callStatusLeadSets: {},
            _visitStatusLeadSets: {},
            _leadStatusLeadSets: {},
            _mandalLeadSets: {},
            _studentGroupLeadSets: {},
            _targetDateLeadSets: {},
            _reclaimedLeadIds: new Set(),
            _unassignedLeadIds: new Set(),
            _sameUserLeadIds: new Set(),
            _otherUserLeadIds: new Set(),
          });
        }

        const bucket = perDate.get(bucketKey);
        const lid = String(row.lead_id ?? '');
        if (!lid) return;
        bucket._allLeadIds.add(lid);

        // 1. Current Engagement status (distinct students)
        if (row.assigned_to === null && row.assigned_to_pro === null) {
          bucket._unassignedLeadIds.add(lid);
        } else if (row.assigned_to === row.user_id || row.assigned_to_pro === row.user_id) {
          bucket._sameUserLeadIds.add(lid);
        } else {
          bucket._otherUserLeadIds.add(lid);
        }

        // 2. Lead Status / Reclamation check (distinct students per bucket label)
        const rKey = `${row.lead_id}-${row.user_id}`;
        const reclaimMeta = latestReclaimMap.get(rKey);
        if (reclaimMeta) {
          bucket._reclaimedLeadIds.add(lid);
          const status = (reclaimMeta.old_status_meta || reclaimMeta.old_status || 'Unknown').trim() || 'Unknown';
          if (!bucket._leadStatusLeadSets[status]) bucket._leadStatusLeadSets[status] = new Set();
          bucket._leadStatusLeadSets[status].add(lid);
        } else {
          const status = (row.lead_status || 'Unknown').trim() || 'Unknown';
          if (!bucket._leadStatusLeadSets[status]) bucket._leadStatusLeadSets[status] = new Set();
          bucket._leadStatusLeadSets[status].add(lid);
        }

        const callS =
          row.call_status != null && String(row.call_status).trim() !== ''
            ? String(row.call_status).trim()
            : 'Not set';
        if (!bucket._callStatusLeadSets[callS]) bucket._callStatusLeadSets[callS] = new Set();
        bucket._callStatusLeadSets[callS].add(lid);
        const visitS =
          row.visit_status != null && String(row.visit_status).trim() !== ''
            ? String(row.visit_status).trim()
            : 'Not set';
        if (!bucket._visitStatusLeadSets[visitS]) bucket._visitStatusLeadSets[visitS] = new Set();
        bucket._visitStatusLeadSets[visitS].add(lid);

        // 3. Target Date breakdown (distinct students per target date key)
        if (effectiveYmd) {
          if (!bucket._targetDateLeadSets[effectiveYmd]) bucket._targetDateLeadSets[effectiveYmd] = new Set();
          bucket._targetDateLeadSets[effectiveYmd].add(lid);
        }

        // 4. Student Group breakdown (distinct students per group)
        const sGroup = (row.student_group || 'Unknown').trim() || 'Unknown';
        if (!bucket._studentGroupLeadSets[sGroup]) bucket._studentGroupLeadSets[sGroup] = new Set();
        bucket._studentGroupLeadSets[sGroup].add(lid);

        // 5. Mandal breakdown (distinct students per mandal label)
        let mandal = (row.mandal || 'Unknown').trim() || 'Unknown';
        const mandalLow = mandal.toLowerCase();

        if (mandal === 'Unknown') {
          // Stay as Unknown
        } else if (row.needs_manual_update === 1 || row.needs_manual_update === 2 || !validMandalsSet.has(mandalLow)) {
          mandal = 'Others';
        }
        if (!bucket._mandalLeadSets[mandal]) bucket._mandalLeadSets[mandal] = new Set();
        bucket._mandalLeadSets[mandal].add(lid);
      });

      const setRecordToCounts = (rec) => {
        const out = {};
        if (!rec || typeof rec !== 'object') return out;
        Object.entries(rec).forEach(([k, set]) => {
          if (set && typeof set.size === 'number' && set.size > 0) out[k] = set.size;
        });
        return out;
      };

      assignmentByDateMap.forEach((perDate) => {
        perDate.forEach((bucket) => {
          let assignedBalance = 0;
          const css = bucket._callStatusLeadSets;
          if (css && typeof css === 'object') {
            Object.entries(css).forEach(([k, set]) => {
              if (canonicalCounselorCallStatusForReports(k) === 'Assigned' && set && typeof set.size === 'number') {
                assignedBalance += set.size;
              }
            });
          }
          const nTot = bucket._allLeadIds ? bucket._allLeadIds.size : 0;
          bucket.balanceByPortfolioRule = assignedBalance;
          bucket.totalAssigned = nTot;
          bucket.callStatusCounts = setRecordToCounts(bucket._callStatusLeadSets);
          bucket.visitStatusCounts = setRecordToCounts(bucket._visitStatusLeadSets);
          bucket.leadStatusCounts = setRecordToCounts(bucket._leadStatusLeadSets);
          bucket.mandalCounts = setRecordToCounts(bucket._mandalLeadSets);
          bucket.studentGroupCounts = setRecordToCounts(bucket._studentGroupLeadSets);
          bucket.targetDateCounts = setRecordToCounts(bucket._targetDateLeadSets);
          bucket.reclaimedCount = bucket._reclaimedLeadIds ? bucket._reclaimedLeadIds.size : 0;
          bucket.currentlyUnassigned = bucket._unassignedLeadIds ? bucket._unassignedLeadIds.size : 0;
          bucket.currentlyWithSameUser = bucket._sameUserLeadIds ? bucket._sameUserLeadIds.size : 0;
          bucket.movedToOtherUser = bucket._otherUserLeadIds ? bucket._otherUserLeadIds.size : 0;
          delete bucket._allLeadIds;
          delete bucket._callStatusLeadSets;
          delete bucket._visitStatusLeadSets;
          delete bucket._leadStatusLeadSets;
          delete bucket._mandalLeadSets;
          delete bucket._studentGroupLeadSets;
          delete bucket._targetDateLeadSets;
          delete bucket._reclaimedLeadIds;
          delete bucket._unassignedLeadIds;
          delete bucket._sameUserLeadIds;
          delete bucket._otherUserLeadIds;
        });
      });

      // Populate reclaimedUniqueMap
      assignmentByDateMap.forEach((perDate, userKey) => {
        let totalReclaimed = 0;
        perDate.forEach(d => { if (d.reclaimedCount > 0) totalReclaimed++; }); 
        reclaimedUniqueMap.set(userKey, totalReclaimed);
      });

    }

    // OPTIMIZATION: Use the Map we built earlier during the optimized combined query
    const leadMap = statsByUserId;

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

    const currentPortfolioCallsMap = new Map();
    currentPortfolioCallCounts.forEach((c) => {
      currentPortfolioCallsMap.set(
        c.user_id,
        typeof c.unique_current_leads_called === 'bigint'
          ? Number(c.unique_current_leads_called)
          : Number(c.unique_current_leads_called || 0)
      );
    });

    let summaryTotals = null;
    if (isPaginated) {
      let totalAssignedLeads = 0;
      let totalCallsDone = 0;
      let totalSms = 0;
      for (const u of perfFilteredUsers) {
        const uid = cohortAnalyticUserKey(u.id);
        const stats = statsByUserId.get(u.id) || {
          total_assigned: 0,
          active_leads: 0,
          total_converted: 0,
          statusBreakdown: {},
        };
        const totalAssigned = numAgg(stats.total_assigned);
        const isStudentCounselor = u.role_name === 'Student Counselor';
        const hasBucket = allottedBucketSumMap.has(uid);
        const bucketSum = hasBucket ? numAgg(allottedBucketSumMap.get(uid)) : null;
        const leadPart = isStudentCounselor && hasBucket ? bucketSum : totalAssigned;
        totalAssignedLeads += leadPart;
        const allottedBag = allottedByCallStatusByUser.get(uid);
        const allottedCallsVisitsDoneDisplay = sumCounselorCallStatusBucketsExcludingAssigned(allottedBag);
        const comms = commMap.get(u.id) || { calls: { total: 0, duration: 0, unique: 0 }, sms: 0 };
        const callsDisplay = isStudentCounselor
          ? allottedBag && Object.keys(allottedBag).length > 0
            ? allottedCallsVisitsDoneDisplay
            : numAgg(comms.calls.unique)
          : numAgg(comms.calls.unique);
        totalCallsDone += callsDisplay;
        totalSms += numAgg(comms.sms);
      }
      summaryTotals = {
        userCount: perfFilteredUsers.length,
        totalAssignedLeads,
        totalCallsDone,
        totalSms,
      };
    }

    // Compile analytics for each user (one page when paginated)
    const userAnalytics = pageUsers.map((user) => {
      const stats = statsByUserId.get(user.id) || { total_assigned: 0, active_leads: 0, total_converted: 0, statusBreakdown: {} };
      const comms = commMap.get(user.id) || { calls: { total: 0, duration: 0, unique: 0 }, sms: 0 };
      const logs = logsMap.get(user.id) || { total_logs: 0, status_changes: 0 };
      const callsOnCurrentPortfolio = currentPortfolioCallsMap.get(user.id) || 0;
      const reclaimedUniqueLeads = reclaimedUniqueMap.get(String(user.id || '').trim().toLowerCase()) || 0;

      const totalAssigned = stats.total_assigned;
      const uidForCohort = cohortAnalyticUserKey(user.id);
      const isStudentCounselor = user.role_name === 'Student Counselor';
      const cohortCallsDoneAmongAllotted = numAgg(callsAmongAllottedMap.get(uidForCohort) ?? 0);
      /** Table Calls/Visits Done = allotted-period footer sum without Assigned column (aligned with expanded table). */
      const allottedCallStatusBag = allottedByCallStatusByUser.get(uidForCohort);
      const allottedCallsVisitsDoneDisplay =
        sumCounselorCallStatusBucketsExcludingAssigned(allottedCallStatusBag);
      const counsellorBucketSum = isStudentCounselor ? numAgg(allottedBucketSumMap.get(uidForCohort) ?? 0) : 0;

      return {
        id: user.id,
        userId: user.id,
        userName: user.name,
        name: user.name,
        email: user.email,
        roleName: user.role_name,
        designation: user.designation || null,
        division: user.division || '-',
        department: user.department || '-',
        group: user.group || '-',
        isActive: user.is_active === 1 || user.is_active === true,
        totalAssigned,
        /** Student Counselor: sum of expanded table “Total Allotted” (bucket rows); portfolio “total handled” stays in totalAssigned for other uses. */
        allottedBucketSumTotal: isStudentCounselor ? counsellorBucketSum : undefined,
        activeLeads: stats.active_leads,
        convertedLeads: stats.total_converted,
        interested: stats.statusBreakdown['Interested'] || 0,
        admittedLeads: stats.statusBreakdown['Admitted'] || 0,
        conversionRate: totalAssigned > 0 ? parseFloat(((stats.total_converted / totalAssigned) * 100).toFixed(2)) : 0,
        statusBreakdown: stats.statusBreakdown,
        activityLogsCount: logs.total_logs,
        calls: {
          // Counsellors: sum of allotted-period breakdown by current call_status, excluding Assigned — matches footer row (Interested + … + Other).
          // Distinct outcome-call totals (communications) remain in expanded performanceCohort.callsDoneAmongAllotted / …ByCallStatus when details load.
          // Other roles: distinct leads with any logged outcome call in the activity window (unchanged).
          total: isStudentCounselor ? allottedCallsVisitsDoneDisplay : comms.calls.unique,
          totalDuration: comms.calls.duration,
          averageDuration: comms.calls.total > 0 ? Math.round(comms.calls.duration / comms.calls.total) : 0,
        },
        callsOnCurrentPortfolio,
        pendingBalance: isStudentCounselor
          ? Math.max(0, counsellorBucketSum - allottedCallsVisitsDoneDisplay)
          : Math.max(Number(totalAssigned || 0) - Number(callsOnCurrentPortfolio || 0), 0),
        reclaimedUniqueLeads,
        sms: {
          total: comms.sms,
        },
        statusConversions: {
          total: logs.status_changes,
        },
        expandedAssignmentDiagnostics:
          shouldIncludeAssignmentDetails && isStudentCounselor
            ? {
                performanceCohort: {
                  allottedDistinctLeads: numAgg(allottedDistinctMap.get(uidForCohort) ?? 0),
                  allottedByCallStatus: allottedCallStatusBag || {},
                  callsDoneAmongAllotted: cohortCallsDoneAmongAllotted,
                  callsDoneAmongAllottedByCallStatus:
                    callsAmongAllottedByCallStatusByUser.get(uidForCohort) || {},
                  /** Footer Balance column: same as main-row pendingBalance — bucket-sum allotted − Calls/Visits Done (non‑Assigned status sum). Per-row Balance cells stay Assigned-based. */
                  periodBalanceByPortfolioRule: numAgg(
                    Math.max(0, counsellorBucketSum - allottedCallsVisitsDoneDisplay)
                  ),
                },
              }
            : undefined,
        assignmentsByDate: (() => {
          const perDateMap = assignmentByDateMap.get(String(user.id || '').trim().toLowerCase());
          if (!perDateMap) return [];
          return Array.from(perDateMap.values())
            .sort((a, b) => {
              const byDate = String(b.date).localeCompare(String(a.date));
              if (byDate !== 0) return byDate;
              const aSk = a.targetDateSortKey || '__NULL__';
              const bSk = b.targetDateSortKey || '__NULL__';
              if (aSk === '__NULL__' && bSk !== '__NULL__') return 1;
              if (bSk === '__NULL__' && aSk !== '__NULL__') return -1;
              return String(aSk).localeCompare(String(bSk));
            });
        })(),
      };
    });

    const payload = {
      users: userAnalytics,
      ...(pagination ? { pagination, summaryTotals } : {}),
    };
    if (String(bypassCache || '').toLowerCase() !== 'true') {
      if (!analyticsCache.has(cacheKey)) {
        while (analyticsCache.size >= MAX_USER_ANALYTICS_CACHE_ENTRIES) {
          const firstKey = analyticsCache.keys().next().value;
          if (firstKey === undefined) break;
          analyticsCache.delete(firstKey);
        }
      }
      analyticsCache.set(cacheKey, {
        data: payload,
        expiresAt: Date.now() + USER_ANALYTICS_CACHE_MS,
      });
    }
    return successResponse(res, payload, 'User analytics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    return errorResponse(res, error.message || 'Failed to get user analytics', 500);
  }
};

