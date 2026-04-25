import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { findTemplate, executeSmsSendForLead } from './communicationSmsDispatch.js';

const SMS_JOB_CONCURRENCY = 4;

const runningJobIds = new Set();

/**
 * @param {object[]} items
 * @param {number} concurrency
 * @param {(row: object) => Promise<void>} worker
 */
async function runWithConcurrencyItems(items, concurrency, worker) {
  if (items.length === 0) return;
  const queue = [...items];
  const pump = async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  };
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => pump()));
}

export const MAX_SMS_BULK_JOB_ITEMS = 2000;

export function scheduleProcessSmsBulkJob(jobId) {
  setImmediate(() => {
    processSmsBulkJob(jobId).catch((err) => {
      console.error('[SMS bulk job] Fatal', jobId, err);
    });
  });
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} userId
 * @param {string} jobId
 * @param {object} row
 */
async function processOneJobItem(pool, userId, jobId, row) {
  const itemId = row.id;
  const leadId = row.lead_id;
  const templateId = row.template_id;
  const nums = typeof row.contact_numbers === 'string' ? JSON.parse(row.contact_numbers) : row.contact_numbers;
  const variables = row.variables == null ? [] : typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
  if (!Array.isArray(nums) || nums.length === 0) {
    await pool.execute(
      `UPDATE sms_bulk_job_items SET status = 'failed', error_message = 'No contact numbers', completed_at = NOW() WHERE id = ?`,
      [itemId]
    );
    await pool.execute(
      `UPDATE sms_bulk_jobs SET done_count = done_count + 1, fail_count = fail_count + 1, last_error = 'Item skipped: no numbers' WHERE id = ?`,
      [jobId]
    );
    return;
  }
  const [u] = await pool.execute(
    `UPDATE sms_bulk_job_items SET status = 'processing', started_at = COALESCE(started_at, NOW()) WHERE id = ? AND status = 'pending'`,
    [itemId]
  );
  if (u.affectedRows === 0) {
    return;
  }
  try {
    const out = await executeSmsSendForLead(pool, userId, leadId, nums, [
      { templateId, variables: Array.isArray(variables) ? variables : [] },
    ]);
    const anyOk = out.results.some((r) => r.success);
    const last = out.results[out.results.length - 1];
    const errMsg = anyOk ? null : (last?.error || 'Provider reported failure');
    const respText = (last?.responseText ? String(last.responseText) : out.results.map((r) => r.responseText).filter(Boolean).join(' | ')).slice(
      0,
      4000
    );
    const mids = (() => {
      for (const r of out.results) {
        if (r.messageId) return [r.messageId];
      }
      return [];
    })();
    await pool.execute(
      `UPDATE sms_bulk_job_items SET
        status = ?,
        response_text = ?,
        error_message = ?,
        communication_ids = ?,
        provider_message_ids = ?,
        completed_at = NOW() WHERE id = ?`,
      [
        anyOk ? 'success' : 'failed',
        respText,
        errMsg,
        JSON.stringify(out.savedCommunicationIds || []),
        JSON.stringify(mids),
        itemId,
      ]
    );
    await pool.execute(
      `UPDATE sms_bulk_jobs SET
        done_count = done_count + 1,
        success_count = success_count + ?,
        fail_count = fail_count + ? WHERE id = ?`,
      [anyOk ? 1 : 0, anyOk ? 0 : 1, jobId]
    );
  } catch (e) {
    const msg = (e?.message || 'Unknown error').slice(0, 2000);
    await pool.execute(
      `UPDATE sms_bulk_job_items SET status = 'failed', error_message = ?, response_text = NULL, completed_at = NOW() WHERE id = ?`,
      [msg, itemId]
    );
    await pool.execute(
      `UPDATE sms_bulk_jobs SET done_count = done_count + 1, fail_count = fail_count + 1, last_error = ? WHERE id = ?`,
      [msg, jobId]
    );
  }
}

export async function processSmsBulkJob(jobId) {
  if (runningJobIds.has(jobId)) {
    return;
  }
  const pool = getPool();
  const [jobRows] = await pool.execute('SELECT * FROM sms_bulk_jobs WHERE id = ?', [jobId]);
  if (jobRows.length === 0) {
    return;
  }
  const job = jobRows[0];
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    return;
  }
  runningJobIds.add(jobId);
  try {
    if (job.status === 'queued') {
      await pool.execute(`UPDATE sms_bulk_jobs SET status = 'running', started_at = NOW() WHERE id = ? AND status = 'queued'`, [jobId]);
    }
    const [itemRows] = await pool.execute(
      `SELECT * FROM sms_bulk_job_items WHERE job_id = ? AND status = 'pending' ORDER BY sort_order ASC`,
      [jobId]
    );
    if (itemRows.length === 0) {
      const [jc] = await pool.execute(`SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ?`, [jobId]);
      if (jc[0]?.c === 0) {
        await pool.execute(
          `UPDATE sms_bulk_jobs SET status = 'failed', completed_at = NOW(), last_error = 'No line items' WHERE id = ?`,
          [jobId]
        );
      } else {
        await pool.execute(`UPDATE sms_bulk_jobs SET status = 'completed', completed_at = NOW() WHERE id = ? AND status != 'cancelled'`, [jobId]);
      }
      return;
    }
    const userId = job.created_by;
    await runWithConcurrencyItems(itemRows, SMS_JOB_CONCURRENCY, (row) => processOneJobItem(pool, userId, jobId, row));
    const [p] = await pool.execute(
      `SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ? AND status IN ('pending','processing')`,
      [jobId]
    );
    if (p[0].c === 0) {
      await pool.execute(`UPDATE sms_bulk_jobs SET status = 'completed', completed_at = NOW() WHERE id = ? AND status != 'cancelled'`, [jobId]);
    }
  } finally {
    runningJobIds.delete(jobId);
  }
}

/**
 * @param {object} p
 * @param {import('mysql2/promise').Pool} p.pool
 * @param {string} p.userId
 * @param {string} p.source
 * @param {string} p.templateId
 * @param {Array<{ leadId: string, leadName?: string, contactNumbers: string[], variables: object[] }>} p.items
 */
export async function createSmsBulkJobRecord({ pool, userId, source, templateId, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one recipient row is required');
  }
  if (items.length > MAX_SMS_BULK_JOB_ITEMS) {
    throw new Error(`A single job cannot exceed ${MAX_SMS_BULK_JOB_ITEMS} lead rows. Split into multiple runs.`);
  }
  const template = await findTemplate(templateId);
  const jobId = uuidv4();
  const insItems = items.map((it, idx) => ({
    id: uuidv4(),
    leadId: it.leadId,
    leadName: (it.leadName || '').trim() || 'Lead',
    contactNumbers: it.contactNumbers,
    variables: it.variables,
    sort_order: idx,
  }));
  await pool.execute(
    `INSERT INTO sms_bulk_jobs (
      id, created_by, source, template_id, template_name, status, total_items, done_count, success_count, fail_count
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0)`,
    [jobId, userId, source, template.id, template.name, insItems.length]
  );
  for (const it of insItems) {
    await pool.execute(
      `INSERT INTO sms_bulk_job_items (
        id, job_id, sort_order, lead_id, lead_name, contact_numbers, template_id, variables, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        it.id,
        jobId,
        it.sort_order,
        it.leadId,
        it.leadName,
        JSON.stringify(it.contactNumbers),
        templateId,
        JSON.stringify(it.variables || []),
      ]
    );
  }
  return { jobId, totalItems: insItems.length, templateName: template.name };
}

export async function formatJobRow(row) {
  return {
    id: row.id,
    source: row.source,
    templateId: row.template_id,
    templateName: row.template_name,
    status: row.status,
    totalItems: row.total_items,
    doneCount: row.done_count,
    successCount: row.success_count,
    failCount: row.fail_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function formatItemRow(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name,
    contactNumbers:
      typeof row.contact_numbers === 'string' ? JSON.parse(row.contact_numbers) : row.contact_numbers,
    status: row.status,
    responseText: row.response_text,
    errorMessage: row.error_message,
    communicationIds: row.communication_ids
      ? typeof row.communication_ids === 'string'
        ? JSON.parse(row.communication_ids)
        : row.communication_ids
      : [],
    providerMessageIds: row.provider_message_ids
      ? typeof row.provider_message_ids === 'string'
        ? JSON.parse(row.provider_message_ids)
        : row.provider_message_ids
      : [],
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
