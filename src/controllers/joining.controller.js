import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { syncToSecondaryDatabase, warnIfSecondaryStudentSyncMissed } from '../utils/studentSync.util.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';
import { updatePerformanceMetric } from '../services/userPerformance.service.js';
import smsService from '../services/sms.service.js';
import { syncJoiningStudentFeeDetailsToFeeMongo } from '../services/joiningStudentFeeMongoSync.service.js';
import {
  formatAdmission,
  persistAdmissionReference1,
  persistAdmissionCourseBranchUpdate,
} from './admission.controller.js';
import { resolveBtechCourseDisplayName } from '../utils/lateralBatch.util.js';
import {
  FATHER_PHOTO_REG_KEYS,
  MOTHER_PHOTO_REG_KEYS,
} from '../utils/joiningParentPhotos.util.js';
import { generateAdmissionNumber } from '../utils/admissionNumber.util.js';
import {
  buildJoiningLeadDataSnapshot,
  backfillJoiningReferenceFromLead,
  resolveReference1ForLead,
  readReference1FromDynamicFields,
} from '../utils/joiningReference.util.js';

const DEFAULT_GENERAL_RESERVATION = 'oc';

const sanitizeString = (value) =>
  typeof value === 'string' ? value.trim() : value ?? '';

/** Last 10 digits for Indian mobile numbers. */
const normalizeMobileDigits = (value) =>
  String(value ?? '')
    .replace(/\D/g, '')
    .slice(-10);

const PREFERRED_MOBILE_REG_KEYS = [
  'preferred_mobile_number',
  'preferred_mobile',
  'preferred_mobileno',
  'preferred_contact_number',
  'preferred_phone',
  'preferred_phone_number',
];

/** SMS / contact: explicit preferred number, else student mobile. */
const resolveContactMobileNumber = (studentInfo) => {
  const preferred = normalizeMobileDigits(studentInfo?.preferredMobileNumber);
  if (preferred.length === 10) return preferred;
  const student = normalizeMobileDigits(studentInfo?.phone);
  if (student.length === 10) return student;
  return '';
};

/** Raw UI / student-DB course or branch id for `managed_*` columns (no FK to primary catalog). */
const normalizeManagedIdForDb = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

/** Per–fee-structure overrides for this joining (stored in lead_data._joiningStudentFeeDetails). */
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

const formatStudentFeeDetailsForClient = (raw) => {
  const s = sanitizeStudentFeeDetailsForDb(raw);
  return s || { lines: [] };
};

/** Managed course/branch IDs may come from the student DB; FK columns on joinings/admissions point at primary `courses` / `branches`. */
const resolvePrimaryCourseBranchFkIds = async (pool, courseId, branchId) => {
  let fkCourseId = null;
  let fkBranchId = null;
  if (courseId != null && String(courseId) !== '') {
    const [pc] = await pool.execute('SELECT id FROM courses WHERE id = ?', [courseId]);
    if (pc.length > 0) fkCourseId = pc[0].id;
  }
  if (branchId != null && String(branchId) !== '') {
    const [pb] = await pool.execute('SELECT id FROM branches WHERE id = ?', [branchId]);
    if (pb.length > 0) fkBranchId = pb[0].id;
  }
  return { fkCourseId, fkBranchId };
};

const ensureLeadExists = async (leadId) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    throw new Error('Invalid lead identifier provided');
  }

  const pool = getPool();
  const [leads] = await pool.execute(
    `SELECT l.*,
            u.id AS assigned_to_user_id,
            u.name AS assigned_to_name,
            u.email AS assigned_to_email
     FROM leads l
     LEFT JOIN users u ON l.assigned_to = u.id
     WHERE l.id = ?`,
    [leadId]
  );

  if (leads.length === 0) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  // Format lead data
  const lead = formatLead(leads[0]);
  return lead;
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
    gender: leadData.gender || 'Not Specified',
    quota: leadData.quota || 'Not Applicable',
    leadStatus: leadData.lead_status || 'New',
    admissionNumber: leadData.admission_number,
    academicYear: leadData.academic_year != null ? Number(leadData.academic_year) : undefined,
    studentGroup: leadData.student_group || '',
    uploadBatchId: leadData.upload_batch_id || undefined,
    dynamicFields: typeof leadData.dynamic_fields === 'string'
      ? JSON.parse(leadData.dynamic_fields)
      : leadData.dynamic_fields || {},
    assignedTo: leadData.assigned_to_user_id
      ? {
          id: leadData.assigned_to_user_id,
          _id: leadData.assigned_to_user_id,
          name: leadData.assigned_to_name,
          email: leadData.assigned_to_email,
        }
      : undefined,
    createdAt: leadData.created_at,
    updatedAt: leadData.updated_at,
  };
};

const applyLeadDefaultsToJoining = (joiningDoc, lead) => {
  if (!joiningDoc.courseInfo) {
    joiningDoc.courseInfo = {};
  }
  if (!joiningDoc.courseInfo.course) {
    joiningDoc.courseInfo.course = lead.courseInterested || '';
  }
  if (!joiningDoc.courseInfo.quota) {
    joiningDoc.courseInfo.quota = lead.quota || '';
  }

  if (!joiningDoc.studentInfo) {
    joiningDoc.studentInfo = {};
  }
  if (!joiningDoc.studentInfo.name) {
    joiningDoc.studentInfo.name = lead.name;
  }
  if (!joiningDoc.studentInfo.phone) {
    joiningDoc.studentInfo.phone = lead.phone;
  }
  if (!joiningDoc.studentInfo.gender) {
    joiningDoc.studentInfo.gender = lead.gender || '';
  }
  if (!joiningDoc.studentInfo.notes) {
    joiningDoc.studentInfo.notes = 'As per SSC for no issues';
  }

  joiningDoc.parents = joiningDoc.parents || {};
  joiningDoc.parents.father = joiningDoc.parents.father || {};
  joiningDoc.parents.mother = joiningDoc.parents.mother || {};

  if (!joiningDoc.parents.father.name) {
    joiningDoc.parents.father.name = lead.fatherName || '';
  }
  if (!joiningDoc.parents.father.phone) {
    joiningDoc.parents.father.phone = lead.fatherPhone || '';
  }
  if (!joiningDoc.parents.mother.name) {
    joiningDoc.parents.mother.name = lead.motherName || '';
  }

  return joiningDoc;
};

const syncLeadWithJoining = (leadDoc, joiningDoc) => {
  if (!leadDoc || !joiningDoc) return false;

  let mutated = false;

  const setStringField = (field, value) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim();
    if (!normalized) return;
    if (leadDoc[field] !== normalized) {
      leadDoc[field] = normalized;
      mutated = true;
    }
  };

  setStringField('name', joiningDoc.studentInfo?.name);
  setStringField('phone', joiningDoc.studentInfo?.phone);

  if (
    typeof joiningDoc.studentInfo?.gender === 'string' &&
    joiningDoc.studentInfo.gender.trim() &&
    leadDoc.gender !== joiningDoc.studentInfo.gender.trim()
  ) {
    leadDoc.gender = joiningDoc.studentInfo.gender.trim();
    mutated = true;
  }

  setStringField('fatherName', joiningDoc.parents?.father?.name);
  setStringField('fatherPhone', joiningDoc.parents?.father?.phone);
  setStringField('motherName', joiningDoc.parents?.mother?.name);

  const communication = joiningDoc.address?.communication || {};
  setStringField('village', communication.villageOrCity);
  setStringField('mandal', communication.mandal);
  setStringField('district', communication.district);

  if (
    typeof joiningDoc.courseInfo?.quota === 'string' &&
    joiningDoc.courseInfo.quota.trim() &&
    leadDoc.quota !== joiningDoc.courseInfo.quota.trim()
  ) {
    leadDoc.quota = joiningDoc.courseInfo.quota.trim();
    mutated = true;
  }

  // After approval, course/branch live on admissions — do not overwrite lead marketing interest.
  if (String(joiningDoc.status || '').toLowerCase() !== 'approved') {
    const courseName =
      typeof joiningDoc.courseInfo?.course === 'string' ? joiningDoc.courseInfo.course.trim() : '';
    const branchName =
      typeof joiningDoc.courseInfo?.branch === 'string' ? joiningDoc.courseInfo.branch.trim() : '';
    const courseInterested =
      courseName && branchName
        ? `${courseName} - ${branchName}`
        : courseName || branchName || null;

    if (courseInterested && leadDoc.courseInterested !== courseInterested) {
      leadDoc.courseInterested = courseInterested;
      mutated = true;
    }
  }

  const interEducation = Array.isArray(joiningDoc.educationHistory)
    ? joiningDoc.educationHistory.find((entry) => entry.level === 'inter_diploma')
    : null;
  if (interEducation?.institutionName) {
    setStringField('interCollege', interEducation.institutionName);
  }

  return mutated;
};

const recordActivity = async ({ leadId, userId, description, statusFrom, statusTo }) => {
  try {
    if (!leadId || !userId) return;
    
    const pool = getPool();
    const activityId = uuidv4();
    await pool.execute(
      `INSERT INTO activity_logs (id, lead_id, type, performed_by, comment, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        activityId,
        leadId,
        'joining_update',
        userId,
        description,
        JSON.stringify({
          statusFrom: statusFrom || null,
          statusTo: statusTo || null,
        }),
      ]
    );
  } catch (error) {
    console.error('Failed to append joining activity log:', error);
  }
};

const ensureLeadForApprovedJoining = async ({
  connection,
  joining,
  formattedJoining,
  joiningLeadData,
  admissionNumber,
}) => {
  if (joining?.lead_id) return joining.lead_id;

  const studentName =
    formattedJoining?.studentInfo?.name || joiningLeadData?.name || 'Unknown Student';
  const studentPhone =
    formattedJoining?.studentInfo?.phone || joiningLeadData?.phone || '0000000000';
  const fatherName =
    formattedJoining?.parents?.father?.name || joiningLeadData?.fatherName || 'Not Provided';
  const fatherPhone =
    formattedJoining?.parents?.father?.phone ||
    joiningLeadData?.fatherPhone ||
    studentPhone;
  const motherName =
    formattedJoining?.parents?.mother?.name || joiningLeadData?.motherName || '';
  const village =
    formattedJoining?.address?.communication?.villageOrCity ||
    joiningLeadData?.village ||
    'Not Provided';
  const district =
    formattedJoining?.address?.communication?.district ||
    joiningLeadData?.district ||
    'Not Provided';
  const mandal =
    formattedJoining?.address?.communication?.mandal ||
    joiningLeadData?.mandal ||
    'Not Provided';
  const quota = formattedJoining?.courseInfo?.quota || joiningLeadData?.quota || 'Not Applicable';
  const courseInterested =
    formattedJoining?.courseInfo?.course || joiningLeadData?.courseInterested || '';
  const state = joiningLeadData?.state || '';
  const gender = joiningLeadData?.gender || formattedJoining?.studentInfo?.gender || 'Not Specified';
  const email = joiningLeadData?.email || null;
  const dynamicFields =
    joiningLeadData?.dynamicFields && typeof joiningLeadData.dynamicFields === 'object'
      ? joiningLeadData.dynamicFields
      : {};

  let enquiryNumber = '';
  if (joiningLeadData?.enquiryNumber && String(joiningLeadData.enquiryNumber).trim()) {
    const candidate = String(joiningLeadData.enquiryNumber).trim();
    const [enquiryConflict] = await connection.execute(
      'SELECT id FROM leads WHERE enquiry_number = ? LIMIT 1',
      [candidate]
    );
    if (enquiryConflict.length === 0) {
      enquiryNumber = candidate;
    }
  }

  const newLeadId = uuidv4();
  await connection.execute(
    `INSERT INTO leads (
      id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
      village, district, mandal, state, gender, quota, course_interested, dynamic_fields,
      lead_status, admission_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      newLeadId,
      enquiryNumber || null,
      studentName,
      studentPhone,
      email,
      fatherName,
      motherName,
      fatherPhone,
      village,
      district,
      mandal,
      state,
      gender,
      quota,
      courseInterested,
      JSON.stringify(dynamicFields),
      'Admitted',
      admissionNumber,
    ]
  );

  await connection.execute('UPDATE joinings SET lead_id = ?, updated_at = NOW() WHERE id = ?', [
    newLeadId,
    joining.id,
  ]);

  return newLeadId;
};

// Helper function to format joining data from SQL to camelCase
const qualificationMeritToSql = (merit) => {
  if (merit === true) return 1;
  return 0;
};

const qualificationMeritFromSql = (value) => {
  if (value === 1 || value === true) return true;
  return false;
};

const formatJoining = async (joiningData, pool, options = {}) => {
  const listMode = Boolean(options?.listMode);
  if (!joiningData) return null;

  const joiningId = joiningData.id;

  let relatives = [];
  let educationHistory = [];
  let siblings = [];
  if (!listMode && pool) {
    const [relativesRows] = await pool.execute(
      'SELECT * FROM joining_relatives WHERE joining_id = ?',
      [joiningId]
    );
    relatives = relativesRows;

    const [educationHistoryRows] = await pool.execute(
      'SELECT * FROM joining_education_history WHERE joining_id = ? ORDER BY created_at ASC',
      [joiningId]
    );
    educationHistory = educationHistoryRows;

    const [siblingsRows] = await pool.execute(
      'SELECT * FROM joining_siblings WHERE joining_id = ? ORDER BY created_at ASC',
      [joiningId]
    );
    siblings = siblingsRows;
  }

  // Parse JSON fields
  const leadDataRaw = typeof joiningData.lead_data === 'string'
    ? JSON.parse(joiningData.lead_data)
    : joiningData.lead_data || {};

  let registrationFormData = {};
  let studentFeeDetails = { lines: [] };
  let leadData = leadDataRaw;
  let storedProgramLevel = '';
  let managedJoiningCourseId = null;
  let managedJoiningBranchId = null;
  if (leadDataRaw && typeof leadDataRaw === 'object') {
    if (leadDataRaw._joiningProgramLevel != null && String(leadDataRaw._joiningProgramLevel).trim()) {
      storedProgramLevel = String(leadDataRaw._joiningProgramLevel).trim();
    }
    if (leadDataRaw._joiningManagedCourseId != null && String(leadDataRaw._joiningManagedCourseId) !== '') {
      managedJoiningCourseId = leadDataRaw._joiningManagedCourseId;
    }
    if (leadDataRaw._joiningManagedBranchId != null && String(leadDataRaw._joiningManagedBranchId) !== '') {
      managedJoiningBranchId = leadDataRaw._joiningManagedBranchId;
    }
    if (leadDataRaw._joiningRegistrationExtras) {
      registrationFormData = {
        ...(typeof leadDataRaw._joiningRegistrationExtras === 'object'
          ? leadDataRaw._joiningRegistrationExtras
          : {}),
      };
      const {
        _joiningRegistrationExtras,
        _joiningStudentFeeDetails,
        _joiningProgramLevel,
        _joiningManagedCourseId: _jmc,
        _joiningManagedBranchId: _jmb,
        ...rest
      } = leadDataRaw;
      studentFeeDetails = formatStudentFeeDetailsForClient(_joiningStudentFeeDetails);
      leadData = rest;
    } else {
      const {
        _joiningStudentFeeDetails,
        _joiningProgramLevel,
        _joiningManagedCourseId: _jmc,
        _joiningManagedBranchId: _jmb,
        ...rest
      } = leadDataRaw;
      studentFeeDetails = formatStudentFeeDetailsForClient(_joiningStudentFeeDetails);
      leadData = rest;
    }
  }

  const reservationOther = typeof joiningData.reservation_other === 'string'
    ? JSON.parse(joiningData.reservation_other)
    : joiningData.reservation_other || [];

  const qualificationMediums = typeof joiningData.qualification_mediums === 'string'
    ? JSON.parse(joiningData.qualification_mediums)
    : joiningData.qualification_mediums || [];

  // Managed course/branch IDs live in the secondary `student_database` and are
  // always exposed as strings to the client (matches `formatCourse` / `formatBranch`
  // in paymentConfig.controller.js where `_id` is stringified). Legacy joinings
  // may carry the FK columns (`course_id` / `branch_id`) as MySQL INTs, so we
  // coerce both sources to strings here — otherwise `course._id === courseId`
  // checks on the frontend silently fail (e.g. `"5" === 5` is false) and the
  // managed branches dropdown never lights up for joinings that were saved
  // before the managed-id columns were introduced.
  const fromRowManagedCourse = normalizeManagedIdForDb(joiningData.managed_course_id);
  const fromRowManagedBranch = normalizeManagedIdForDb(joiningData.managed_branch_id);
  const rawJoiningCourseId =
    fromRowManagedCourse != null
      ? fromRowManagedCourse
      : managedJoiningCourseId != null
        ? managedJoiningCourseId
        : joiningData.course_id;
  const rawJoiningBranchId =
    fromRowManagedBranch != null
      ? fromRowManagedBranch
      : managedJoiningBranchId != null
        ? managedJoiningBranchId
        : joiningData.branch_id;
  const normalizedJoiningCourseId =
    rawJoiningCourseId != null && String(rawJoiningCourseId).trim() !== ''
      ? String(rawJoiningCourseId).trim()
      : null;
  const normalizedJoiningBranchId =
    rawJoiningBranchId != null && String(rawJoiningBranchId).trim() !== ''
      ? String(rawJoiningBranchId).trim()
      : null;

  const fromRegFatherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    FATHER_PHOTO_REG_KEYS
  );
  const fromRegMotherPhoto = pickFromRegistrationFormData(
    registrationFormData,
    MOTHER_PHOTO_REG_KEYS
  );
  const colFatherPhoto = String(joiningData.father_photo || '').trim();
  const colMotherPhoto = String(joiningData.mother_photo || '').trim();
  const fatherPortrait = (fromRegFatherPhoto || colFatherPhoto || '').trim();
  const motherPortrait = (fromRegMotherPhoto || colMotherPhoto || '').trim();
  if (colFatherPhoto && !fromRegFatherPhoto) {
    registrationFormData = { ...registrationFormData, father_photo: colFatherPhoto };
  }
  if (colMotherPhoto && !fromRegMotherPhoto) {
    registrationFormData = { ...registrationFormData, mother_photo: colMotherPhoto };
  }

  return {
    _id: joiningData.id,
    id: joiningData.id,
    leadId: joiningData.lead_id,
    leadData,
    registrationFormData,
    studentFeeDetails,
    status: joiningData.status,
    courseInfo: {
      courseId: normalizedJoiningCourseId,
      branchId: normalizedJoiningBranchId,
      course: resolveBtechCourseDisplayName(
        joiningData.course || '',
        registrationFormData,
        joiningData.admission_number
      ),
      branch: joiningData.branch || '',
      quota: joiningData.quota || '',
      programLevel: storedProgramLevel || undefined,
    },
    paymentSummary: {
      totalFee: Number(joiningData.payment_total_fee) || 0,
      totalPaid: Number(joiningData.payment_total_paid) || 0,
      balance: Number(joiningData.payment_balance) || 0,
      currency: joiningData.payment_currency || 'INR',
      status: joiningData.payment_status || 'not_started',
      lastPaymentAt: joiningData.payment_last_payment_at,
    },
    studentInfo: {
      name: joiningData.student_name || '',
      phone: joiningData.student_phone || '',
      preferredMobileNumber: joiningData.preferred_mobile_number || '',
      gender: joiningData.student_gender || '',
      dateOfBirth: joiningData.student_date_of_birth || '',
      notes: joiningData.student_notes || '',
      aadhaarNumber: joiningData.student_aadhaar_number || '',
    },
    parents: {
      father: {
        name: joiningData.father_name || '',
        phone: joiningData.father_phone || '',
        aadhaarNumber: joiningData.father_aadhaar_number || '',
        photo: fatherPortrait,
      },
      mother: {
        name: joiningData.mother_name || '',
        phone: joiningData.mother_phone || '',
        aadhaarNumber: joiningData.mother_aadhaar_number || '',
        photo: motherPortrait,
      },
    },
    reservation: {
      general: joiningData.reservation_general || 'oc',
      isEws: joiningData.reservation_is_ews === 1 || joiningData.reservation_is_ews === true,
      other: reservationOther,
    },
    address: {
      communication: {
        doorOrStreet: joiningData.address_door_street || '',
        landmark: joiningData.address_landmark || '',
        villageOrCity: joiningData.address_village_city || '',
        mandal: joiningData.address_mandal || '',
        district: joiningData.address_district || '',
        pinCode: joiningData.address_pin_code || '',
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
      ssc: joiningData.qualification_ssc === 1 || joiningData.qualification_ssc === true,
      interOrDiploma: joiningData.qualification_inter_diploma === 1 || joiningData.qualification_inter_diploma === true,
      ug: joiningData.qualification_ug === 1 || joiningData.qualification_ug === true,
      merit: qualificationMeritFromSql(joiningData.qualification_merit),
      mediums: qualificationMediums,
      otherMediumLabel: joiningData.qualification_other_medium_label || '',
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
    // List query joins `leads` and exposes these aliases (not present on SELECT j.* only).
    ...(joiningData.lead_id &&
    (joiningData.lead_name != null ||
      joiningData.lead_enquiry_number != null ||
      joiningData.lead_phone != null)
      ? {
          lead: {
            name: joiningData.lead_name || '',
            phone: joiningData.lead_phone || '',
            enquiryNumber: joiningData.lead_enquiry_number || '',
            hallTicketNumber: joiningData.lead_hall_ticket_number || '',
            leadStatus: joiningData.lead_lead_status || '',
            courseInterested: joiningData.lead_course_interested || '',
            mandal: joiningData.lead_mandal || '',
            district: joiningData.lead_district || '',
            quota: joiningData.lead_quota || '',
            fatherPhone: joiningData.lead_father_phone || '',
          },
        }
      : {}),
    documents: {
      ssc: joiningData.document_ssc || 'pending',
      inter: joiningData.document_inter || 'pending',
      ugPgCmm: joiningData.document_ug_pg_cmm || 'pending',
      transferCertificate: joiningData.document_transfer_certificate || 'pending',
      studyCertificate: joiningData.document_study_certificate || 'pending',
      aadhaarCard: joiningData.document_aadhaar_card || 'pending',
      photos: joiningData.document_photos || 'pending',
      incomeCertificate: joiningData.document_income_certificate || 'pending',
      casteCertificate: joiningData.document_caste_certificate || 'pending',
      cetRankCard: joiningData.document_cet_rank_card || 'pending',
      cetHallTicket: joiningData.document_cet_hall_ticket || 'pending',
      allotmentLetter: joiningData.document_allotment_letter || 'pending',
      joiningReport: joiningData.document_joining_report || 'pending',
      bankPassbook: joiningData.document_bank_passbook || 'pending',
      rationCard: joiningData.document_ration_card || 'pending',
    },
    draftUpdatedAt: joiningData.draft_updated_at,
    submittedAt: joiningData.submitted_at,
    submittedBy: joiningData.submitted_by,
    approvedAt: joiningData.approved_at,
    approvedBy: joiningData.approved_by,
    createdBy: joiningData.created_by,
    updatedBy: joiningData.updated_by,
    createdAt: joiningData.created_at,
    updatedAt: joiningData.updated_at,
  };
};

export const listJoinings = async (req, res) => {
  try {
    const {
      status: statusParam,
      page = 1,
      limit = 20,
      search = '',
      leadStatus,
      requireEnquiry,
    } = req.query;

    const pool = getPool();
    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Number(page) - 1) * paginationLimit;

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Status filtering
    if (statusParam) {
      const statusesRaw = Array.isArray(statusParam) ? statusParam : String(statusParam).split(',');
      const statuses = statusesRaw
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);

      if (statuses.length === 1) {
        conditions.push('j.status = ?');
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        conditions.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }

    // Lead status filtering
    if (leadStatus) {
      conditions.push('(l.lead_status = ? OR JSON_EXTRACT(j.lead_data, "$.leadStatus") = ?)');
      params.push(leadStatus, leadStatus);
    }

    // Search filtering
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(`(
        l.name LIKE ? OR l.phone LIKE ? OR l.hall_ticket_number LIKE ? OR l.enquiry_number LIKE ?
        OR JSON_EXTRACT(j.lead_data, "$.name") LIKE ? OR JSON_EXTRACT(j.lead_data, "$.phone") LIKE ?
        OR JSON_EXTRACT(j.lead_data, "$.hallTicketNumber") LIKE ? OR JSON_EXTRACT(j.lead_data, "$.enquiryNumber") LIKE ?
        OR j.student_name LIKE ? OR j.student_phone LIKE ?
      )`);
      params.push(
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern
      );
    }

    const enquiryRequired =
      requireEnquiry === true ||
      requireEnquiry === 'true' ||
      requireEnquiry === '1' ||
      String(requireEnquiry || '').toLowerCase() === 'yes';
    if (enquiryRequired) {
      conditions.push(`(
        (l.id IS NOT NULL AND TRIM(COALESCE(l.enquiry_number, '')) <> '')
        OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.enquiryNumber')), '')) <> ''
      )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total
       FROM joinings j
       LEFT JOIN leads l ON j.lead_id = l.id
       ${whereClause}`,
      params
    );
    const total = countResult[0]?.total || 0;

    // Get paginated results
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [joinings] = await pool.execute(
      `SELECT j.*, l.name as lead_name, l.phone as lead_phone, l.hall_ticket_number as lead_hall_ticket_number,
              l.enquiry_number as lead_enquiry_number, l.lead_status as lead_lead_status,
              l.course_interested as lead_course_interested, l.mandal as lead_mandal, l.district as lead_district,
              l.quota as lead_quota, l.father_phone as lead_father_phone
       FROM joinings j
       LEFT JOIN leads l ON j.lead_id = l.id
       ${whereClause}
       ORDER BY j.updated_at DESC
       LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`,
      params
    );

    // List view: skip relatives / education / siblings queries (3 round-trips per row).
    const formattedJoinings = await Promise.all(
      joinings.map((j) => formatJoining(j, pool, { listMode: true }))
    );

    return successResponse(
      res,
      {
        joinings: formattedJoinings,
        pagination: {
          page: Number(page),
          limit: paginationLimit,
          total,
          pages: Math.ceil(total / paginationLimit) || 1,
        },
      },
      'Joining records retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing joining records:', error);
    return errorResponse(
      res,
      error.message || 'Failed to retrieve joining records',
      error.statusCode || 500
    );
  }
};

/**
 * Load joining + lead for read-only flows (no auto-create when a lead has no joining yet).
 * @param {string} leadId Joining id or lead id (same URL segment as authenticated API).
 * @returns {Promise<{ joining: object; lead: object | null }>}
 */
export async function fetchJoiningPayloadReadOnly(leadId) {
  if (!leadId || typeof leadId !== 'string' || leadId === 'new' || leadId === 'undefined') {
    const err = new Error('Joining form not found');
    err.statusCode = 404;
    throw err;
  }

  const pool = getPool();
  let joiningDoc = null;
  let lead = null;

  if (leadId.length === 36) {
    const [joinings] = await pool.execute('SELECT * FROM joinings WHERE id = ?', [leadId]);

    if (joinings.length > 0) {
      joiningDoc = joinings[0];
      if (!joiningDoc.lead_id) {
        const formattedJoining = await formatJoining(joiningDoc, pool);
        return { joining: formattedJoining, lead: null };
      }
      try {
        lead = await ensureLeadExists(joiningDoc.lead_id);
      } catch {
        lead = null;
      }
    }
  }

  if (!joiningDoc) {
    try {
      lead = await ensureLeadExists(leadId);
      const [joinings] = await pool.execute('SELECT * FROM joinings WHERE lead_id = ?', [leadId]);

      if (joinings.length > 0) {
        joiningDoc = joinings[0];
      }
    } catch (error) {
      if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
        const err = new Error('Invalid joining or lead identifier');
        err.statusCode = 404;
        throw err;
      }
      throw error;
    }
  }

  if (!joiningDoc) {
    const err = new Error('Joining form not found');
    err.statusCode = 404;
    throw err;
  }

  const formattedJoining = await formatJoining(joiningDoc, pool);
  if (!lead && joiningDoc.lead_id) {
    try {
      lead = await ensureLeadExists(joiningDoc.lead_id);
    } catch {
      lead = null;
    }
  }

  return { joining: formattedJoining, lead };
};

/**
 * Ensure a draft joining exists for a CRM lead (UUID). Creates one if missing (same as first open of joining form).
 * Only when the lead is in Confirmed status. Throws with statusCode if not allowed.
 * @param {string} leadId Lead UUID
 * @param {string} userId Staff user id for created_by / activity
 */
export async function ensureJoiningDraftForLead(leadId, userId) {
  const pool = getPool();
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    const err = new Error('Invalid lead identifier');
    err.statusCode = 400;
    throw err;
  }

  const [existingByLead] = await pool.execute(
    'SELECT id, status FROM joinings WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1',
    [leadId]
  );

  if (existingByLead.length > 0) {
    if (existingByLead[0].status !== 'draft') {
      const err = new Error(
        'This lead already has a joining form that is not a draft. Manage it from the joining desk.'
      );
      err.statusCode = 400;
      throw err;
    }
    return;
  }

  const lead = await ensureLeadExists(leadId);
  const ls = String(lead.leadStatus || '').trim().toLowerCase();
  if (ls !== 'confirmed') {
    const err = new Error(
      'A self-serve joining link can only be created when the lead is in Confirmed status.'
    );
    err.statusCode = 400;
    throw err;
  }

  const leadDataSnapshot = await buildJoiningLeadDataSnapshot(pool, lead);

  const joiningId = uuidv4();
  await pool.execute(
    `INSERT INTO joinings (
      id, lead_id, lead_data, status, course, quota,
      student_name, student_phone, student_gender, student_notes,
      father_name, father_phone, mother_name,
      reservation_general, reservation_other, reservation_is_ews,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NOW(), NOW())`,
    [
      joiningId,
      leadId,
      JSON.stringify(leadDataSnapshot),
      'draft',
      lead.courseInterested || '',
      lead.quota || '',
      lead.name,
      lead.phone,
      lead.gender || '',
      'As per SSC for no issues',
      lead.fatherName || '',
      lead.fatherPhone || '',
      lead.motherName || '',
      DEFAULT_GENERAL_RESERVATION,
      JSON.stringify([]),
      userId,
      userId,
    ]
  );

  await recordActivity({
    leadId: lead.id,
    userId,
    description: 'Joining draft created for lead self-serve form link',
  });
}

export const getJoining = async (req, res) => {
  try {
    const { leadId } = req.params;

    // Handle new joining form without lead - return empty structure, don't create yet
    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      // Return empty joining structure - will be created on save/submit
      const emptyJoining = {
        _id: null,
        leadId: undefined,
        leadData: {},
        courseInfo: {
          courseId: undefined,
          branchId: undefined,
          course: '',
          branch: '',
          quota: '',
        },
        studentInfo: {
          name: '',
          phone: '',
          preferredMobileNumber: '',
          gender: '',
          dateOfBirth: '',
          notes: 'As per SSC for no issues',
          aadhaarNumber: '',
        },
        parents: {
          father: {
            name: '',
            phone: '',
            aadhaarNumber: '',
            photo: '',
          },
          mother: {
            name: '',
            phone: '',
            aadhaarNumber: '',
            photo: '',
          },
        },
        reservation: {
          general: DEFAULT_GENERAL_RESERVATION,
          other: [],
        },
        address: {
          communication: {
            doorOrStreet: '',
            landmark: '',
            villageOrCity: '',
            mandal: '',
            district: '',
            pinCode: '',
          },
          relatives: [],
        },
        qualifications: {
          ssc: false,
          interOrDiploma: false,
          ug: false,
          merit: null,
          mediums: [],
          otherMediumLabel: '',
        },
        educationHistory: [],
        siblings: [],
        documents: {},
        status: 'draft',
      };

      return successResponse(
        res,
        {
          joining: emptyJoining,
          lead: null,
        },
        'New joining form template loaded',
        200
      );
    }

    const pool = getPool();
    let joiningDoc = null;
    let lead = null;

    // Check if leadId is actually a joining _id (for joinings without leads)
    // First, try to find joining by id (in case it's a joining without a lead)
    if (leadId && typeof leadId === 'string' && leadId.length === 36) {
      const [joinings] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ?',
        [leadId]
      );

      if (joinings.length > 0) {
        joiningDoc = joinings[0];
        if (!joiningDoc.lead_id) {
          // This is a joining without a lead, return it
          const formattedJoining = await formatJoining(joiningDoc, pool);
          return successResponse(
            res,
            {
              joining: formattedJoining,
              lead: null,
            },
            'Joining draft retrieved successfully',
            200
          );
        }
        try {
          lead = await ensureLeadExists(joiningDoc.lead_id);
        } catch {
          lead = null;
        }
      }
    }

    // If not found by id, try to find by leadId
    if (!joiningDoc) {
      try {
        lead = await ensureLeadExists(leadId);
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE lead_id = ?',
          [leadId]
        );

        if (joinings.length > 0) {
          joiningDoc = joinings[0];
        }
      } catch (error) {
        // If lead doesn't exist and it's not a valid UUID, return error
        if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
          return errorResponse(res, 'Invalid joining or lead identifier', 404);
        }
        throw error;
      }
    }

    if (!joiningDoc && lead) {
      const leadDataSnapshot = await buildJoiningLeadDataSnapshot(pool, lead);
      
      const joiningId = uuidv4();
      await pool.execute(
        `INSERT INTO joinings (
          id, lead_id, lead_data, status, course, quota,
          student_name, student_phone, student_gender, student_notes,
          father_name, father_phone, mother_name,
          reservation_general, reservation_other,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          joiningId,
          leadId,
          JSON.stringify(leadDataSnapshot),
          'draft',
          lead.courseInterested || '',
          lead.quota || '',
          lead.name,
          lead.phone,
          lead.gender || '',
          'As per SSC for no issues',
          lead.fatherName || '',
          lead.fatherPhone || '',
          lead.motherName || '',
          DEFAULT_GENERAL_RESERVATION,
          JSON.stringify([]),
          req.user.id,
          req.user.id,
        ]
      );

      // Fetch created joining
      const [created] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ?',
        [joiningId]
      );
      joiningDoc = created[0];

      await recordActivity({
        leadId: lead.id,
        userId: req.user.id,
        description: 'Joining draft created automatically',
      });
    }

    if (joiningDoc && lead) {
      await backfillJoiningReferenceFromLead(pool, joiningDoc, lead);
      const reference1 = await resolveReference1ForLead(pool, lead);
      if (reference1 && !readReference1FromDynamicFields(lead.dynamicFields)) {
        lead.dynamicFields = { ...(lead.dynamicFields || {}), reference1 };
        lead.reference1 = reference1;
      }
    }

    const formattedJoining = joiningDoc ? await formatJoining(joiningDoc, pool) : null;

    return successResponse(
      res,
      {
        joining: formattedJoining,
        lead,
      },
      'Joining draft retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error retrieving joining draft:', error);
    return errorResponse(
      res,
      error.message || 'Failed to load joining draft',
      error.statusCode || 500
    );
  }
};

const STUDENT_PHONE_REG_KEYS = [
  'student_phone',
  'phone',
  'mobile',
  'phonenumber',
  'student_mobile',
  'student_mobileno',
  'mobile_number',
  'phone_number',
  'contact_number',
  'primary_phone',
  'student_contact_number',
];

const STUDENT_DOB_REG_KEYS = [
  'date_of_birth',
  'dateofbirth',
  'dob',
  'student_dob',
  'student_date_of_birth',
  'birth_date',
  'birthdate',
];

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

function normalizePhoneTenDigits(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length >= 10) return d.slice(-10);
  return d;
}

/** Fill structured student phone / DOB from registration JSON when columns would otherwise stay empty. */
function mergeStudentInfoFromRegistrationFormData(studentInfo, registrationFormData) {
  const next = { ...studentInfo };
  let phoneDigits = normalizePhoneTenDigits(next.phone || '');
  if (phoneDigits.length !== 10) {
    const fromReg = normalizePhoneTenDigits(
      pickFromRegistrationFormData(registrationFormData, STUDENT_PHONE_REG_KEYS)
    );
    if (fromReg.length === 10) phoneDigits = fromReg;
  }
  if (phoneDigits.length === 10) {
    next.phone = phoneDigits;
  }

  let dob = String(next.dateOfBirth || '').trim();
  if (!dob) {
    dob = String(pickFromRegistrationFormData(registrationFormData, STUDENT_DOB_REG_KEYS) || '').trim();
  }
  if (dob) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      const [y, m, day] = dob.split('-');
      dob = `${day}-${m}-${y}`;
    }
    next.dateOfBirth = dob;
  }

  return next;
}

function parseJoiningRegistrationExtras(joiningRow) {
  try {
    const ld =
      typeof joiningRow.lead_data === 'string'
        ? JSON.parse(joiningRow.lead_data)
        : joiningRow.lead_data || {};
    if (ld && typeof ld === 'object' && ld._joiningRegistrationExtras && typeof ld._joiningRegistrationExtras === 'object') {
      return ld._joiningRegistrationExtras;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** Phone (10 digits) and DOB (DD-MM-YYYY when possible) from row + `lead_data._joiningRegistrationExtras`. */
function getEffectiveStudentPhoneAndDob(joiningRow) {
  const extras = parseJoiningRegistrationExtras(joiningRow);
  let phoneDigits = normalizePhoneTenDigits(joiningRow.student_phone || '');
  if (phoneDigits.length !== 10) {
    phoneDigits = normalizePhoneTenDigits(
      pickFromRegistrationFormData(extras, STUDENT_PHONE_REG_KEYS)
    );
  }

  let dobVal = String(joiningRow.student_date_of_birth || '').trim();
  if (!dobVal) {
    dobVal = String(pickFromRegistrationFormData(extras, STUDENT_DOB_REG_KEYS) || '').trim();
  }
  if (dobVal && /^\d{4}-\d{2}-\d{2}$/.test(dobVal)) {
    const [y, m, d] = dobVal.split('-');
    dobVal = `${d}-${m}-${y}`;
  }
  return { phoneDigits, dobVal };
}

const normalizeJoiningPayload = (payload) => {
  const safePayload = { ...payload };
  const rawRegForMerge =
    safePayload.registrationFormData && typeof safePayload.registrationFormData === 'object'
      ? safePayload.registrationFormData
      : {};
  if (safePayload.studentInfo && Object.keys(rawRegForMerge).length > 0) {
    safePayload.studentInfo = mergeStudentInfoFromRegistrationFormData(
      safePayload.studentInfo,
      rawRegForMerge
    );
  }

  if (safePayload.studentInfo) {
    safePayload.studentInfo.name = sanitizeString(safePayload.studentInfo.name);
    safePayload.studentInfo.phone = sanitizeString(safePayload.studentInfo.phone);
    const preferredFromPayload = normalizeMobileDigits(
      safePayload.studentInfo.preferredMobileNumber
    );
    const preferredFromReg = pickFromRegistrationFormData(
      rawRegForMerge,
      PREFERRED_MOBILE_REG_KEYS
    );
    const preferredResolved = normalizeMobileDigits(
      preferredFromPayload || preferredFromReg
    );
    safePayload.studentInfo.preferredMobileNumber =
      preferredResolved.length === 10 ? preferredResolved : '';
    safePayload.studentInfo.gender = sanitizeString(safePayload.studentInfo.gender);
    safePayload.studentInfo.dateOfBirth = sanitizeString(
      safePayload.studentInfo.dateOfBirth
    );

    if (safePayload.studentInfo.dateOfBirth) {
      const dob = safePayload.studentInfo.dateOfBirth;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        const [year, month, day] = dob.split('-');
        safePayload.studentInfo.dateOfBirth = `${day}-${month}-${year}`;
      }
    }
  }

  if (safePayload.parents?.father) {
    safePayload.parents.father.name = sanitizeString(safePayload.parents.father.name);
    safePayload.parents.father.phone = sanitizeString(
      safePayload.parents.father.phone
    );
  }

  if (safePayload.parents?.mother) {
    safePayload.parents.mother.name = sanitizeString(safePayload.parents.mother.name);
    safePayload.parents.mother.phone = sanitizeString(
      safePayload.parents.mother.phone
    );
  }

  if (safePayload.reservation) {
    safePayload.reservation.general =
      safePayload.reservation.general || DEFAULT_GENERAL_RESERVATION;
    safePayload.reservation.other =
      safePayload.reservation.other?.map((entry) => sanitizeString(entry)) || [];
  }

  if (safePayload.courseInfo) {
    safePayload.courseInfo = {
      ...safePayload.courseInfo,
      course: sanitizeString(safePayload.courseInfo.course),
      branch: sanitizeString(safePayload.courseInfo.branch),
      quota: sanitizeString(safePayload.courseInfo.quota),
    };

    if (safePayload.courseInfo.courseId === '') {
      safePayload.courseInfo.courseId = undefined;
    }

    if (safePayload.courseInfo.branchId === '') {
      safePayload.courseInfo.branchId = undefined;
    }
  }

  if (safePayload.registrationFormData && typeof safePayload.registrationFormData === 'object') {
    const cleaned = {};
    Object.entries(safePayload.registrationFormData).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        cleaned[k] = v;
      }
    });
    safePayload.registrationFormData = cleaned;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'studentFeeDetails')) {
    safePayload.studentFeeDetails = sanitizeStudentFeeDetailsForDb(payload.studentFeeDetails);
  }

  return safePayload;
};

// Helper function to save related tables (relatives, education history, siblings)
const saveJoiningRelatedTables = async (pool, joiningId, payload) => {
  // Delete existing related records
  await pool.execute('DELETE FROM joining_relatives WHERE joining_id = ?', [joiningId]);
  await pool.execute('DELETE FROM joining_education_history WHERE joining_id = ?', [joiningId]);
  await pool.execute('DELETE FROM joining_siblings WHERE joining_id = ?', [joiningId]);

  // Insert relatives
  if (Array.isArray(payload.address?.relatives)) {
    for (const relative of payload.address.relatives) {
      const relativeId = uuidv4();
      await pool.execute(
        `INSERT INTO joining_relatives (id, joining_id, name, relationship, door_street, landmark,
         village_city, mandal, district, pin_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          relativeId,
          joiningId,
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
        `INSERT INTO joining_education_history (id, joining_id, level, other_level_label,
         course_or_branch, year_of_passing, institution_name, institution_address,
         hall_ticket_number, total_marks_or_grade, cet_rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eduId,
          joiningId,
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
    for (const sibling of payload.siblings) {
      const siblingId = uuidv4();
      await pool.execute(
        `INSERT INTO joining_siblings (id, joining_id, name, relation, studying_standard,
         institution_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          siblingId,
          joiningId,
          sibling.name || '',
          sibling.relation || '',
          sibling.studyingStandard || '',
          sibling.institutionName || '',
        ]
      );
    }
  }
};

export const saveJoiningDraft = async (req, res) => {
  try {
    const { leadId } = req.params;
    const payload = normalizeJoiningPayload(req.body || {});
    const pool = getPool();

    // Handle new joining form without lead
    const isNewJoining = leadId === 'new' || !leadId || leadId === 'undefined';
    let lead = null;
    let joiningId = null;

    if (isNewJoining) {
      // For new joining, get joiningId from payload or create new
      if (payload._id) {
        joiningId = payload._id;
      }
    } else {
      // Check if leadId is actually a joining _id (for joinings without leads)
      if (leadId && typeof leadId === 'string' && leadId.length === 36) {
        const [existingJoinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [leadId]
        );

        if (existingJoinings.length > 0) {
          const existingJoining = existingJoinings[0];
          if (!existingJoining.lead_id) {
            // This is a joining without a lead, use it directly
            joiningId = leadId;
            lead = null;
          } else if (existingJoining.lead_id) {
            // This is a joining with a lead, use the leadId
            lead = await ensureLeadExists(existingJoining.lead_id);
          } else {
            // Try to find lead
            try {
              lead = await ensureLeadExists(leadId);
            } catch (error) {
              // If lead not found, treat as invalid
              if (error.statusCode === 404) {
                return errorResponse(res, 'Invalid joining or lead identifier', 404);
              }
              throw error;
            }
          }
        } else {
          // Try to find lead
          try {
            lead = await ensureLeadExists(leadId);
          } catch (error) {
            if (error.statusCode === 404) {
              return errorResponse(res, 'Invalid joining or lead identifier', 404);
            }
            throw error;
          }
        }
      } else {
        // Existing flow: ensure lead exists
        lead = await ensureLeadExists(leadId);
      }
    }

    let courseDoc = null;
    let branchDoc = null;
    // Managed courses / branches in the app come from the student (secondary) database — same as payment settings.
    // The primary pool may not contain matching `courses` / `branches` rows, so validate there.
    const secondaryPool = getSecondaryPool();

    if (payload.courseInfo?.branchId && !payload.courseInfo?.courseId) {
      const [branches] = await secondaryPool.execute(
        'SELECT * FROM course_branches WHERE id = ?',
        [payload.courseInfo.branchId]
      );
      if (branches.length === 0) {
        return errorResponse(res, 'Selected branch could not be found', 404);
      }
      branchDoc = branches[0];
      payload.courseInfo.courseId = branchDoc.course_id;
    }

    if (payload.courseInfo?.courseId) {
      const [courses] = await secondaryPool.execute(
        'SELECT * FROM courses WHERE id = ?',
        [payload.courseInfo.courseId]
      );
      if (courses.length === 0) {
        return errorResponse(res, 'Selected course could not be found', 404);
      }
      courseDoc = courses[0];
      payload.courseInfo.courseId = courseDoc.id;
    }

    if (payload.courseInfo?.branchId) {
      if (!branchDoc) {
        const [branches] = await secondaryPool.execute(
          'SELECT * FROM course_branches WHERE id = ? AND course_id = ?',
          [payload.courseInfo.branchId, payload.courseInfo.courseId || courseDoc?.id]
        );
        if (branches.length === 0) {
          return errorResponse(res, 'Selected branch is invalid for the chosen course', 400);
        }
        branchDoc = branches[0];
      }

      payload.courseInfo.branchId = branchDoc.id;
      if (!payload.courseInfo.branch) {
        payload.courseInfo.branch = branchDoc.name;
      }

      if (!payload.courseInfo.courseId) {
        payload.courseInfo.courseId = branchDoc.course_id;
      }
    }

    if (courseDoc && !payload.courseInfo?.course) {
      payload.courseInfo.course = courseDoc.name;
    }

    let joiningIdToUse = null;
    let previousStatus = 'draft';
    let isNewRecord = false;

    // Find or create joining
    if (isNewJoining || joiningId) {
      const payloadId = payload._id || joiningId;
      delete payload._id;

      if (payloadId && typeof payloadId === 'string' && payloadId.length === 36) {
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [payloadId]
        );
        if (joinings.length > 0) {
          joiningIdToUse = payloadId;
          previousStatus = joinings[0].status;
        } else {
          return errorResponse(res, 'Joining form not found', 404);
        }
      } else {
        return errorResponse(
          res,
          'Standalone joining drafts without an enquiry number are no longer allowed. Use "Add Joining Form" on the joining pipeline to create a lead with an enquiry and a linked draft.',
          400
        );
      }
    } else {
      if (joiningId) {
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [joiningId]
        );
        if (joinings.length > 0) {
          joiningIdToUse = joiningId;
          previousStatus = joinings[0].status;
        } else {
          return errorResponse(res, 'Joining form not found', 404);
        }
      } else {
        // Try to find by leadId
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE lead_id = ?',
          [leadId]
        );
        if (joinings.length > 0) {
          joiningIdToUse = joinings[0].id;
          previousStatus = joinings[0].status;
        } else {
          const enq = String(lead?.enquiryNumber || '').trim();
          if (!enq) {
            return errorResponse(
              res,
              'This lead does not have an enquiry number yet. Assign an enquiry before creating a joining form.',
              400
            );
          }
          // Create new joining for this lead
          joiningIdToUse = uuidv4();
          isNewRecord = true;
          const leadDataSnapshot = await buildJoiningLeadDataSnapshot(pool, lead);

          await pool.execute(
            `INSERT INTO joinings (id, lead_id, lead_data, status, reservation_general, reservation_other,
             course, quota, student_name, student_phone, student_gender, student_notes,
             father_name, father_phone, mother_name, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              joiningIdToUse,
              leadId,
              JSON.stringify(leadDataSnapshot),
              'draft',
              DEFAULT_GENERAL_RESERVATION,
              JSON.stringify([]),
              lead?.courseInterested || '',
              lead?.quota || '',
              lead?.name || '',
              lead?.phone || '',
              lead?.gender || '',
              'As per SSC for no issues',
              lead?.fatherName || '',
              lead?.fatherPhone || '',
              lead?.motherName || '',
              req.user.id,
              req.user.id,
            ]
          );
        }
      }
    }

    if (!joiningIdToUse) {
      return errorResponse(res, 'Joining form not found', 404);
    }

    const [orphanGuard] = await pool.execute(
      `SELECT j.lead_id, j.lead_data, j.status,
        TRIM(COALESCE(l.enquiry_number, '')) AS lead_enquiry
       FROM joinings j
       LEFT JOIN leads l ON j.lead_id = l.id
       WHERE j.id = ? LIMIT 1`,
      [joiningIdToUse]
    );
    if (orphanGuard.length > 0) {
      const g = orphanGuard[0];
      if (String(g.status || '').toLowerCase() === 'draft') {
        let enqSnap = '';
        try {
          const ld =
            typeof g.lead_data === 'string' ? JSON.parse(g.lead_data || '{}') : g.lead_data || {};
          enqSnap = String(ld.enquiryNumber || '').trim();
        } catch {
          enqSnap = '';
        }
        const hasEnquiry = String(g.lead_enquiry || '').trim() !== '' || enqSnap !== '';
        if (!hasEnquiry) {
          return errorResponse(
            res,
            'This joining draft has no enquiry number (on the lead or on the form snapshot) and cannot be saved. Remove it from the joining desk and use "Add Joining Form" instead.',
            400
          );
        }
      }
    }

    // Prepare joining data for update
    const studentInfo = payload.studentInfo || {};
    const parents = payload.parents || {};
    const courseInfo = payload.courseInfo || {};
    const reservation = payload.reservation || { general: DEFAULT_GENERAL_RESERVATION, other: [] };
    const address = payload.address || {};
    const qualifications = payload.qualifications || {};
    const documents = payload.documents || {};

    // FK columns: only set when a matching row exists in primary DB; managed IDs live in lead_data.
    const { fkCourseId: joiningFkCourseId, fkBranchId: joiningFkBranchId } =
      await resolvePrimaryCourseBranchFkIds(pool, courseInfo.courseId, courseInfo.branchId);

    // Apply lead defaults if lead exists
    let finalPayload = { ...payload };
    if (lead) {
      const tempJoining = { ...finalPayload };
      applyLeadDefaultsToJoining(tempJoining, lead);
      finalPayload = tempJoining;

      // Sync changes to lead
      const leadWasUpdated = syncLeadWithJoining(lead, finalPayload);
      if (leadWasUpdated) {
        // Update lead in SQL
        const updateFields = [];
        const updateParams = [];
        if (lead.name) { updateFields.push('name = ?'); updateParams.push(lead.name); }
        if (lead.phone) { updateFields.push('phone = ?'); updateParams.push(lead.phone); }
        if (lead.gender) { updateFields.push('gender = ?'); updateParams.push(lead.gender); }
        if (lead.fatherName) { updateFields.push('father_name = ?'); updateParams.push(lead.fatherName); }
        if (lead.fatherPhone) { updateFields.push('father_phone = ?'); updateParams.push(lead.fatherPhone); }
        if (lead.motherName) { updateFields.push('mother_name = ?'); updateParams.push(lead.motherName); }
        if (lead.village) { updateFields.push('village = ?'); updateParams.push(lead.village); }
        if (lead.mandal) { updateFields.push('mandal = ?'); updateParams.push(lead.mandal); }
        if (lead.district) { updateFields.push('district = ?'); updateParams.push(lead.district); }
        if (lead.quota) { updateFields.push('quota = ?'); updateParams.push(lead.quota); }
        if (lead.courseInterested) { updateFields.push('course_interested = ?'); updateParams.push(lead.courseInterested); }
        if (lead.interCollege) { updateFields.push('inter_college = ?'); updateParams.push(lead.interCollege); }

        if (updateFields.length > 0) {
          updateFields.push('updated_at = NOW()');
          updateParams.push(leadId);
          await pool.execute(
            `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
            updateParams
          );
        }
      }

      // Update lead data snapshot; preserve registration extras from form builder (unmapped fields)
      let preservedRegistrationExtras = {};
      let preservedStudentFeeDetails = null;
      try {
        const [existingJoiningRows] = await pool.execute(
          'SELECT lead_data FROM joinings WHERE id = ?',
          [joiningIdToUse]
        );
        if (existingJoiningRows?.[0]?.lead_data) {
          const parsed =
            typeof existingJoiningRows[0].lead_data === 'string'
              ? JSON.parse(existingJoiningRows[0].lead_data)
              : existingJoiningRows[0].lead_data;
          if (
            parsed &&
            typeof parsed === 'object' &&
            parsed._joiningRegistrationExtras &&
            typeof parsed._joiningRegistrationExtras === 'object'
          ) {
            preservedRegistrationExtras = { ...parsed._joiningRegistrationExtras };
          }
          if (
            parsed &&
            typeof parsed === 'object' &&
            parsed._joiningStudentFeeDetails &&
            typeof parsed._joiningStudentFeeDetails === 'object'
          ) {
            preservedStudentFeeDetails = { ...parsed._joiningStudentFeeDetails };
          }
        }
      } catch {
        /* ignore parse errors */
      }

      const leadDataSnapshot = await buildJoiningLeadDataSnapshot(pool, lead);

      const mergedRegistrationExtras = {
        ...preservedRegistrationExtras,
        ...(payload.registrationFormData && typeof payload.registrationFormData === 'object'
          ? payload.registrationFormData
          : {}),
      };

      const nextStudentFees = Object.prototype.hasOwnProperty.call(payload, 'studentFeeDetails')
        ? sanitizeStudentFeeDetailsForDb(payload.studentFeeDetails)
        : sanitizeStudentFeeDetailsForDb(preservedStudentFeeDetails);
      const studentFeeSidecar =
        nextStudentFees && (nextStudentFees.lines?.length > 0 || nextStudentFees.batch)
          ? { _joiningStudentFeeDetails: nextStudentFees }
          : {};

      const trimmedProgramLevel =
        courseInfo.programLevel != null && String(courseInfo.programLevel).trim()
          ? String(courseInfo.programLevel).trim()
          : '';
      finalPayload.leadData = {
        ...leadDataSnapshot,
        ...(trimmedProgramLevel ? { _joiningProgramLevel: trimmedProgramLevel } : {}),
        ...(Object.keys(mergedRegistrationExtras).length > 0
          ? { _joiningRegistrationExtras: mergedRegistrationExtras }
          : {}),
        ...studentFeeSidecar,
      };
    } else if (!lead && joiningIdToUse) {
      let base = {};
      try {
        const [rows] = await pool.execute('SELECT lead_data FROM joinings WHERE id = ?', [joiningIdToUse]);
        if (rows?.[0]?.lead_data) {
          base =
            typeof rows[0].lead_data === 'string'
              ? JSON.parse(rows[0].lead_data)
              : rows[0].lead_data;
        }
      } catch {
        base = {};
      }
      if (!base || typeof base !== 'object') base = {};
      const prevExtras =
        base._joiningRegistrationExtras && typeof base._joiningRegistrationExtras === 'object'
          ? { ...base._joiningRegistrationExtras }
          : {};
      const mergedRegistrationExtras = {
        ...prevExtras,
        ...(payload.registrationFormData && typeof payload.registrationFormData === 'object'
          ? payload.registrationFormData
          : {}),
      };
      const prevSfd =
        base._joiningStudentFeeDetails && typeof base._joiningStudentFeeDetails === 'object'
          ? base._joiningStudentFeeDetails
          : null;
      const nextStudentFees = Object.prototype.hasOwnProperty.call(payload, 'studentFeeDetails')
        ? sanitizeStudentFeeDetailsForDb(payload.studentFeeDetails)
        : sanitizeStudentFeeDetailsForDb(prevSfd);
      const studentFeeSidecar =
        nextStudentFees && (nextStudentFees.lines?.length > 0 || nextStudentFees.batch)
          ? { _joiningStudentFeeDetails: nextStudentFees }
          : {};

      const {
        _joiningRegistrationExtras: _strip,
        _joiningStudentFeeDetails: _stripSfd,
        ...baseWithout
      } = base;
      const trimmedProgramLevelNoLead =
        courseInfo.programLevel != null && String(courseInfo.programLevel).trim()
          ? String(courseInfo.programLevel).trim()
          : '';
      finalPayload.leadData = {
        ...baseWithout,
        ...(trimmedProgramLevelNoLead ? { _joiningProgramLevel: trimmedProgramLevelNoLead } : {}),
        ...(Object.keys(mergedRegistrationExtras).length > 0
          ? { _joiningRegistrationExtras: mergedRegistrationExtras }
          : {}),
        ...studentFeeSidecar,
      };
    }

    const managedCourseRefs = {};
    if (courseInfo.courseId != null && String(courseInfo.courseId) !== '') {
      managedCourseRefs._joiningManagedCourseId = courseInfo.courseId;
    }
    if (courseInfo.branchId != null && String(courseInfo.branchId) !== '') {
      managedCourseRefs._joiningManagedBranchId = courseInfo.branchId;
    }
    if (Object.keys(managedCourseRefs).length > 0) {
      finalPayload.leadData = {
        ...(finalPayload.leadData && typeof finalPayload.leadData === 'object' ? finalPayload.leadData : {}),
        ...managedCourseRefs,
      };
    }

    if (payload.reference1 !== undefined) {
      const ref = String(payload.reference1 ?? '').trim();
      finalPayload.leadData = {
        ...(finalPayload.leadData && typeof finalPayload.leadData === 'object' ? finalPayload.leadData : {}),
        reference1: ref,
      };
      if (lead?.id) {
        await pool.execute(
          `UPDATE leads SET
             dynamic_fields = JSON_SET(
               COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
               '$.reference1', ?
             ),
             updated_at = NOW()
           WHERE id = ?`,
          [ref, lead.id]
        );
      }
    }

    const regExtrasForParentPhotos =
      finalPayload.leadData &&
      typeof finalPayload.leadData === 'object' &&
      finalPayload.leadData._joiningRegistrationExtras &&
      typeof finalPayload.leadData._joiningRegistrationExtras === 'object'
        ? finalPayload.leadData._joiningRegistrationExtras
        : {};
    const fatherPhotoForRowPick = pickFromRegistrationFormData(
      regExtrasForParentPhotos,
      FATHER_PHOTO_REG_KEYS
    );
    const motherPhotoForRowPick = pickFromRegistrationFormData(
      regExtrasForParentPhotos,
      MOTHER_PHOTO_REG_KEYS
    );
    const fatherPhotoForRow = fatherPhotoForRowPick ? fatherPhotoForRowPick : null;
    const motherPhotoForRow = motherPhotoForRowPick ? motherPhotoForRowPick : null;

    const statusToPersist =
      previousStatus === 'approved' || previousStatus === 'pending_approval'
        ? previousStatus
        : 'draft';
    const preserveApprovalTimestamps = statusToPersist === 'approved';

    // Update main joining record
    await pool.execute(
      `UPDATE joinings SET
        lead_id = ?,
        lead_data = ?,
        status = ?,
        course_id = ?,
        branch_id = ?,
        managed_course_id = ?,
        managed_branch_id = ?,
        course = ?,
        branch = ?,
        quota = ?,
        student_name = ?,
        student_phone = ?,
        student_gender = ?,
        student_date_of_birth = ?,
        student_notes = ?,
        student_aadhaar_number = ?,
        father_name = ?,
        father_phone = ?,
        father_aadhaar_number = ?,
        mother_name = ?,
        mother_phone = ?,
        mother_aadhaar_number = ?,
        preferred_mobile_number = ?,
        father_photo = ?,
        mother_photo = ?,
        reservation_general = ?,
        reservation_other = ?,
        address_door_street = ?,
        address_landmark = ?,
        address_village_city = ?,
        address_mandal = ?,
        address_district = ?,
        address_pin_code = ?,
        qualification_ssc = ?,
        qualification_inter_diploma = ?,
        qualification_ug = ?,
        qualification_merit = ?,
        qualification_mediums = ?,
        qualification_other_medium_label = ?,
        document_ssc = ?,
        document_inter = ?,
        document_ug_pg_cmm = ?,
        document_transfer_certificate = ?,
        document_study_certificate = ?,
        document_aadhaar_card = ?,
        document_photos = ?,
        document_income_certificate = ?,
        document_caste_certificate = ?,
        document_cet_rank_card = ?,
        document_cet_hall_ticket = ?,
        document_allotment_letter = ?,
        document_joining_report = ?,
        document_bank_passbook = ?,
        document_ration_card = ?,
        reservation_is_ews = ?,
        draft_updated_at = NOW(),
        submitted_at = ${preserveApprovalTimestamps ? 'submitted_at' : 'NULL'},
        submitted_by = ${preserveApprovalTimestamps ? 'submitted_by' : 'NULL'},
        approved_at = ${preserveApprovalTimestamps ? 'approved_at' : 'NULL'},
        approved_by = ${preserveApprovalTimestamps ? 'approved_by' : 'NULL'},
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        finalPayload.leadId || lead?.id || null,
        JSON.stringify(finalPayload.leadData || {}),
        statusToPersist,
        joiningFkCourseId,
        joiningFkBranchId,
        normalizeManagedIdForDb(courseInfo.courseId),
        normalizeManagedIdForDb(courseInfo.branchId),
        courseInfo.course || '',
        courseInfo.branch || '',
        courseInfo.quota || '',
        studentInfo.name || '',
        studentInfo.phone || '',
        studentInfo.gender || '',
        studentInfo.dateOfBirth || '',
        studentInfo.notes || '',
        studentInfo.aadhaarNumber || null,
        parents.father?.name || '',
        parents.father?.phone || '',
        parents.father?.aadhaarNumber || null,
        parents.mother?.name || '',
        parents.mother?.phone || '',
        parents.mother?.aadhaarNumber || null,
        (() => {
          const p = normalizeMobileDigits(studentInfo?.preferredMobileNumber);
          return p.length === 10 ? p : null;
        })(),
        fatherPhotoForRow,
        motherPhotoForRow,
        reservation.general || DEFAULT_GENERAL_RESERVATION,
        JSON.stringify(reservation.other || []),
        address.communication?.doorOrStreet || '',
        address.communication?.landmark || '',
        address.communication?.villageOrCity || '',
        address.communication?.mandal || '',
        address.communication?.district || '',
        address.communication?.pinCode || '',
        qualifications.ssc === true ? 1 : 0,
        qualifications.interOrDiploma === true ? 1 : 0,
        qualifications.ug === true ? 1 : 0,
        qualificationMeritToSql(qualifications.merit),
        JSON.stringify(qualifications.mediums || []),
        qualifications.otherMediumLabel || '',
        documents.ssc || 'pending',
        documents.inter || 'pending',
        documents.ugPgCmm || 'pending',
        documents.transferCertificate || 'pending',
        documents.studyCertificate || 'pending',
        documents.aadhaarCard || 'pending',
        documents.photos || 'pending',
        documents.incomeCertificate || 'pending',
        documents.casteCertificate || 'pending',
        documents.cetRankCard || 'pending',
        documents.cetHallTicket || 'pending',
        documents.allotmentLetter || 'pending',
        documents.joiningReport || 'pending',
        documents.bankPassbook || 'pending',
        documents.rationCard || 'pending',
        reservation.isEws === true ? 1 : 0,
        req.user.id,
        joiningIdToUse,
      ]
    );

    // Save related tables
    await saveJoiningRelatedTables(pool, joiningIdToUse, finalPayload);

    const resolvedLeadIdForFeeMirror =
      (lead && lead.id) ||
      (finalPayload.leadId != null && String(finalPayload.leadId).trim() !== ''
        ? String(finalPayload.leadId).trim()
        : null);
    const rawStudentFeeFromLeadData =
      finalPayload.leadData &&
      typeof finalPayload.leadData === 'object' &&
      Object.prototype.hasOwnProperty.call(finalPayload.leadData, '_joiningStudentFeeDetails')
        ? finalPayload.leadData._joiningStudentFeeDetails
        : null;
    await syncJoiningStudentFeeDetailsToFeeMongo({
      joiningId: joiningIdToUse,
      leadId: resolvedLeadIdForFeeMirror,
      studentFeeDetails: sanitizeStudentFeeDetailsForDb(rawStudentFeeFromLeadData),
    });

    if (payload.reference1 !== undefined) {
      const [admRows] = await pool.execute(
        'SELECT id FROM admissions WHERE joining_id = ? LIMIT 1',
        [joiningIdToUse]
      );
      if (admRows.length > 0) {
        await persistAdmissionReference1(pool, admRows[0].id, payload.reference1, req.user.id);
      }
    }

    if (
      previousStatus === 'approved' &&
      courseInfo?.courseId &&
      courseInfo?.branchId
    ) {
      const [admRows] = await pool.execute(
        'SELECT id FROM admissions WHERE joining_id = ? LIMIT 1',
        [joiningIdToUse]
      );
      if (admRows.length > 0) {
        await persistAdmissionCourseBranchUpdate(
          pool,
          admRows[0].id,
          courseInfo,
          req.user?.id,
          joiningIdToUse
        );
      }
    }

    // Record activity if lead exists
    if (lead) {
      await recordActivity({
        leadId: lead.id,
        userId: req.user.id,
        description: 'Joining form saved as draft',
        statusFrom: previousStatus,
        statusTo: statusToPersist,
      });
    }

    // Fetch and return formatted joining
    const [updated] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joiningIdToUse]
    );
    const formattedJoining = await formatJoining(updated[0], pool);

    return successResponse(
      res,
      formattedJoining,
      'Joining form saved as draft',
      200
    );
  } catch (error) {
    console.error('Error saving joining draft:', error);
    return errorResponse(
      res,
      error.message || 'Failed to save joining draft',
      error.statusCode || 500
    );
  }
};

/**
 * Merge certificate-related registration extras and/or student fee line overrides into
 * `joinings.lead_data`, mirror the same keys into the linked `admissions.lead_data` snapshot,
 * and re-sync fee Mongo when fee details change. Only allowed once the joining is approved.
 */
export const patchJoiningStepTwo = async (req, res) => {
  try {
    const { leadId } = req.params;
    if (!leadId || leadId === 'new' || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    const pool = getPool();
    const [joiningRows] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ? OR lead_id = ? LIMIT 1',
      [leadId, leadId]
    );
    if (!joiningRows.length) {
      return errorResponse(res, 'Joining not found', 404);
    }
    const joining = joiningRows[0];
    if (joining.status !== 'approved') {
      return errorResponse(
        res,
        'Certificate checklist and fee lines can only be edited after the joining is approved.',
        400
      );
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patchReg =
      body.registrationFormData && typeof body.registrationFormData === 'object'
        ? body.registrationFormData
        : {};
    const hasStudentFees = Object.prototype.hasOwnProperty.call(body, 'studentFeeDetails');

    let ld =
      typeof joining.lead_data === 'string' ? JSON.parse(joining.lead_data) : joining.lead_data || {};
    if (!ld || typeof ld !== 'object') ld = {};

    const prevExtras =
      ld._joiningRegistrationExtras && typeof ld._joiningRegistrationExtras === 'object'
        ? { ...ld._joiningRegistrationExtras }
        : {};
    const mergedExtras = { ...prevExtras, ...patchReg };

    const nextLd = {
      ...ld,
      ...(Object.keys(mergedExtras).length > 0 ? { _joiningRegistrationExtras: mergedExtras } : {}),
    };

    let rawFees = null;
    if (hasStudentFees) {
      rawFees = sanitizeStudentFeeDetailsForDb(body.studentFeeDetails);
      if (rawFees && (rawFees.lines?.length > 0 || rawFees.batch)) {
        nextLd._joiningStudentFeeDetails = rawFees;
      } else {
        delete nextLd._joiningStudentFeeDetails;
        rawFees = null;
      }
    }

    await pool.execute(
      `UPDATE joinings SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(nextLd), req.user.id, joining.id]
    );

    const resolvedLeadIdForFeeMirror =
      joining.lead_id != null && String(joining.lead_id).trim() !== ''
        ? String(joining.lead_id).trim()
        : null;

    if (hasStudentFees) {
      await syncJoiningStudentFeeDetailsToFeeMongo({
        joiningId: joining.id,
        leadId: resolvedLeadIdForFeeMirror,
        studentFeeDetails: rawFees,
      });
    }

    const [admRows] = await pool.execute('SELECT * FROM admissions WHERE joining_id = ? LIMIT 1', [
      joining.id,
    ]);
    if (admRows.length > 0) {
      const adm = admRows[0];
      let admLd =
        typeof adm.lead_data === 'string' ? JSON.parse(adm.lead_data) : adm.lead_data || {};
      if (!admLd || typeof admLd !== 'object') admLd = {};

      const admPrevExtras =
        admLd._joiningRegistrationExtras && typeof admLd._joiningRegistrationExtras === 'object'
          ? { ...admLd._joiningRegistrationExtras }
          : {};
      const admMergedExtras = { ...admPrevExtras, ...patchReg };
      const admNextLd = {
        ...admLd,
        ...(Object.keys(admMergedExtras).length > 0
          ? { _joiningRegistrationExtras: admMergedExtras }
          : {}),
      };
      if (hasStudentFees) {
        if (rawFees && (rawFees.lines?.length > 0 || rawFees.batch)) {
          admNextLd._joiningStudentFeeDetails = rawFees;
        } else {
          delete admNextLd._joiningStudentFeeDetails;
        }
      }

      await pool.execute(
        `UPDATE admissions SET lead_data = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(admNextLd), req.user.id, adm.id]
      );

      const [admFresh] = await pool.execute('SELECT * FROM admissions WHERE id = ?', [adm.id]);
      const formattedAdmission = await formatAdmission(admFresh[0], pool);
      warnIfSecondaryStudentSyncMissed(
        'patchJoiningStepTwo',
        { joiningId: joining.id, admissionId: adm.id },
        await syncToSecondaryDatabase(formattedAdmission, formattedAdmission.admissionNumber, {
          leadId: formattedAdmission.leadId,
          joiningId: formattedAdmission.joiningId,
          email: formattedAdmission.leadData?.email || '',
        })
      );
    }

    const [updatedJoining] = await pool.execute('SELECT * FROM joinings WHERE id = ?', [joining.id]);
    const formattedJoining = await formatJoining(updatedJoining[0], pool);
    return successResponse(
      res,
      { joining: formattedJoining },
      'Certificate checklist and fee lines saved',
      200
    );
  } catch (error) {
    console.error('Error patching joining step two:', error);
    return errorResponse(
      res,
      error.message || 'Failed to save certificate and fee details',
      error.statusCode || 500
    );
  }
};

/**
 * Resolve managed course/branch ids from a joinings row (same precedence as `formatJoining`).
 * @returns {{ courseId: string | null, branchId: string | null }}
 */
const getEffectiveManagedCourseBranchIds = (joiningData) => {
  if (!joiningData) return { courseId: null, branchId: null };

  let leadDataRaw = {};
  try {
    leadDataRaw =
      typeof joiningData.lead_data === 'string'
        ? JSON.parse(joiningData.lead_data || '{}')
        : joiningData.lead_data || {};
  } catch {
    leadDataRaw = {};
  }

  let managedJoiningCourseId = null;
  let managedJoiningBranchId = null;
  if (leadDataRaw && typeof leadDataRaw === 'object') {
    if (leadDataRaw._joiningManagedCourseId != null && String(leadDataRaw._joiningManagedCourseId) !== '') {
      managedJoiningCourseId = leadDataRaw._joiningManagedCourseId;
    }
    if (leadDataRaw._joiningManagedBranchId != null && String(leadDataRaw._joiningManagedBranchId) !== '') {
      managedJoiningBranchId = leadDataRaw._joiningManagedBranchId;
    }
  }

  const fromRowManagedCourse = normalizeManagedIdForDb(joiningData.managed_course_id);
  const fromRowManagedBranch = normalizeManagedIdForDb(joiningData.managed_branch_id);
  const rawJoiningCourseId =
    fromRowManagedCourse != null
      ? fromRowManagedCourse
      : managedJoiningCourseId != null
        ? managedJoiningCourseId
        : joiningData.course_id;
  const rawJoiningBranchId =
    fromRowManagedBranch != null
      ? fromRowManagedBranch
      : managedJoiningBranchId != null
        ? managedJoiningBranchId
        : joiningData.branch_id;
  const normalizedJoiningCourseId =
    rawJoiningCourseId != null && String(rawJoiningCourseId).trim() !== ''
      ? String(rawJoiningCourseId).trim()
      : null;
  const normalizedJoiningBranchId =
    rawJoiningBranchId != null && String(rawJoiningBranchId).trim() !== ''
      ? String(rawJoiningBranchId).trim()
      : null;

  return { courseId: normalizedJoiningCourseId, branchId: normalizedJoiningBranchId };
};

/** `_joiningRegistrationExtras` on `lead_data` — college is chosen there (not a top-level joinings column). */
const getJoiningRegistrationExtrasObject = (joiningData) => {
  if (!joiningData) return {};
  let leadDataRaw = {};
  try {
    leadDataRaw =
      typeof joiningData.lead_data === 'string'
        ? JSON.parse(joiningData.lead_data || '{}')
        : joiningData.lead_data || {};
  } catch {
    leadDataRaw = {};
  }
  const ex = leadDataRaw._joiningRegistrationExtras;
  if (ex && typeof ex === 'object') return ex;
  return {};
};

const registrationExtrasHaveCollegeSelection = (joiningData) => {
  const o = getJoiningRegistrationExtrasObject(joiningData);
  for (const k of ['college_id', 'collegeId', 'school_or_college_id', 'schoolOrCollegeId']) {
    const v = o[k];
    if (v != null && String(v).trim() !== '') return true;
  }
  const nm = o.school_or_college_name ?? o.college;
  if (typeof nm === 'string' && nm.trim() !== '') return true;
  return false;
};

const validateBeforeSubmit = (joining) => {
  const errors = [];
  const { phoneDigits, dobVal } = getEffectiveStudentPhoneAndDob(joining);

  if (!joining.student_name) {
    errors.push('Student name is required');
  }

  if (!phoneDigits || phoneDigits.length !== 10) {
    errors.push('Student phone number must be 10 digits');
  }

  if (!dobVal) {
    errors.push('Date of birth is required');
  } else {
    let formattedDob = dobVal;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dobVal)) {
      const [year, month, day] = dobVal.split('-');
      formattedDob = `${day}-${month}-${year}`;
    }
    if (!/^\d{2}-\d{2}-\d{4}$/.test(formattedDob)) {
      errors.push('Date of birth must be in DD-MM-YYYY format');
    }
  }

  if (!joining.reservation_general) {
    errors.push('General reservation category is required');
  }

  return errors;
};

export const submitJoiningForApproval = async (req, res) => {
  try {
    const { leadId } = req.params;
    const pool = getPool();

    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    // Find joining by id or leadId
    let joining = null;
    if (leadId && typeof leadId === 'string' && leadId.length === 36) {
      const [joinings] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ? OR lead_id = ?',
        [leadId, leadId]
      );
      if (joinings.length > 0) {
        joining = joinings[0];
      }
    }

    if (!joining) {
      return errorResponse(res, 'Joining draft not found', 404);
    }

    const validationErrors = validateBeforeSubmit(joining);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const previousStatus = joining.status;
    const { phoneDigits, dobVal } = getEffectiveStudentPhoneAndDob(joining);

    // Persist phone/DOB onto row when they only lived in registration extras (keeps admissions/reporting consistent).
    await pool.execute(
      `UPDATE joinings SET
        student_phone = ?,
        student_date_of_birth = ?,
        status = ?,
        submitted_at = NOW(),
        submitted_by = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        phoneDigits || joining.student_phone || '',
        dobVal || joining.student_date_of_birth || '',
        'pending_approval',
        req.user.id,
        joining.id,
      ]
    );

    // Record activity if lead exists
    if (joining.lead_id) {
      await recordActivity({
        leadId: joining.lead_id,
        userId: req.user.id,
        description: 'Joining form submitted for approval',
        statusFrom: previousStatus,
        statusTo: 'pending_approval',
      });
    }

    // Fetch and return formatted joining
    const [updated] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joining.id]
    );
    const formattedJoining = await formatJoining(updated[0], pool);

    return successResponse(
      res,
      formattedJoining,
      'Joining form submitted for approval',
      200
    );
  } catch (error) {
    console.error('Error submitting joining form:', error);
    return errorResponse(
      res,
      error.message || 'Failed to submit joining form',
      error.statusCode || 500
    );
  }
};

export const approveJoining = async (req, res) => {
  const pool = getPool();
  let connection;
  try {
    const { leadId } = req.params;

    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    // Find joining by id or leadId
    let joining = null;
    const [joinings] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ? OR lead_id = ?',
      [leadId, leadId]
    );
    if (joinings.length > 0) {
      joining = joinings[0];
    }

    if (!joining) {
      return errorResponse(res, 'Joining draft not found', 404);
    }

    if (joining.status !== 'pending_approval' && joining.status !== 'approved') {
      return errorResponse(
        res,
        'Only submissions awaiting approval can be approved',
        400
      );
    }

    if (joining.status === 'pending_approval') {
      const { courseId, branchId } = getEffectiveManagedCourseBranchIds(joining);
      const quotaOk = String(joining.quota ?? '').trim() !== '';
      const collegeOk = registrationExtrasHaveCollegeSelection(joining);
      if (!courseId || !branchId || !quotaOk || !collegeOk) {
        return errorResponse(
          res,
          'College, quota, managed course, and managed branch must all be set before approving. Open the joining form and complete Course & Quota.',
          400
        );
      }
    }

    const previousStatus = joining.status;

    // Start transaction
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Update joining status
    await connection.execute(
      `UPDATE joinings SET
        status = ?,
        approved_at = NOW(),
        approved_by = ?,
        updated_at = NOW()
      WHERE id = ?`,
      ['approved', req.user.id, joining.id]
    );

    // 2. Format joining for use
    const formattedJoining = await formatJoining(joining, connection);
    const { fkCourseId: admissionFkCourseId, fkBranchId: admissionFkBranchId } =
      await resolvePrimaryCourseBranchFkIds(
        connection,
        formattedJoining.courseInfo?.courseId,
        formattedJoining.courseInfo?.branchId
      );

    // 3. Get/Update lead
    let lead = null;
    if (joining.lead_id) {
      const [leads] = await connection.execute(
        'SELECT * FROM leads WHERE id = ?',
        [joining.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    // Generate admission number
    let admissionNumber = lead?.admissionNumber || joining.admission_number;
    if (!admissionNumber) {
      admissionNumber = await generateAdmissionNumber(connection);
    }

    const joiningLeadData =
      typeof joining.lead_data === 'string' ? JSON.parse(joining.lead_data) : joining.lead_data || {};

    if (!joining.lead_id) {
      const createdLeadId = await ensureLeadForApprovedJoining({
        connection,
        joining,
        formattedJoining,
        joiningLeadData,
        admissionNumber,
      });
      joining.lead_id = createdLeadId;
      const [createdLeadRows] = await connection.execute('SELECT * FROM leads WHERE id = ?', [
        createdLeadId,
      ]);
      if (createdLeadRows.length > 0) {
        lead = formatLead(createdLeadRows[0]);
      }
    }

    if (lead) {
      // Sync joining data to lead
      const leadUpdates = {};
      if (formattedJoining.studentInfo?.name) leadUpdates.name = formattedJoining.studentInfo.name;
      if (formattedJoining.studentInfo?.phone) leadUpdates.phone = formattedJoining.studentInfo.phone;
      if (formattedJoining.studentInfo?.gender) leadUpdates.gender = formattedJoining.studentInfo.gender;
      if (formattedJoining.parents?.father?.name) leadUpdates.fatherName = formattedJoining.parents.father.name;
      if (formattedJoining.parents?.father?.phone) leadUpdates.fatherPhone = formattedJoining.parents.father.phone;
      if (formattedJoining.parents?.mother?.name) leadUpdates.motherName = formattedJoining.parents.mother.name;
      if (formattedJoining.address?.communication?.villageOrCity) leadUpdates.village = formattedJoining.address.communication.villageOrCity;
      if (formattedJoining.address?.communication?.mandal) leadUpdates.mandal = formattedJoining.address.communication.mandal;
      if (formattedJoining.address?.communication?.district) leadUpdates.district = formattedJoining.address.communication.district;
      if (formattedJoining.courseInfo?.quota) leadUpdates.quota = formattedJoining.courseInfo.quota;
      if (formattedJoining.courseInfo?.course) leadUpdates.courseInterested = formattedJoining.courseInfo.course;

      const interEducation = formattedJoining.educationHistory?.find((e) => e.level === 'inter_diploma');
      if (interEducation?.institutionName) leadUpdates.interCollege = interEducation.institutionName;

      const updateFields = [];
      const updateParams = [];
      Object.entries(leadUpdates).forEach(([key, value]) => {
        const sqlKey = key === 'fatherName' ? 'father_name' : key === 'fatherPhone' ? 'father_phone' : key === 'motherName' ? 'mother_name' : key === 'courseInterested' ? 'course_interested' : key === 'interCollege' ? 'inter_college' : key;
        updateFields.push(`${sqlKey} = ?`);
        updateParams.push(value);
      });

      updateFields.push('lead_status = ?');
      updateFields.push('admission_number = ?');
      updateFields.push('updated_at = NOW()');
      updateParams.push('Admitted', admissionNumber, joining.lead_id);

      await connection.execute(
        `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // 4. Prepare lead data snapshot
    const leadDataSnapshot = lead ? { ...lead } : { ...joiningLeadData };
    
    // Preserve registration extras and other unmapped fields
    if (joiningLeadData && typeof joiningLeadData === 'object') {
      ['_joiningRegistrationExtras', '_joiningStudentFeeDetails', '_joiningProgramLevel', '_joiningManagedCourseId', '_joiningManagedBranchId'].forEach(key => {
        if (joiningLeadData[key] != null) {
          leadDataSnapshot[key] = joiningLeadData[key];
        }
      });
    }
    delete leadDataSnapshot._id;
    delete leadDataSnapshot.id;
    delete leadDataSnapshot.__v;
    leadDataSnapshot.admissionNumber = admissionNumber;

    // 5. Upsert admission (Primary DB)
    const [existingAdmissions] = await connection.execute(
      'SELECT id FROM admissions WHERE joining_id = ?',
      [joining.id]
    );

    const admissionId = existingAdmissions.length > 0 ? existingAdmissions[0].id : uuidv4();

    const managedCourseIdForAdmission = normalizeManagedIdForDb(
      formattedJoining.courseInfo?.courseId
    );
    const managedBranchIdForAdmission = normalizeManagedIdForDb(
      formattedJoining.courseInfo?.branchId
    );

    if (existingAdmissions.length > 0) {
      await connection.execute(
        `UPDATE admissions SET
          lead_id = ?, enquiry_number = ?, lead_data = ?, admission_number = ?,
          course_id = ?, branch_id = ?, managed_course_id = ?, managed_branch_id = ?, course = ?, branch = ?, quota = ?,
          student_name = ?, student_phone = ?, student_gender = ?, student_date_of_birth = ?, student_notes = ?, student_aadhaar_number = ?,
          father_name = ?, father_phone = ?, father_aadhaar_number = ?, father_photo = ?,
          mother_name = ?, mother_phone = ?, mother_aadhaar_number = ?, preferred_mobile_number = ?, mother_photo = ?,
          reservation_general = ?, reservation_other = ?,
          address_door_street = ?, address_landmark = ?, address_village_city = ?, address_mandal = ?, address_district = ?, address_pin_code = ?,
          qualification_ssc = ?, qualification_inter_diploma = ?, qualification_ug = ?, qualification_merit = ?, qualification_mediums = ?, qualification_other_medium_label = ?,
          document_ssc = ?, document_inter = ?, document_ug_pg_cmm = ?, document_transfer_certificate = ?, document_study_certificate = ?,
          document_aadhaar_card = ?, document_photos = ?, document_income_certificate = ?, document_caste_certificate = ?,
          document_cet_rank_card = ?, document_cet_hall_ticket = ?, document_allotment_letter = ?, document_joining_report = ?,
          document_bank_passbook = ?, document_ration_card = ?,
          reservation_is_ews = ?,
          status = ?, updated_by = ?, updated_at = NOW()
        WHERE id = ?`,
        [
          joining.lead_id || null,
          lead?.enquiryNumber || leadDataSnapshot.enquiryNumber || '',
          JSON.stringify(leadDataSnapshot),
          admissionNumber,
          admissionFkCourseId,
          admissionFkBranchId,
          managedCourseIdForAdmission,
          managedBranchIdForAdmission,
          formattedJoining.courseInfo?.course || '',
          formattedJoining.courseInfo?.branch || '',
          formattedJoining.courseInfo?.quota || '',
          formattedJoining.studentInfo?.name || '',
          formattedJoining.studentInfo?.phone || '',
          formattedJoining.studentInfo?.gender || '',
          formattedJoining.studentInfo?.dateOfBirth || '',
          formattedJoining.studentInfo?.notes || '',
          formattedJoining.studentInfo?.aadhaarNumber || null,
          formattedJoining.parents?.father?.name || '',
          formattedJoining.parents?.father?.phone || '',
          formattedJoining.parents?.father?.aadhaarNumber || null,
          String(formattedJoining.parents?.father?.photo || '').trim() || null,
          formattedJoining.parents?.mother?.name || '',
          formattedJoining.parents?.mother?.phone || '',
          formattedJoining.parents?.mother?.aadhaarNumber || null,
          (() => {
            const p = normalizeMobileDigits(formattedJoining.studentInfo?.preferredMobileNumber);
            return p.length === 10 ? p : null;
          })(),
          String(formattedJoining.parents?.mother?.photo || '').trim() || null,
          formattedJoining.reservation?.general || 'oc',
          JSON.stringify(formattedJoining.reservation?.other || []),
          formattedJoining.address?.communication?.doorOrStreet || '',
          formattedJoining.address?.communication?.landmark || '',
          formattedJoining.address?.communication?.villageOrCity || '',
          formattedJoining.address?.communication?.mandal || '',
          formattedJoining.address?.communication?.district || '',
          formattedJoining.address?.communication?.pinCode || '',
          formattedJoining.qualifications?.ssc === true ? 1 : 0,
          formattedJoining.qualifications?.interOrDiploma === true ? 1 : 0,
          formattedJoining.qualifications?.ug === true ? 1 : 0,
          qualificationMeritToSql(formattedJoining.qualifications?.merit),
          JSON.stringify(formattedJoining.qualifications?.mediums || []),
          formattedJoining.qualifications?.otherMediumLabel || '',
          formattedJoining.documents?.ssc || 'pending',
          formattedJoining.documents?.inter || 'pending',
          formattedJoining.documents?.ugPgCmm || 'pending',
          formattedJoining.documents?.transferCertificate || 'pending',
          formattedJoining.documents?.studyCertificate || 'pending',
          formattedJoining.documents?.aadhaarCard || 'pending',
          formattedJoining.documents?.photos || 'pending',
          formattedJoining.documents?.incomeCertificate || 'pending',
          formattedJoining.documents?.casteCertificate || 'pending',
          formattedJoining.documents?.cetRankCard || 'pending',
          formattedJoining.documents?.cetHallTicket || 'pending',
          formattedJoining.documents?.allotmentLetter || 'pending',
          formattedJoining.documents?.joiningReport || 'pending',
          formattedJoining.documents?.bankPassbook || 'pending',
          formattedJoining.documents?.rationCard || 'pending',
          formattedJoining.reservation?.isEws === true ? 1 : 0,
          'active',
          req.user.id,
          admissionId
        ]
      );
    } else {
      await connection.execute(
        `INSERT INTO admissions (
          id, lead_id, enquiry_number, lead_data, joining_id, admission_number, status,
          course_id, branch_id, managed_course_id, managed_branch_id, course, branch, quota,
          student_name, student_phone, student_gender, student_date_of_birth, student_notes, student_aadhaar_number,
          father_name, father_phone, father_aadhaar_number, father_photo,
          mother_name, mother_phone, mother_aadhaar_number, preferred_mobile_number, mother_photo,
          reservation_general, reservation_other,
          address_door_street, address_landmark, address_village_city, address_mandal, address_district, address_pin_code,
          qualification_ssc, qualification_inter_diploma, qualification_ug, qualification_merit, qualification_mediums, qualification_other_medium_label,
          document_ssc, document_inter, document_ug_pg_cmm, document_transfer_certificate, document_study_certificate,
          document_aadhaar_card, document_photos, document_income_certificate, document_caste_certificate,
          document_cet_rank_card, document_cet_hall_ticket, document_allotment_letter, document_joining_report,
          document_bank_passbook, document_ration_card,
          reservation_is_ews,
          admission_date, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW())`,
        [
          admissionId, // 1
          joining.lead_id || null, // 2
          lead?.enquiryNumber || leadDataSnapshot.enquiryNumber || '', // 3
          JSON.stringify(leadDataSnapshot), // 4
          joining.id, // 5
          admissionNumber, // 6
          'active', // 7
          admissionFkCourseId, // 8
          admissionFkBranchId, // 9
          managedCourseIdForAdmission, // 10
          managedBranchIdForAdmission, // 11
          formattedJoining.courseInfo?.course || '', // 12
          formattedJoining.courseInfo?.branch || '', // 13
          formattedJoining.courseInfo?.quota || '', // 14
          formattedJoining.studentInfo?.name || '', // 15
          formattedJoining.studentInfo?.phone || '', // 14
          formattedJoining.studentInfo?.gender || '', // 15
          formattedJoining.studentInfo?.dateOfBirth || '', // 16
          formattedJoining.studentInfo?.notes || '', // 17
          formattedJoining.studentInfo?.aadhaarNumber || null, // 18
          formattedJoining.parents?.father?.name || '', // 19
          formattedJoining.parents?.father?.phone || '', // 20
          formattedJoining.parents?.father?.aadhaarNumber || null, // 21
          String(formattedJoining.parents?.father?.photo || '').trim() || null, // 22
          formattedJoining.parents?.mother?.name || '', // 23
          formattedJoining.parents?.mother?.phone || '', // 24
          formattedJoining.parents?.mother?.aadhaarNumber || null, // 25
          (() => {
            const p = normalizeMobileDigits(formattedJoining.studentInfo?.preferredMobileNumber);
            return p.length === 10 ? p : null;
          })(), // preferred_mobile_number
          String(formattedJoining.parents?.mother?.photo || '').trim() || null, // 26
          formattedJoining.reservation?.general || 'oc', // 27
          JSON.stringify(formattedJoining.reservation?.other || []), // 28
          formattedJoining.address?.communication?.doorOrStreet || '', // 27
          formattedJoining.address?.communication?.landmark || '', // 28
          formattedJoining.address?.communication?.villageOrCity || '', // 29
          formattedJoining.address?.communication?.mandal || '', // 30
          formattedJoining.address?.communication?.district || '', // 31
          formattedJoining.address?.communication?.pinCode || '', // 32
          formattedJoining.qualifications?.ssc === true ? 1 : 0, // 33
          formattedJoining.qualifications?.interOrDiploma === true ? 1 : 0, // 34
          formattedJoining.qualifications?.ug === true ? 1 : 0, // 35
          qualificationMeritToSql(formattedJoining.qualifications?.merit),
          JSON.stringify(formattedJoining.qualifications?.mediums || []), // 36
          formattedJoining.qualifications?.otherMediumLabel || '', // 37
          formattedJoining.documents?.ssc || 'pending', // 38
          formattedJoining.documents?.inter || 'pending', // 39
          formattedJoining.documents?.ugPgCmm || 'pending', // 40
          formattedJoining.documents?.transferCertificate || 'pending', // 41
          formattedJoining.documents?.studyCertificate || 'pending', // 42
          formattedJoining.documents?.aadhaarCard || 'pending', // 43
          formattedJoining.documents?.photos || 'pending', // 44
          formattedJoining.documents?.incomeCertificate || 'pending', // 45
          formattedJoining.documents?.casteCertificate || 'pending', // 46
          formattedJoining.documents?.cetRankCard || 'pending', // 47
          formattedJoining.documents?.cetHallTicket || 'pending', // 48
          formattedJoining.documents?.allotmentLetter || 'pending', // 49
          formattedJoining.documents?.joiningReport || 'pending', // 50
          formattedJoining.documents?.bankPassbook || 'pending', // 51
          formattedJoining.documents?.rationCard || 'pending', // 52
          formattedJoining.reservation?.isEws === true ? 1 : 0, // 53 (reservation_is_ews)
          req.user.id, // 54 (created_by)
          req.user.id, // 55 (updated_by)
        ]
      );

      // 6. Copy related records
      const tables = [
        { joining: 'joining_relatives', admission: 'admission_relatives' },
        { joining: 'joining_education_history', admission: 'admission_education_history' },
        { joining: 'joining_siblings', admission: 'admission_siblings' }
      ];

      for (const t of tables) {
        const [rows] = await connection.execute(`SELECT * FROM ${t.joining} WHERE joining_id = ?`, [joining.id]);
        for (const row of rows) {
          const rowData = { ...row };
          delete rowData.id;
          delete rowData.joining_id;
          rowData.admission_id = admissionId;
          rowData.id = uuidv4();
          
          const keys = Object.keys(rowData);
          const placeholders = keys.map(() => '?').join(', ');
          await connection.execute(
            `INSERT INTO ${t.admission} (${keys.join(', ')}) VALUES (${placeholders})`,
            Object.values(rowData)
          );
        }
      }
    }

    await connection.execute(
      `UPDATE joinings SET managed_course_id = ?, managed_branch_id = ? WHERE id = ?`,
      [managedCourseIdForAdmission, managedBranchIdForAdmission, joining.id]
    );

    const [joiningAfterManagedRows] = await connection.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joining.id]
    );
    const joiningForSecondarySync =
      joiningAfterManagedRows.length > 0
        ? await formatJoining(joiningAfterManagedRows[0], connection)
        : formattedJoining;

    // 7. Sync to Secondary DB (+ student portal credentials when missing)
    const secondarySyncResult = await syncToSecondaryDatabase(joiningForSecondarySync, admissionNumber, {
      leadId: joining.lead_id,
      joiningId: joining.id,
      email: lead?.email || ''
    });
    warnIfSecondaryStudentSyncMissed(
      'approveJoining',
      { joiningId: joining.id, admissionNumber },
      secondarySyncResult
    );

    await connection.commit();

    // Fire-and-forget SMS to the student. Runs strictly after commit so gateway
    // failures never roll back the admission.
    {
      const studentPhone =
        resolveContactMobileNumber(formattedJoining?.studentInfo) ||
        normalizeMobileDigits(lead?.phone) ||
        '';
      const studentName =
        formattedJoining?.studentInfo?.name || lead?.name || 'Student';
      if (studentPhone && admissionNumber) {
        smsService
          .sendAdmissionConfirmation(studentPhone, studentName, admissionNumber)
          .catch((err) =>
            console.error('Admission confirmation SMS dispatch failed:', err?.message || err)
          );

        if (
          secondarySyncResult?.credentialsCreated &&
          secondarySyncResult?.plainPassword
        ) {
          smsService
            .sendStudentAccountCreated(
              studentPhone,
              studentName,
              admissionNumber,
              secondarySyncResult.plainPassword
            )
            .catch((err) =>
              console.error('Student account SMS dispatch failed:', err?.message || err)
            );
        }
      } else {
        console.warn(
          `Admission SMS skipped — missing ${!studentPhone ? 'studentPhone' : 'admissionNumber'} for joining ${joining.id}.`
        );
      }
    }

    // Record activity after commit so activity_logs lock contention
    // never delays or interferes with core approval/admission writes.
    if (joining.lead_id) {
      recordActivity({
        leadId: joining.lead_id,
        userId: req.user.id,
        description: 'Joining form approved and admission created',
        statusFrom: previousStatus,
        statusTo: 'approved',
      });

      // Update performance summary (conversion)
      // We attribute the conversion to the user currently assigned to the lead
      const assigneeId = lead?.assigned_to || lead?.assigned_to_pro || null;
      if (lead && assigneeId) {
        const [assignedUser] = await pool.execute('SELECT role_name FROM users WHERE id = ?', [
          assigneeId,
        ]);
        if (assignedUser.length > 0) {
          updatePerformanceMetric({
            userId: assigneeId,
            academicYear: lead.academicYear,
            studentGroup: lead.studentGroup,
            roleName: assignedUser[0].role_name,
            metric: 'converted_count',
            value: 1
          });
        }
      }
    }

    // Fetch updated joining for response
    const [updated] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joining.id]
    );
    const finalJoining = await formatJoining(updated[0], pool);

    return successResponse(
      res,
      {
        joining: finalJoining,
        admissionNumber,
      },
      'Joining form approved',
      200
    );
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error approving joining form:', error);
    return errorResponse(
      res,
      error.message || 'Failed to approve joining form',
      error.statusCode || 500
    );
  } finally {
    if (connection) connection.release();
  }
};



