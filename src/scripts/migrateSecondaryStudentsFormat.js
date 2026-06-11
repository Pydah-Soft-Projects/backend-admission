import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { classifyAdmissionQuotaCategory } from '../utils/quotaClassification.util.js';

dotenv.config();

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

const normalizeStudTypeFromQuota = (quotaValue) => classifyAdmissionQuotaCategory(quotaValue);

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

  let certUpdates = 0;
  let photoUpdates = 0;
  let studTypeUpdates = 0;
  let examinedStudents = 0;

  try {
    // 1) Normalize certificates_status globally in secondary students table to Verified/Not Verified.
    const [students] = await secondary.execute(
      'SELECT id, certificates_status, student_data, stud_type FROM students'
    );
    examinedStudents = students.length;

    for (const row of students) {
      let derived = null;
      try {
        const parsed =
          typeof row.student_data === 'string'
            ? JSON.parse(row.student_data || '{}')
            : row.student_data || {};
        const extras =
          parsed &&
          typeof parsed === 'object' &&
          parsed.leadData &&
          typeof parsed.leadData === 'object' &&
          parsed.leadData._joiningRegistrationExtras &&
          typeof parsed.leadData._joiningRegistrationExtras === 'object'
            ? parsed.leadData._joiningRegistrationExtras
            : {};

        const checklist = extras?.certificate_checklist;
        if (checklist && typeof checklist === 'object' && !Array.isArray(checklist)) {
          const values = Object.values(checklist);
          if (values.length > 0) {
            const allReceived = values.every(
              (entry) => normalizeChecklistItemStatus(entry) === 'received'
            );
            if (!allReceived) {
              derived = 'Not Verified';
            } else {
              const hasTemporaryOption = values.some((entry) => {
                const option = normalizeChecklistOption(entry);
                if (!option) return false;
                return /(temporary|provisional|memo)/i.test(option);
              });
              derived = hasTemporaryOption ? 'Partial' : 'Verified';
            }
          }
        }
      } catch {
        derived = null;
      }
      const normalized = derived || normalizeVerifiedState(row.certificates_status);
      if (!normalized) continue;
      const current = String(row.certificates_status ?? '').trim();
      if (current === normalized) continue;
      await secondary.execute(
        'UPDATE students SET certificates_status = ?, updated_at = NOW() WHERE id = ?',
        [normalized, row.id]
      );
      certUpdates += 1;
    }

    // 1b) Normalize stud_type from stored quota in student_data to MANG/CONV.
    for (const row of students) {
      let normalizedStudType = null;
      try {
        const parsed =
          typeof row.student_data === 'string'
            ? JSON.parse(row.student_data || '{}')
            : row.student_data || {};
        const quota =
          parsed?.courseInfo?.quota ??
          parsed?.quota ??
          parsed?.leadData?.quota ??
          null;
        normalizedStudType = normalizeStudTypeFromQuota(quota);
      } catch {
        normalizedStudType = null;
      }
      if (!normalizedStudType) continue;
      const current = String(row.stud_type ?? '').trim().toUpperCase();
      if (current === normalizedStudType) continue;
      await secondary.execute(
        'UPDATE students SET stud_type = ?, updated_at = NOW() WHERE id = ?',
        [normalizedStudType, row.id]
      );
      studTypeUpdates += 1;
    }

    // 2) Backfill student_photo from admissions lead_data extras when secondary is empty.
    const [admissions] = await primary.execute(
      `SELECT admission_number, lead_data
       FROM admissions
       WHERE admission_number IS NOT NULL
         AND admission_number <> ''`
    );

    for (const admission of admissions) {
      const admissionNumber = String(admission.admission_number || '').trim();
      if (!admissionNumber) continue;

      let leadData = {};
      try {
        leadData =
          typeof admission.lead_data === 'string'
            ? JSON.parse(admission.lead_data || '{}')
            : admission.lead_data || {};
      } catch {
        leadData = {};
      }

      const extras =
        leadData &&
        typeof leadData === 'object' &&
        leadData._joiningRegistrationExtras &&
        typeof leadData._joiningRegistrationExtras === 'object'
          ? leadData._joiningRegistrationExtras
          : {};

      const photoRaw = extras?.student_photo;
      const photo = typeof photoRaw === 'string' ? photoRaw.trim() : '';
      if (!photo) continue;

      const [updated] = await secondary.execute(
        `UPDATE students
         SET student_photo = ?, updated_at = NOW()
         WHERE admission_number = ?
           AND (student_photo IS NULL OR TRIM(student_photo) = '')`,
        [photo, admissionNumber]
      );
      if (updated.affectedRows > 0) {
        photoUpdates += Number(updated.affectedRows);
      }
    }

    console.log(
      JSON.stringify(
        {
          examinedStudents,
          certificatesStatusUpdated: certUpdates,
          studTypeUpdatedFromQuota: studTypeUpdates,
          studentPhotoBackfilled: photoUpdates,
        },
        null,
        2
      )
    );
  } finally {
    await primary.end();
    await secondary.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

