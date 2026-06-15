import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { syncJoiningStudentFeeDetailsToFeeMongo } from '../services/joiningStudentFeeMongoSync.service.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';
import {
  canApproveFeeRequest,
  canSubmitFeeRequest,
} from '../utils/joiningPermissions.util.js';

const sanitizeStudentFeeDetailsForDb = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const batch =
    raw.batch != null && String(raw.batch).trim() !== ''
      ? String(raw.batch).trim().slice(0, 32)
      : undefined;
  const linesIn = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = linesIn
    .map((line) => {
      const structureId = String(line?.structureId ?? '').trim();
      if (!structureId) return null;
      let amount = null;
      if (line?.amount !== undefined && line?.amount !== null && line?.amount !== '') {
        const n = Number(line.amount);
        if (Number.isFinite(n) && n >= 0) amount = n;
      }
      const remarks = typeof line?.remarks === 'string' ? line.remarks.trim().slice(0, 2000) : '';
      return { structureId, amount, remarks };
    })
    .filter(Boolean);
  if (lines.length === 0 && !batch) return null;
  return { ...(batch ? { batch } : {}), lines };
};

const parseLeadData = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
};

const isProbablyEnquiryNumber = (value) => {
  const v = String(value || '').trim();
  if (!v) return false;
  return /^ENQ/i.test(v);
};

const normalizeAdmissionNumberCandidate = (value) => {
  const v = String(value || '').trim();
  if (!v) return '';
  if (isProbablyEnquiryNumber(v)) return '';
  return v;
};

const resolveJoiningAdmissionNumber = (leadData, registrationExtras) => {
  const fromLead =
    leadData?.admissionNumber ||
    leadData?.admission_number ||
    '';
  const normalizedFromLead = normalizeAdmissionNumberCandidate(fromLead);
  if (normalizedFromLead) return normalizedFromLead;

  const extras =
    (registrationExtras && typeof registrationExtras === 'object' ? registrationExtras : null) ||
    (leadData?._joiningRegistrationExtras &&
    typeof leadData._joiningRegistrationExtras === 'object'
      ? leadData._joiningRegistrationExtras
      : null);
  if (extras) {
    const n = normalizeAdmissionNumberCandidate(extras.admission_number || extras.admissionNumber);
    if (n) return n;
  }
  return '';
};

const buildJoiningFeeSyncContext = (
  joiningRow,
  studentFeeDetails,
  registrationExtras,
  admissionNumber = ''
) => {
  const transportDetails =
    registrationExtras?.transport_details &&
    typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null;
  return {
    course: joiningRow?.course || '',
    branch: joiningRow?.branch || '',
    quota: joiningRow?.quota || '',
    batch:
      studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
        ? String(studentFeeDetails.batch).trim()
        : '',
    admissionNumber: admissionNumber || '',
    studentName: joiningRow?.student_name || '',
    studentPhone: joiningRow?.student_phone || '',
    studentGender: joiningRow?.student_gender || '',
    fatherPhone: joiningRow?.father_phone || '',
    managedCourseId:
      joiningRow?.managed_course_id ??
      registrationExtras?.managed_course_id ??
      registrationExtras?.managedCourseId ??
      null,
    collegeId:
      registrationExtras?.college_id ??
      registrationExtras?.collegeId ??
      registrationExtras?.school_or_college_id ??
      registrationExtras?.schoolOrCollegeId ??
      null,
    transportDetails,
    programTotalYears: resolveProgramTotalYearsFromExtras(
      registrationExtras,
      joiningRow?.course || ''
    ),
    intakeBatch: resolveIntakeBatchFromExtras(
      registrationExtras,
      studentFeeDetails,
      admissionNumber
    ),
  };
};

const resolveIntakeBatchFromExtras = (registrationExtras, studentFeeDetails, admissionNumber = '') => {
  const fromFees = normalizeCalendarAcademicYear(studentFeeDetails?.batch ?? '');
  if (fromFees) return fromFees;
  const fromExtras = normalizeCalendarAcademicYear(
    registrationExtras?.academic_year ?? registrationExtras?.academicYear ?? ''
  );
  if (fromExtras) return fromExtras;
  return deriveAdmissionSeriesYear(admissionNumber) || '';
};

const resolveProgramTotalYearsFromExtras = (registrationExtras, course = '') => {
  const normalizedCourse = String(course || '').trim().toLowerCase();
  if (normalizedCourse === 'diploma' || normalizedCourse === 'polytechnic') return 3;
  const raw =
    registrationExtras?.program_total_years ??
    registrationExtras?.programTotalYears ??
    null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(8, Math.trunc(n));
  return 4;
};

const resolveJoiningAdmissionNumberFromDb = async (pool, joining) => {
  const leadData = parseLeadData(joining.lead_data);
  let admissionNumber = resolveJoiningAdmissionNumber(leadData);

  if (!admissionNumber && joining.lead_id) {
    const [leadRows] = await pool.execute(
      'SELECT admission_number FROM leads WHERE id = ? LIMIT 1',
      [joining.lead_id]
    );
    if (leadRows[0]?.admission_number) {
      admissionNumber = normalizeAdmissionNumberCandidate(leadRows[0].admission_number);
    }
  }

  if (!admissionNumber) {
    const [admRows] = await pool.execute(
      'SELECT admission_number FROM admissions WHERE joining_id = ? LIMIT 1',
      [joining.id]
    );
    if (admRows[0]?.admission_number) {
      admissionNumber = normalizeAdmissionNumberCandidate(admRows[0].admission_number);
    }
  }

  return admissionNumber;
};

const formatFeeRequestRow = (row) => ({
  id: row.id,
  joiningId: row.joining_id,
  leadId: row.lead_id,
  admissionNumber: row.admission_number || '',
  studentName: row.student_name || '',
  course: row.course || '',
  branch: row.branch || '',
  batch: row.batch || '',
  status: row.status,
  requestLines:
    typeof row.request_lines === 'string'
      ? JSON.parse(row.request_lines)
      : row.request_lines || [],
  accommodationType: row.accommodation_type || null,
  transportDetails:
    typeof row.transport_details === 'string'
      ? JSON.parse(row.transport_details)
      : row.transport_details || null,
  studentFeeDetails:
    typeof row.student_fee_details === 'string'
      ? JSON.parse(row.student_fee_details)
      : row.student_fee_details || null,
  submittedAt: row.submitted_at,
  submittedBy: row.submitted_by,
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
  rejectedAt: row.rejected_at,
  rejectedBy: row.rejected_by,
  rejectionReason: row.rejection_reason || '',
  reviewerNote: row.reviewer_note || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** GET /api/fee-requests?status=pending_approval|approved&page=&limit=&search= */
export const listFeeRequests = async (req, res) => {
  try {
    if (!canApproveFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to view fee requests', 403);
    }

    const status = String(req.query.status || 'pending_approval').trim();
    if (!['pending_approval', 'approved', 'rejected'].includes(status)) {
      return errorResponse(res, 'Invalid status filter', 400);
    }

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();

    const pool = getPool();
    const where = ['status = ?'];
    const params = [status];

    if (search) {
      where.push(
        '(student_name LIKE ? OR admission_number LIKE ? OR course LIKE ? OR branch LIKE ?)'
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM fee_requests ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total) || 0;

    const [rows] = await pool.execute(
      `SELECT * FROM fee_requests ${whereSql}
       ORDER BY COALESCE(submitted_at, created_at) DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return successResponse(res, {
      feeRequests: rows.map(formatFeeRequestRow),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error('listFeeRequests error:', error);
    return errorResponse(res, error.message || 'Failed to list fee requests', 500);
  }
};

/** POST /api/fee-requests/submit */
export const submitFeeRequest = async (req, res) => {
  try {
    if (!canSubmitFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to submit fee requests', 403);
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const joiningId = String(body.joiningId || body.joining_id || '').trim();
    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 400);
    }

    const studentFeeDetails = sanitizeStudentFeeDetailsForDb(body.studentFeeDetails);
    const registrationExtras =
      body.registrationFormData && typeof body.registrationFormData === 'object'
        ? body.registrationFormData
        : {};

    const pool = getPool();
    const [joiningRows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [
      joiningId,
    ]);
    if (!joiningRows.length) {
      return errorResponse(res, 'Joining not found', 404);
    }
    const joining = joiningRows[0];
    if (joining.status !== 'approved') {
      return errorResponse(res, 'Fee requests can only be submitted for approved joinings', 400);
    }

    const admissionNumber = await resolveJoiningAdmissionNumberFromDb(pool, joining);
    const syncContext = buildJoiningFeeSyncContext(
      joining,
      studentFeeDetails,
      registrationExtras,
      admissionNumber
    );
    const syncResult = await syncJoiningStudentFeeDetailsToFeeMongo({
      joiningId,
      leadId: joining.lead_id,
      studentFeeDetails,
      joiningContext: syncContext,
    });

    const revisedLines = (syncResult?.lines || []).filter((line) => line.isRevised);
    if (revisedLines.length === 0) {
      return errorResponse(
        res,
        'No revised fees to submit — revised amounts match the catalog fees',
        400
      );
    }

    const transportDetails = registrationExtras.transport_details || null;
    const accommodationType =
      transportDetails && typeof transportDetails === 'object'
        ? transportDetails.accommodationType || null
        : null;

    const [existingPending] = await pool.execute(
      `SELECT id FROM fee_requests WHERE joining_id = ? AND status = 'pending_approval' LIMIT 1`,
      [joiningId]
    );

    const payload = {
      lead_id: joining.lead_id || null,
      admission_number: admissionNumber,
      student_name: joining.student_name || '',
      course: joining.course || '',
      branch: joining.branch || '',
      batch: studentFeeDetails?.batch || syncContext.batch || '',
      status: 'pending_approval',
      request_lines: JSON.stringify(revisedLines),
      accommodation_type: accommodationType,
      transport_details: transportDetails ? JSON.stringify(transportDetails) : null,
      student_fee_details: studentFeeDetails ? JSON.stringify(studentFeeDetails) : null,
      submitted_at: new Date(),
      submitted_by: req.user.id,
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      approved_at: null,
      approved_by: null,
      reviewer_note: null,
    };

    if (existingPending.length > 0) {
      await pool.execute(
        `UPDATE fee_requests SET
          lead_id = ?, admission_number = ?, student_name = ?, course = ?, branch = ?, batch = ?,
          request_lines = ?, accommodation_type = ?, transport_details = ?, student_fee_details = ?,
          submitted_at = NOW(), submitted_by = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          payload.lead_id,
          payload.admission_number,
          payload.student_name,
          payload.course,
          payload.branch,
          payload.batch,
          payload.request_lines,
          payload.accommodation_type,
          payload.transport_details,
          payload.student_fee_details,
          payload.submitted_by,
          existingPending[0].id,
        ]
      );
      const [updated] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [
        existingPending[0].id,
      ]);
      return successResponse(res, formatFeeRequestRow(updated[0]), 'Fee request updated', 200);
    }

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO fee_requests (
        id, joining_id, lead_id, admission_number, student_name, course, branch, batch,
        status, request_lines, accommodation_type, transport_details, student_fee_details,
        submitted_at, submitted_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), NOW())`,
      [
        id,
        joiningId,
        payload.lead_id,
        payload.admission_number,
        payload.student_name,
        payload.course,
        payload.branch,
        payload.batch,
        payload.status,
        payload.request_lines,
        payload.accommodation_type,
        payload.transport_details,
        payload.student_fee_details,
        payload.submitted_by,
      ]
    );

    const [created] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [id]);
    return successResponse(res, formatFeeRequestRow(created[0]), 'Fee request submitted', 201);
  } catch (error) {
    console.error('submitFeeRequest error:', error);
    return errorResponse(res, error.message || 'Failed to submit fee request', 500);
  }
};

/** POST /api/fee-requests/:id/approve */
export const approveFeeRequest = async (req, res) => {
  try {
    if (!canApproveFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to approve fee requests', 403);
    }

    const { id } = req.params;
    const reviewerNote =
      typeof req.body?.reviewerNote === 'string' ? req.body.reviewerNote.trim().slice(0, 2000) : '';

    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM fee_requests WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return errorResponse(res, 'Fee request not found', 404);
    }
    const request = rows[0];
    if (request.status !== 'pending_approval') {
      return errorResponse(res, 'Only pending fee requests can be approved', 400);
    }

    const studentFeeDetails = sanitizeStudentFeeDetailsForDb(
      typeof request.student_fee_details === 'string'
        ? JSON.parse(request.student_fee_details)
        : request.student_fee_details
    );
    const transportDetails =
      typeof request.transport_details === 'string'
        ? JSON.parse(request.transport_details)
        : request.transport_details;

    const [joiningRows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [
      request.joining_id,
    ]);
    if (!joiningRows.length) {
      return errorResponse(res, 'Linked joining not found', 404);
    }
    const joining = joiningRows[0];

    let leadData = parseLeadData(joining.lead_data);
    const prevExtras =
      leadData._joiningRegistrationExtras && typeof leadData._joiningRegistrationExtras === 'object'
        ? { ...leadData._joiningRegistrationExtras }
        : {};
    const mergedExtras = {
      ...prevExtras,
      ...(transportDetails ? { transport_details: transportDetails } : {}),
    };

    leadData = {
      ...leadData,
      ...(Object.keys(mergedExtras).length > 0
        ? { _joiningRegistrationExtras: mergedExtras }
        : {}),
      ...(studentFeeDetails ? { _joiningStudentFeeDetails: studentFeeDetails } : {}),
    };

    await pool.execute(
      `UPDATE joinings SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(leadData), req.user.id, joining.id]
    );

    const syncContext = buildJoiningFeeSyncContext(joining, studentFeeDetails, mergedExtras);
    await syncJoiningStudentFeeDetailsToFeeMongo({
      joiningId: joining.id,
      leadId: joining.lead_id,
      studentFeeDetails,
      joiningContext: syncContext,
    });

    await pool.execute(
      `UPDATE fee_requests SET
        status = 'approved', approved_at = NOW(), approved_by = ?, reviewer_note = ?, updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, reviewerNote || null, id]
    );

    const [updated] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [id]);
    return successResponse(res, formatFeeRequestRow(updated[0]), 'Fee request approved', 200);
  } catch (error) {
    console.error('approveFeeRequest error:', error);
    return errorResponse(res, error.message || 'Failed to approve fee request', 500);
  }
};

/** POST /api/fee-requests/:id/reject */
export const rejectFeeRequest = async (req, res) => {
  try {
    if (!canApproveFeeRequest(req.user)) {
      return errorResponse(res, 'Not authorized to reject fee requests', 403);
    }

    const { id } = req.params;
    const reason =
      typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : '';

    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM fee_requests WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return errorResponse(res, 'Fee request not found', 404);
    }
    if (rows[0].status !== 'pending_approval') {
      return errorResponse(res, 'Only pending fee requests can be rejected', 400);
    }

    await pool.execute(
      `UPDATE fee_requests SET
        status = 'rejected', rejected_at = NOW(), rejected_by = ?, rejection_reason = ?, updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, reason || null, id]
    );

    const [updated] = await pool.execute('SELECT * FROM fee_requests WHERE id = ?', [id]);
    return successResponse(res, formatFeeRequestRow(updated[0]), 'Fee request rejected', 200);
  } catch (error) {
    console.error('rejectFeeRequest error:', error);
    return errorResponse(res, error.message || 'Failed to reject fee request', 500);
  }
};

/** GET /api/fee-requests/joining/:joiningId/pending — check pending for a joining */
export const getPendingFeeRequestForJoining = async (req, res) => {
  try {
    const joiningId = String(req.params.joiningId || '').trim();
    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 400);
    }

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT * FROM fee_requests WHERE joining_id = ? AND status = 'pending_approval' ORDER BY submitted_at DESC LIMIT 1`,
      [joiningId]
    );

    return successResponse(res, rows.length ? formatFeeRequestRow(rows[0]) : null);
  } catch (error) {
    console.error('getPendingFeeRequestForJoining error:', error);
    return errorResponse(res, error.message || 'Failed to load fee request', 500);
  }
};
