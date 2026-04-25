import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import {
  createSmsBulkJobRecord,
  formatItemRow,
  formatJobRow,
  scheduleProcessSmsBulkJob,
} from '../services/smsBulkJob.service.js';

/**
 * Re-queue the background worker (e.g. after a long hang, deploy, or 199/460 "stuck" progress).
 * Safe to call multiple times; the processor re-loads `pending` rows and resets long-stuck `processing` rows.
 */
export const resumeBulkSmsJob = async (req, res) => {
  try {
    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'Forbidden', 403);
    }
    const { id } = req.params;
    if (!id || id.length !== 36) {
      return errorResponse(res, 'Invalid job id', 400);
    }
    const pool = getPool();
    const [jobs] = await pool.execute('SELECT id, status, created_by FROM sms_bulk_jobs WHERE id = ?', [id]);
    if (jobs.length === 0) {
      return errorResponse(res, 'Job not found', 404);
    }
    const job = jobs[0];
    if (String(job.status) === 'failed' || String(job.status) === 'cancelled') {
      return errorResponse(res, 'Job is not in a resumable state', 400);
    }
    const isOwner = String(job.created_by) === String(req.user.id || req.user._id);
    if (!isOwner && !hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Forbidden', 403);
    }
    scheduleProcessSmsBulkJob(id);
    return successResponse(res, { requeued: true, jobId: id }, 'Bulk SMS job processor requeued', 200);
  } catch (e) {
    console.error('resumeBulkSmsJob', e);
    return errorResponse(res, e.message || 'Failed to resume job', 500);
  }
};

const VALID_SOURCES = new Set(['send_to_leads', 'user_specific_leads']);

export const createBulkSmsJob = async (req, res) => {
  try {
    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'SMS bulk jobs are not available for PRO users', 403);
    }
    const { source, templateId, items, reportContext: rawContext } = req.body || {};
    if (!source || !VALID_SOURCES.has(String(source))) {
      return errorResponse(res, 'Invalid or missing source', 400);
    }
    if (!templateId || typeof templateId !== 'string') {
      return errorResponse(res, 'templateId is required', 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(res, 'items array is required', 400);
    }
    for (const it of items) {
      if (!it?.leadId || typeof it.leadId !== 'string' || it.leadId.length !== 36) {
        return errorResponse(res, 'Each item must have a valid leadId', 400);
      }
      if (!Array.isArray(it?.contactNumbers) || it.contactNumbers.length === 0) {
        return errorResponse(res, 'Each item must have contactNumbers', 400);
      }
    }
    const pool = getPool();
    const userId = req.user.id || req.user._id;
    const { jobId, totalItems, templateName } = await createSmsBulkJobRecord({
      pool,
      userId,
      source: String(source),
      templateId,
      reportContext: rawContext,
      items: items.map((it) => ({
        leadId: it.leadId,
        leadName: it.leadName,
        contactNumbers: it.contactNumbers,
        variables: it.variables,
      })),
    });
    scheduleProcessSmsBulkJob(jobId);
    return successResponse(
      res,
      { jobId, totalItems, templateName, message: 'Job queued. Processing in background.' },
      'Bulk SMS job created',
      201
    );
  } catch (e) {
    console.error('createBulkSmsJob', e);
    return errorResponse(res, e.message || 'Failed to create job', 400);
  }
};

export const getBulkSmsJob = async (req, res) => {
  try {
    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'Forbidden', 403);
    }
    const { id } = req.params;
    if (!id || id.length !== 36) {
      return errorResponse(res, 'Invalid job id', 400);
    }
    const pool = getPool();
    const [jobs] = await pool.execute('SELECT * FROM sms_bulk_jobs WHERE id = ?', [id]);
    if (jobs.length === 0) {
      return errorResponse(res, 'Job not found', 404);
    }
    const job = jobs[0];
    const isOwner = String(job.created_by) === String(req.user.id || req.user._id);
    if (!isOwner && !hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Forbidden', 403);
    }
    const [items] = await pool.execute(
      `SELECT * FROM sms_bulk_job_items WHERE job_id = ? ORDER BY sort_order ASC`,
      [id]
    );
    const out = {
      job: await formatJobRow(job),
      items: await Promise.all(items.map((r) => formatItemRow(r))),
    };
    return successResponse(res, out);
  } catch (e) {
    console.error('getBulkSmsJob', e);
    return errorResponse(res, e.message || 'Failed to load job', 500);
  }
};

export const listBulkSmsJobs = async (req, res) => {
  try {
    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'Forbidden', 403);
    }
    const userId = req.user.id || req.user._id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const pool = getPool();
    const isSuper = hasElevatedAdminPrivileges(req.user.roleName);
    const [countRows] = isSuper
      ? await pool.execute(`SELECT COUNT(*) AS c FROM sms_bulk_jobs`)
      : await pool.execute(`SELECT COUNT(*) AS c FROM sms_bulk_jobs WHERE created_by = ?`, [userId]);
    const total = countRows[0]?.c ?? 0;
    const [jobs] = isSuper
      ? await pool.execute(
          `SELECT * FROM sms_bulk_jobs ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
        )
      : await pool.execute(
          `SELECT * FROM sms_bulk_jobs WHERE created_by = ? ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(
            offset
          )}`,
          [userId]
    );
    const data = { items: await Promise.all(jobs.map((j) => formatJobRow(j))), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    return successResponse(res, data);
  } catch (e) {
    console.error('listBulkSmsJobs', e);
    return errorResponse(res, e.message || 'Failed to list jobs', 500);
  }
};
