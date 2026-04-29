import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const TARGET_NUMBERS = ['20260003', '20260006', '20260007'];

const toNullableText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const parseCurrentYear = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1 || parsed > 12) return null;
  return parsed;
};

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

const deriveCertificatesStatus = (extras) => {
  const checklist = extras?.certificate_checklist;
  if (checklist && typeof checklist === 'object' && !Array.isArray(checklist)) {
    const values = Object.values(checklist);
    if (values.length > 0) {
      const allReceived = values.every(
        (entry) => normalizeChecklistItemStatus(entry) === 'received'
      );
      if (!allReceived) return 'Not Verified';
      const hasTemporaryOption = values.some((entry) => {
        const option = normalizeChecklistOption(entry);
        if (!option) return false;
        return /(temporary|provisional|memo)/i.test(option);
      });
      return hasTemporaryOption ? 'Partial' : 'Verified';
    }
  }
  return normalizeVerifiedState(extras?.certificates_status);
};

const normalizeStudentPhotoForSecondary = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(raw)) return raw;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100) {
    return `data:image/jpeg;base64,${raw}`;
  }
  return null;
};

async function main() {
  const primary = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const secondary = await mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    const [admissions] = await primary.execute(
      `SELECT admission_number, reservation_general, lead_data
       FROM admissions
       WHERE admission_number IN (?,?,?)`,
      TARGET_NUMBERS
    );

    const results = [];
    for (const admission of admissions) {
      const leadData =
        typeof admission.lead_data === 'string'
          ? JSON.parse(admission.lead_data || '{}')
          : admission.lead_data || {};
      const extras =
        leadData && typeof leadData === 'object' && leadData._joiningRegistrationExtras
          ? leadData._joiningRegistrationExtras
          : {};

      const batch = toNullableText(extras.batch) || toNullableText(extras.academic_year);
      const college =
        toNullableText(extras.school_or_college_name) || toNullableText(extras.college);
      const studType = toNullableText(extras.data_collection_type);
      const scholarStatus = toNullableText(extras.scholar_status);
      const caste = toNullableText(admission.reservation_general)?.toUpperCase() || null;
      const remarks = toNullableText(extras.remarks);
      const previousCollege = toNullableText(extras.previous_college);
      const certificatesStatus = deriveCertificatesStatus(extras);
      const studentPhoto = normalizeStudentPhotoForSecondary(extras.student_photo);
      const studentStatus = toNullableText(extras.student_status);
      const currentYear =
        parseCurrentYear(extras.current_year) ?? parseCurrentYear(extras.currentYear);

      await secondary.execute(
        `UPDATE students
         SET
           batch = COALESCE(?, batch),
           college = COALESCE(?, college),
           stud_type = COALESCE(?, stud_type),
           scholar_status = COALESCE(?, scholar_status),
           caste = COALESCE(?, caste),
           remarks = COALESCE(?, remarks),
           previous_college = COALESCE(?, previous_college),
           certificates_status = COALESCE(?, certificates_status),
           student_photo = COALESCE(?, student_photo),
           current_year = COALESCE(?, current_year),
           student_status = COALESCE(?, student_status),
           updated_at = NOW()
         WHERE admission_number = ?`,
        [
          batch,
          college,
          studType,
          scholarStatus,
          caste,
          remarks,
          previousCollege,
          certificatesStatus,
          studentPhoto,
          currentYear,
          studentStatus,
          admission.admission_number,
        ]
      );

      results.push({
        admissionNumber: admission.admission_number,
        applied: {
          batch,
          college,
          studType,
          scholarStatus,
          caste,
          remarks,
          previousCollege,
          certificatesStatus,
          studentPhoto: studentPhoto ? '[set]' : null,
          currentYear,
          studentStatus,
        },
      });
    }

    console.log(JSON.stringify({ updated: results }, null, 2));
  } finally {
    await primary.end();
    await secondary.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
