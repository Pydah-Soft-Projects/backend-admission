import ExcelJS from 'exceljs';
import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { generateEnquiryNumber } from '../utils/generateEnquiryNumber.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadCreated } from '../services/notification.service.js';
import { buildLeadNameFuzzySql, buildLeadSearchPhoneOrSql } from '../utils/leadNameSearch.util.js';
import {
  resolveLeadStatus,
  isPipelineNewLeadStatus,
  canonicalizeLeadStatus,
} from '../utils/leadChannelStatus.util.js';
import {
  fetchActiveStudentQuotas,
  mergeQuotaOptionLabels,
  quotaNamesFromCatalog,
} from '../utils/studentQuotas.util.js';
import { applyReference1OnCallStatusConfirm, isCallStatusConfirmedValue } from '../utils/joiningReference.util.js';
import { managerCanAccessLead } from '../utils/managerLeadAccess.util.js';

const deleteQueue = new PQueue({
  concurrency: Number(process.env.LEAD_DELETE_CONCURRENCY || 1),
});

// Lightweight in-memory caches to reduce repeated heavy reads on large lead tables.
const queryCache = new Map();
const CACHE_TTL = {
  leadsCountMs: Number(process.env.LEADS_COUNT_CACHE_MS || 15000),
  filterOptionsMs: Number(process.env.LEADS_FILTER_OPTIONS_CACHE_MS || 120000),
  /** Dedicated student-group list: one DISTINCT query; longer TTL than full filter-options bundle. */
  studentGroupFilterMs: Number(process.env.LEADS_STUDENT_GROUP_FILTER_CACHE_MS || 600000),
};

const stableStringify = (value) => {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${k}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const getCached = (key) => {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    queryCache.delete(key);
    return null;
  }
  return entry.value;
};

const setCached = (key, value, ttlMs) => {
  queryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const getCachedCount = async (pool, sql, params, ttlMs, scopeKey) => {
  const key = `count:${scopeKey}:${sql}:${stableStringify(params)}`;
  const cached = getCached(key);
  if (cached !== null) return cached;
  const [rows] = await pool.execute(sql, params);
  const raw = rows?.[0]?.total ?? 0;
  const count = typeof raw === 'bigint' ? Number(raw) : Number(raw || 0);
  setCached(key, count, ttlMs);
  return count;
};

/** One SET slot per column so assignment defaults and body fields do not duplicate (e.g. call_status twice). */
function upsertLeadUpdateColumn(updateFields, updateValues, column, value) {
  const clause = `${column} = ?`;
  const i = updateFields.findIndex((f) => String(f) === clause);
  if (i >= 0) {
    updateValues[i] = value;
  } else {
    updateFields.push(clause);
    updateValues.push(value);
  }
}

const leadSqlDateToYmd = (v) => {
  if (v == null || v === '') return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return undefined;
  return s.length >= 10 ? s.slice(0, 10) : undefined;
};

/** Calendar-day range [start, end) for DATETIME filters — index-friendly vs DATE(column). */
const ymdSubtractDays = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const ymdDayRangeExclusive = (ymd) => {
  const start = `${ymd} 00:00:00`;
  const endYmd = ymdSubtractDays(ymd, -1);
  return [start, `${endYmd} 00:00:00`];
};

/**
 * Common logic to build WHERE conditions for leads across different controllers.
 * Optimized for large datasets (500k+) by using FULLTEXT index for general search
 * and index-friendly prefix matching for phones/enquiries.
 * 
 * @param {object} req Express request object
 * @param {string} alias Table alias for leads table (e.g., 'l')
 * @returns {{ conditions: string[], params: any[] }}
 */
const buildLeadFilterConditions = (req, alias = 'l') => {
  const conditions = [];
  const params = [];
  const p = alias ? `${alias}.` : '';

  const {
    mandal, state, district, village, villageInAddress, quota,
    leadStatus, callStatus, visitStatus, applicationStatus,
    assignedTo, courseInterested, source, startDate, endDate,
    scheduledOn, academicYear, studentGroup, cycleNumber,
    needsUpdate, touchedToday, excludeTouchedToday,
    enquiryNumber, search
  } = req.query;

  // Standard Equality Filters
  if (mandal) { conditions.push(`${p}mandal = ?`); params.push(mandal); }
  if (state) { conditions.push(`${p}state = ?`); params.push(state); }
  if (district) { conditions.push(`${p}district = ?`); params.push(district); }
  
  if (village) {
    const villages = Array.isArray(village) 
      ? village 
      : String(village).split(',').map(v => v.trim()).filter(Boolean);
      
    if (villages.length > 0) {
      if (req.user.roleName === 'PRO' && (villageInAddress === 'true' || villageInAddress === '1')) {
        const villageConditions = [];
        villages.forEach(v => {
          const esc = v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
          // Note: CONCAT_WS is expensive on large tables; this is kept for PRO-specific village-in-address matching
          villageConditions.push(`LOWER(CONCAT_WS(' ', IFNULL(${p}address,''), IFNULL(${p}village,''), IFNULL(${p}mandal,''), IFNULL(${p}district,''), IFNULL(${p}state,''))) LIKE ?`);
          params.push(`%${esc.toLowerCase()}%`);
        });
        conditions.push(`(${villageConditions.join(' OR ')})`);
      } else {
        if (villages.length === 1) {
          conditions.push(`${p}village = ?`);
          params.push(villages[0]);
        } else {
          const placeholders = villages.map(() => '?').join(',');
          conditions.push(`${p}village IN (${placeholders})`);
          params.push(...villages);
        }
      }
    }
  }

  if (quota) { conditions.push(`${p}quota = ?`); params.push(quota); }
  if (leadStatus) {
    conditions.push(`${p}lead_status = ?`);
    params.push(leadStatus);
    // Joining desk: hide Confirmed rows that already completed joining (approved + admission).
    if (String(leadStatus).trim() === 'Confirmed') {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM joinings j_stale
        INNER JOIN admissions a_stale ON a_stale.joining_id = j_stale.id
        WHERE j_stale.lead_id = ${p}id
          AND j_stale.status = 'approved'
          AND TRIM(COALESCE(a_stale.admission_number, '')) <> ''
      )`);
      conditions.push(`NOT EXISTS (
        SELECT 1
        FROM leads l_phone_dup
        INNER JOIN joinings j_phone_dup ON j_phone_dup.lead_id = l_phone_dup.id AND j_phone_dup.status = 'approved'
        INNER JOIN admissions a_phone_dup ON a_phone_dup.joining_id = j_phone_dup.id
        WHERE l_phone_dup.id <> ${p}id
          AND TRIM(COALESCE(${p}phone, '')) <> ''
          AND l_phone_dup.phone = ${p}phone
          AND TRIM(COALESCE(a_phone_dup.admission_number, '')) <> ''
      )`);
    }
  }
  if (callStatus) { conditions.push(`${p}call_status = ?`); params.push(callStatus); }
  if (visitStatus) { conditions.push(`${p}visit_status = ?`); params.push(visitStatus); }
  if (applicationStatus) { conditions.push(`${p}application_status = ?`); params.push(applicationStatus); }
  
  if (assignedTo) {
    conditions.push(`(${p}assigned_to = ? OR ${p}assigned_to_pro = ?)`);
    params.push(assignedTo, assignedTo);
  }
  
  if (courseInterested) { conditions.push(`${p}course_interested = ?`); params.push(courseInterested); }
  if (source) { conditions.push(`${p}source = ?`); params.push(source); }

  // Permissions-based filtering
  const allowedSources = req.user.permissions?.allowedSources;
  if (allowedSources && Array.isArray(allowedSources) && allowedSources.length > 0) {
    const placeholders = allowedSources.map(() => '?').join(',');
    conditions.push(`${p}source IN (${placeholders})`);
    params.push(...allowedSources);
  }

  // Date Filtering
  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    conditions.push(`${p}created_at >= ?`);
    params.push(start.toISOString().slice(0, 19).replace('T', ' '));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    conditions.push(`${p}created_at <= ?`);
    params.push(end.toISOString().slice(0, 19).replace('T', ' '));
  }
  if (scheduledOn) {
    const ymd = String(scheduledOn).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      const [dayStart, dayEnd] = ymdDayRangeExclusive(ymd);
      conditions.push(`${p}next_scheduled_call >= ? AND ${p}next_scheduled_call < ?`);
      params.push(dayStart, dayEnd);
    }
  }

  // Grouping and Cycles
  if (academicYear != null && academicYear !== '') { 
    conditions.push(`${p}academic_year = ?`); 
    params.push(Number(academicYear)); 
  }
  if (studentGroup) { 
    conditions.push(`${p}student_group = ?`); 
    params.push(studentGroup); 
  }
  if (cycleNumber != null && cycleNumber !== '') {
    const cycle = Number(cycleNumber);
    if (!Number.isNaN(cycle)) {
      conditions.push(`${p}cycle_number = ?`);
      params.push(cycle);
    }
  }

  if (needsUpdate === 'true' || needsUpdate === '1') {
    conditions.push(`${p}needs_manual_update IN (1, 2)`);
  }

  // User-specific Touch Logic
  const userId = req.user.id || req.user._id;
  if (touchedToday === 'true' || touchedToday === '1') {
    conditions.push(`EXISTS (
      SELECT 1 FROM activity_logs a
      WHERE a.lead_id = ${p}id AND a.performed_by = ?
      AND DATE(a.created_at) = CURDATE()
      AND a.type IN ('status_change', 'comment')
    )`);
    params.push(userId);
  }

  if (excludeTouchedToday === 'true' || excludeTouchedToday === '1') {
    // Exclude leads that were already processed today (call/sms or log)
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM communications c
      WHERE c.lead_id = ${p}id AND c.sent_by = ? AND DATE(c.sent_at) = CURDATE()
    )`);
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM activity_logs a
      WHERE a.lead_id = ${p}id AND a.performed_by = ? AND DATE(a.created_at) = CURDATE()
    )`);
    params.push(userId, userId);
  }

  // Enquiry Number specific search
  if (enquiryNumber) {
    const t = enquiryNumber.trim();
    if (t.toUpperCase().startsWith('ENQ')) {
      conditions.push(`${p}enquiry_number LIKE ?`);
      params.push(`${t}%`);
    } else {
      conditions.push(`${p}enquiry_number LIKE ?`);
      params.push(`%${t}%`);
    }
  }

  // --- HIGHLY OPTIMIZED SEARCH LOGIC ---
  if (search) {
    const t = search.trim();
    if (t.length >= 2) {
      const isEnq = t.toUpperCase().startsWith('ENQ');
      const isPhone = /^\d{5,}$/.test(t);
      
      if (isEnq) {
        // Direct hit on enquiry number (starts with)
        conditions.push(`${p}enquiry_number LIKE ?`);
        params.push(`${t}%`);
      } else if (isPhone) {
        // Direct index hit on phone columns (starts with) - much faster than fulltext for digits
        conditions.push(`(${p}phone LIKE ? OR ${p}father_phone LIKE ?)`);
        params.push(`${t}%`, `${t}%`);
      } else {
        // USE FULLTEXT INDEX for names and other text fields.
        // Boolean mode with prefix matching (+) ensures high speed on 500k+ rows.
        // Clean the search term by removing boolean operators that could cause SQL syntax errors
        const cleanT = t.replace(/[+\-<>\~*\"()@]/g, ' ').trim();
        if (cleanT.length > 0) {
          const booleanSearchStr = cleanT.split(/\s+/).map(word => `+${word}*`).join(' ');
          // Columns must match exactly those defined in the FULLTEXT index:
          // enquiry_number, name, phone, email, father_name, mother_name, course_interested, district, mandal, state, application_status, hall_ticket_number, inter_college
          conditions.push(`MATCH(${p}enquiry_number, ${p}name, ${p}phone, ${p}email, ${p}father_name, ${p}mother_name, ${p}course_interested, ${p}district, ${p}mandal, ${p}state, ${p}application_status, ${p}hall_ticket_number, ${p}inter_college) AGAINST(? IN BOOLEAN MODE)`);
          params.push(booleanSearchStr);
        }
      }
    }
  }

  // Access control
  if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
    if (req.user.roleName === 'PRO') {
      conditions.push(`(${p}assigned_to_pro = ? OR ${p}assigned_to = ?)`);
      params.push(userId, userId);
    } else {
      conditions.push(`${p}assigned_to = ?`);
      params.push(userId);
    }
  }

  return { conditions, params };
};

// Helper function to format lead data from SQL to camelCase
const formatLead = (leadData, assignedToUser = null, uploadedByUser = null, assignedToProUser = null, viewerOptions = {}) => {
  if (!leadData) return null;
  const viewerRole = viewerOptions.viewerRoleName;
  const callStatus = leadData.call_status ?? null;
  const visitStatus = leadData.visit_status ?? null;
  const counsellorTargetYmd = leadSqlDateToYmd(leadData.counsellor_target_date);
  const proTargetYmd = leadSqlDateToYmd(leadData.pro_target_date);
  const legacyTargetYmd = leadSqlDateToYmd(leadData.target_date);
  const primaryTargetYmd = legacyTargetYmd ?? counsellorTargetYmd ?? proTargetYmd;
  return {
    id: leadData.id,
    _id: leadData.id, // Keep _id for backward compatibility
    enquiryNumber: leadData.enquiry_number,
    name: leadData.name,
    phone: leadData.phone,
    email: leadData.email,
    fatherName: leadData.father_name,
    motherName: leadData.mother_name || '',
    fatherPhone: leadData.father_phone,
    motherPhone: leadData.mother_phone || '',
    hallTicketNumber: leadData.hall_ticket_number || '',
    village: leadData.village,
    address: leadData.address || '',
    courseInterested: leadData.course_interested,
    district: leadData.district,
    mandal: leadData.mandal,
    state: leadData.state || '',
    isNRI: leadData.is_nri === 1 || leadData.is_nri === true,
    gender: leadData.gender || 'Not Specified',
    rank: leadData.rank,
    interCollege: leadData.inter_college || '',
    alternateMobile: leadData.alternate_mobile || '',
    quota: leadData.quota || 'Not Applicable',
    applicationStatus: leadData.application_status || 'Not Provided',
    dynamicFields: typeof leadData.dynamic_fields === 'string'
      ? JSON.parse(leadData.dynamic_fields)
      : leadData.dynamic_fields || {},
    leadStatus: canonicalizeLeadStatus(leadData.lead_status || 'New'),
    ...(viewerRole !== 'PRO' ? { callStatus } : {}),
    ...(viewerRole !== 'Student Counselor' ? { visitStatus } : {}),
    admissionNumber: leadData.admission_number,
    assignedTo: assignedToUser || leadData.assigned_to,
    assignedAt: leadData.assigned_at,
    assignedBy: leadData.assigned_by,
    assignedToPro: assignedToProUser || leadData.assigned_to_pro,
    proAssignedAt: leadData.pro_assigned_at,
    proAssignedBy: leadData.pro_assigned_by,
    source: leadData.source,
    utmSource: leadData.utm_source,
    utmMedium: leadData.utm_medium,
    utmCampaign: leadData.utm_campaign,
    utmTerm: leadData.utm_term,
    utmContent: leadData.utm_content,
    lastFollowUp: leadData.last_follow_up,
    nextScheduledCall: leadData.next_scheduled_call,
    cycle_number: leadData.cycle_number != null ? Number(leadData.cycle_number) : undefined,
    cycleNumber: leadData.cycle_number != null ? Number(leadData.cycle_number) : undefined,
    counsellor_target_date: counsellorTargetYmd,
    counsellorTargetDate: counsellorTargetYmd,
    pro_target_date: proTargetYmd,
    proTargetDate: proTargetYmd,
    target_date: primaryTargetYmd,
    targetDate: primaryTargetYmd,
    academicYear: leadData.academic_year != null ? leadData.academic_year : undefined,
    studentGroup: leadData.student_group || undefined,
    needsManualUpdate: leadData.needs_manual_update != null ? Number(leadData.needs_manual_update) : 0,
    notes: leadData.notes,
    uploadedBy: uploadedByUser || leadData.uploaded_by,
    uploadBatchId: leadData.upload_batch_id,
    createdAt: leadData.created_at,
    updatedAt: leadData.updated_at,
  };
};

// Helper function to format user data (for populated fields)
const formatUser = (userData) => {
  if (!userData) return null;
  return {
    id: userData.id,
    _id: userData.id,
    name: userData.name,
    email: userData.email,
  };
};

const buildAssignedCounsellorFromSqlRow = (row) => {
  if (!row?.assigned_to_id) return null;
  const roleName = row.assigned_to_role_name || undefined;
  const designation = row.assigned_to_designation || undefined;
  return {
    id: row.assigned_to_id,
    _id: row.assigned_to_id,
    name: row.assigned_to_name,
    email: row.assigned_to_email,
    roleName,
    designation,
    /** Confirmed-leads table legacy field — show role when department is absent. */
    department: roleName || designation || undefined,
  };
};

const buildAssignedProFromSqlRow = (row) => {
  if (!row?.assigned_to_pro_id) return null;
  const roleName = row.assigned_to_pro_role_name || undefined;
  const designation = row.assigned_to_pro_designation || undefined;
  return {
    id: row.assigned_to_pro_id,
    _id: row.assigned_to_pro_id,
    name: row.assigned_to_pro_name,
    email: row.assigned_to_pro_email,
    roleName,
    designation,
    department: roleName || designation || undefined,
  };
};

const ASSIGNED_USER_SQL_SELECT = `
        u1.id as assigned_to_id, u1.name as assigned_to_name, u1.email as assigned_to_email,
        u1.role_name as assigned_to_role_name, u1.designation as assigned_to_designation,
        u2.id as uploaded_by_id, u2.name as uploaded_by_name,
        u3.id as assigned_to_pro_id, u3.name as assigned_to_pro_name, u3.email as assigned_to_pro_email,
        u3.role_name as assigned_to_pro_role_name, u3.designation as assigned_to_pro_designation`;

/** Raw row from leads + user joins (same shape as getLeads main SELECT). */
function buildFormattedLeadFromSqlRow(lead, req, autoRescheduledFromYesterday) {
  const assignedToUser = buildAssignedCounsellorFromSqlRow(lead);
  const uploadedByUser = lead.uploaded_by_id ? {
    id: lead.uploaded_by_id,
    _id: lead.uploaded_by_id,
    name: lead.uploaded_by_name,
  } : null;
  const assignedToProUser = buildAssignedProFromSqlRow(lead);

  const formattedLead = formatLead(lead, assignedToUser, uploadedByUser, assignedToProUser, {
    viewerRoleName: req.user.roleName,
  });
  if (autoRescheduledFromYesterday.has(lead.id)) {
    formattedLead.isYesterdayMissedCall = true;
    formattedLead.missedScheduledDate = autoRescheduledFromYesterday.get(lead.id);
  }
  return formattedLead;
}

// @desc    Get all leads with pagination
// @route   GET /api/leads
// @access  Private
export const getLeads = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const autoRescheduledFromYesterday = new Map();

    /**
     * Auto-rollover missed scheduled calls (runs when `scheduledOn` is set — dashboards pass the viewer's local YYYY-MM-DD):
     * If next_scheduled_call was on the calendar day *before* `scheduledOn` and there is no outgoing `call` communication
     * on that same scheduled calendar day, bump next_scheduled_call by +1 day so the lead appears under `scheduledOn`.
     * Anchors to the query param (not server local date) so browser "today" and rollover stay aligned when API runs in UTC.
     */
    if (req.query.scheduledOn) {
      const requestedYmd = String(req.query.scheduledOn).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(requestedYmd)) {
        const prevYmd = ymdSubtractDays(requestedYmd, 1);
        const [prevDayStart, prevDayEnd] = ymdDayRangeExclusive(prevYmd);
        const [missedRows] = await pool.execute(
          `SELECT l.id, l.next_scheduled_call
           FROM leads l
           WHERE l.next_scheduled_call IS NOT NULL
             AND l.next_scheduled_call >= ? AND l.next_scheduled_call < ?
             AND NOT EXISTS (
               SELECT 1
               FROM communications c
               WHERE c.lead_id = l.id
                 AND c.type = 'call'
                 AND c.sent_at >= ? AND c.sent_at < ?
             )`,
          [prevDayStart, prevDayEnd, prevDayStart, prevDayEnd]
        );

        if (missedRows.length > 0) {
          for (const row of missedRows) {
            autoRescheduledFromYesterday.set(row.id, String(row.next_scheduled_call).slice(0, 10));
          }
          const idPlaceholders = missedRows.map(() => '?').join(',');
          const ids = missedRows.map((r) => r.id);
          await pool.execute(
            `UPDATE leads
             SET next_scheduled_call = DATE_ADD(next_scheduled_call, INTERVAL 1 DAY),
                 updated_at = NOW()
             WHERE id IN (${idPlaceholders})`,
            ids
          );
        }
      }
    }

    // Build WHERE conditions using optimized helper
    const { conditions, params } = buildLeadFilterConditions(req, 'l');

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for pagination (cached briefly to avoid repetitive scans)
    const total = await getCachedCount(
      pool,
      `SELECT COUNT(*) as total FROM leads l ${whereClause}`,
      params,
      CACHE_TTL.leadsCountMs,
      'leads-total'
    );

    // Get count of leads needing manual update (cached briefly, same filter scope)
    const needsUpdateConditions = [...conditions, 'l.needs_manual_update IN (1, 2)'];
    const needsUpdateWhereClause = `WHERE ${needsUpdateConditions.join(' AND ')}`;
    const needsUpdateCount = await getCachedCount(
      pool,
      `SELECT COUNT(*) as total FROM leads l ${needsUpdateWhereClause}`,
      params,
      CACHE_TTL.leadsCountMs,
      'leads-needs-update'
    );

    // Get leads with pagination and user info.
    // Optimization: Selective column selection and paginating IDs first to avoid heavy memory usage.
    const query = `
      SELECT 
        l.id, l.enquiry_number, l.name, l.phone, l.email, l.father_name, l.father_phone, 
        l.village, l.district, l.mandal, l.state, l.is_nri, l.gender, l.rank, l.inter_college, 
        l.alternate_mobile, l.quota, l.application_status, l.lead_status, l.call_status, 
        l.visit_status, l.academic_year, l.student_group, l.admission_number, l.assigned_at, 
        l.source, l.last_follow_up, l.next_scheduled_call, l.created_at, l.updated_at,
        l.cycle_number, l.counsellor_target_date, l.pro_target_date, l.target_date, l.needs_manual_update,
        ${ASSIGNED_USER_SQL_SELECT}
      FROM (
        SELECT l.id
        FROM leads l
        ${whereClause}
        ORDER BY l.created_at DESC, l.id ASC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      ) page_ids
      INNER JOIN leads l ON l.id = page_ids.id
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      LEFT JOIN users u3 ON l.assigned_to_pro = u3.id
      ORDER BY l.created_at DESC, l.id ASC
    `;

    const [leads] = await pool.execute(query, params);

    // Format leads
    let formattedLeads = leads.map((lead) => buildFormattedLeadFromSqlRow(lead, req, autoRescheduledFromYesterday));

    /**
     * After the first dashboard hit, missed calls are already bumped to `scheduledOn`, so
     * `isYesterdayMissedCall` would never be set from `autoRescheduledFromYesterday` alone.
     * Re-apply the same "likely rolled" heuristic as count-missed-call-auto-reschedule.js (--mode=likely)
     * so "Yesterday Missed" stays populated (heuristic may include same-day edits unrelated to rollover).
     */
    if (req.query.scheduledOn) {
      const requestedYmd = String(req.query.scheduledOn).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(requestedYmd)) {
        const rolledExtra = [
          'DATE(l.updated_at) = ?',
          `NOT EXISTS (
            SELECT 1 FROM communications c
            WHERE c.lead_id = l.id AND c.type = 'call'
              AND DATE(c.sent_at) = DATE_SUB(DATE(l.next_scheduled_call), INTERVAL 1 DAY)
          )`,
        ];
        const rolledWhereClause =
          conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')} AND ${rolledExtra.join(' AND ')}`
            : `WHERE ${rolledExtra.join(' AND ')}`;
        const rolledParams = [...params, requestedYmd];
        const rolledQuery = `
          SELECT
            l.id, l.enquiry_number, l.name, l.phone, l.email, l.father_name, l.father_phone, 
            l.village, l.district, l.mandal, l.state, l.is_nri, l.gender, l.rank, l.inter_college, 
            l.alternate_mobile, l.quota, l.application_status, l.lead_status, l.call_status, 
            l.visit_status, l.academic_year, l.student_group, l.admission_number, l.assigned_at, 
            l.source, l.last_follow_up, l.next_scheduled_call, l.created_at, l.updated_at,
            l.cycle_number, l.counsellor_target_date, l.pro_target_date, l.target_date, l.needs_manual_update,
            DATE_FORMAT(DATE_SUB(DATE(l.next_scheduled_call), INTERVAL 1 DAY), '%Y-%m-%d') AS missed_schedule_prev_day,
            ${ASSIGNED_USER_SQL_SELECT}
          FROM leads l
          LEFT JOIN users u1 ON l.assigned_to = u1.id
          LEFT JOIN users u2 ON l.uploaded_by = u2.id
          LEFT JOIN users u3 ON l.assigned_to_pro = u3.id
          ${rolledWhereClause}
          ORDER BY l.updated_at DESC
          LIMIT 500
        `;
        const [rolledRows] = await pool.execute(rolledQuery, rolledParams);
        const rolledFormatted = rolledRows.map((lead) => {
          const fl = buildFormattedLeadFromSqlRow(lead, req, autoRescheduledFromYesterday);
          if (!autoRescheduledFromYesterday.has(lead.id)) {
            fl.isYesterdayMissedCall = true;
            fl.missedScheduledDate = lead.missed_schedule_prev_day || null;
          }
          return fl;
        });
        const rolledById = new Map(rolledFormatted.map((r) => [String(r._id || r.id), r]));
        const mainIds = new Set(formattedLeads.map((f) => String(f._id || f.id)));
        formattedLeads = formattedLeads.map((fl) => {
          const id = String(fl._id || fl.id);
          const rolled = rolledById.get(id);
          if (rolled && !autoRescheduledFromYesterday.has(id)) {
            return {
              ...fl,
              isYesterdayMissedCall: true,
              missedScheduledDate: rolled.missedScheduledDate ?? fl.missedScheduledDate,
            };
          }
          return fl;
        });
        for (const rf of rolledFormatted) {
          const id = String(rf._id || rf.id);
          if (!mainIds.has(id)) formattedLeads.push(rf);
        }
      }
    }

    return successResponse(res, {
      leads: formattedLeads,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      needsUpdateCount,
    }, 'Leads retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting leads:', error);
    return errorResponse(res, error.message || 'Failed to get leads', 500);
  }
};

// @desc    Get single lead
// @route   GET /api/leads/:id
// @access  Private
export const getLead = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Get lead with user info
    const [leads] = await pool.execute(
      `SELECT 
        l.*,
        ${ASSIGNED_USER_SQL_SELECT}
      FROM leads l
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      LEFT JOIN users u3 ON l.assigned_to_pro = u3.id
      WHERE l.id = ?`,
      [req.params.id]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const leadData = leads[0];

    // Check if user has access
    let hasAccess = false;

    // Admin, PRO, Super Admin always have access
    const isAdmin = req.user.roleName === 'Admin';
    const isPro = req.user.roleName === 'PRO';

    if (hasElevatedAdminPrivileges(req.user.roleName) || isAdmin || isPro) {
      hasAccess = true;
    }
    // If lead is assigned to the user, they have access
    else if (leadData.assigned_to === userId || leadData.assigned_to_pro === userId) {
      hasAccess = true;
    }
    else if (req.user.isManager) {
      hasAccess = await managerCanAccessLead(pool, userId, leadData);
    }

    if (!hasAccess) {
      return errorResponse(res, 'Access denied', 403);
    }

    const assignedToUser = buildAssignedCounsellorFromSqlRow(leadData);
    const uploadedByUser = leadData.uploaded_by_id ? {
      id: leadData.uploaded_by_id,
      _id: leadData.uploaded_by_id,
      name: leadData.uploaded_by_name,
    } : null;
    const assignedToProUser = buildAssignedProFromSqlRow(leadData);

    const lead = formatLead(leadData, assignedToUser, uploadedByUser, assignedToProUser, {
      viewerRoleName: req.user.roleName,
    });

    return successResponse(res, lead, 'Lead retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting lead:', error);
    return errorResponse(res, error.message || 'Failed to get lead', 500);
  }
};

// @desc    Create single lead (public - for form submissions)
// @route   POST /api/leads/public
// @access  Public
export const createPublicLead = async (req, res) => {
  try {
    const {
      hallTicketNumber,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName,
      village,
      district,
      courseInterested,
      mandal,
      state,
      quota,
      applicationStatus,
      gender,
      rank,
      interCollege,
      dynamicFields,
      source,
      address,
      isNRI,
      // UTM Parameters (can come from body or query params)
      utm_source,
      utmSource,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
    } = req.body;

    // Also check query parameters for UTM (in case they're passed via URL)
    const finalUtmSource = utmSource || utm_source || req.query.utm_source;
    const utmMedium = req.body.utmMedium || utm_medium || req.query.utm_medium;
    const utmCampaign = req.body.utmCampaign || utm_campaign || req.query.utm_campaign;
    const utmTerm = req.body.utmTerm || utm_term || req.query.utm_term;
    const utmContent = req.body.utmContent || utm_content || req.query.utm_content;

    // Helper function to extract value from dynamicFields if direct field is missing
    const getFieldValue = (directValue, fieldVariations, dynamicFieldsObj) => {
      if (directValue && String(directValue).trim()) {
        return String(directValue).trim();
      }

      if (dynamicFieldsObj && typeof dynamicFieldsObj === 'object') {
        for (const variation of fieldVariations) {
          const key = Object.keys(dynamicFieldsObj).find(
            k => k.toLowerCase() === variation.toLowerCase()
          );
          if (key && dynamicFieldsObj[key] && String(dynamicFieldsObj[key]).trim()) {
            return String(dynamicFieldsObj[key]).trim();
          }
        }
      }

      return null;
    };

    // Extract required fields from direct values or dynamicFields
    const finalName = getFieldValue(name, ['name', 'fullname', 'full_name', 'studentname', 'student_name'], dynamicFields);
    const finalPhone = getFieldValue(phone, ['phone', 'phonenumber', 'phone_number', 'student_phone', 'studentphone', 'mobile', 'mobilenumber', 'mobile_number', 'contactnumber', 'contact_number', 'primaryphone', 'primary_phone'], dynamicFields);
    const finalFatherName = getFieldValue(fatherName, ['fathername', 'father_name', 'fathersname', 'fathers_name'], dynamicFields) || 'Not Provided';
    const finalFatherPhone = getFieldValue(fatherPhone, ['fatherphone', 'father_phone', 'fathersphone', 'fathers_phone', 'fatherphonenumber', 'father_phone_number'], dynamicFields) || 'Not Provided';
    const finalVillage = getFieldValue(village, ['village', 'city', 'town', 'address_village_city', 'address_village'], dynamicFields) || 'Not Provided';
    const finalAddress = getFieldValue(address, ['address', 'full_address', 'residence_address'], dynamicFields) || '';
    const finalDistrict = getFieldValue(district, ['district'], dynamicFields) || 'Not Provided';
    const finalMandal = getFieldValue(mandal, ['mandal', 'tehsil'], dynamicFields) || 'Not Provided';

    // Validate only name and phone as truly required
    if (!finalName || !finalPhone) {
      const missingFields = [];
      if (!finalName) missingFields.push('name');
      if (!finalPhone) missingFields.push('phone');

      return errorResponse(
        res,
        `Please provide required fields: ${missingFields.join(', ')}. Make sure your form includes a student name field and a primary phone number field.`,
        400
      );
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();
 
    // If UTM source exists, use it as the lead source
    const leadSource = finalUtmSource ? String(finalUtmSource).trim() : (source || 'Public Form');

    const pool = getPool();
    const leadId = uuidv4();

    // Insert lead
    await pool.execute(
      `INSERT INTO leads (
        id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
        hall_ticket_number, village, address, course_interested, district, mandal, state,
        is_nri, gender, \`rank\`, inter_college, quota, application_status,
        dynamic_fields, lead_status, source, utm_source, utm_medium, utm_campaign,
        utm_term, utm_content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        leadId,
        enquiryNumber,
        finalName,
        finalPhone,
        email || getFieldValue(email, ['email', 'emailaddress', 'email_address'], dynamicFields) || null,
        finalFatherName,
        motherName ? String(motherName).trim() : (getFieldValue(motherName, ['mothername', 'mother_name', 'mothersname', 'mothers_name'], dynamicFields) || ''),
        finalFatherPhone,
        hallTicketNumber ? String(hallTicketNumber).trim() : (getFieldValue(hallTicketNumber, ['hallticketnumber', 'hall_ticket_number', 'ticketnumber', 'ticket_number'], dynamicFields) || ''),
        finalVillage,
        finalAddress,
        courseInterested || getFieldValue(courseInterested, ['courseinterested', 'course_interested', 'course', 'coursename', 'course_name'], dynamicFields) || null,
        finalDistrict,
        finalMandal,
        state?.trim() || getFieldValue(state, ['state'], dynamicFields) || 'Andhra Pradesh',
        (() => {
          if (isNRI === true || isNRI === 'true') return true;
          const nriValue = getFieldValue(isNRI, ['isnri', 'is_nri', 'nri'], dynamicFields);
          return nriValue === true || nriValue === 'true';
        })(),
        gender ? String(gender).trim() : (getFieldValue(gender, ['gender'], dynamicFields) || 'Not Specified'),
        rank !== undefined && rank !== null && !Number.isNaN(Number(rank)) ? Number(rank) : (() => {
          const rankValue = getFieldValue(rank, ['rank'], dynamicFields);
          return rankValue && !Number.isNaN(Number(rankValue)) ? Number(rankValue) : null;
        })(),
        interCollege ? String(interCollege).trim() : (getFieldValue(interCollege, ['intercollege', 'inter_college', 'college', 'collegename', 'college_name'], dynamicFields) || ''),
        quota || 'Not Applicable',
        applicationStatus || 'Not Provided',
        JSON.stringify(dynamicFields || {}),
        'New',
        leadSource,
        finalUtmSource ? String(finalUtmSource).trim() : null,
        utmMedium ? String(utmMedium).trim() : null,
        utmCampaign ? String(utmCampaign).trim() : null,
        utmTerm ? String(utmTerm).trim() : null,
        utmContent ? String(utmContent).trim() : null,
      ]
    );

    // Fetch created lead
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );

    const lead = formatLead(leads[0]);

    // Send notification to lead (async, don't wait for it)
    notifyLeadCreated(lead).catch((error) => {
      console.error('[Lead] Error sending notification to lead:', error);
    });

    return successResponse(res, lead, 'Lead submitted successfully', 201);
  } catch (error) {
    console.error('Error creating public lead:', error);
    return errorResponse(res, error.message || 'Failed to submit lead', 500);
  }
};

// @desc    Create single lead
// @route   POST /api/leads
// @access  Private
export const createLead = async (req, res) => {
  try {
    const {
      hallTicketNumber,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName,
      village,
      district,
      courseInterested,
      mandal,
      state,
      quota,
      applicationStatus,
      gender,
      rank,
      interCollege,
      dynamicFields,
      source,
      address, // Added address to destructuring
      studentGroup,
    } = req.body;

    // Helper function to extract a value from direct fields or dynamicFields
    const getFieldValue = (directValue, fieldVariations, dynamicFieldsObj) => {
      if (directValue && String(directValue).trim()) {
        return String(directValue).trim();
      }

      if (dynamicFieldsObj && typeof dynamicFieldsObj === 'object') {
        for (const variation of fieldVariations) {
          const key = Object.keys(dynamicFieldsObj).find(
            (k) => k.toLowerCase() === variation.toLowerCase()
          );
          if (key && dynamicFieldsObj[key] && String(dynamicFieldsObj[key]).trim()) {
            return String(dynamicFieldsObj[key]).trim();
          }
        }
      }

      return null;
    };

    // Resolve key fields from either direct body values or dynamicFields
    const finalName = getFieldValue(
      name,
      ['name', 'fullname', 'full_name', 'studentname', 'student_name'],
      dynamicFields
    );
    const finalPhone = getFieldValue(
      phone,
      [
        'phone',
        'phonenumber',
        'phone_number',
        'student_phone',
        'studentphone',
        'mobile',
        'mobilenumber',
        'mobile_number',
        'contactnumber',
        'contact_number',
        'primaryphone',
        'primary_phone',
      ],
      dynamicFields
    );

    const finalFatherName =
      getFieldValue(
        fatherName,
        ['fathername', 'father_name', 'fathersname', 'fathers_name'],
        dynamicFields
      ) || 'Not Provided';
    const finalFatherPhone =
      getFieldValue(
        fatherPhone,
        [
          'fatherphone',
          'father_phone',
          'fathersphone',
          'fathers_phone',
          'fatherphonenumber',
          'father_phone_number',
        ],
        dynamicFields
      ) || 'Not Provided';
    const finalVillage =
      getFieldValue(village, ['village', 'city', 'town', 'address_village_city', 'address_village'], dynamicFields) || 'Not Provided';
    const finalAddress = getFieldValue(address, ['address', 'full_address', 'residence_address'], dynamicFields) || '';
    const finalDistrict =
      getFieldValue(district, ['district'], dynamicFields) || 'Not Provided';
    const finalMandal =
      getFieldValue(mandal, ['mandal', 'tehsil'], dynamicFields) || 'Not Provided';
    const finalStudentGroup =
      getFieldValue(
        studentGroup,
        ['student_group', 'studentgroup', 'student group'],
        dynamicFields
      ) || null;

    // Internal lead creation requires name, phone and student group.
    if (!finalName || !finalPhone || !finalStudentGroup) {
      const missing = [];
      if (!finalName) missing.push('name');
      if (!finalPhone) missing.push('phone');
      if (!finalStudentGroup) missing.push('studentGroup');
      return errorResponse(res, `Please provide ${missing.join(', ')}`, 400);
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();

    const pool = getPool();
    const leadId = uuidv4();
    const userId = req.user.id || req.user._id;
    const isPro = req.user.roleName === 'PRO';
    const isStudentCounselor = req.user.roleName === 'Student Counselor';

    // Auto-assignment logic: if a PRO creates the lead, assign it to them.
    // If a Student Counselor creates it, assign it to them as well.
    const assignedTo = isStudentCounselor ? userId : null;
    const assignedAt = isStudentCounselor ? new Date() : null;
    const assignedBy = isStudentCounselor ? userId : null;

    const assignedToPro = isPro ? userId : null;
    const proAssignedAt = isPro ? new Date() : null;
    const proAssignedBy = isPro ? userId : null;

    // Resolved lead status: if assigned to anyone, it becomes "Assigned"
    const finalLeadStatus = (assignedTo || assignedToPro) ? 'Assigned' : 'New';

    // Insert lead
    await pool.execute(
      `INSERT INTO leads (
        id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
        hall_ticket_number, village, address, course_interested, district, mandal, state,
        gender, \`rank\`, inter_college, quota, application_status,
        dynamic_fields, lead_status, source, student_group, uploaded_by, 
        assigned_to, assigned_at, assigned_by,
        assigned_to_pro, pro_assigned_at, pro_assigned_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        leadId,
        enquiryNumber,
        finalName,
        finalPhone,
        email || null,
        finalFatherName,
        motherName ? String(motherName).trim() : '',
        finalFatherPhone,
        hallTicketNumber ? String(hallTicketNumber).trim() : '',
        finalVillage,
        finalAddress,
        courseInterested || null,
        finalDistrict,
        finalMandal,
        state?.trim() || 'Andhra Pradesh',
        gender ? String(gender).trim() : 'Not Specified',
        rank !== undefined && rank !== null && !Number.isNaN(Number(rank)) ? Number(rank) : null,
        interCollege ? String(interCollege).trim() : '',
        quota || 'Not Applicable',
        applicationStatus || 'Not Provided',
        JSON.stringify(dynamicFields || {}),
        finalLeadStatus,
        source || 'Manual Entry',
        finalStudentGroup,
        userId,
        assignedTo,
        assignedAt,
        assignedBy,
        assignedToPro,
        proAssignedAt,
        proAssignedBy,
      ]
    );

    // Fetch created lead
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );

    const lead = formatLead(leads[0]);

    // Send notification to lead (async, don't wait for it)
    notifyLeadCreated(lead).catch((error) => {
      console.error('[Lead] Error sending notification to lead:', error);
    });

    return successResponse(res, lead, 'Lead created successfully', 201);
  } catch (error) {
    console.error('Error creating lead:', error);
    return errorResponse(res, error.message || 'Failed to create lead', 500);
  }
};

// @desc    Update lead
// @route   PUT /api/leads/:id
// @access  Private
export const updateLead = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Get current lead
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [req.params.id]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const currentLead = leads[0];

    // Check if user has access
    const isSuperAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    const isAdmin = req.user.roleName === 'Admin';
    const isPro = req.user.roleName === 'PRO';
    const isStudentCounselor = req.user.roleName === 'Student Counselor';
    const isAssigned = currentLead.assigned_to === userId || currentLead.assigned_to_pro === userId;
    const managerHasLeadAccess =
      req.user.isManager === true && (await managerCanAccessLead(pool, userId, currentLead));

    if (!isSuperAdmin && !isAdmin && !isPro && !isAssigned && !managerHasLeadAccess) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Regular users can only update allowed scoped fields; Super Admin can update everything.
    // Assigned counselor/PRO can update limited profile fields from user edit flow.
    const isAssignedCounsellorOnly = !isSuperAdmin && isStudentCounselor && currentLead.assigned_to === userId;
    const isAssignedProOnly = !isSuperAdmin && isPro && currentLead.assigned_to_pro === userId;

    // Store original values for comparison
    const originalLead = {
      name: currentLead.name,
      phone: currentLead.phone,
      email: currentLead.email,
      fatherName: currentLead.father_name,
      fatherPhone: currentLead.father_phone,
      motherName: currentLead.mother_name,
      courseInterested: currentLead.course_interested,
      village: currentLead.village,
      address: currentLead.address,
      district: currentLead.district,
      mandal: currentLead.mandal,
      state: currentLead.state,
      quota: currentLead.quota,
      gender: currentLead.gender,
      rank: currentLead.rank,
      interCollege: currentLead.inter_college,
      alternateMobile: currentLead.alternate_mobile,
      hallTicketNumber: currentLead.hall_ticket_number,
      applicationStatus: currentLead.application_status,
    };

    // Update fields
    const {
      hallTicketNumber,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName,
      village,
      district,
      courseInterested,
      mandal,
      state,
      gender,
      rank,
      interCollege,
      quota,
      dynamicFields,
      applicationStatus,
      leadStatus,
      status: legacyStatus,
      callStatus,
      visitStatus,
      assignedTo,
      source,
      notes,
      lastFollowUp,
      nextScheduledCall,
      academicYear,
      studentGroup,
      address,
      alternateMobile,
    } = req.body;

    const newLeadStatus = leadStatus ?? legacyStatus;
    const updateFields = [];
    const updateValues = [];
    let oldStatus = currentLead.lead_status || 'New';
    let oldAssignedTo = currentLead.assigned_to;
    let assignmentChanged = false;
    let desiredLeadFromAssignment = null;
    let nextCall = currentLead.call_status ?? null;
    let nextVisit = currentLead.visit_status ?? null;

    // Only Super Admin can update these fields
    if (isSuperAdmin) {
      if (hallTicketNumber !== undefined) {
        updateFields.push('hall_ticket_number = ?');
        updateValues.push(hallTicketNumber ? String(hallTicketNumber).trim() : '');
      }
      if (name && String(name).trim()) {
        updateFields.push('name = ?');
        updateValues.push(String(name).trim());
      }
      if (phone && String(phone).trim()) {
        updateFields.push('phone = ?');
        updateValues.push(String(phone).trim());
      }
      if (email !== undefined) {
        updateFields.push('email = ?');
        updateValues.push(email || null);
      }
      if (fatherName && String(fatherName).trim()) {
        updateFields.push('father_name = ?');
        updateValues.push(String(fatherName).trim());
      }
      if (fatherPhone && String(fatherPhone).trim()) {
        updateFields.push('father_phone = ?');
        updateValues.push(String(fatherPhone).trim());
      }
      if (motherName !== undefined) {
        updateFields.push('mother_name = ?');
        updateValues.push(motherName ? String(motherName).trim() : '');
      }
      if (courseInterested !== undefined) {
        updateFields.push('course_interested = ?');
        updateValues.push(courseInterested || null);
      }
      if (village && String(village).trim()) {
        updateFields.push('village = ?');
        updateValues.push(String(village).trim());
      }
      if (address !== undefined) {
        updateFields.push('address = ?');
        updateValues.push(address ? String(address).trim() : '');
      }
      if (district && String(district).trim()) {
        updateFields.push('district = ?');
        updateValues.push(String(district).trim());
      }
      if (mandal && String(mandal).trim()) {
        updateFields.push('mandal = ?');
        updateValues.push(String(mandal).trim());
      }
      if (state !== undefined) {
        const trimmedState = typeof state === 'string' ? state.trim() : state;
        updateFields.push('state = ?');
        updateValues.push(trimmedState ? trimmedState : 'Andhra Pradesh');
      }
      if (quota && String(quota).trim()) {
        updateFields.push('quota = ?');
        updateValues.push(String(quota).trim());
      }
      if (gender !== undefined) {
        updateFields.push('gender = ?');
        updateValues.push(gender ? String(gender).trim() : 'Not Specified');
      }
      if (rank !== undefined && rank !== null && !Number.isNaN(Number(rank))) {
        updateFields.push('`rank` = ?');
        updateValues.push(Number(rank));
      }
      if (interCollege !== undefined) {
        updateFields.push('inter_college = ?');
        updateValues.push(interCollege ? String(interCollege).trim() : '');
      }
      if (alternateMobile !== undefined) {
        updateFields.push('alternate_mobile = ?');
        updateValues.push(alternateMobile ? String(alternateMobile).trim() : '');
      }
      if (applicationStatus !== undefined) {
        updateFields.push('application_status = ?');
        updateValues.push(applicationStatus);
      }
      if (dynamicFields) {
        const currentDynamicFields = typeof currentLead.dynamic_fields === 'string'
          ? JSON.parse(currentLead.dynamic_fields)
          : currentLead.dynamic_fields || {};
        const mergedFields = { ...currentDynamicFields, ...dynamicFields };
        updateFields.push('dynamic_fields = ?');
        updateValues.push(JSON.stringify(mergedFields));
      }
      if (assignedTo) {
        const newAssignedTo = assignedTo.toString();

        // Only update if assignment is actually changing
        if (oldAssignedTo !== newAssignedTo) {
          assignmentChanged = true;
          updateFields.push('assigned_to = ?');
          updateValues.push(newAssignedTo);
          updateFields.push('assigned_at = NOW()');
          updateFields.push('assigned_by = ?');
          updateValues.push(userId);

          // New pipeline (any casing / blank) → Assigned when assigning to a counsellor
          if (isPipelineNewLeadStatus(currentLead.lead_status)) {
            desiredLeadFromAssignment = 'Assigned';
          }

          const [assigneeRows] = await pool.execute(
            'SELECT role_name FROM users WHERE id = ? LIMIT 1',
            [newAssignedTo]
          );
          const assigneeRole = String(assigneeRows[0]?.role_name || '').trim().toUpperCase();
          if (assigneeRole === 'PRO') {
            upsertLeadUpdateColumn(updateFields, updateValues, 'visit_status', 'Assigned');
            nextVisit = 'Assigned';
          } else {
            upsertLeadUpdateColumn(updateFields, updateValues, 'call_status', 'Assigned');
            nextCall = 'Assigned';
          }
        }
      }
      if (source) {
        updateFields.push('source = ?');
        updateValues.push(source);
      }
      if (lastFollowUp) {
        updateFields.push('last_follow_up = ?');
        updateValues.push(new Date(lastFollowUp).toISOString().slice(0, 19).replace('T', ' '));
      }
    }

    // Assigned counsellor / PRO can update limited profile fields from user lead detail edit flow.
    if (isAssignedCounsellorOnly || isAssignedProOnly) {
      if (interCollege !== undefined) {
        updateFields.push('inter_college = ?');
        updateValues.push(interCollege ? String(interCollege).trim() : '');
      }
      if (alternateMobile !== undefined) {
        updateFields.push('alternate_mobile = ?');
        updateValues.push(alternateMobile ? String(alternateMobile).trim() : '');
      }
      if (isAssignedProOnly && address !== undefined) {
        updateFields.push('address = ?');
        updateValues.push(address ? String(address).trim() : '');
      }
      if (isAssignedProOnly && village !== undefined) {
        updateFields.push('village = ?');
        updateValues.push(village ? String(village).trim() : '');
      }
    }

    const assignedAsCounsellor = currentLead.assigned_to === userId;
    const assignedAsPro = currentLead.assigned_to_pro === userId;

    let desiredLead = desiredLeadFromAssignment ?? currentLead.lead_status;

    const counsellorProfileBodyKeys = [
      'hallTicketNumber', 'name', 'phone', 'email', 'fatherName', 'fatherPhone', 'motherName',
      'village', 'district', 'courseInterested', 'mandal', 'state', 'gender', 'rank', 'interCollege',
      'quota', 'applicationStatus', 'address', 'alternateMobile', 'dynamicFields',
    ];
    const proVisitBumpFromCounsellor =
      isStudentCounselor &&
      assignedAsCounsellor &&
      currentLead.assigned_to_pro &&
      !isCallStatusConfirmedValue(currentLead.visit_status) &&
      (
        callStatus !== undefined ||
        notes !== undefined ||
        nextScheduledCall !== undefined ||
        academicYear !== undefined ||
        studentGroup !== undefined ||
        counsellorProfileBodyKeys.some((k) => Object.prototype.hasOwnProperty.call(req.body, k))
      );
    if (proVisitBumpFromCounsellor) {
      nextVisit = 'Assigned';
    }

    if ((isSuperAdmin || isAdmin) && callStatus !== undefined) {
      nextCall = callStatus === '' || callStatus === null ? null : String(callStatus).trim();
      upsertLeadUpdateColumn(updateFields, updateValues, 'call_status', nextCall);
    }
    if ((isSuperAdmin || isAdmin) && visitStatus !== undefined) {
      nextVisit = visitStatus === '' || visitStatus === null ? null : String(visitStatus).trim();
      upsertLeadUpdateColumn(updateFields, updateValues, 'visit_status', nextVisit);
    }
    if (isStudentCounselor && assignedAsCounsellor && callStatus !== undefined) {
      nextCall = callStatus === '' || callStatus === null ? null : String(callStatus).trim();
      upsertLeadUpdateColumn(updateFields, updateValues, 'call_status', nextCall);
    }
    if (isPro && assignedAsPro && visitStatus !== undefined) {
      nextVisit = visitStatus === '' || visitStatus === null ? null : String(visitStatus).trim();
      upsertLeadUpdateColumn(updateFields, updateValues, 'visit_status', nextVisit);
    }

    if (proVisitBumpFromCounsellor && !updateFields.some((f) => String(f) === 'visit_status = ?')) {
      upsertLeadUpdateColumn(updateFields, updateValues, 'visit_status', 'Assigned');
    }

    if ((isSuperAdmin || isAdmin) && newLeadStatus && newLeadStatus !== currentLead.lead_status) {
      desiredLead = newLeadStatus;
    } else if (
      newLeadStatus &&
      newLeadStatus !== currentLead.lead_status &&
      !isStudentCounselor &&
      !isPro &&
      isAssigned
    ) {
      desiredLead = newLeadStatus;
    }

    const resolvedLead = resolveLeadStatus(desiredLead, nextCall, nextVisit);
    if (resolvedLead !== currentLead.lead_status) {
      updateFields.push('lead_status = ?');
      updateValues.push(resolvedLead);
    }

    if (notes !== undefined && (isSuperAdmin || isAdmin || !isPro)) {
      updateFields.push('notes = ?');
      updateValues.push(notes || null);
    }
    if (nextScheduledCall !== undefined && (isSuperAdmin || isAdmin || !isPro)) {
      updateFields.push('next_scheduled_call = ?');
      updateValues.push(
        nextScheduledCall
          ? new Date(nextScheduledCall).toISOString().slice(0, 19).replace('T', ' ')
          : null
      );
    }
    if (academicYear !== undefined && (isSuperAdmin || isAdmin || !isPro)) {
      updateFields.push('academic_year = ?');
      updateValues.push(academicYear != null && academicYear !== '' ? Number(academicYear) : null);
    }
    if (studentGroup !== undefined && (isSuperAdmin || isAdmin || isAssignedCounsellorOnly || isAssignedProOnly)) {
      updateFields.push('student_group = ?');
      updateValues.push(studentGroup ? String(studentGroup).trim() || null : null);
    }
    // Clear needs_manual_update when lead is updated (Super Admin or assigned counsellor has reviewed/corrected)
    if ((isSuperAdmin || isAssignedCounsellorOnly || isAssignedProOnly) && updateFields.length > 0) {
      updateFields.push('needs_manual_update = ?');
      updateValues.push(0);
    }

    const callMarkedConfirmed =
      callStatus !== undefined && isCallStatusConfirmedValue(nextCall);
    const visitMarkedConfirmed =
      visitStatus !== undefined && isCallStatusConfirmedValue(nextVisit);
    if (callMarkedConfirmed || visitMarkedConfirmed) {
      await applyReference1OnCallStatusConfirm(
        pool,
        currentLead,
        updateFields,
        updateValues,
        dynamicFields,
        userId
      );
    }

    // Execute update
    if (updateFields.length > 0) {
      updateFields.push('updated_at = NOW()');
      updateValues.push(req.params.id);
      await pool.execute(
        `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // Create activity logs
    const finalStatus = resolvedLead;

    // Log assignment change
    if (assignmentChanged && assignedTo) {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          req.params.id,
          'status_change',
          oldStatus,
          finalStatus,
          'Assigned to counsellor',
          userId,
          JSON.stringify({
            assignment: {
              assignedTo: assignedTo.toString(),
              assignedBy: userId,
            },
          }),
        ]
      );
    }

    // Log lead_status change (not from assignment row above)
    if (resolvedLead !== currentLead.lead_status && !assignmentChanged) {
      const activityLogId = uuidv4();
      const statusMeta = {};
      if (callStatus !== undefined) {
        statusMeta.statusChannel = 'call_status';
        statusMeta.callStatus = nextCall;
      } else if (visitStatus !== undefined) {
        statusMeta.statusChannel = 'visit_status';
        statusMeta.visitStatus = nextVisit;
      } else if (newLeadStatus) {
        statusMeta.statusChannel = 'lead_status';
      }
      const hasMeta = Object.keys(statusMeta).length > 0;
      await pool.execute(
        hasMeta
          ? `INSERT INTO activity_logs (id, lead_id, type, old_status, new_status, performed_by, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`
          : `INSERT INTO activity_logs (id, lead_id, type, old_status, new_status, performed_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        hasMeta
          ? [
              activityLogId,
              req.params.id,
              'status_change',
              currentLead.lead_status,
              resolvedLead,
              userId,
              JSON.stringify(statusMeta),
            ]
          : [
              activityLogId,
              req.params.id,
              'status_change',
              currentLead.lead_status,
              resolvedLead,
              userId,
            ]
      );
    }

    // Log field updates (Super Admin or assigned counsellor)
    const fieldChanges = [];

    const normalize = (val) => {
      if (val === null || val === undefined) return '';
      return String(val).trim();
    };

    const compareAndLog = (fieldLabel, oldVal, newVal, rawVal) => {
      if (rawVal === undefined) return; // Key not in payload
      const n = normalize(newVal);
      const o = normalize(oldVal);
      if (n !== o) {
        fieldChanges.push({ field: fieldLabel, old: o, new: n });
      }
    };

    compareAndLog('Name', originalLead.name, name, name);
    compareAndLog('Phone', originalLead.phone, phone, phone);
    compareAndLog('Email', originalLead.email, email, email);
    compareAndLog('Father Name', originalLead.fatherName, fatherName, fatherName);
    compareAndLog('Father Phone', originalLead.fatherPhone, fatherPhone, fatherPhone);
    compareAndLog('Mother Name', originalLead.motherName, motherName, motherName);
    compareAndLog('Course Interested', originalLead.courseInterested, courseInterested, courseInterested);
    compareAndLog('Village', originalLead.village, village, village);
    compareAndLog('Address', originalLead.address, address, address);
    compareAndLog('District', originalLead.district, district, district);
    compareAndLog('Mandal', originalLead.mandal, mandal, mandal);
    compareAndLog('State', originalLead.state, state, state);
    compareAndLog('Quota', originalLead.quota, quota, quota);
    compareAndLog('Gender', originalLead.gender, gender, gender);
    compareAndLog('Rank', originalLead.rank, rank, rank);
    compareAndLog('Inter College', originalLead.interCollege, interCollege, interCollege);
    compareAndLog('Alternate Mobile', originalLead.alternateMobile, alternateMobile, alternateMobile);
    compareAndLog('Hall Ticket Number', originalLead.hallTicketNumber, hallTicketNumber, hallTicketNumber);
    compareAndLog('Application Status', originalLead.applicationStatus, applicationStatus, applicationStatus);

    if ((isSuperAdmin || isAssignedCounsellorOnly) && fieldChanges.length > 0 && !assignedTo) {
      const activityLogId = uuidv4();
      const changeSummary = fieldChanges.map(c => `${c.field} (${c.old || 'empty'} -> ${c.new || 'empty'})`).join(', ');

      await pool.execute(
        `INSERT INTO activity_logs (id, lead_id, type, comment, performed_by, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          req.params.id,
          'field_update',
          `Student details updated: ${changeSummary}`,
          userId,
          JSON.stringify({
            fieldUpdate: {
              changes: fieldChanges,
              count: fieldChanges.length,
            },
          }),
        ]
      );
    }

    // Fetch updated lead
    const [updatedLeads] = await pool.execute(
      `SELECT 
        l.*,
        ${ASSIGNED_USER_SQL_SELECT}
      FROM leads l
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      LEFT JOIN users u3 ON l.assigned_to_pro = u3.id
      WHERE l.id = ?`,
      [req.params.id]
    );

    const assignedToUser = buildAssignedCounsellorFromSqlRow(updatedLeads[0]);
    const uploadedByUser = updatedLeads[0].uploaded_by_id ? {
      id: updatedLeads[0].uploaded_by_id,
      _id: updatedLeads[0].uploaded_by_id,
      name: updatedLeads[0].uploaded_by_name,
    } : null;
    const assignedToProUser = buildAssignedProFromSqlRow(updatedLeads[0]);

    const lead = formatLead(updatedLeads[0], assignedToUser, uploadedByUser, assignedToProUser, {
      viewerRoleName: req.user.roleName,
    });

    return successResponse(res, lead, 'Lead updated successfully', 200);
  } catch (error) {
    console.error('Error updating lead:', error);
    return errorResponse(res, error.message || 'Failed to update lead', 500);
  }
};

// @desc    Delete lead
// @route   DELETE /api/leads/:id
// @access  Private (Super Admin only)
export const deleteLead = async (req, res) => {
  try {
    const pool = getPool();

    // Check if lead exists
    const [leads] = await pool.execute(
      'SELECT id FROM leads WHERE id = ?',
      [req.params.id]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Only Super Admin can delete
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    // Delete all activity logs for this lead first (CASCADE will handle this, but explicit for clarity)
    await pool.execute(
      'DELETE FROM activity_logs WHERE lead_id = ?',
      [req.params.id]
    );

    // Then delete the lead (CASCADE will also delete related records)
    await pool.execute(
      'DELETE FROM leads WHERE id = ?',
      [req.params.id]
    );

    return successResponse(res, null, 'Lead and associated activity logs deleted successfully', 200);
  } catch (error) {
    console.error('Error deleting lead:', error);
    return errorResponse(res, error.message || 'Failed to delete lead', 500);
  }
};

// Process delete job in background
const processDeleteJob = async (jobId) => {
  const pool = getPool();

  // Get job
  const [jobs] = await pool.execute(
    'SELECT * FROM delete_jobs WHERE job_id = ?',
    [jobId]
  );

  if (jobs.length === 0) {
    console.error(`Delete job ${jobId} not found`);
    return;
  }

  const job = jobs[0];

  if (job.status !== 'queued') {
    console.warn(`Delete job ${jobId} is not in queued status: ${job.status}`);
    return;
  }

  const startTime = Date.now();

  // Update job status to processing
  await pool.execute(
    'UPDATE delete_jobs SET status = ?, started_at = NOW(), updated_at = NOW() WHERE job_id = ?',
    ['processing', jobId]
  );

  try {
    // Get all lead IDs for this job
    const [leadIdsRows] = await pool.execute(
      'SELECT lead_id FROM delete_job_lead_ids WHERE delete_job_id = ?',
      [job.id]
    );

    const validIds = leadIdsRows
      .map(row => row.lead_id)
      .filter(id => id && typeof id === 'string' && id.length === 36); // UUID validation

    if (validIds.length === 0) {
      await pool.execute(
        `UPDATE delete_jobs SET 
          status = ?, completed_at = NOW(), updated_at = NOW(),
          stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
          stats_deleted_log_count = ?, stats_duration_ms = ?, message = ?
         WHERE job_id = ?`,
        ['completed', job.stats_requested_count || 0, 0, 0, 0, Date.now() - startTime, 'No valid lead IDs to delete', jobId]
      );
      return;
    }

    const uniqueValidIds = Array.from(new Set(validIds));
    const chunkSize = uniqueValidIds.length > 20000 ? 10000 : uniqueValidIds.length > 5000 ? 5000 : 1000;

    let totalLeadDeleted = 0;
    let totalLogDeleted = 0;
    const errorDetails = [];

    // Process in chunks
    for (let index = 0; index < uniqueValidIds.length; index += chunkSize) {
      const chunk = uniqueValidIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      try {
        // Delete activity logs first
        const [logResult] = await pool.execute(
          `DELETE FROM activity_logs WHERE lead_id IN (${placeholders})`,
          chunk
        );
        totalLogDeleted += logResult.affectedRows || 0;

        // Delete leads (CASCADE will handle related records)
        const [leadResult] = await pool.execute(
          `DELETE FROM leads WHERE id IN (${placeholders})`,
          chunk
        );
        totalLeadDeleted += leadResult.affectedRows || 0;

        // Update job progress periodically
        if ((index + chunkSize) % (chunkSize * 5) === 0 || index + chunkSize >= uniqueValidIds.length) {
          await pool.execute(
            `UPDATE delete_jobs SET 
              stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
              stats_deleted_log_count = ?, stats_duration_ms = ?, updated_at = NOW()
             WHERE job_id = ?`,
            [job.stats_requested_count || 0, uniqueValidIds.length, totalLeadDeleted, totalLogDeleted, Date.now() - startTime, jobId]
          );
        }

        // Yield the event loop
        await new Promise((resolve) => setImmediate(resolve));
      } catch (chunkError) {
        console.error(`Error deleting chunk ${index}-${index + chunkSize}:`, chunkError);
        chunk.forEach((id) => {
          errorDetails.push({
            leadId: id,
            error: chunkError.message || 'Unknown error',
          });
        });
      }
    }

    const durationMs = Date.now() - startTime;

    // Insert error details (limit to 200)
    const limitedErrors = errorDetails.slice(0, 200);
    for (const errorDetail of limitedErrors) {
      const errorId = uuidv4();
      await pool.execute(
        'INSERT INTO delete_job_error_details (id, delete_job_id, lead_id, error, created_at) VALUES (?, ?, ?, ?, NOW())',
        [errorId, job.id, errorDetail.leadId, errorDetail.error]
      );
    }

    // Update job to completed
    await pool.execute(
      `UPDATE delete_jobs SET 
        status = ?, completed_at = NOW(), updated_at = NOW(),
        stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
        stats_deleted_log_count = ?, stats_duration_ms = ?, message = ?
       WHERE job_id = ?`,
      [
        'completed',
        job.stats_requested_count || 0,
        uniqueValidIds.length,
        totalLeadDeleted,
        totalLogDeleted,
        durationMs,
        `Deleted ${totalLeadDeleted} lead(s) and ${totalLogDeleted} activity log(s) in ${durationMs} ms`,
        jobId
      ]
    );

    console.log(`Delete job ${jobId} completed: ${totalLeadDeleted} leads deleted`);
  } catch (error) {
    console.error(`Delete job ${jobId} failed:`, error);
    await pool.execute(
      `UPDATE delete_jobs SET 
        status = ?, completed_at = NOW(), updated_at = NOW(),
        stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
        stats_deleted_log_count = ?, stats_duration_ms = ?, message = ?
       WHERE job_id = ?`,
      [
        'failed',
        job.stats_requested_count || 0,
        0,
        0,
        0,
        Date.now() - startTime,
        error.message || 'Failed to process delete job',
        jobId
      ]
    );
  }
};

// @desc    Bulk delete leads (queued)
// @route   DELETE /api/leads/bulk
// @access  Private (Super Admin only)
export const bulkDeleteLeads = async (req, res) => {
  try {
    const { leadIds } = req.body;

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return errorResponse(res, 'Please provide an array of lead IDs to delete', 400);
    }

    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    // Validate UUIDs (36 characters)
    const validIds = leadIds.filter((id) => {
      return id && typeof id === 'string' && id.length === 36;
    });

    if (validIds.length === 0) {
      return errorResponse(res, 'No valid lead IDs provided', 400);
    }

    const uniqueValidIds = Array.from(new Set(validIds));
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Create delete job
    const jobId = uuidv4();
    const deleteJobId = uuidv4();

    await pool.execute(
      `INSERT INTO delete_jobs (
        id, job_id, status, deleted_by, stats_requested_count, stats_valid_count,
        stats_deleted_lead_count, stats_deleted_log_count, stats_duration_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        deleteJobId,
        jobId,
        'queued',
        userId,
        leadIds.length,
        uniqueValidIds.length,
        0,
        0,
        0,
      ]
    );

    // Insert lead IDs
    for (const leadId of uniqueValidIds) {
      const leadIdRecordId = uuidv4();
      await pool.execute(
        'INSERT INTO delete_job_lead_ids (id, delete_job_id, lead_id, created_at) VALUES (?, ?, ?, NOW())',
        [leadIdRecordId, deleteJobId, leadId]
      );
    }

    // Queue the job for processing
    deleteQueue.add(() => processDeleteJob(jobId)).catch((error) => {
      console.error(`Error queuing delete job ${jobId}:`, error);
    });

    return successResponse(
      res,
      {
        jobId,
        status: 'queued',
        requestedCount: leadIds.length,
        validCount: uniqueValidIds.length,
        message: 'Delete job queued successfully',
      },
      'Bulk delete job queued. Use the job ID to check status.',
      202,
    );
  } catch (error) {
    console.error('Bulk delete error:', error);
    return errorResponse(res, error.message || 'Failed to queue bulk delete', 500);
  }
};

// @desc    Get delete job status
// @route   GET /api/leads/delete-jobs/:jobId
// @access  Private (Super Admin only)
export const getDeleteJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    const pool = getPool();

    const [jobs] = await pool.execute(
      'SELECT * FROM delete_jobs WHERE job_id = ?',
      [jobId]
    );

    if (jobs.length === 0) {
      return errorResponse(res, 'Delete job not found', 404);
    }

    const job = jobs[0];

    // Get error details
    const [errorDetails] = await pool.execute(
      'SELECT lead_id, error FROM delete_job_error_details WHERE delete_job_id = ? LIMIT 200',
      [job.id]
    );

    return successResponse(
      res,
      {
        jobId: job.job_id,
        status: job.status,
        stats: {
          requestedCount: job.stats_requested_count,
          validCount: job.stats_valid_count,
          deletedLeadCount: job.stats_deleted_lead_count,
          deletedLogCount: job.stats_deleted_log_count,
          durationMs: job.stats_duration_ms,
        },
        errorDetails: errorDetails.map(e => ({ leadId: e.lead_id, error: e.error })),
        message: job.message,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        createdAt: job.created_at,
      },
      'Delete job status retrieved successfully',
      200,
    );
  } catch (error) {
    console.error('Error getting delete job status:', error);
    return errorResponse(res, error.message || 'Failed to get delete job status', 500);
  }
};

// @desc    Get all lead IDs matching filters (for bulk operations)
// @route   GET /api/leads/ids
// @access  Private
export const getAllLeadIds = async (req, res) => {
  try {
    const pool = getPool();

    // Build WHERE conditions using optimized helper
    const { conditions, params } = buildLeadFilterConditions(req, 'l');
    const userId = req.user.id || req.user._id;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get IDs ordered by assignment time: latest assigned first (assigned_at DESC), then by id for stability
    const [leadIds] = await pool.execute(
      `SELECT l.id FROM leads l ${whereClause} ORDER BY l.assigned_at DESC, l.id ASC`,
      params
    );

    const ids = leadIds.map(row => row.id);

    return successResponse(res, {
      ids,
      count: ids.length,
    }, 'Lead IDs retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting lead IDs:', error);
    return errorResponse(res, error.message || 'Failed to get lead IDs', 500);
  }
};

// @desc    Get filter options (public - for form dropdowns)
// @route   GET /api/leads/filters/options/public
// @access  Public
export const getPublicFilterOptions = async (req, res) => {
  try {
    const pool = getPool();
    const cacheKey = 'filter-options:public';
    const cached = getCached(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Filter options retrieved successfully', 200);
    }

    const [
      [mandals],
      [districts],
      [states],
      [quotas],
      [applicationStatuses],
    ] = await Promise.all([
      pool.execute('SELECT DISTINCT mandal FROM leads WHERE mandal IS NOT NULL AND mandal != "" ORDER BY mandal ASC'),
      pool.execute('SELECT DISTINCT district FROM leads WHERE district IS NOT NULL AND district != "" ORDER BY district ASC'),
      pool.execute('SELECT DISTINCT state FROM leads WHERE state IS NOT NULL AND state != "" ORDER BY state ASC'),
      pool.execute('SELECT DISTINCT quota FROM leads WHERE quota IS NOT NULL AND quota != "" ORDER BY quota ASC'),
      pool.execute(
        'SELECT DISTINCT application_status FROM leads WHERE application_status IS NOT NULL AND application_status != "" ORDER BY application_status ASC'
      ),
    ]);

    const catalogQuotas = quotaNamesFromCatalog(await fetchActiveStudentQuotas());
    const legacyQuotas = quotas.map((r) => r.quota);
    const payload = {
      mandals: mandals.map(r => r.mandal),
      districts: districts.map(r => r.district),
      states: states.map(r => r.state),
      quotas: mergeQuotaOptionLabels(catalogQuotas, legacyQuotas),
      applicationStatuses: applicationStatuses.map(r => r.application_status),
    };
    setCached(cacheKey, payload, CACHE_TTL.filterOptionsMs);
    return successResponse(res, payload, 'Filter options retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting public filter options:', error);
    return errorResponse(res, error.message || 'Failed to get filter options', 500);
  }
};

// @desc    Get filter options (for dropdowns)
// @route   GET /api/leads/filters/options
// @access  Private
export const getFilterOptions = async (req, res) => {
  try {
    const pool = getPool();

    // Build WHERE clause for access control (mirror GET /leads: PRO uses assigned_to_pro OR assigned_to)
    const conditions = [];

    const adminLike = hasElevatedAdminPrivileges(req.user.roleName) || req.user.roleName === 'Admin';
    const userId = req.user.id || req.user._id;
    
    const params = !adminLike
      ? (req.user.roleName === 'PRO' ? [userId, userId] : [userId])
      : [];

    if (!adminLike) {
      if (req.user.roleName === 'PRO') {
        conditions.push('(assigned_to_pro = ? OR assigned_to = ?)');
      } else {
        conditions.push('assigned_to = ?');
      }
    }

    // Lead source restriction from user permissions
    const allowedSources = req.user.permissions?.allowedSources;
    if (allowedSources && Array.isArray(allowedSources) && allowedSources.length > 0) {
      const placeholders = allowedSources.map(() => '?').join(',');
      conditions.push(`source IN (${placeholders})`);
      params.push(...allowedSources);
    }

    // Add field-specific conditions
    const mandalCondition = [...conditions, 'mandal IS NOT NULL AND mandal != ""'];
    const districtCondition = [...conditions, 'district IS NOT NULL AND district != ""'];
    const villageCondition = [...conditions, 'village IS NOT NULL AND TRIM(village) != ""'];
    const stateCondition = [...conditions, 'state IS NOT NULL AND state != ""'];
    const quotaCondition = [...conditions, 'quota IS NOT NULL AND quota != ""'];
    const leadStatusCondition = [...conditions, 'lead_status IS NOT NULL AND lead_status != ""'];
    const sourceCondition = [...conditions, 'source IS NOT NULL AND TRIM(source) != ""'];
    const callStatusCondition = [...conditions, 'call_status IS NOT NULL AND TRIM(call_status) != ""'];
    const visitStatusCondition = [...conditions, 'visit_status IS NOT NULL AND TRIM(visit_status) != ""'];
    const appStatusCondition = [...conditions, 'application_status IS NOT NULL AND application_status != ""'];

    const whereClause = (conditions) => conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const districtFilter = (req.query.district && String(req.query.district).trim()) || '';
    const mandalFilter = (req.query.mandal && String(req.query.mandal).trim()) || '';
    const academicYearFilter =
      req.query.academicYear != null && req.query.academicYear !== ''
        ? parseInt(String(req.query.academicYear), 10)
        : NaN;
    if (!Number.isNaN(academicYearFilter)) {
      conditions.push('academic_year = ?');
      params.push(academicYearFilter);
    }
    const privateCacheKey = `filter-options:private:v2-sources:${stableStringify({
      roleName: req.user.roleName,
      userId: adminLike ? 'admin-like' : userId,
      districtFilter,
      mandalFilter,
      academicYear: Number.isNaN(academicYearFilter) ? null : academicYearFilter,
    })}`;
    const cached = getCached(privateCacheKey);
    if (cached) {
      return successResponse(res, cached, 'Filter options retrieved successfully', 200);
    }

    const mandalConditionScoped = [...mandalCondition];
    const mandalParams = [...params];
    if (districtFilter) {
      mandalConditionScoped.push('district = ?');
      mandalParams.push(districtFilter);
    }

    const villageConditionScoped = [...villageCondition];
    const villageParams = [...params];
    if (districtFilter) {
      villageConditionScoped.push('district = ?');
      villageParams.push(districtFilter);
    }
    if (mandalFilter) {
      villageConditionScoped.push('mandal = ?');
      villageParams.push(mandalFilter);
    } else if (!districtFilter && mandalFilter) {
      villageConditionScoped.push('mandal = ?');
      villageParams.push(mandalFilter);
    }

    const academicYearCondition = [...conditions, 'academic_year IS NOT NULL'];
    const studentGroupCondition = [...conditions, 'student_group IS NOT NULL AND student_group != ""'];

    // Run DISTINCT scans in parallel — sequential round-trips were timing out (502) behind proxies on large leads tables.
    const [
      [mandals],
      [districts],
      [villages],
      [states],
      [quotas],
      [leadStatuses],
      [sources],
      [callStatuses],
      [visitStatuses],
      [applicationStatuses],
      [academicYearsRows],
      [studentGroupsRows],
    ] = await Promise.all([
      pool.execute(
        `SELECT DISTINCT mandal FROM leads ${whereClause(mandalConditionScoped)} ORDER BY mandal ASC`,
        mandalParams
      ),
      pool.execute(
        `SELECT DISTINCT district FROM leads ${whereClause(districtCondition)} ORDER BY district ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT village FROM leads ${whereClause(villageConditionScoped)} ORDER BY village ASC`,
        villageParams
      ),
      pool.execute(
        `SELECT DISTINCT state FROM leads ${whereClause(stateCondition)} ORDER BY state ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT quota FROM leads ${whereClause(quotaCondition)} ORDER BY quota ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT lead_status FROM leads ${whereClause(leadStatusCondition)} AND LOWER(lead_status) NOT IN ('eamcet applied', 'polycet applied') ORDER BY lead_status ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT TRIM(source) AS source FROM leads ${whereClause(sourceCondition)} AND TRIM(COALESCE(source, '')) != '' ORDER BY source ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT call_status FROM leads ${whereClause(callStatusCondition)} ORDER BY call_status ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT visit_status FROM leads ${whereClause(visitStatusCondition)} ORDER BY visit_status ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT application_status FROM leads ${whereClause(appStatusCondition)} ORDER BY application_status ASC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT academic_year FROM leads ${whereClause(academicYearCondition)} ORDER BY academic_year DESC`,
        params
      ),
      pool.execute(
        `SELECT DISTINCT student_group FROM leads ${whereClause(studentGroupCondition)} ORDER BY student_group ASC`,
        params
      ),
    ]);
    const academicYears = academicYearsRows.map(r => r.academic_year).filter(Boolean);
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= currentYear - 3; y -= 1) {
      if (!academicYears.includes(y)) academicYears.unshift(y);
    }
    academicYears.sort((a, b) => b - a);

    const studentGroupOptions = ['10th', 'Inter', 'Inter-MPC', 'Inter-BIPC', 'Degree', 'Diploma'];
    const studentGroupsFromDb = studentGroupsRows.map(r => r.student_group).filter(Boolean);
    const studentGroups = [...new Set([...studentGroupOptions, ...studentGroupsFromDb])].sort();

    const catalogQuotas = quotaNamesFromCatalog(await fetchActiveStudentQuotas());
    const legacyQuotas = quotas.map((r) => r.quota);

    const payload = {
      mandals: mandals.map(r => r.mandal),
      districts: districts.map(r => r.district),
      villages: villages.map((r) => r.village),
      states: states.map(r => r.state),
      quotas: mergeQuotaOptionLabels(catalogQuotas, legacyQuotas),
      leadStatuses: [...new Set(leadStatuses.map((r) => canonicalizeLeadStatus(r.lead_status)))].sort(),
      sources: [...new Set(sources.map((r) => String(r.source || '').trim()).filter(Boolean))].sort(),
      callStatuses: callStatuses.map(r => r.call_status),
      visitStatuses: visitStatuses.map(r => r.visit_status),
      applicationStatuses: applicationStatuses.map(r => r.application_status),
      academicYears,
      studentGroups,
    };
    setCached(privateCacheKey, payload, CACHE_TTL.filterOptionsMs);
    return successResponse(res, payload, 'Filter options retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting filter options:', error);
    return errorResponse(res, error.message || 'Failed to get filter options', 500);
  }
};

/**
 * @desc    Student group values only (for dropdowns). One DISTINCT query + cache — avoids waiting on the full
 *          `/filters/options` bundle (11 parallel lead-table scans), which was blocking Call Reports student-group UI.
 * @route   GET /api/leads/filters/student-groups
 * @access  Private
 */
export const getStudentGroupFilterOptions = async (req, res) => {
  try {
    const pool = getPool();

    const adminLike = hasElevatedAdminPrivileges(req.user.roleName) || req.user.roleName === 'Admin';
    const userId = req.user.id || req.user._id;

    const accessConditions = [];
    if (!adminLike) {
      if (req.user.roleName === 'PRO') {
        accessConditions.push('(assigned_to_pro = ? OR assigned_to = ?)');
      } else {
        accessConditions.push('assigned_to = ?');
      }
    }

    const studentGroupCondition = [
      ...accessConditions,
      'student_group IS NOT NULL AND student_group != ""',
    ];
    const params = !adminLike
      ? req.user.roleName === 'PRO'
        ? [userId, userId]
        : [userId]
      : [];

    const whereClause =
      studentGroupCondition.length > 0 ? `WHERE ${studentGroupCondition.join(' AND ')}` : '';

    const cacheKey = `filter-options:student-groups:v1:${stableStringify({
      roleName: req.user.roleName,
      userId: adminLike ? 'admin-like' : String(userId),
    })}`;

    const cached = getCached(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Student group filter options retrieved successfully', 200);
    }

    const [studentGroupsRows] = await pool.execute(
      `SELECT DISTINCT student_group FROM leads ${whereClause} ORDER BY student_group ASC`,
      params
    );

    const studentGroupOptions = ['10th', 'Inter', 'Inter-MPC', 'Inter-BIPC', 'Degree', 'Diploma'];
    const studentGroupsFromDb = (studentGroupsRows || []).map((r) => r.student_group).filter(Boolean);
    const studentGroups = [...new Set([...studentGroupOptions, ...studentGroupsFromDb])].sort();

    const payload = { studentGroups };
    setCached(cacheKey, payload, CACHE_TTL.studentGroupFilterMs);
    return successResponse(res, payload, 'Student group filter options retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting student group filter options:', error);
    return errorResponse(res, error.message || 'Failed to get student group filter options', 500);
  }
};




/**
 * @desc    Get HTML report of mismatched leads (Location validation)
 * @route   GET /api/leads/mismatch-report
 * @access  Public
 */











// @desc    Export leads to Excel with filters
// @route   GET /api/leads/export
// @access  Private (Super Admin / Admin)
export const exportLeads = async (req, res) => {
  try {
    const pool = getPool();

    // Build WHERE conditions using optimized helper
    const { conditions, params } = buildLeadFilterConditions(req, 'l');

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT 
        l.*,
        u1.name as assigned_to_name,
        u2.name as uploaded_by_name,
        u3.name as assigned_to_pro_name
      FROM leads l
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      LEFT JOIN users u3 ON l.assigned_to_pro = u3.id
      ${whereClause}
      ORDER BY l.created_at DESC
    `;

    const [leads] = await pool.execute(query, params);

    // Create Excel Workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Leads');

    // Define Columns
    worksheet.columns = [
      { header: 'Enquiry Number', key: 'enquiryNumber', width: 20 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Status', key: 'leadStatus', width: 15 },
      { header: 'District', key: 'district', width: 15 },
      { header: 'Mandal', key: 'mandal', width: 15 },
      { header: 'Village', key: 'village', width: 20 },
      { header: 'Father Name', key: 'fatherName', width: 20 },
      { header: 'Father Phone', key: 'fatherPhone', width: 15 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'Admission Date', key: 'createdAt', width: 20 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Assigned To', key: 'assignedToName', width: 20 },
      { header: 'PRO Assigned To', key: 'assignedToProName', width: 20 },
    ];

    // Add Rows
    leads.forEach(lead => {
      worksheet.addRow({
        enquiryNumber: lead.enquiry_number,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        leadStatus: canonicalizeLeadStatus(lead.lead_status),
        district: lead.district,
        mandal: lead.mandal,
        village: lead.village,
        fatherName: lead.father_name,
        fatherPhone: lead.father_phone,
        gender: lead.gender,
        createdAt: lead.created_at ? new Date(lead.created_at).toLocaleString() : '',
        source: lead.source,
        assignedToName: lead.assigned_to_name || 'Unassigned',
        assignedToProName: lead.assigned_to_pro_name || 'Unassigned',
      });
    });

    // Style the header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Set Response Headers
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=leads_export.xlsx'
    );

    // Write to stream
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error exporting leads:', error);
    if (!res.headersSent) {
      return errorResponse(res, error.message || 'Failed to export leads', 500);
    }
  }
};
