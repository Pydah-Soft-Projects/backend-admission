import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { v4 as uuidv4 } from 'uuid';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import { updatePerformanceMetric } from '../services/userPerformance.service.js';
import smsService from '../services/sms.service.js';
import ExcelJS from 'exceljs';

const ensureLeadId = (leadId) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    const error = new Error('Invalid lead identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ensureAdmissionId = (admissionId) => {
  if (!admissionId || typeof admissionId !== 'string' || admissionId.length !== 36) {
    const error = new Error('Invalid admission identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ADMISSION_CANCELLED_STATUS = 'Admission Cancelled';

const parseAdmissionLeadData = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
};

// Helper function to format lead data from SQL
const formatLead = (leadData) => {
  if (!leadData) return null;
  return {
    _id: leadData.id,
    id: leadData.id,
    enquiryNumber: leadData.enquiry_number,
    name: leadData.name,
    phone: leadData.phone,
    fatherName: leadData.father_name,
    fatherPhone: leadData.father_phone,
    leadStatus: leadData.lead_status,
    admissionNumber: leadData.admission_number,
  };
};

// Helper function to format admission data from SQL (exported for one-off resync scripts)
export const formatAdmission = async (admissionData, pool) => {
  if (!admissionData) return null;

  const admissionId = admissionData.id;

  // Fetch related data
  const [relatives] = await pool.execute(
    'SELECT * FROM admission_relatives WHERE admission_id = ?',
    [admissionId]
  );

  const [educationHistory] = await pool.execute(
    'SELECT * FROM admission_education_history WHERE admission_id = ? ORDER BY created_at ASC',
    [admissionId]
  );

  const [siblings] = await pool.execute(
    'SELECT * FROM admission_siblings WHERE admission_id = ? ORDER BY created_at ASC',
    [admissionId]
  );

  // Parse JSON fields
  const leadDataRaw = typeof admissionData.lead_data === 'string'
    ? JSON.parse(admissionData.lead_data)
    : admissionData.lead_data || {};
  const registrationFormData =
    leadDataRaw &&
    typeof leadDataRaw === 'object' &&
    leadDataRaw._joiningRegistrationExtras &&
    typeof leadDataRaw._joiningRegistrationExtras === 'object'
      ? leadDataRaw._joiningRegistrationExtras
      : {};
  const leadData =
    leadDataRaw && typeof leadDataRaw === 'object'
      ? (() => {
          const {
            _joiningRegistrationExtras,
            _joiningProgramLevel,
            _joiningManagedCourseId,
            _joiningManagedBranchId,
            ...rest
          } = leadDataRaw;
          return rest;
        })()
      : leadDataRaw;

  const reservationOther = typeof admissionData.reservation_other === 'string'
    ? JSON.parse(admissionData.reservation_other)
    : admissionData.reservation_other || [];

  const qualificationMediums = typeof admissionData.qualification_mediums === 'string'
    ? JSON.parse(admissionData.qualification_mediums)
    : admissionData.qualification_mediums || [];

  return {
    _id: admissionData.id,
    id: admissionData.id,
    leadId: admissionData.lead_id,
    enquiryNumber: admissionData.enquiry_number,
    leadData,
    registrationFormData,
    joiningId: admissionData.joining_id,
    admissionNumber: admissionData.admission_number,
    status: admissionData.status,
    admissionDate: admissionData.admission_date,
    courseInfo: {
      // Coerce to strings so frontend equality checks against `courseSettings`
      // (where `course._id` is always stringified) keep working for legacy
      // admissions saved with raw INT FK ids.
      courseId:
        admissionData.course_id != null && String(admissionData.course_id).trim() !== ''
          ? String(admissionData.course_id).trim()
          : null,
      branchId:
        admissionData.branch_id != null && String(admissionData.branch_id).trim() !== ''
          ? String(admissionData.branch_id).trim()
          : null,
      course: admissionData.course || '',
      branch: admissionData.branch || '',
      quota: admissionData.quota || '',
    },
    paymentSummary: {
      totalFee: Number(admissionData.payment_total_fee) || 0,
      totalPaid: Number(admissionData.payment_total_paid) || 0,
      balance: Number(admissionData.payment_balance) || 0,
      currency: admissionData.payment_currency || 'INR',
      status: admissionData.payment_status || 'not_started',
      lastPaymentAt: admissionData.payment_last_payment_at,
    },
    studentInfo: {
      name: admissionData.student_name || '',
      phone: admissionData.student_phone || '',
      gender: admissionData.student_gender || '',
      dateOfBirth: admissionData.student_date_of_birth || '',
      notes: admissionData.student_notes || '',
      aadhaarNumber: admissionData.student_aadhaar_number || '',
    },
    parents: {
      father: {
        name: admissionData.father_name || '',
        phone: admissionData.father_phone || '',
        aadhaarNumber: admissionData.father_aadhaar_number || '',
      },
      mother: {
        name: admissionData.mother_name || '',
        phone: admissionData.mother_phone || '',
        aadhaarNumber: admissionData.mother_aadhaar_number || '',
      },
    },
    reservation: {
      general: admissionData.reservation_general || 'oc',
      isEws: admissionData.reservation_is_ews === 1 || admissionData.reservation_is_ews === true,
      other: reservationOther,
    },
    address: {
      communication: {
        doorOrStreet: admissionData.address_door_street || '',
        landmark: admissionData.address_landmark || '',
        villageOrCity: admissionData.address_village_city || '',
        mandal: admissionData.address_mandal || '',
        district: admissionData.address_district || '',
        pinCode: admissionData.address_pin_code || '',
      },
      relatives: relatives.map((rel) => ({
        name: rel.name || '',
        relationship: rel.relationship || '',
        doorOrStreet: rel.door_street || '',
        landmark: rel.landmark || '',
        villageOrCity: rel.village_city || '',
        mandal: rel.mandal || '',
        district: rel.district || '',
        pinCode: rel.pin_code || '',
      })),
    },
    qualifications: {
      ssc: admissionData.qualification_ssc === 1 || admissionData.qualification_ssc === true,
      interOrDiploma: admissionData.qualification_inter_diploma === 1 || admissionData.qualification_inter_diploma === true,
      ug: admissionData.qualification_ug === 1 || admissionData.qualification_ug === true,
      mediums: qualificationMediums,
      otherMediumLabel: admissionData.qualification_other_medium_label || '',
    },
    educationHistory: educationHistory.map((edu) => ({
      level: edu.level,
      otherLevelLabel: edu.other_level_label || '',
      courseOrBranch: edu.course_or_branch || '',
      yearOfPassing: edu.year_of_passing || '',
      institutionName: edu.institution_name || '',
      institutionAddress: edu.institution_address || '',
      hallTicketNumber: edu.hall_ticket_number || '',
      totalMarksOrGrade: edu.total_marks_or_grade || '',
      cetRank: edu.cet_rank || '',
    })),
    siblings: siblings.map((sib) => ({
      name: sib.name || '',
      relation: sib.relation || '',
      studyingStandard: sib.studying_standard || '',
      institutionName: sib.institution_name || '',
    })),
    documents: {
      ssc: admissionData.document_ssc || 'pending',
      inter: admissionData.document_inter || 'pending',
      ugPgCmm: admissionData.document_ug_pg_cmm || 'pending',
      transferCertificate: admissionData.document_transfer_certificate || 'pending',
      studyCertificate: admissionData.document_study_certificate || 'pending',
      aadhaarCard: admissionData.document_aadhaar_card || 'pending',
      photos: admissionData.document_photos || 'pending',
      incomeCertificate: admissionData.document_income_certificate || 'pending',
      casteCertificate: admissionData.document_caste_certificate || 'pending',
      cetRankCard: admissionData.document_cet_rank_card || 'pending',
      cetHallTicket: admissionData.document_cet_hall_ticket || 'pending',
      allotmentLetter: admissionData.document_allotment_letter || 'pending',
      joiningReport: admissionData.document_joining_report || 'pending',
      bankPassbook: admissionData.document_bank_passbook || 'pending',
      rationCard: admissionData.document_ration_card || 'pending',
    },
    createdBy: admissionData.created_by,
    updatedBy: admissionData.updated_by,
    createdAt: admissionData.created_at,
    updatedAt: admissionData.updated_at,
  };
};

const validateAdmissionPayload = (payload = {}) => {
  const errors = [];
  if (!payload.studentInfo?.name) {
    errors.push('Student name is required');
  }
  if (!payload.reservation?.general) {
    errors.push('General reservation category is required');
  }
  return errors;
};

const resolvePrimaryCourseBranchIds = async (pool, courseId, branchId) => {
  let resolvedCourseId =
    courseId !== undefined && courseId !== null && String(courseId).trim() !== ''
      ? courseId
      : null;
  let resolvedBranchId =
    branchId !== undefined && branchId !== null && String(branchId).trim() !== ''
      ? branchId
      : null;

  if (resolvedCourseId != null) {
    const [courses] = await pool.execute('SELECT id FROM courses WHERE id = ? LIMIT 1', [
      resolvedCourseId,
    ]);
    if (courses.length === 0) resolvedCourseId = null;
  }

  if (resolvedBranchId != null) {
    const [branches] = await pool.execute(
      'SELECT id, course_id FROM branches WHERE id = ? LIMIT 1',
      [resolvedBranchId]
    );
    if (branches.length === 0) {
      resolvedBranchId = null;
    } else if (
      resolvedCourseId != null &&
      branches[0].course_id != null &&
      String(branches[0].course_id) !== String(resolvedCourseId)
    ) {
      resolvedBranchId = null;
    } else if (resolvedCourseId == null) {
      resolvedCourseId = branches[0].course_id ?? null;
    }
  }

  if (resolvedCourseId == null) resolvedBranchId = null;
  return { resolvedCourseId, resolvedBranchId };
};

const formatAdmissionListItem = (row) => ({
  _id: row.id,
  id: row.id,
  leadId: row.lead_id,
  joiningId: row.joining_id,
  admissionNumber: row.admission_number,
  status: row.status,
  courseInfo: {
    courseId:
      row.course_id != null && String(row.course_id).trim() !== ''
        ? String(row.course_id).trim()
        : null,
    branchId:
      row.branch_id != null && String(row.branch_id).trim() !== ''
        ? String(row.branch_id).trim()
        : null,
    course: row.course || '',
    branch: row.branch || '',
    quota: row.quota || '',
  },
  studentInfo: {
    name: row.student_name || row.lead_name || '',
    phone: row.student_phone || row.lead_phone || '',
  },
  reservation: {
    general: row.reservation_general || 'oc',
    other: row.reservation_other ? (typeof row.reservation_other === 'string' ? JSON.parse(row.reservation_other) : row.reservation_other) : [],
  },
  paymentSummary: {
    totalPaid: Number(row.payment_total_paid) || 0,
  },
  documents: {
    ssc: row.document_ssc,
    inter: row.document_inter,
    ugPgCmm: row.document_ug_pg_cmm,
    transferCertificate: row.document_transfer_certificate,
    studyCertificate: row.document_study_certificate,
    aadhaarCard: row.document_aadhaar_card,
    photos: row.document_photos,
    incomeCertificate: row.document_income_certificate,
    casteCertificate: row.document_caste_certificate,
    cetRankCard: row.document_cet_rank_card,
    cetHallTicket: row.document_cet_hall_ticket,
    allotmentLetter: row.document_allotment_letter,
    joiningReport: row.document_joining_report,
    bankPassbook: row.document_bank_passbook,
    rationCard: row.document_ration_card,
  },
  leadSource: row.lead_source || '',
  updatedAt: row.updated_at,
  createdAt: row.created_at,
});

// Helper function to save admission related tables
const saveAdmissionRelatedTables = async (pool, admissionId, payload) => {

  // Delete existing related records
  await pool.execute('DELETE FROM admission_relatives WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_education_history WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_siblings WHERE admission_id = ?', [admissionId]);

  // Insert relatives
  if (Array.isArray(payload.address?.relatives)) {
    for (const relative of payload.address.relatives) {
      const relativeId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_relatives (id, admission_id, name, relationship, door_street, landmark,
         village_city, mandal, district, pin_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          relativeId,
          admissionId,
          relative.name || '',
          relative.relationship || '',
          relative.doorOrStreet || '',
          relative.landmark || '',
          relative.villageOrCity || '',
          relative.mandal || '',
          relative.district || '',
          relative.pinCode || '',
        ]
      );
    }
  }

  // Insert education history
  if (Array.isArray(payload.educationHistory)) {
    for (const edu of payload.educationHistory) {
      const eduId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_education_history (id, admission_id, level, other_level_label,
         course_or_branch, year_of_passing, institution_name, institution_address,
         hall_ticket_number, total_marks_or_grade, cet_rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eduId,
          admissionId,
          edu.level,
          edu.otherLevelLabel || '',
          edu.courseOrBranch || '',
          edu.yearOfPassing || '',
          edu.institutionName || '',
          edu.institutionAddress || '',
          edu.hallTicketNumber || '',
          edu.totalMarksOrGrade || '',
          edu.cetRank || '',
        ]
      );
    }
  }

  // Insert siblings
  if (Array.isArray(payload.siblings)) {
    for (const sib of payload.siblings) {
      const sibId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_siblings (id, admission_id, name, relation, studying_standard,
         institution_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          sibId,
          admissionId,
          sib.name || '',
          sib.relation || '',
          sib.studyingStandard || '',
          sib.institutionName || '',
        ]
      );
    }
  }
};

export const listAdmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status, courseId, branchId, courseName, branchName,
    } = req.query;

    const pool = getPool();
    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Number(page) - 1) * paginationLimit;

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Status filtering
    if (status) {
      conditions.push('a.status = ?');
      params.push(status);
    }
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push('(a.course_id = ? OR a.course = ?)');
        params.push(courseId, courseName);
      } else {
        conditions.push('(a.course_id = ? OR a.course = ?)');
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push('(a.branch_id = ? OR a.branch = ?)');
        params.push(branchId, branchName);
      } else {
        conditions.push('(a.branch_id = ? OR a.branch = ?)');
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    // Search filtering
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(`(
        a.admission_number LIKE ? OR
        l.name LIKE ? OR l.phone LIKE ? OR l.hall_ticket_number LIKE ? OR l.enquiry_number LIKE ?
        OR JSON_EXTRACT(a.lead_data, "$.name") LIKE ? OR JSON_EXTRACT(a.lead_data, "$.phone") LIKE ?
        OR JSON_EXTRACT(a.lead_data, "$.hallTicketNumber") LIKE ? OR JSON_EXTRACT(a.lead_data, "$.enquiryNumber") LIKE ?
        OR a.student_name LIKE ? OR a.student_phone LIKE ?
      )`);
      params.push(
        searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total
       FROM admissions a
       LEFT JOIN leads l ON a.lead_id = l.id
       ${whereClause}`,
      params
    );
    const total = countResult[0]?.total || 0;

    // Get paginated results.
    // Keep this query narrow (avoid a.*) so MySQL does not sort huge TEXT/BLOB payloads.
    const [admissions] = await pool.execute(
      `SELECT a.id, a.lead_id, a.joining_id, a.admission_number, a.status,
              a.course_id, a.branch_id, a.course, a.branch, a.quota,
              a.student_name, a.student_phone, a.created_at, a.updated_at,
              a.reservation_general, a.reservation_other, a.payment_total_paid,
              a.document_ssc, a.document_inter, a.document_ug_pg_cmm, a.document_transfer_certificate,
              a.document_study_certificate, a.document_aadhaar_card, a.document_photos,
              a.document_income_certificate, a.document_caste_certificate, a.document_cet_rank_card,
              a.document_cet_hall_ticket, a.document_allotment_letter, a.document_joining_report,
              a.document_bank_passbook, a.document_ration_card,
              l.name as lead_name, l.phone as lead_phone, l.source as lead_source
       FROM admissions a
       LEFT JOIN leads l ON a.lead_id = l.id
       ${whereClause}
       ORDER BY a.updated_at DESC
       LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`,
      params
    );

    const formattedAdmissions = admissions.map(formatAdmissionListItem);

    return successResponse(
      res,
      {
        admissions: formattedAdmissions,
        pagination: {
          page: Number(page),
          limit: paginationLimit,
          total,
          pages: Math.ceil(total / paginationLimit) || 1,
        },
      },
      'Admissions retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing admissions:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list admissions',
      error.statusCode || 500
    );
  }
};

export const getAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByJoiningId = async (req, res) => {
  try {
    const { joiningId } = req.params;
    if (!joiningId || typeof joiningId !== 'string' || joiningId.length !== 36) {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    const pool = getPool();

    // Fetch admission by joining_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE joining_id = ?',
      [joiningId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this joining', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    // Fetch admission by lead_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ?',
      [leadId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead
    const [leads] = await pool.execute(
      `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number
       FROM leads WHERE id = ?`,
      [leadId]
    );

    const lead = leads.length > 0 ? formatLead(leads[0]) : null;

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const cancelAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const reason = String(req.body?.reason || '').trim();
    const approvedBy = String(req.body?.approvedBy || '').trim();

    if (!reason) {
      return errorResponse(res, 'Reason for cancellation is required', 400);
    }

    if (!approvedBy) {
      return errorResponse(res, 'Approved by is required', 400);
    }

    const pool = getPool();
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const existingLeadData = parseAdmissionLeadData(admissionData.lead_data);
    const cancellation = {
      reason,
      approvedBy,
      cancelledAt: new Date().toISOString(),
      cancelledBy: req.user.id,
    };
    const nextLeadData = {
      ...existingLeadData,
      _admissionCancellation: cancellation,
    };

    await pool.execute(
      `UPDATE admissions
       SET status = ?, lead_data = ?, updated_by = ?, updated_at = NOW()
       WHERE id = ?`,
      [ADMISSION_CANCELLED_STATUS, JSON.stringify(nextLeadData), req.user.id, admissionId]
    );

    if (admissionData.lead_id) {
      await pool.execute(
        `UPDATE leads
         SET application_status = ?, updated_at = NOW()
         WHERE id = ?`,
        [ADMISSION_CANCELLED_STATUS, admissionData.lead_id]
      );
    }

    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
      leadId: formattedAdmission.leadId,
      joiningId: formattedAdmission.joiningId,
      email: formattedAdmission.leadData?.email || ''
    });

    return successResponse(
      res,
      formattedAdmission,
      'Admission cancelled successfully',
      200
    );
  } catch (error) {
    console.error('Error cancelling admission:', error);
    return errorResponse(
      res,
      error.message || 'Failed to cancel admission',
      error.statusCode || 500
    );
  }
};

/**
 * Send the DLT-approved admission confirmation SMS to the student on demand.
 *
 * Wired to "Send Admission SMS" on the admission detail page so staff can
 * (re)trigger the message for any admission that already exists in the DB —
 * including ones approved before the auto-send was wired into `approveJoining`.
 *
 * The send is fully synchronous so the UI can surface success / failure /
 * skip reasons via toast. We never throw on gateway errors; instead we return
 * a structured payload that the frontend can show to the user.
 */
export const sendAdmissionConfirmationSmsById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, status, admission_number, student_name, student_phone, lead_id, lead_data
       FROM admissions WHERE id = ?`,
      [admissionId]
    );

    if (rows.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admission = rows[0];
    if (admission.status === ADMISSION_CANCELLED_STATUS) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — admission is cancelled.',
        400
      );
    }

    const admissionNumber = String(admission.admission_number || '').trim();
    if (!admissionNumber) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — admission number is missing on this record.',
        400
      );
    }

    // Fall back to the lead row if studentInfo on the admission is sparse.
    let studentName = String(admission.student_name || '').trim();
    let studentPhone = String(admission.student_phone || '').trim();
    if ((!studentName || !studentPhone) && admission.lead_id) {
      const [leadRows] = await pool.execute(
        'SELECT name, phone FROM leads WHERE id = ? LIMIT 1',
        [admission.lead_id]
      );
      if (leadRows.length > 0) {
        if (!studentName) studentName = String(leadRows[0].name || '').trim();
        if (!studentPhone) studentPhone = String(leadRows[0].phone || '').trim();
      }
    }

    if (!studentPhone) {
      return errorResponse(
        res,
        'Cannot send confirmation SMS — student phone is not on file for this admission.',
        400
      );
    }

    const result = await smsService.sendAdmissionConfirmation(
      studentPhone,
      studentName || 'Student',
      admissionNumber
    );

    if (!result?.success) {
      const reasonMap = {
        template_not_found:
          'Confirmation SMS template is not registered. Run `npm run migrate:admission-confirmation-sms-template` and try again.',
        invalid_mobile_number: 'Cannot send confirmation SMS — student phone is not a valid 10-digit number.',
        missing_admission_number: 'Cannot send confirmation SMS — admission number is missing.',
        gateway_rejected:
          `SMS gateway rejected the request${result?.gatewayMessage ? `: ${result.gatewayMessage}` : ''}. ` +
          'Verify that DLT template id is whitelisted on the BulkSMSApps account and that sender id matches.',
      };
      const message =
        reasonMap[result?.error] ||
        `Failed to send confirmation SMS${result?.error ? `: ${result.error}` : ''}.`;
      return errorResponse(res, message, 502);
    }

    return successResponse(
      res,
      {
        sentTo: studentPhone.replace(/\D/g, '').slice(-10),
        admissionNumber,
        gateway: result.data ?? null,
      },
      'Admission confirmation SMS sent.',
      200
    );
  } catch (error) {
    console.error('Error sending admission confirmation SMS:', error);
    return errorResponse(
      res,
      error.message || 'Failed to send admission confirmation SMS',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };

    // Build dynamic UPDATE query
    const updateFields = [];
    const updateParams = [];

    // Main admission fields
    if (payload.courseInfo !== undefined) {
      const { resolvedCourseId, resolvedBranchId } = await resolvePrimaryCourseBranchIds(
        pool,
        payload.courseInfo.courseId,
        payload.courseInfo.branchId
      );
      if (payload.courseInfo.courseId !== undefined) {
        updateFields.push('course_id = ?');
        updateParams.push(resolvedCourseId);
      }
      if (payload.courseInfo.branchId !== undefined) {
        updateFields.push('branch_id = ?');
        updateParams.push(resolvedBranchId);
      }
      if (payload.courseInfo.course !== undefined) {
        updateFields.push('course = ?');
        updateParams.push(payload.courseInfo.course || '');
      }
      if (payload.courseInfo.branch !== undefined) {
        updateFields.push('branch = ?');
        updateParams.push(payload.courseInfo.branch || '');
      }
      if (payload.courseInfo.quota !== undefined) {
        updateFields.push('quota = ?');
        updateParams.push(payload.courseInfo.quota || '');
      }
    }

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(payload.studentInfo.dateOfBirth || '');
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || 'oc');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
      if (payload.reservation.isEws !== undefined) {
        updateFields.push('reservation_is_ews = ?');
        updateParams.push(payload.reservation.isEws === true ? 1 : 0);
      }
    }

    if (payload.address?.communication !== undefined) {
      const comm = payload.address.communication;
      if (comm.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (comm.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (comm.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (comm.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (comm.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (comm.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    // Sync to secondary DB
    await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
      leadId: formattedAdmission.leadId,
      joiningId: formattedAdmission.joiningId,
      email: formattedAdmission.leadData?.email || ''
    });

    return successResponse(
      res,
      formattedAdmission,
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    // Fetch admission by lead_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ?',
      [leadId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const admissionId = admissions[0].id;

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };

    // Build dynamic UPDATE query (same as updateAdmissionById)
    const updateFields = [];
    const updateParams = [];

    // Main admission fields (same logic as updateAdmissionById)
    if (payload.courseInfo !== undefined) {
      const { resolvedCourseId, resolvedBranchId } = await resolvePrimaryCourseBranchIds(
        pool,
        payload.courseInfo.courseId,
        payload.courseInfo.branchId
      );
      if (payload.courseInfo.courseId !== undefined) {
        updateFields.push('course_id = ?');
        updateParams.push(resolvedCourseId);
      }
      if (payload.courseInfo.branchId !== undefined) {
        updateFields.push('branch_id = ?');
        updateParams.push(resolvedBranchId);
      }
      if (payload.courseInfo.course !== undefined) {
        updateFields.push('course = ?');
        updateParams.push(payload.courseInfo.course || '');
      }
      if (payload.courseInfo.branch !== undefined) {
        updateFields.push('branch = ?');
        updateParams.push(payload.courseInfo.branch || '');
      }
      if (payload.courseInfo.quota !== undefined) {
        updateFields.push('quota = ?');
        updateParams.push(payload.courseInfo.quota || '');
      }
    }

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(payload.studentInfo.dateOfBirth || '');
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || 'oc');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
    }

    if (payload.address?.communication !== undefined) {
      const comm = payload.address.communication;
      if (comm.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (comm.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (comm.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (comm.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (comm.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (comm.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    // Sync to secondary DB
    await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
      leadId: formattedAdmission.leadId,
      joiningId: formattedAdmission.joiningId,
      email: formattedAdmission.leadData?.email || ''
    });

    return successResponse(
      res,
      formattedAdmission,
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};

export const getAdmissionStats = async (req, res) => {
  try {
    const { startDate, endDate, courseId, branchId, courseName, branchName } = req.query;
    const pool = getPool();
    const conditions = [];
    const params = [];
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(new Date(startDate));
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      const end = new Date(endDate);
      end.setDate(end.getDate() + 1);
      params.push(end);
    }
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push('(course_id = ? OR course = ?)');
        params.push(courseId, courseName);
      } else {
        conditions.push('(course_id = ? OR course = ?)');
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push('(branch_id = ? OR branch = ?)');
        params.push(branchId, branchName);
      } else {
        conditions.push('(branch_id = ? OR branch = ?)');
        const val = branchId || branchName;
        params.push(val, val);
      }
    }
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const query = `
      SELECT 
        course_id as courseId, 
        MAX(course) as courseName,
        COUNT(CASE WHEN status != 'Admission Cancelled' THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN status = 'Admission Cancelled' THEN 1 END) as totalCancelled
      FROM admissions
      ${whereClause}
      GROUP BY course_id, course
      ORDER BY totalAdmissions DESC
    `;
    const [stats] = await pool.execute(query, params);

    const queryBranches = `
      SELECT 
        course_id as courseId,
        branch_id as branchId,
        MAX(course) as courseName,
        MAX(branch) as branchName,
        COUNT(CASE WHEN status != 'Admission Cancelled' THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN status = 'Admission Cancelled' THEN 1 END) as totalCancelled
      FROM admissions
      ${whereClause}
      GROUP BY course_id, course, branch_id, branch
      ORDER BY courseName, branchName
    `;
    const [branchStats] = await pool.execute(queryBranches, params);
    const courseStats = stats.map(course => ({
      ...course,
      branches: branchStats.filter(b => b.courseId === course.courseId && b.courseName === course.courseName)
    }));
    return successResponse(res, { stats: courseStats }, 'Admission stats retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting admission stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission stats', 500);
  }
};

/**
 * @desc    Export admissions to Excel
 * @route   GET /api/admissions/export
 * @access  Private (Super Admin)
 */
export const exportAdmissions = async (req, res) => {
  try {
    const pool = getPool();
    const { 
      search, 
      status, 
      startDate, 
      endDate, 
      courseId, 
      branchId,
      courseName,
      branchName
    } = req.query;

    const conditions = [];
    const params = [];


    if (status && status !== 'all') {
      conditions.push('a.status = ?');
      params.push(status);
    }

    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push('(a.course_id = ? OR a.course = ?)');
        params.push(courseId, courseName);
      } else {
        conditions.push('(a.course_id = ? OR a.course = ?)');
        const val = courseId || courseName;
        params.push(val, val);
      }
    }

    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push('(a.branch_id = ? OR a.branch = ?)');
        params.push(branchId, branchName);
      } else {
        conditions.push('(a.branch_id = ? OR a.branch = ?)');
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    if (startDate) {
      conditions.push('a.created_at >= ?');
      params.push(`${startDate} 00:00:00`);
    }

    if (endDate) {
      conditions.push('a.created_at <= ?');
      params.push(`${endDate} 23:59:59`);
    }

    if (search) {
      const searchTerm = `%${search.trim()}%`;
      conditions.push('(a.student_name LIKE ? OR a.admission_number LIKE ? OR a.student_phone LIKE ?)');
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT a.* 
      FROM admissions a
      ${whereClause}
      ORDER BY a.created_at DESC
    `;

    // Increase sort buffer for this session to handle large rows (e.g., 1MB+)
    await pool.execute('SET SESSION sort_buffer_size = 4194304'); // 4MB

    const [rows] = await pool.execute(query, params);

    // Format all admissions
    const formattedAdmissions = await Promise.all(
      rows.map(row => formatAdmission(row, pool))
    );

    // Create Excel Workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Admissions');

    // Define Columns
    worksheet.columns = [
      { header: 'Admission #', key: 'admissionNumber', width: 15 },
      { header: 'Timestamp', key: 'createdAt', width: 20 },
      { header: 'Student Name', key: 'studentName', width: 25 },
      { header: 'Contact No', key: 'studentPhone', width: 15 },
      { header: 'Course', key: 'course', width: 20 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Quota', key: 'quota', width: 15 },
      { header: 'Reservation (General)', key: 'reservationGeneral', width: 20 },
      { header: 'Reservation (Other)', key: 'reservationOther', width: 20 },
      { header: 'EWS', key: 'isEws', width: 10 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total Fee', key: 'totalFee', width: 15 },
      { header: 'Total Paid', key: 'totalPaid', width: 15 },
      { header: 'Balance', key: 'balance', width: 15 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'SSC Result', key: 'sscResult', width: 10 },
      { header: 'SSC Passed Year', key: 'sscPassedYear', width: 15 },
      { header: 'Intermediate Passed Year', key: 'interPassedYear', width: 15 },
    ];

    // Add Rows
    formattedAdmissions.forEach(record => {
      const reservationOther = Array.isArray(record.reservation?.other) 
        ? record.reservation.other.join(', ') 
        : (record.reservation?.other || '');

      worksheet.addRow({
        admissionNumber: record.admissionNumber,
        createdAt: record.createdAt ? new Date(record.createdAt).toLocaleString() : '',
        studentName: record.studentInfo?.name || '',
        studentPhone: record.studentInfo?.phone || '',
        course: record.courseInfo?.course || '',
        branch: record.courseInfo?.branch || '',
        quota: record.courseInfo?.quota || '',
        reservationGeneral: record.reservation?.general || 'OC',
        reservationOther: reservationOther,
        isEws: record.reservation?.isEws ? 'Yes' : 'No',
        status: record.status || '',
        totalFee: record.paymentSummary?.totalFee || 0,
        totalPaid: record.paymentSummary?.totalPaid || 0,
        balance: (record.paymentSummary?.totalFee || 0) - (record.paymentSummary?.totalPaid || 0),
        source: record.leadData?.source || 'Direct',
        sscResult: record.educationHistory?.[0]?.gradeOrPercentage || '',
        sscPassedYear: record.educationHistory?.[0]?.yearOfPassing || '',
        interPassedYear: record.educationHistory?.[1]?.yearOfPassing || '',
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
      'attachment; filename=admissions_export.xlsx'
    );

    // Write to stream
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error exporting admissions:', error);
    if (!res.headersSent) {
      return errorResponse(res, error.message || 'Failed to export admissions', 500);
    }
  }
};
