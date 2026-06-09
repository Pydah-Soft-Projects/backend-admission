import { getPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { normalizeJsonObject } from '../utils/secondaryCourseLevel.util.js';
import { getTableColumnSet } from '../utils/secondarySchema.util.js';

/** Inline base64 in JSON is kept only for small QR files; larger images use /fee-qr-image. */
const MAX_INLINE_FEE_QR_BYTES = 120_000;

/** Default admissions contact block on admit cards when not set in student_database. */
export const DEFAULT_ADMISSION_CONTACT_DETAILS =
  'Mobile: +91 73820 15999\nMail: admissions@pydah.edu.in';

function bufferToDataUrl(buffer, mimeType) {
  if (!buffer || !mimeType) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.length) return null;
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

function resolveFeeQrFromMetadata(metadata) {
  const meta = normalizeJsonObject(metadata);
  if (!meta) return null;
  const raw =
    meta.fee_qr_image ??
    meta.feeQrImage ??
    meta.fee_qr_url ??
    meta.feeQrUrl ??
    meta.fee_qr ??
    meta.feeQr;
  if (raw == null) return null;
  const text = String(raw).trim();
  return text || null;
}

async function loadCourseFeeQrRow(pool, courseIdInt) {
  const courseCols = await getTableColumnSet(pool, 'courses');
  const selectCols = ['id', 'name', 'college_id', 'metadata'];
  if (courseCols.has('fee_qr_image')) selectCols.push('fee_qr_image');
  if (courseCols.has('fee_qr_image_type')) selectCols.push('fee_qr_image_type');

  const [courses] = await pool.execute(
    `SELECT ${selectCols.join(', ')} FROM courses WHERE id = ? LIMIT 1`,
    [courseIdInt]
  );
  if (!courses.length) return null;

  const course = courses[0];
  let feeQrBuffer = null;
  let feeQrMime = null;

  if (course.fee_qr_image) {
    const buf = Buffer.isBuffer(course.fee_qr_image)
      ? course.fee_qr_image
      : Buffer.from(course.fee_qr_image);
    if (buf.length) {
      feeQrBuffer = buf;
      feeQrMime = course.fee_qr_image_type || 'image/png';
    }
  }

  const metadataUrl = resolveFeeQrFromMetadata(course.metadata);
  return { course, feeQrBuffer, feeQrMime, metadataUrl };
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

function resolveCollegeAddress(college) {
  if (!college) return '';
  const direct = String(college.address ?? '').trim();
  if (direct) return direct;

  const meta = normalizeJsonObject(college.metadata);
  if (!meta) return '';

  const fromMeta = String(
    meta.address ??
      meta.college_address ??
      meta.collegeAddress ??
      meta.location ??
      meta.campus_address ??
      meta.campusAddress ??
      ''
  ).trim();
  return fromMeta;
}

async function loadCollegeForAdmitCard(pool, collegeId) {
  if (!collegeId) return null;
  const collegeCols = await getTableColumnSet(pool, 'colleges');
  const selectCols = ['id', 'name'];
  if (collegeCols.has('address')) selectCols.push('address');
  if (collegeCols.has('metadata')) selectCols.push('metadata');

  const [colleges] = await pool.execute(
    `SELECT ${selectCols.join(', ')} FROM colleges WHERE id = ? LIMIT 1`,
    [collegeId]
  );
  return colleges.length ? colleges[0] : null;
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
 * - colleges.name + colleges.address (printed header on admit card)
 * - courses.fee_qr_image (course fee UPI QR)
 * - settings.admission_contact_details or colleges.metadata admission contact
 */
/**
 * Stream the course fee QR image (binary). Used when the stored file is too large for JSON.
 */
export const getCourseFeeQrImage = async (req, res) => {
  try {
    const courseIdInt = parseInt(req.params.courseId, 10);
    if (Number.isNaN(courseIdInt)) {
      return errorResponse(res, 'Invalid course ID', 400);
    }

    const pool = getPool();
    const loaded = await loadCourseFeeQrRow(pool, courseIdInt);
    if (!loaded) {
      return errorResponse(res, 'Course not found', 404);
    }

    const { feeQrBuffer, feeQrMime, metadataUrl } = loaded;
    if (feeQrBuffer?.length) {
      res.setHeader('Content-Type', feeQrMime || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(200).send(feeQrBuffer);
    }

    if (metadataUrl && /^https?:\/\//i.test(metadataUrl)) {
      return res.redirect(metadataUrl);
    }

    return errorResponse(res, 'Fee QR image not configured for this course', 404);
  } catch (error) {
    console.error('getCourseFeeQrImage error:', error);
    return errorResponse(res, error.message || 'Failed to load fee QR image', 500);
  }
};

export const getAdmitCardAssets = async (req, res) => {
  try {
    const courseIdInt = parseInt(req.params.courseId, 10);
    if (Number.isNaN(courseIdInt)) {
      return errorResponse(res, 'Invalid course ID', 400);
    }

    const pool = getPool();
    const loaded = await loadCourseFeeQrRow(pool, courseIdInt);
    if (!loaded) {
      return errorResponse(res, 'Course not found', 404);
    }

    const { course, feeQrBuffer, feeQrMime, metadataUrl } = loaded;
    let collegeName = '';
    let collegeAddress = '';
    let admissionContactDetails = null;

    if (course.college_id) {
      const college = await loadCollegeForAdmitCard(pool, course.college_id);
      if (college) {
        collegeName = college.name || '';
        collegeAddress = resolveCollegeAddress(college);
        admissionContactDetails = resolveAdmissionContactFromMetadata(college.metadata);
      }
    }

    if (!admissionContactDetails) {
      admissionContactDetails = await loadSettingValue(pool, 'admission_contact_details');
    }
    if (!admissionContactDetails) {
      admissionContactDetails = await loadSettingValue(pool, 'admission_contact');
    }

    const hasFeeQrImage = Boolean(feeQrBuffer?.length);
    let feeQrImage = null;
    if (hasFeeQrImage && feeQrBuffer.length <= MAX_INLINE_FEE_QR_BYTES) {
      feeQrImage = bufferToDataUrl(feeQrBuffer, feeQrMime);
    } else if (
      metadataUrl &&
      (/^data:image\//i.test(metadataUrl) || /^https?:\/\//i.test(metadataUrl))
    ) {
      feeQrImage = metadataUrl;
    }

    return successResponse(res, {
      courseId: String(course.id),
      courseName: course.name || '',
      collegeName,
      collegeAddress,
      feeQrImage,
      hasFeeQrImage,
      admissionContactDetails: admissionContactDetails || DEFAULT_ADMISSION_CONTACT_DETAILS,
      feeQrPaymentNote: 'Pay the fee through the QR',
    });
  } catch (error) {
    console.error('getAdmitCardAssets error:', error);
    return errorResponse(res, error.message || 'Failed to load acknowledgement card assets', 500);
  }
};
