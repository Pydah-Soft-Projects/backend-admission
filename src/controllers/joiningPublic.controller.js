import { createHash, randomBytes } from 'crypto';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';
import { generateEnquiryNumber } from '../utils/generateEnquiryNumber.js';
import { fetchCoursePaymentCatalogPayload } from './paymentConfig.controller.js';
import {
  fetchJoiningPayloadReadOnly,
  getJoining,
  saveJoiningDraft,
  submitJoiningForApproval,
  ensureJoiningDraftForLead,
} from './joining.controller.js';
import { listRegistrationForms, getRegistrationForm } from './registrationForm.controller.js';
import { listCourseProgramLevels } from './secondaryJoiningContext.controller.js';

const PUBLIC_EDIT_TTL_MS = 5 * 60 * 1000;
const sanitizeString = (value) => (typeof value === 'string' ? value.trim() : '');
const sanitizePhone = (value) => sanitizeString(value).replace(/\D/g, '').slice(-10);

async function captureControllerJson(handler, buildReq) {
  let captured = null;
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      captured = body;
    },
    setHeader() {},
  };
  const req = buildReq();
  await handler(req, res);
  return captured;
}

/** Plain token from `?t=` / `?token=` (DLT-friendly) or legacy path `/:token`. */
function normalizePublicJoiningToken(req) {
  const qRaw = req.query?.t ?? req.query?.token;
  if (qRaw !== undefined && qRaw !== null) {
    const s = Array.isArray(qRaw) ? qRaw[0] : qRaw;
    const trimmed = String(s || '').trim();
    if (trimmed) {
      try {
        return decodeURIComponent(trimmed);
      } catch {
        return trimmed;
      }
    }
  }
  const p = req.params?.token;
  if (p != null && String(p).trim()) {
    try {
      return decodeURIComponent(String(p).trim());
    } catch {
      return String(p).trim();
    }
  }
  return '';
}

async function resolvePublicTokenRow(plainToken) {
  /** Legacy hex tokens were 64 chars; short tokens are ~22 chars (16 bytes, base64url). */
  if (!plainToken || typeof plainToken !== 'string' || plainToken.length < 12) {
    return null;
  }
  const pool = getPool();
  const tokenHash = createHash('sha256').update(plainToken, 'utf8').digest('hex');
  const [rows] = await pool.execute(
    'SELECT * FROM joining_public_edit_tokens WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1',
    [tokenHash]
  );
  return rows.length ? rows[0] : null;
}

async function assertDraftJoiningForRouteKey(routeKey) {
  const { joining } = await fetchJoiningPayloadReadOnly(routeKey);
  if (joining.status !== 'draft') {
    const err = new Error('This link is only valid while the joining form is a draft.');
    err.statusCode = 400;
    throw err;
  }
  return joining;
}

async function createPublicEditTokenForRouteKey(pool, routeKey, userId) {
  const rawToken = randomBytes(16).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + PUBLIC_EDIT_TTL_MS);

  await pool.execute(
    `INSERT INTO joining_public_edit_tokens (id, token_hash, route_key, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [id, tokenHash, routeKey, expiresAt, userId || null]
  );

  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_JOINING_FORM_BASE_URL ||
    '';
  const path = `/joining/public?t=${encodeURIComponent(rawToken)}`;
  const publicUrl = base ? `${String(base).replace(/\/$/, '')}${path}` : path;

  return {
    path,
    publicUrl,
    token: rawToken,
    expiresAt: expiresAt.toISOString(),
    ttlSeconds: Math.floor(PUBLIC_EDIT_TTL_MS / 1000),
  };
}

/**
 * POST /api/joinings/:leadId/public-edit-link (authenticated)
 */
export const createJoiningPublicEditLink = async (req, res) => {
  try {
    const { leadId } = req.params;
    const pool = getPool();

    if (!leadId || typeof leadId !== 'string' || (leadId.length !== 36 && leadId !== 'new')) {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    const isPublicNewFlow = leadId === 'new';
    let joiningRow = null;
    if (!isPublicNewFlow) {
      const [byId] = await pool.execute('SELECT id, status FROM joinings WHERE id = ? LIMIT 1', [leadId]);
      if (byId.length > 0) {
        joiningRow = byId[0];
      }
      if (!joiningRow) {
        const [byLead] = await pool.execute('SELECT id, status FROM joinings WHERE lead_id = ? LIMIT 1', [
          leadId,
        ]);
        if (byLead.length > 0) joiningRow = byLead[0];
      }

      if (!joiningRow) {
        try {
          await ensureJoiningDraftForLead(leadId, req.user.id);
        } catch (e) {
          return errorResponse(
            res,
            e.message || 'Cannot create a public joining link for this lead.',
            e.statusCode || 400
          );
        }
        const [createdRow] = await pool.execute(
          'SELECT id, status FROM joinings WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1',
          [leadId]
        );
        if (createdRow.length > 0) joiningRow = createdRow[0];
      }

      if (!joiningRow || joiningRow.status !== 'draft') {
        return errorResponse(
          res,
          joiningRow && joiningRow.status !== 'draft'
            ? 'A public form link is only available while the joining form is still a draft.'
            : 'Could not prepare a joining draft for this link.',
          400
        );
      }
    }

    // Short URL-friendly token (~22 chars vs 64 hex) — still 128-bit entropy, hashed at rest.
    const link = await createPublicEditTokenForRouteKey(
      pool,
      isPublicNewFlow ? 'new' : leadId,
      req.user?.id
    );

    return successResponse(
      res,
      link,
      'Public edit link created',
      201
    );
  } catch (error) {
    console.error('createJoiningPublicEditLink:', error);
    return errorResponse(res, error.message || 'Failed to create link', error.statusCode || 500);
  }
};

/**
 * POST /api/joinings/send-public-link
 * Creates a lightweight lead + joining draft, then returns a public joining link for SMS.
 */
export const createJoiningDraftAndPublicLink = async (req, res) => {
  const pool = getPool();
  let connection;
  try {
    const studentName = sanitizeString(req.body?.studentName || req.body?.name);
    const studentPhone = sanitizePhone(req.body?.studentPhone || req.body?.phone);
    const fatherPhone = sanitizePhone(req.body?.fatherPhone);
    const fatherName = sanitizeString(req.body?.fatherName) || 'Not Provided';
    const courseInterested = sanitizeString(req.body?.courseInterested || req.body?.course);
    const courseId = sanitizeString(req.body?.courseId);
    const branchId = sanitizeString(req.body?.branchId);
    const branch = sanitizeString(req.body?.branch);
    const quota = sanitizeString(req.body?.quota);
    const programLevel = sanitizeString(req.body?.programLevel);

    if (!studentName) return errorResponse(res, 'Student name is required', 400);
    if (studentPhone.length !== 10) {
      return errorResponse(res, 'Student mobile number must be 10 digits', 400);
    }
    if (fatherPhone.length !== 10) {
      return errorResponse(res, 'Father mobile number must be 10 digits', 400);
    }
    if (!courseInterested) return errorResponse(res, 'Interested course is required', 400);
    if (!quota) return errorResponse(res, 'Quota is required', 400);

    const enquiryNumber = await generateEnquiryNumber();
    const leadId = uuidv4();
    const joiningId = uuidv4();
    const userId = req.user?.id || null;
    const leadDataSnapshot = {
      enquiryNumber,
      name: studentName,
      phone: studentPhone,
      fatherName,
      fatherPhone,
      village: 'Not Provided',
      district: 'Not Provided',
      mandal: 'Not Provided',
      state: '',
      quota,
      courseInterested,
      applicationStatus: 'Draft',
      leadStatus: 'Confirmed',
      source: 'Joining Form Link',
      ...(programLevel ? { _joiningProgramLevel: programLevel } : {}),
      ...(courseId ? { _joiningManagedCourseId: courseId } : {}),
      ...(branchId ? { _joiningManagedBranchId: branchId } : {}),
    };

    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.execute(
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
        studentPhone,
        null,
        fatherName,
        '',
        fatherPhone,
        '',
        'Not Provided',
        '',
        courseInterested,
        'Not Provided',
        'Not Provided',
        '',
        'Not Specified',
        null,
        '',
        quota,
        'Draft',
        JSON.stringify({ createdFrom: 'send_joining_form' }),
        'Confirmed',
        'Joining Form Link',
        userId,
      ]
    );

    await connection.execute(
      `INSERT INTO joinings (
        id, lead_id, lead_data, status, course_id, branch_id, course, branch, quota,
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
        null,
        null,
        courseInterested,
        branch,
        quota,
        studentName,
        studentPhone,
        'Not Specified',
        'As per SSC for no issues',
        fatherName,
        fatherPhone,
        '',
        'oc',
        JSON.stringify([]),
        userId,
        userId,
      ]
    );

    const link = await createPublicEditTokenForRouteKey(connection, leadId, userId);
    await connection.commit();

    return successResponse(
      res,
      {
        ...link,
        leadId,
        joiningId,
        enquiryNumber,
      },
      'Joining draft created and public link prepared',
      201
    );
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('createJoiningDraftAndPublicLink:', error);
    return errorResponse(
      res,
      error.message || 'Failed to create joining draft link',
      error.statusCode || 500
    );
  } finally {
    if (connection) connection.release();
  }
};

/**
 * GET /api/joinings/public?t=… or GET /api/joinings/public/:token (legacy)
 */
export const getJoiningPublicBootstrap = async (req, res) => {
  try {
    const token = normalizePublicJoiningToken(req);
    if (!token) {
      return errorResponse(res, 'Missing or invalid token', 400);
    }
    const tokenRow = await resolvePublicTokenRow(token);
    if (!tokenRow) {
      return errorResponse(res, 'Invalid or expired link', 404);
    }

    let joining = null;
    let lead = null;
    if (tokenRow.route_key === 'new') {
      const body = await captureControllerJson(getJoining, () => ({
        params: { leadId: 'new' },
      }));
      joining = body?.data?.joining || null;
      lead = body?.data?.lead || null;
    } else {
      const payload = await fetchJoiningPayloadReadOnly(tokenRow.route_key);
      joining = payload.joining;
      lead = payload.lead;
      if (joining.status !== 'draft') {
        return errorResponse(
          res,
          'This link is only valid while the joining form is a draft.',
          400
        );
      }
    }

    const courseSettings = await fetchCoursePaymentCatalogPayload(false);

    const programLevelsBody = await captureControllerJson(listCourseProgramLevels, () => ({}));
    const programLevels = Array.isArray(programLevelsBody?.data) ? programLevelsBody.data : [];

    const listBody = await captureControllerJson(listRegistrationForms, () => ({
      query: { showInactive: 'false', includeFieldCount: 'true' },
    }));
    const registrationForms = Array.isArray(listBody?.data) ? listBody.data : [];

    const def =
      registrationForms.find((f) => f.isDefault || f.is_default) || registrationForms[0] || null;
    const formId = def ? def.id || def._id : null;

    let registrationForm = null;
    if (formId) {
      const formBody = await captureControllerJson(getRegistrationForm, () => ({
        params: { formId: String(formId) },
        query: { includeFields: 'true', showInactive: 'false' },
      }));
      registrationForm = formBody?.data ?? null;
    }

    // Public magic links are Step 1 (application form) only. Certificate checklist and fees
    // are completed by admissions staff after approval (Step 2 / Step 3 on the desk).
    const certificateGuidance = null;

    const expiresAt =
      tokenRow.expires_at instanceof Date
        ? tokenRow.expires_at.toISOString()
        : String(tokenRow.expires_at);

    return successResponse(
      res,
      {
        joining,
        lead,
        routeKey: tokenRow.route_key,
        expiresAt,
        ttlSeconds: Math.floor(PUBLIC_EDIT_TTL_MS / 1000),
        courseSettings,
        programLevels,
        registrationForms,
        registrationForm,
        certificateGuidance,
      },
      'Public joining workspace loaded',
      200
    );
  } catch (error) {
    console.error('getJoiningPublicBootstrap:', error);
    return errorResponse(
      res,
      error.message || 'Failed to load public joining form',
      error.statusCode || 500
    );
  }
};

/**
 * POST /api/joinings/public/:token — save draft (same body as authenticated save)
 */
export const saveJoiningPublicDraft = async (req, res) => {
  try {
    const token = normalizePublicJoiningToken(req);
    if (!token) {
      return errorResponse(res, 'Missing or invalid token', 400);
    }
    const tokenRow = await resolvePublicTokenRow(token);
    if (!tokenRow) {
      return errorResponse(res, 'Invalid or expired link', 404);
    }

    if (tokenRow.route_key !== 'new') {
      await assertDraftJoiningForRouteKey(tokenRow.route_key);
    }

    const actorId = tokenRow.created_by || null;
    const mockReq = {
      params: { leadId: tokenRow.route_key },
      body: req.body || {},
      user: { id: actorId },
    };
    return saveJoiningDraft(mockReq, res);
  } catch (error) {
    console.error('saveJoiningPublicDraft:', error);
    return errorResponse(
      res,
      error.message || 'Failed to save draft',
      error.statusCode || 500
    );
  }
};

/**
 * POST /api/joinings/public/:token/submit
 */
export const submitJoiningPublic = async (req, res) => {
  try {
    const token = normalizePublicJoiningToken(req);
    if (!token) {
      return errorResponse(res, 'Missing or invalid token', 400);
    }
    const tokenRow = await resolvePublicTokenRow(token);
    if (!tokenRow) {
      return errorResponse(res, 'Invalid or expired link', 404);
    }

    const submittedRouteKey =
      tokenRow.route_key === 'new'
        ? String((req.body && req.body.routeKey) || '')
        : tokenRow.route_key;
    if (!submittedRouteKey || submittedRouteKey === 'new') {
      return errorResponse(res, 'Missing joining identifier for submit', 400);
    }

    await assertDraftJoiningForRouteKey(submittedRouteKey);

    const actorId = tokenRow.created_by || null;
    const mockReq = {
      params: { leadId: submittedRouteKey },
      body: {},
      user: { id: actorId },
    };
    return submitJoiningForApproval(mockReq, res);
  } catch (error) {
    console.error('submitJoiningPublic:', error);
    return errorResponse(
      res,
      error.message || 'Failed to submit joining form',
      error.statusCode || 500
    );
  }
};
