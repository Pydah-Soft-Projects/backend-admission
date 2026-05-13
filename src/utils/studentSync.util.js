import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';

const normalizeChecklistItemStatus = (entry) => {
  if (typeof entry === 'string') {
    const s = String(entry).trim().toLowerCase();
    return s === 'received' || s === 'pending' ? s : null;
  }
  if (entry && typeof entry === 'object') {
    const s = String(entry.status ?? '').trim().toLowerCase();
    return s === 'received' || s === 'pending' ? s : null;
  }
  return null;
};

const normalizeChecklistOption = (entry) => {
  if (entry && typeof entry === 'object') {
    const opt = String(entry.option ?? '').trim();
    return opt || null;
  }
  return null;
};

const normalizeVerifiedState = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'yes' || v === 'y' || v === 'true' || v === '1') return 'Verified';
  if (v === 'no' || v === 'n' || v === 'false' || v === '0') return 'Not Verified';
  if (v === 'verified' || v === 'received' || v === 'complete' || v === 'completed')
    return 'Verified';
  if (v === 'certified') return 'Verified';
  if (v === 'partial' || v === 'temporary' || v === 'provisional') return 'Temporary';
  if (v === 'unverified' || v === 'not verified' || v === 'pending' || v === 'incomplete')
    return 'Not Verified';
  if (v === 'not certified' || v === 'submitted') return 'Not Verified';
  return null;
};

const deriveCertificatesStatus = (registrationExtras) => {
  const checklist = registrationExtras?.certificate_checklist;
  if (checklist && typeof checklist === 'object' && !Array.isArray(checklist)) {
    const values = Object.values(checklist);
    if (values.length > 0) {
      const everyReceived = values.every(
        (entry) => normalizeChecklistItemStatus(entry) === 'received'
      );
      if (!everyReceived) return 'Not Verified';

      // Business rule: received + temporary/provisional/memo option means Temporary.
      const hasTemporaryOption = values.some((entry) => {
        const option = normalizeChecklistOption(entry);
        if (!option) return false;
        return /(temporary|provisional|memo)/i.test(option);
      });
      return hasTemporaryOption ? 'Temporary' : 'Verified';
    }
  }

  // Fallback only when checklist is unavailable.
  return normalizeVerifiedState(registrationExtras?.certificates_status);
};

const normalizeStudentPhotoForSecondary = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(raw)) {
    return raw;
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100) {
    return `data:image/jpeg;base64,${raw}`;
  }

  // Preserve non-empty filename/URL strings instead of dropping them.
  // Some records currently store only filename in registration extras.
  return raw;
};

export const deriveSecondaryStudentStatus = (admissionStatus, registrationExtras) => {
  const explicitStatus = String(registrationExtras?.student_status ?? '').trim();
  if (explicitStatus) {
    const lower = explicitStatus.toLowerCase();
    // Never persist primary workflow labels into secondary student_status.
    if (lower === 'active' || lower === 'pending_approval' || lower === 'approved') {
      return 'Regular';
    }
    if (lower === 'withdrawn') return 'Discontinued';

    // Keep known secondary lifecycle values, fallback to Regular for unknown workflow-like tokens.
    const allowed = new Set([
      'regular',
      'discontinued',
      'admission cancelled',
      'detained',
      'long absent',
      're-joined',
      'rejoined',
    ]);
    if (allowed.has(lower)) return explicitStatus;
    return 'Regular';
  }

  const admission = String(admissionStatus ?? '').trim().toLowerCase();
  if (admission === 'withdrawn') return 'Discontinued';
  if (admission === 'admission cancelled') return 'Admission Cancelled';

  // Secondary DB: academic student status, not admission row status (active/withdrawn).
  return 'Regular';
};

const normalizeDobForSecondary = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const dmy = raw.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  if (dmy) {
    const day = Number.parseInt(dmy[1], 10);
    const month = Number.parseInt(dmy[2], 10);
    const year = Number.parseInt(dmy[3], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return raw;
};
const deriveCertificationDialogCompat = (certificatesStatus, registrationExtras) => {
  const status = String(certificatesStatus ?? '').trim();
  const statusLower = status.toLowerCase();
  const isCertified = statusLower === 'verified' || statusLower === 'temporary';
  const yesNo = isCertified ? 'Yes' : 'No';

  const checklist =
    registrationExtras?.certificate_checklist &&
    typeof registrationExtras.certificate_checklist === 'object' &&
    !Array.isArray(registrationExtras.certificate_checklist)
      ? registrationExtras.certificate_checklist
      : {};

  const findChecklistEntry = (patterns) => {
    const hit = Object.entries(checklist).find(([key]) =>
      patterns.some((re) => re.test(String(key || '').toLowerCase()))
    );
    return hit ? hit[1] : null;
  };

  const isChecklistReceived = (entry) => normalizeChecklistItemStatus(entry) === 'received';
  const mapInterStudyOption = (entry) => {
    const statusVal = normalizeChecklistItemStatus(entry);
    if (statusVal !== 'received') return 'No';
    const option = String(normalizeChecklistOption(entry) ?? '').toLowerCase();
    if (/(memo|temporary|provisional)/i.test(option)) return 'Memo';
    return 'Original';
  };

  const tenthStudyEntry = findChecklistEntry([/10th[_\s-]*study/, /ssc[_\s-]*study/, /10th/, /ssc/]);
  const tenthTcEntry = findChecklistEntry([/10th[_\s-]*tc/]);
  const interTcEntry = findChecklistEntry([/inter[_\s-]*diploma[_\s-]*tc/, /inter[_\s-]*tc/, /diploma[_\s-]*tc/]);
  const interStudyEntry = findChecklistEntry([/inter[_\s-]*diploma[_\s-]*study/, /inter[_\s-]*study/, /diploma[_\s-]*study/]);

  const tenthStudyReceived = tenthStudyEntry != null ? isChecklistReceived(tenthStudyEntry) : null;
  const tenthTcReceived = tenthTcEntry != null ? isChecklistReceived(tenthTcEntry) : null;
  const interTcReceived = interTcEntry != null ? isChecklistReceived(interTcEntry) : null;
  const interStudyReceived = interStudyEntry != null ? isChecklistReceived(interStudyEntry) : null;
  const interStudySelection = interStudyEntry != null ? mapInterStudyOption(interStudyEntry) : (isCertified ? 'Original' : 'No');

  return {
    certification_status: yesNo,
    certificates_verified: yesNo,
    certificates_status: status || (isCertified ? 'Verified' : 'Not Verified'),
    ssc_certificate: tenthStudyReceived == null ? isCertified : tenthStudyReceived,
    inter_diploma_cert: interStudyReceived == null ? yesNo : interStudyReceived ? 'Yes' : 'No',
    inter_diploma_study: interStudySelection,
    inter_diploma_tc: interTcReceived == null ? yesNo : interTcReceived ? 'Yes' : 'No',
    '10th_study': tenthStudyReceived == null ? isCertified : tenthStudyReceived,
    '10th_tc': tenthTcReceived == null ? isCertified : tenthTcReceived,
    '10th_original': tenthStudyReceived == null ? yesNo : tenthStudyReceived ? 'Yes' : 'No',
  };
};
const deriveStudTypeFromQuota = (quotaValue, registrationExtras) => {
  const q = String(quotaValue ?? '').trim().toUpperCase();
  if (q === 'MANG' || q === 'MANAGEMENT') return 'MANG';
  if (q === 'CONV' || q === 'CONVENOR' || q === 'CONVENER') return 'CONV';

  const fallback = String(registrationExtras?.data_collection_type ?? '').trim().toUpperCase();
  if (fallback === 'MANG' || fallback === 'MANAGEMENT') return 'MANG';
  if (fallback === 'CONV' || fallback === 'CONVENOR' || fallback === 'CONVENER') return 'CONV';
  return null;
};

/**
 * Build JSON for `students.student_data` so legacy consumers (e.g. sibling apps that
 * flatten objects into SQL) do not receive nested `address` objects, which can produce
 * invalid SQL like `student_address = communication = '[object Object]'`.
 */
const buildStudentDataForSecondaryStorage = (
  admissionData,
  admissionNumber,
  extraInfo,
  secondaryStudentStatus,
  normalizedDob,
  certificationCompat
) => {
  const payload = {
    ...admissionData,
    admission_number: admissionNumber,
    admission_date: new Date().toISOString().split('T')[0],
    _lead_id: extraInfo.leadId,
    _joining_id: extraInfo.joiningId,
    _synced_at: new Date().toISOString(),
  };

  const ci = admissionData?.courseInfo;
  if (ci && typeof ci === 'object') {
    if (ci.courseId != null && String(ci.courseId).trim() !== '') {
      payload._crm_managed_course_id = String(ci.courseId).trim();
    }
    if (ci.branchId != null && String(ci.branchId).trim() !== '') {
      payload._crm_managed_branch_id = String(ci.branchId).trim();
    }
  }

  // Never leave primary joining/admission workflow on top-level `status` — other apps treat it like student_status.
  if ('status' in payload) {
    const raw = payload.status;
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'active' || s === 'withdrawn' || s === 'admission cancelled') {
      payload.admission_status = raw;
    }
    delete payload.status;
  }
  payload.student_status = secondaryStudentStatus;
  payload.dob = normalizedDob || '';
  Object.assign(payload, certificationCompat || {});

  /** Registration extras sometimes copy joining workflow into `student_status` — strip from JSON blob. */
  const stripWorkflowStudentStatus = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const v = String(obj.student_status ?? '').trim().toLowerCase();
    const joiningLike = new Set(['draft', 'pending_approval', 'approved']);
    if (joiningLike.has(v)) delete obj.student_status;
  };
  stripWorkflowStudentStatus(payload.registrationFormData);
  if (payload.leadData && typeof payload.leadData === 'object') {
    stripWorkflowStudentStatus(payload.leadData._joiningRegistrationExtras);
  }

  if (payload?.studentInfo && typeof payload.studentInfo === 'object') {
    payload.studentInfo = {
      ...payload.studentInfo,
      dateOfBirth: normalizedDob || payload.studentInfo.dateOfBirth || '',
    };
  }

  const comm = admissionData?.address?.communication;
  const lineParts = [
    comm?.doorOrStreet,
    comm?.landmark,
    comm?.villageOrCity,
    comm?.mandal,
    comm?.district,
    comm?.pinCode,
  ]
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean);
  const fullAddressLine = lineParts.join(', ').trim();

  delete payload.address;
  if (fullAddressLine) {
    payload.student_address = fullAddressLine;
  }

  return { payload, studentAddressLine: fullAddressLine };
};

/**
 * Sync admission/student data to secondary database
 * @param {Object} admissionData - Formatted admission/joining data
 * @param {string} admissionNumber - The student's admission number
 * @param {Object} extraInfo - Optional extra info like lead email, joining id
 */
export const syncToSecondaryDatabase = async (admissionData, admissionNumber, extraInfo = {}) => {
  if (!admissionNumber) return;

  try {
    const secondaryPool = getSecondaryPool();
    const registrationExtras =
      (admissionData?.registrationFormData &&
      typeof admissionData.registrationFormData === 'object'
        ? admissionData.registrationFormData
        : null) ||
      (admissionData?.leadData &&
      typeof admissionData.leadData === 'object' &&
      admissionData.leadData._joiningRegistrationExtras &&
      typeof admissionData.leadData._joiningRegistrationExtras === 'object'
        ? admissionData.leadData._joiningRegistrationExtras
        : {});

    const toText = (value) => {
      if (value === undefined || value === null) return '';
      return String(value).trim();
    };
    const toNullableText = (value) => {
      const text = toText(value);
      return text || null;
    };
    const parseCurrentYear = (value) => {
      const parsed = Number.parseInt(String(value ?? '').trim(), 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < 1 || parsed > 12) return null;
      return parsed;
    };

    const reservationGeneral = toText(admissionData?.reservation?.general).toUpperCase();
    const currentYearFromExtras =
      parseCurrentYear(registrationExtras?.current_year) ??
      parseCurrentYear(registrationExtras?.currentYear);
    const certificatesStatus = deriveCertificatesStatus(registrationExtras);
    const secondaryStudentStatus = deriveSecondaryStudentStatus(
      admissionData?.status,
      registrationExtras
    );
    const studType = deriveStudTypeFromQuota(admissionData?.courseInfo?.quota, registrationExtras);
    const normalizedDob = normalizeDobForSecondary(admissionData?.studentInfo?.dateOfBirth);
    const certificationCompat = deriveCertificationDialogCompat(certificatesStatus, registrationExtras);

    const collegeIdRaw =
      registrationExtras?.college_id ??
      registrationExtras?.collegeId ??
      registrationExtras?.school_or_college_id ??
      registrationExtras?.schoolOrCollegeId;
    let resolvedCollegeName = null;
    if (collegeIdRaw !== undefined && collegeIdRaw !== null && String(collegeIdRaw).trim() !== '') {
      const collegeId = Number.parseInt(String(collegeIdRaw), 10);
      if (Number.isFinite(collegeId)) {
        const [collegeRows] = await secondaryPool.execute(
          'SELECT name FROM colleges WHERE id = ? LIMIT 1',
          [collegeId]
        );
        if (collegeRows.length > 0) {
          resolvedCollegeName = toNullableText(collegeRows[0].name);
        }
      }
    }

    // Check if student exists
    const [existingStudents] = await secondaryPool.execute(
      'SELECT id FROM students WHERE admission_number = ?',
      [admissionNumber]
    );

    const { payload: studentDataSecondary, studentAddressLine } = buildStudentDataForSecondaryStorage(
      admissionData,
      admissionNumber,
      extraInfo,
      secondaryStudentStatus,
      normalizedDob,
      certificationCompat
    );

    const studentParams = [
      admissionNumber,
      admissionNumber,
      admissionData.studentInfo?.name || '',
      admissionData.studentInfo?.phone || '',
      normalizedDob,
      admissionData.studentInfo?.aadhaarNumber || '',
      admissionData.parents?.father?.name || '',
      admissionData.parents?.father?.phone || '',
      extraInfo.email || '',
      admissionData.courseInfo?.course || '',
      admissionData.courseInfo?.branch || '',
      admissionData.studentInfo?.gender || '',
      admissionData.address?.communication?.villageOrCity || '',
      admissionData.address?.communication?.mandal || '',
      admissionData.address?.communication?.district || '',
      admissionData.address?.communication?.pinCode || '',
      studentAddressLine ||
        `${admissionData.address?.communication?.doorOrStreet || ''}, ${admissionData.address?.communication?.landmark || ''}`.trim(),
      JSON.stringify(studentDataSecondary),
      admissionData.parents?.mother?.phone || '',
      toNullableText(registrationExtras?.batch) || toNullableText(registrationExtras?.academic_year),
      resolvedCollegeName ||
        toNullableText(registrationExtras?.school_or_college_name) ||
        toNullableText(registrationExtras?.college),
      studType,
      toNullableText(registrationExtras?.scholar_status),
      reservationGeneral || null,
      toNullableText(registrationExtras?.remarks),
      toNullableText(registrationExtras?.previous_college),
      certificatesStatus,
      normalizeStudentPhotoForSecondary(registrationExtras?.student_photo),
      currentYearFromExtras,
      new Date().toISOString().split('T')[0],
      secondaryStudentStatus,
    ];

    if (existingStudents.length > 0) {
      await secondaryPool.execute(
        `UPDATE students SET
          student_name = ?,
          student_mobile = ?,
          dob = ?,
          adhar_no = ?,
          father_name = ?,
          parent_mobile1 = ?,
          email = ?,
          course = ?,
          branch = ?,
          gender = ?,
          city_village = ?,
          mandal_name = ?,
          district = ?,
          pin_no = ?,
          student_address = ?,
          student_data = ?,
          parent_mobile2 = ?,
          batch = ?,
          college = ?,
          stud_type = ?,
          scholar_status = ?,
          caste = ?,
          remarks = ?,
          previous_college = ?,
          certificates_status = ?,
          student_photo = ?,
          current_year = COALESCE(?, current_year),
          updated_at = NOW(),
          admission_date = ?,
          student_status = ?
        WHERE admission_number = ?`,
        [...studentParams.slice(2), admissionNumber]
      );
      console.log(`Synced update for student ${admissionNumber} to secondary DB`);
    } else {
      await secondaryPool.execute(
        `INSERT INTO students (
          admission_number,
          admission_no,
          student_name,
          student_mobile,
          dob,
          adhar_no,
          father_name,
          parent_mobile1,
          email,
          course,
          branch,
          gender,
          city_village,
          mandal_name,
          district,
          pin_no,
          student_address,
          student_data,
          parent_mobile2,
          batch,
          college,
          stud_type,
          scholar_status,
          caste,
          remarks,
          previous_college,
          certificates_status,
          student_photo,
          current_year,
          created_at,
          updated_at,
          admission_date,
          student_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?)`,
        studentParams
      );
      console.log(`Synced new student ${admissionNumber} to secondary DB`);
    }
    return true;
  } catch (error) {
    console.error('Secondary DB sync failed:', error);
    return false;
  }
};














