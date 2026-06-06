import { getPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { normalizeJsonObject } from '../utils/secondaryCourseLevel.util.js';

/** Default admissions contact block on admit cards when not set in student_database. */
export const DEFAULT_ADMISSION_CONTACT_DETAILS =
  'Mobile: +91 73820 15999\nMail: admissions@pydah.edu.in';

function bufferToDataUrl(buffer, mimeType) {
  if (!buffer || !mimeType) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.length) return null;
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

async function loadSettingValue(pool, key) {
  try {
    const [rows] = await pool.execute('SELECT value FROM settings WHERE `key` = ? LIMIT 1', [key]);
    if (!rows?.length) return null;
    const v = rows[0].value;
    if (v == null) return null;
    const text = String(v).trim();
    return text || null;
  } catch {
    return null;
  }
}

function resolveAdmissionContactFromMetadata(metadata) {
  const meta = normalizeJsonObject(metadata);
  if (!meta) return null;
  const raw =
    meta.admission_contact_details ??
    meta.admissionContactDetails ??
    meta.admission_contact ??
    meta.admissionContact;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t || null;
  }
  if (typeof raw === 'object') {
    const lines = [];
    for (const [k, v] of Object.entries(raw)) {
      if (v == null || String(v).trim() === '') continue;
      const label = String(k)
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`${label}: ${String(v).trim()}`);
    }
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}

/**
 * Admit card print assets from secondary student_database:
 * - colleges.name (printed as text header on admit card)
 * - courses.fee_qr_image (course fee UPI QR)
 * - settings.admission_contact_details or colleges.metadata admission contact
 */
export const getAdmitCardAssets = async (req, res) => {
  try {
    const courseIdInt = parseInt(req.params.courseId, 10);
    if (Number.isNaN(courseIdInt)) {
      return errorResponse(res, 'Invalid course ID', 400);
    }

    const pool = getPool();
    const [courses] = await pool.execute(
      'SELECT id, name, college_id, fee_qr_image, fee_qr_image_type FROM courses WHERE id = ? LIMIT 1',
      [courseIdInt]
    );

    if (!courses.length) {
      return errorResponse(res, 'Course not found', 404);
    }

    const course = courses[0];
    let collegeName = '';
    let admissionContactDetails = null;

    if (course.college_id) {
      const [colleges] = await pool.execute(
        'SELECT id, name, metadata FROM colleges WHERE id = ? LIMIT 1',
        [course.college_id]
      );
      if (colleges.length) {
        const college = colleges[0];
        collegeName = college.name || '';
        admissionContactDetails = resolveAdmissionContactFromMetadata(college.metadata);
      }
    }

    if (!admissionContactDetails) {
      admissionContactDetails = await loadSettingValue(pool, 'admission_contact_details');
    }
    if (!admissionContactDetails) {
      admissionContactDetails = await loadSettingValue(pool, 'admission_contact');
    }

    const feeQrImage = bufferToDataUrl(course.fee_qr_image, course.fee_qr_image_type);

    return successResponse(res, {
      courseId: String(course.id),
      courseName: course.name || '',
      collegeName,
      feeQrImage,
      admissionContactDetails: admissionContactDetails || DEFAULT_ADMISSION_CONTACT_DETAILS,
      feeQrPaymentNote: 'Pay the fee through the QR',
    });
  } catch (error) {
    console.error('getAdmitCardAssets error:', error);
    return errorResponse(res, error.message || 'Failed to load admit card assets', 500);
  }
};
