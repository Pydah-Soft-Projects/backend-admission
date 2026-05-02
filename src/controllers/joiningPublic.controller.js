import { createHash, randomBytes } from 'crypto';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';
import { fetchCoursePaymentCatalogPayload } from './paymentConfig.controller.js';
import {
  fetchJoiningPayloadReadOnly,
  getJoining,
  saveJoiningDraft,
  submitJoiningForApproval,
  ensureJoiningDraftForLead,
} from './joining.controller.js';
import { listRegistrationForms, getRegistrationForm } from './registrationForm.controller.js';
import { listCourseProgramLevels, getCertificateGuidanceForLevel } from './secondaryJoiningContext.controller.js';

const PUBLIC_EDIT_TTL_MS = 5 * 60 * 1000;

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
    const rawToken = randomBytes(16).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + PUBLIC_EDIT_TTL_MS);

    await pool.execute(
      `INSERT INTO joining_public_edit_tokens (id, token_hash, route_key, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, tokenHash, isPublicNewFlow ? 'new' : leadId, expiresAt, req.user?.id || null]
    );

    const base =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.FRONTEND_URL ||
      process.env.PUBLIC_JOINING_FORM_BASE_URL ||
      '';
    // DLT / CTA: static URL through `?` then variable value only (whitelist `.../joining/public?t=`).
    const path = `/joining/public?t=${encodeURIComponent(rawToken)}`;
    const publicUrl = base ? `${String(base).replace(/\/$/, '')}${path}` : path;

    return successResponse(
      res,
      {
        path,
        publicUrl,
        token: rawToken,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: Math.floor(PUBLIC_EDIT_TTL_MS / 1000),
      },
      'Public edit link created',
      201
    );
  } catch (error) {
    console.error('createJoiningPublicEditLink:', error);
    return errorResponse(res, error.message || 'Failed to create link', error.statusCode || 500);
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

    const level = (joining.courseInfo?.programLevel || '').trim();
    let certificateGuidance = null;
    if (level) {
      const cgBody = await captureControllerJson(getCertificateGuidanceForLevel, () => ({
        query: { level },
      }));
      certificateGuidance = cgBody?.data ?? null;
    }

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
