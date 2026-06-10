import { v4 as uuidv4 } from 'uuid';
import { generateEnquiryNumber } from './generateEnquiryNumber.js';

/** CRM lead source for student self-registration (Step 1 public form). */
export const SELF_REGISTRATION_SOURCE = 'Self Registration';

/** Magic-link route_key stored in joining_public_edit_tokens. */
export const SELF_REGISTRATION_ROUTE_KEY = 'self-registration';

/** @deprecated Self-registration links are permanent — see joiningSelfRegistrationLink.service.js */
export const SELF_REGISTRATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** SQL predicate: row is a self-registration request (lead source, snapshot, or dynamic_fields). */
export const SQL_JOINING_IS_SELF_REGISTRATION = `(
  TRIM(COALESCE(l.source, '')) = ?
  OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.source')), '')) = ?
  OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.createdFrom')), '')) = 'self_registration'
)`;

const DEFAULT_GENERAL_RESERVATION = 'oc';

export const isSelfRegistrationLead = (leadOrSnapshot) => {
  if (!leadOrSnapshot || typeof leadOrSnapshot !== 'object') return false;
  const source = String(leadOrSnapshot.source ?? '').trim();
  if (source === SELF_REGISTRATION_SOURCE) return true;
  const dyn = leadOrSnapshot.dynamicFields ?? leadOrSnapshot.dynamic_fields;
  if (dyn && typeof dyn === 'object') {
    return String(dyn.createdFrom ?? '').trim() === 'self_registration';
  }
  return false;
};

export const isSelfRegistrationLeadData = (leadData) => {
  if (!leadData || typeof leadData !== 'object') return false;
  const source = String(leadData.source ?? '').trim();
  if (source === SELF_REGISTRATION_SOURCE) return true;
  return false;
};

const normalizeManagedIdForDb = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

/**
 * First save from the public self-registration form: mint enquiry + lead + joining draft.
 * Reference is intentionally omitted (null).
 */
export async function createSelfRegistrationLeadAndJoining(pool, payload, userId) {
  const studentInfo = payload?.studentInfo && typeof payload.studentInfo === 'object' ? payload.studentInfo : {};
  const parents = payload?.parents && typeof payload.parents === 'object' ? payload.parents : {};
  const courseInfo = payload?.courseInfo && typeof payload.courseInfo === 'object' ? payload.courseInfo : {};
  const address = payload?.address && typeof payload.address === 'object' ? payload.address : {};
  const comm = address.communication && typeof address.communication === 'object' ? address.communication : {};

  const enquiryNumber = await generateEnquiryNumber();
  const leadId = uuidv4();
  const joiningId = uuidv4();

  const studentName = String(studentInfo.name ?? '').trim() || 'Not Provided';
  const studentPhone = String(studentInfo.phone ?? '').trim();
  const fatherName = String(parents.father?.name ?? '').trim() || 'Not Provided';
  const fatherPhone = String(parents.father?.phone ?? '').trim();
  const motherName = String(parents.mother?.name ?? '').trim();
  const courseInterested = String(courseInfo.course ?? '').trim();
  const branch = String(courseInfo.branch ?? '').trim();
  const quota = String(courseInfo.quota ?? '').trim() || 'Not Applicable';
  const village = String(comm.villageOrCity ?? '').trim();
  const district = String(comm.district ?? '').trim();
  const mandal = String(comm.mandal ?? '').trim();
  const state = String(comm.state ?? '').trim();

  const leadDataSnapshot = {
    enquiryNumber,
    name: studentName,
    phone: studentPhone,
    fatherName,
    fatherPhone,
    motherName: motherName || undefined,
    village,
    district,
    mandal,
    state,
    quota,
    courseInterested,
    applicationStatus: 'Draft',
    leadStatus: 'Confirmed',
    source: SELF_REGISTRATION_SOURCE,
    ...(courseInfo.programLevel != null && String(courseInfo.programLevel).trim()
      ? { _joiningProgramLevel: String(courseInfo.programLevel).trim() }
      : {}),
    ...(courseInfo.courseId != null && String(courseInfo.courseId).trim()
      ? { _joiningManagedCourseId: courseInfo.courseId }
      : {}),
    ...(courseInfo.branchId != null && String(courseInfo.branchId).trim()
      ? { _joiningManagedBranchId: courseInfo.branchId }
      : {}),
  };

  const leadDynamicFields = {
    createdFrom: 'self_registration',
  };

  await pool.execute(
    `INSERT INTO leads (
      id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
      hall_ticket_number, village, address, course_interested, district, mandal, state,
      gender, \`rank\`, inter_college, quota, application_status,
      dynamic_fields, lead_status, source, uploaded_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      leadId,
      enquiryNumber,
      studentName,
      studentPhone || null,
      null,
      fatherName,
      motherName || '',
      fatherPhone || null,
      '',
      village,
      '',
      courseInterested || null,
      district,
      mandal,
      state,
      String(studentInfo.gender ?? '').trim() || 'Not Specified',
      null,
      '',
      quota,
      'Draft',
      JSON.stringify(leadDynamicFields),
      'Confirmed',
      SELF_REGISTRATION_SOURCE,
      userId || null,
    ]
  );

  const managedCourseId = normalizeManagedIdForDb(courseInfo.courseId);
  const managedBranchId = normalizeManagedIdForDb(courseInfo.branchId);

  await pool.execute(
    `INSERT INTO joinings (
      id, lead_id, lead_data, status, managed_course_id, managed_branch_id,
      course, branch, quota,
      student_name, student_phone, student_gender, student_notes,
      father_name, father_phone, mother_name,
      reservation_general, reservation_other,
      created_by, updated_by, draft_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
    [
      joiningId,
      leadId,
      JSON.stringify(leadDataSnapshot),
      'draft',
      managedCourseId,
      managedBranchId,
      courseInterested,
      branch,
      quota,
      studentName,
      studentPhone || '',
      String(studentInfo.gender ?? '').trim() || 'Not Specified',
      String(studentInfo.notes ?? '').trim() || 'As per SSC for no issues',
      fatherName,
      fatherPhone || '',
      motherName || '',
      DEFAULT_GENERAL_RESERVATION,
      JSON.stringify([]),
      userId || null,
      userId || null,
    ]
  );

  return { leadId, joiningId, enquiryNumber };
}
