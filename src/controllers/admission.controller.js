import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { v4 as uuidv4 } from 'uuid';
import { hydrateUserRowsFromHrms } from './user.controller.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import { updatePerformanceMetric } from '../services/userPerformance.service.js';
import smsService from '../services/sms.service.js';
import ExcelJS from 'exceljs';
import {
  FATHER_PHOTO_REG_KEYS,
  MOTHER_PHOTO_REG_KEYS,
} from '../utils/joiningParentPhotos.util.js';

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

/** Primary `course_id` when set; else student-DB id in `managed_course_id` (no FK). Same for branch. */
const SQL_A_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(a.course_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.managed_course_id AS CHAR)), ''))`;
const SQL_A_EFF_BRANCH_ID = `COALESCE(NULLIF(TRIM(CAST(a.branch_id AS CHAR)), ''), NULLIF(TRIM(CAST(a.managed_branch_id AS CHAR)), ''))`;
const SQL_EFF_COURSE_ID = `COALESCE(NULLIF(TRIM(CAST(course_id AS CHAR)), ''), NULLIF(TRIM(CAST(managed_course_id AS CHAR)), ''))`;
const SQL_EFF_BRANCH_ID = `COALESCE(NULLIF(TRIM(CAST(branch_id AS CHAR)), ''), NULLIF(TRIM(CAST(managed_branch_id AS CHAR)), ''))`;

/** Valid JSON object for lead_data on admissions (alias `a`). */
const SQL_A_LEAD_DATA_JSON = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
/** Excel / student Reference 1 from lead_data. */
const SQL_A_REFERENCE1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA_JSON}, '$.reference1'))), '')`;
/** Business admission date; falls back to record created_at when not set. */
const SQL_A_EFFECTIVE_ADMISSION_DATE = `COALESCE(a.admission_date, a.created_at)`;

const normalizeManagedIdForDb = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

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

const qualificationMeritFromSql = (value) => {
  if (value === null || value === undefined) return null;
  if (value === 1 || value === true) return true;
  return false;
};

const qualificationMeritToSql = (merit) => {
  if (merit === true) return 1;
  if (merit === false) return 0;
  return null;
};

function pickFromRegistrationFormData(registrationFormData, keys) {
  if (!registrationFormData || typeof registrationFormData !== 'object') return '';
  const want = new Set(keys.map((k) => String(k).toLowerCase()));
  for (const [k, v] of Object.entries(registrationFormData)) {
    if (!want.has(String(k).toLowerCase())) continue;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

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
  let registrationFormData =
    leadDataRaw &&
    typeof leadDataRaw === 'object' &&
    leadDataRaw._joiningRegistrationExtras &&
    typeof leadDataRaw._joiningRegistrationExtras === 'object'
      ? { ...leadDataRaw._joiningRegistrationExtras }
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

  const fromRegFatherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    FATHER_PHOTO_REG_KEYS
  );
  const fromRegMotherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    MOTHER_PHOTO_REG_KEYS
  );
  const colFatherPhoto = String(admissionData.father_photo || '').trim();
  const colMotherPhoto = String(admissionData.mother_photo || '').trim();
  const fatherPortrait = (fromRegFatherPhoto || colFatherPhoto || '').trim();
  const motherPortrait = (fromRegMotherPhoto || colMotherPhoto || '').trim();
  if (colFatherPhoto && !fromRegFatherPhoto) {
    registrationFormData = { ...registrationFormData, father_photo: colFatherPhoto };
  }
  if (colMotherPhoto && !fromRegMotherPhoto) {
    registrationFormData = { ...registrationFormData, mother_photo: colMotherPhoto };
  }

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
          : admissionData.managed_course_id != null &&
              String(admissionData.managed_course_id).trim() !== ''
            ? String(admissionData.managed_course_id).trim()
            : null,
      branchId:
        admissionData.branch_id != null && String(admissionData.branch_id).trim() !== ''
          ? String(admissionData.branch_id).trim()
          : admissionData.managed_branch_id != null &&
              String(admissionData.managed_branch_id).trim() !== ''
            ? String(admissionData.managed_branch_id).trim()
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
        photo: fatherPortrait,
      },
      mother: {
        name: admissionData.mother_name || '',
        phone: admissionData.mother_phone || '',
        aadhaarNumber: admissionData.mother_aadhaar_number || '',
        photo: motherPortrait,
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
      merit: qualificationMeritFromSql(admissionData.qualification_merit),
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
  if (payload.courseInfo !== undefined && payload.courseInfo !== null && typeof payload.courseInfo === 'object') {
    const cid = String(payload.courseInfo.courseId ?? '').trim();
    const bid = String(payload.courseInfo.branchId ?? '').trim();
    if (!cid) {
      errors.push('Managed course selection is required');
    }
    if (!bid) {
      errors.push('Managed branch selection is required');
    }
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

async function applyAdmissionCourseInfoUpdates(pool, courseInfo, updateFields, updateParams) {
  if (!courseInfo || typeof courseInfo !== 'object') return;
  const { resolvedCourseId, resolvedBranchId } = await resolvePrimaryCourseBranchIds(
    pool,
    courseInfo.courseId,
    courseInfo.branchId
  );
  if (courseInfo.courseId !== undefined) {
    updateFields.push('course_id = ?');
    updateParams.push(resolvedCourseId);
    updateFields.push('managed_course_id = ?');
    updateParams.push(normalizeManagedIdForDb(courseInfo.courseId));
  }
  if (courseInfo.branchId !== undefined) {
    updateFields.push('branch_id = ?');
    updateParams.push(resolvedBranchId);
    updateFields.push('managed_branch_id = ?');
    updateParams.push(normalizeManagedIdForDb(courseInfo.branchId));
  }
  if (courseInfo.course !== undefined) {
    updateFields.push('course = ?');
    updateParams.push(courseInfo.course || '');
  }
  if (courseInfo.branch !== undefined) {
    updateFields.push('branch = ?');
    updateParams.push(courseInfo.branch || '');
  }
  if (courseInfo.quota !== undefined) {
    updateFields.push('quota = ?');
    updateParams.push(courseInfo.quota || '');
  }
}

const parseReferenceNameFromRow = (row) => {
  const direct = String(row.reference_name ?? '').trim();
  if (direct) return direct;
  try {
    const ld =
      typeof row.lead_data === 'string' ? JSON.parse(row.lead_data || '{}') : row.lead_data || {};
    return String(ld.reference1 ?? ld.referenceName ?? '').trim();
  } catch {
    return '';
  }
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
        : row.managed_course_id != null && String(row.managed_course_id).trim() !== ''
          ? String(row.managed_course_id).trim()
          : null,
    branchId:
      row.branch_id != null && String(row.branch_id).trim() !== ''
        ? String(row.branch_id).trim()
        : row.managed_branch_id != null && String(row.managed_branch_id).trim() !== ''
          ? String(row.managed_branch_id).trim()
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
  referenceName: parseReferenceNameFromRow(row),
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
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
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

    const needsLeadJoin = Boolean(search);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = needsLeadJoin
      ? 'FROM admissions a LEFT JOIN leads l ON a.lead_id = l.id'
      : 'FROM admissions a';

    // Get total count
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total ${fromClause} ${whereClause}`,
      params
    );
    const total = countResult[0]?.total || 0;

    // Phase 1: paginate ids only — no lead join unless search needs it; no wide row payload in sort.
    const [idRowsResult] = await pool.execute(
      `SELECT a.id ${fromClause} ${whereClause}
       ORDER BY a.admission_number DESC, a.updated_at DESC
       LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`,
      params
    );
    const idRows = idRowsResult;

    let admissions = [];
    if (idRows.length > 0) {
      const pageIds = idRows.map((row) => row.id);
      const inMarks = pageIds.map(() => '?').join(',');
      const orderIndex = new Map(pageIds.map((id, index) => [String(id), index]));

      // Phase 2: fetch page rows by primary key (no ORDER BY — reorder in app to avoid sort buffer).
      const [pageRows] = await pool.execute(
        `SELECT a.id, a.lead_id, a.joining_id, a.admission_number, a.status,
                a.course_id, a.branch_id, a.managed_course_id, a.managed_branch_id, a.course, a.branch, a.quota,
                a.student_name, a.student_phone, a.created_at, a.updated_at,
                a.reservation_general, a.reservation_other, a.payment_total_paid,
                a.document_ssc, a.document_inter, a.document_ug_pg_cmm, a.document_transfer_certificate,
                a.document_study_certificate, a.document_aadhaar_card, a.document_photos,
                a.document_income_certificate, a.document_caste_certificate, a.document_cet_rank_card,
                a.document_cet_hall_ticket, a.document_allotment_letter, a.document_joining_report,
                a.document_bank_passbook, a.document_ration_card,
                a.lead_data,
                l.name as lead_name, l.phone as lead_phone, l.source as lead_source
         FROM admissions a
         LEFT JOIN leads l ON a.lead_id = l.id
         WHERE a.id IN (${inMarks})`,
        pageIds
      );
      admissions = pageRows.sort(
        (a, b) => (orderIndex.get(String(a.id)) ?? 0) - (orderIndex.get(String(b.id)) ?? 0)
      );
    }

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
      await applyAdmissionCourseInfoUpdates(pool, payload.courseInfo, updateFields, updateParams);
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
        if (payload.parents.father.photo !== undefined) {
          updateFields.push('father_photo = ?');
          const p = String(payload.parents.father.photo || '').trim();
          updateParams.push(p || null);
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
        if (payload.parents.mother.photo !== undefined) {
          updateFields.push('mother_photo = ?');
          const p = String(payload.parents.mother.photo || '').trim();
          updateParams.push(p || null);
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
      if (payload.qualifications.merit !== undefined) {
        updateFields.push('qualification_merit = ?');
        updateParams.push(qualificationMeritToSql(payload.qualifications.merit));
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
      await applyAdmissionCourseInfoUpdates(pool, payload.courseInfo, updateFields, updateParams);
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
        if (payload.parents.father.photo !== undefined) {
          updateFields.push('father_photo = ?');
          const p = String(payload.parents.father.photo || '').trim();
          updateParams.push(p || null);
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
        if (payload.parents.mother.photo !== undefined) {
          updateFields.push('mother_photo = ?');
          const p = String(payload.parents.mother.photo || '').trim();
          updateParams.push(p || null);
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
      if (payload.qualifications.merit !== undefined) {
        updateFields.push('qualification_merit = ?');
        updateParams.push(qualificationMeritToSql(payload.qualifications.merit));
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
      conditions.push('DATE(COALESCE(admission_date, created_at)) >= ?');
      params.push(String(startDate).slice(0, 10));
    }
    if (endDate) {
      conditions.push('DATE(COALESCE(admission_date, created_at)) <= ?');
      params.push(String(endDate).slice(0, 10));
    }
    if (courseId || courseName) {
      if (courseId && courseName) {
        conditions.push(`(${SQL_EFF_COURSE_ID} = ? OR course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_EFF_COURSE_ID} = ? OR course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }
    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_EFF_BRANCH_ID} = ? OR branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_EFF_BRANCH_ID} = ? OR branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const query = `
      SELECT 
        ${SQL_EFF_COURSE_ID} as courseId, 
        MAX(course) as courseName,
        COUNT(CASE WHEN status != 'Admission Cancelled' THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN status = 'Admission Cancelled' THEN 1 END) as totalCancelled
      FROM admissions
      ${whereClause}
      GROUP BY ${SQL_EFF_COURSE_ID}
      ORDER BY totalAdmissions DESC
    `;
    const [stats] = await pool.execute(query, params);

    const queryBranches = `
      SELECT 
        ${SQL_EFF_COURSE_ID} as courseId,
        ${SQL_EFF_BRANCH_ID} as branchId,
        MAX(course) as courseName,
        MAX(branch) as branchName,
        COUNT(CASE WHEN status != 'Admission Cancelled' THEN 1 END) as totalAdmissions,
        COUNT(CASE WHEN status = 'Admission Cancelled' THEN 1 END) as totalCancelled
      FROM admissions
      ${whereClause}
      GROUP BY ${SQL_EFF_COURSE_ID}, ${SQL_EFF_BRANCH_ID}
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
 * Shared filters for admission pivot reports (alias `a`).
 * When status is omitted or `all`, excludes "Admission Cancelled" to match course-wise stats.
 */
const buildAdmissionPivotFilters = (query) => {
  const {
    startDate,
    endDate,
    courseId,
    branchId,
    courseName,
    branchName,
    status,
  } = query;
  const conditions = [];
  const params = [];
  const c = (field) => `a.${field}`;

  if (startDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
    params.push(String(startDate).slice(0, 10));
  }
  if (endDate) {
    conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
    params.push(String(endDate).slice(0, 10));
  }
  if (courseId || courseName) {
    if (courseId && courseName) {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR ${c('course')} = ?)`);
      params.push(courseId, courseName);
    } else {
      conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR ${c('course')} = ?)`);
      const val = courseId || courseName;
      params.push(val, val);
    }
  }
  if (branchId || branchName) {
    if (branchId && branchName) {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR ${c('branch')} = ?)`);
      params.push(branchId, branchName);
    } else {
      conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR ${c('branch')} = ?)`);
      const val = branchId || branchName;
      params.push(val, val);
    }
  }
  if (status && status !== 'all') {
    conditions.push(`${c('status')} = ?`);
    params.push(status);
  } else {
    conditions.push(`${c('status')} != ?`);
    params.push(ADMISSION_CANCELLED_STATUS);
  }
  return { conditions, params };
};

/** Normalize course header text so "B.Tech", "B.TECH", "b.tech " map to one bucket. */
const normalizeAdmissionCourseColumnName = (name) =>
  String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

const sumCountsForCourseColumn = (countsRaw, col) => {
  const ids = col.courseIds || [col.courseId];
  let sum = 0;
  for (const rawId of ids) {
    const id = String(rawId);
    let v = countsRaw[id];
    if (v === undefined && /^\d+$/.test(id)) {
      const n = Number(id);
      if (Number.isSafeInteger(n)) v = countsRaw[n];
    }
    if (v !== undefined && v !== null) sum += Number(v) || 0;
  }
  return sum;
};

/**
 * Build pivot columns aligned with how admissions store data:
 * - `admissions.course_id` (primary catalog FK when present) or `admissions.managed_course_id`
 *   (student DB id, no FK) plus denormalized `admissions.course` text.
 * - Secondary `courses` may list multiple ids or different ids than stored on older rows.
 *
 * We bucket by **normalized label** derived from admission `MAX(course)` when present, else
 * secondary name for that id. All ids that share the same bucket get merged so counts sum
 * into one column (fixes duplicate "DIPLOMA" / B.TECH showing 0).
 */
const getAdmissionReportCourses = async (primaryPool, whereClause, params) => {
  let activeCourses = [];
  try {
    const secondaryPool = getSecondaryPool();
    const [rows] = await secondaryPool.execute(
      'SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC'
    );
    activeCourses = rows || [];
  } catch (err) {
    console.error(
      'getAdmissionReportCourses: secondary courses query failed, using primary:',
      err?.message || err
    );
    const [rows] = await primaryPool.execute(
      'SELECT id, name FROM courses WHERE is_active = 1 ORDER BY name ASC'
    );
    activeCourses = rows || [];
  }

  const [distinctCourseRows] = await primaryPool.execute(
    `SELECT ${SQL_A_EFF_COURSE_ID} AS courseId, MAX(a.course) AS courseName
     FROM admissions a
     ${whereClause}
     GROUP BY ${SQL_A_EFF_COURSE_ID}`,
    params
  );

  const idToSecondaryName = new Map(
    activeCourses.map((r) => [String(r.id), String(r.name || '').trim()])
  );

  const buckets = new Map();

  const addToBucket = (bucketKey, displayLabel, idStr) => {
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        courseName: String(displayLabel || '').trim() || '—',
        mergeIds: new Set(),
      });
    }
    const b = buckets.get(bucketKey);
    b.mergeIds.add(String(idStr));
    const next = String(displayLabel || '').trim();
    if (next.length > String(b.courseName || '').trim().length) {
      b.courseName = next;
    }
  };

  /** Each course id must map to one pivot column (avoids double-count when catalog id ≠ admission label). */
  const assignedCourseIds = new Set();

  for (const row of distinctCourseRows) {
    const rawId = row.courseId;
    const idStr =
      rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : '__none__';
    const fromAdmissionText = String(row.courseName || '').trim();
    const label =
      idStr === '__none__'
        ? '—'
        : fromAdmissionText || idToSecondaryName.get(idStr) || 'Unknown';
    const k = idStr === '__none__' ? '__none__' : normalizeAdmissionCourseColumnName(label);
    addToBucket(k, label, idStr);
    if (idStr !== '__none__') assignedCourseIds.add(idStr);
  }

  for (const r of activeCourses) {
    const id = String(r.id);
    if (assignedCourseIds.has(id)) continue;
    const nm = String(r.name || '').trim() || 'Unknown';
    const k = normalizeAdmissionCourseColumnName(nm);
    addToBucket(k, nm, id);
  }

  const orderedKeys = [...buckets.keys()].filter((key) => key !== '__none__');
  orderedKeys.sort((a, b) => {
    const na = buckets.get(a).courseName;
    const nb = buckets.get(b).courseName;
    return String(na).localeCompare(String(nb), undefined, { sensitivity: 'base' });
  });

  const out = [];
  for (const k of orderedKeys) {
    const b = buckets.get(k);
    const ids = [...b.mergeIds]
      .filter((id) => id !== '__none__')
      .sort((x, y) => String(x).localeCompare(String(y)));
    if (ids.length === 0) continue;
    out.push({
      courseId: ids.length === 1 ? ids[0] : ids.join('|'),
      courseName: b.courseName,
      courseIds: ids,
    });
  }

  if (buckets.has('__none__')) {
    const b = buckets.get('__none__');
    const ids = [...b.mergeIds].sort((x, y) => String(x).localeCompare(String(y)));
    out.push({
      courseId: ids.length === 1 ? ids[0] : ids.join('|'),
      courseName: b.courseName,
      courseIds: ids,
    });
  }

  return out;
};

/**
 * @desc    Admissions counts by student Reference 1 (lead_data.reference1) × course
 * @route   GET /api/admissions/stats/by-reference
 */
export const getAdmissionStatsByReference = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const [agg] = await pool.execute(
      `SELECT
         COALESCE(${SQL_A_REFERENCE1}, '__none__') AS referenceKey,
         MAX(${SQL_A_REFERENCE1}) AS referenceName,
         ${SQL_A_EFF_COURSE_ID} AS courseId,
         COUNT(*) AS cnt
       FROM admissions a
       ${whereClause}
       GROUP BY COALESCE(${SQL_A_REFERENCE1}, '__none__'), ${SQL_A_EFF_COURSE_ID}`,
      params
    );

    const courseKey = (courseId) => {
      if (courseId === undefined || courseId === null) return '__none__';
      const s = String(courseId).trim();
      if (s === '') return '__none__';
      if (typeof courseId === 'bigint') return String(courseId);
      return s;
    };

    const byReference = new Map();
    for (const row of agg) {
      const refKey = String(row.referenceKey || '__none__');
      if (!byReference.has(refKey)) {
        byReference.set(refKey, {
          displayName:
            refKey === '__none__'
              ? '(Not specified)'
              : String(row.referenceName || refKey).trim() || '(Not specified)',
        });
      }
      const bucket = byReference.get(refKey);
      if (!bucket.counts) bucket.counts = {};
      const ck = courseKey(row.courseId);
      bucket.counts[ck] = (bucket.counts[ck] || 0) + (Number(row.cnt) || 0);
    }

    const rows = [...byReference.entries()]
      .sort((a, b) => {
        if (a[0] === '__none__') return 1;
        if (b[0] === '__none__') return -1;
        return String(a[1].displayName).localeCompare(String(b[1].displayName));
      })
      .map(([refKey, bucket]) => {
        const countsRaw = bucket.counts || {};
        const counts = {};
        for (const c of courses) {
          counts[c.courseId] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return {
          referenceKey: refKey === '__none__' ? null : refKey,
          name: bucket.displayName,
          counts,
          total,
        };
      });

    return successResponse(
      res,
      { courses, rows },
      'Admission reference stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission reference stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission reference stats', 500);
  }
};

/**
 * @desc    Admissions counts by calendar date × course
 * @route   GET /api/admissions/stats/by-date
 */
export const getAdmissionStatsByDate = async (req, res) => {
  try {
    const pool = getPool();
    const { conditions, params } = buildAdmissionPivotFilters(req.query);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const courses = await getAdmissionReportCourses(pool, whereClause, params);

    const [agg] = await pool.execute(
      `SELECT DATE_FORMAT(${SQL_A_EFFECTIVE_ADMISSION_DATE}, '%Y-%m-%d') AS d,
              ${SQL_A_EFF_COURSE_ID} AS courseId,
              COUNT(*) AS cnt
       FROM admissions a
       ${whereClause}
       GROUP BY DATE_FORMAT(${SQL_A_EFFECTIVE_ADMISSION_DATE}, '%Y-%m-%d'), ${SQL_A_EFF_COURSE_ID}`,
      params
    );

    const courseKey = (courseId) => {
      if (courseId === undefined || courseId === null) return '__none__';
      const s = String(courseId).trim();
      if (s === '') return '__none__';
      if (typeof courseId === 'bigint') return String(courseId);
      return s;
    };

    const byDate = new Map();
    for (const row of agg) {
      const dateStr = row.d ? String(row.d).slice(0, 10) : '';
      if (!dateStr) continue;
      if (!byDate.has(dateStr)) byDate.set(dateStr, {});
      const ck = courseKey(row.courseId);
      const cur = byDate.get(dateStr);
      cur[ck] = (cur[ck] || 0) + (Number(row.cnt) || 0);
    }

    const rows = [...byDate.keys()]
      .sort((a, b) => b.localeCompare(a))
      .map((date) => {
        const countsRaw = byDate.get(date) || {};
        const counts = {};
        for (const c of courses) {
          counts[c.courseId] = sumCountsForCourseColumn(countsRaw, c);
        }
        const total = Object.values(countsRaw).reduce((sum, n) => sum + (Number(n) || 0), 0);
        return { date, counts, total };
      });

    return successResponse(
      res,
      { courses, rows },
      'Admission date-wise stats retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting admission date-wise stats:', error);
    return errorResponse(res, error.message || 'Failed to get admission date-wise stats', 500);
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
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        params.push(courseId, courseName);
      } else {
        conditions.push(`(${SQL_A_EFF_COURSE_ID} = ? OR a.course = ?)`);
        const val = courseId || courseName;
        params.push(val, val);
      }
    }

    if (branchId || branchName) {
      if (branchId && branchName) {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        params.push(branchId, branchName);
      } else {
        conditions.push(`(${SQL_A_EFF_BRANCH_ID} = ? OR a.branch = ?)`);
        const val = branchId || branchName;
        params.push(val, val);
      }
    }

    if (startDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) >= ?`);
      params.push(String(startDate).slice(0, 10));
    }

    if (endDate) {
      conditions.push(`DATE(${SQL_A_EFFECTIVE_ADMISSION_DATE}) <= ?`);
      params.push(String(endDate).slice(0, 10));
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
      ORDER BY a.admission_number DESC, a.updated_at DESC
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
      { header: 'Reference', key: 'reference', width: 22 },
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
        reference:
          record.leadData?.reference1 ||
          record.leadData?.referenceName ||
          record.registrationFormData?.reference1 ||
          '',
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
