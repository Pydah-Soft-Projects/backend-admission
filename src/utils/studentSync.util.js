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
  if (v === 'partial' || v === 'temporary' || v === 'provisional') return 'Partial';
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

      // Business rule: received + temporary/provisional option means Partial.
      const hasTemporaryOption = values.some((entry) => {
        const option = normalizeChecklistOption(entry);
        if (!option) return false;
        return /(temporary|provisional|memo)/i.test(option);
      });
      return hasTemporaryOption ? 'Partial' : 'Verified';
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

  // For non-base64 values (e.g., filenames), skip sync to keep storage consistent.
  return null;
};

const deriveSecondaryStudentStatus = (admissionStatus, registrationExtras) => {
  const explicitStatus = String(registrationExtras?.student_status ?? '').trim();
  if (explicitStatus) return explicitStatus;

  // Keep secondary domain labels distinct from primary admission status labels.
  return 'Regular';
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
    const secondaryStudentStatus = deriveSecondaryStudentStatus(admissionData?.status, registrationExtras);
    const studType = deriveStudTypeFromQuota(admissionData?.courseInfo?.quota, registrationExtras);

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

    const studentDataSecondary = {
      ...admissionData,
      admission_number: admissionNumber,
      admission_date: new Date().toISOString().split('T')[0],
      _lead_id: extraInfo.leadId,
      _joining_id: extraInfo.joiningId,
      _synced_at: new Date().toISOString(),
    };

    const studentParams = [
      admissionNumber,
      admissionNumber,
      admissionData.studentInfo?.name || '',
      admissionData.studentInfo?.phone || '',
      admissionData.studentInfo?.dateOfBirth || '',
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
