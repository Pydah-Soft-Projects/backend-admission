import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { findTemplate, executeSmsSendForLead } from './communicationSmsDispatch.js';

const SMS_JOB_CONCURRENCY = 4;
/** If one lead blocks (DB/network), the whole job used to wait forever. Fail this item and continue. */
const SMS_ITEM_MAX_MS = Math.min(180_000, Math.max(30_000, Number.parseInt(process.env.SMS_BULK_ITEM_TIMEOUT_MS, 10) || 120_000));
/** Items left in `processing` (e.g. crash) become retryable. */
const STUCK_PROCESSING_RESET_MIN = Math.max(1, Number.parseInt(process.env.SMS_BULK_STUCK_PROCESSING_MIN, 10) || 5);

const runningJobIds = new Set();

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms (${label})`));
    }, ms);
    Promise.resolve(promise)
      .then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
  });
}

/**
 * Reset rows stuck in `processing` (worker crash, hung I/O) so a later run or this run can re-fetch them.
 */
async function releaseStuckProcessingItems(pool, jobId) {
  const [stuck] = await pool.execute(
    `SELECT id FROM sms_bulk_job_items
     WHERE job_id = ? AND status = 'processing'
     AND (started_at IS NULL OR started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))`,
    [jobId, STUCK_PROCESSING_RESET_MIN]
  );
  for (const row of stuck) {
    await pool.execute(
      `UPDATE sms_bulk_job_items
       SET status = 'pending', started_at = NULL, error_message = NULL, completed_at = NULL
       WHERE id = ? AND status = 'processing'`,
      [row.id]
    );
  }
  if (stuck.length > 0) {
    console.warn(`[SMS bulk job] ${jobId}: re-queued ${stuck.length} item(s) stuck in processing (>${STUCK_PROCESSING_RESET_MIN}m)`);
  }
}

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

/**
 * Safe JSON for `sms_bulk_jobs.report_context` (user-specific audience for reports).
 */
function normalizeReportContextForInsert(source, raw) {
  if (String(source) !== 'user_specific_leads' || raw == null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const studentGroup =
    raw.studentGroup != null && String(raw.studentGroup).trim() !== '' ? String(raw.studentGroup).trim().slice(0, 200) : null;
  const district = raw.district != null && String(raw.district).trim() !== '' ? String(raw.district).trim().slice(0, 200) : null;
  const su = Array.isArray(raw.selectedUsers) ? raw.selectedUsers : [];
  const selectedUsers = su
    .map((u) => {
      const id = u?.id != null ? String(u.id).trim() : '';
      // Leads in this app use UUIDs (36 chars). User roster ids are often MongoDB ObjectId (24 hex) or other strings.
      if (id.length < 1 || id.length > 200) return null;
      if (/[\n\r\0]/.test(id)) return null;
      const name = u?.name != null ? String(u.name).trim().slice(0, 300) : '';
      return { id, name: name || id };
    })
    .filter(Boolean)
    .slice(0, 500);
  const out = { version: 1, studentGroup, district, selectedUsers };
  const json = JSON.stringify(out);
  if (json.length > 65000) {
    return JSON.stringify({ version: 1, studentGroup, district, selectedUsers: selectedUsers.slice(0, 50), _truncated: true });
  }
  return out;
}

export function scheduleProcessSmsBulkJob(jobId) {
  setImmediate(() => {
    processSmsBulkJob(jobId).catch((err) => {
      console.error('[SMS bulk job] Fatal', jobId, err);
    });
  });
}

/**
 * Call once after a deploy/restart. The old Node process is gone; in-memory work is lost but DB rows remain.
 * - Puts all `processing` line items for `running` jobs back to `pending` (they are retried, not skipped).
 * - Schedules each job that still has `pending` work (`running` or `queued`).
 * Set `SMS_BULK_STARTUP_RESUME=0` in `.env` to disable. Small delay recommended so the MySQL pool is up.
 * Note: a lead that already received the SMS in the last run but crashed before the DB update could be sent
 * again (rare); prefer idempotent templates / accept rare duplicate vs losing the batch.
 */
export async function resumeRunningSmsBulkJobsOnStartup() {
  if (String(process.env.SMS_BULK_STARTUP_RESUME).toLowerCase() === '0' || String(process.env.SMS_BULK_STARTUP_RESUME).toLowerCase() === 'false') {
    console.log('[SMS bulk job] Startup resume disabled (SMS_BULK_STARTUP_RESUME=0)');
    return;
  }
  let pool;
  try {
    pool = getPool();
  } catch {
    return;
  }
  try {
    const [r1] = await pool.execute(
      `UPDATE sms_bulk_job_items i
       INNER JOIN sms_bulk_jobs j ON j.id = i.job_id
       SET i.status = 'pending', i.started_at = NULL, i.error_message = NULL, i.completed_at = NULL, i.response_text = NULL
       WHERE j.status = 'running' AND i.status = 'processing'`
    );
    const nOrphan = typeof r1.affectedRows === 'bigint' ? Number(r1.affectedRows) : (r1.affectedRows || 0);
    if (nOrphan > 0) {
      console.log(
        `[SMS bulk job] Startup: re-queued ${nOrphan} in-flight line item(s) (processing → pending after restart)`
      );
    }
    const [jobIds] = await pool.execute(
      `SELECT j.id
       FROM sms_bulk_jobs j
       WHERE j.status IN ('running', 'queued')
       AND EXISTS (SELECT 1 FROM sms_bulk_job_items i WHERE i.job_id = j.id AND i.status = 'pending')`
    );
    for (const row of jobIds) {
      const id = String(row.id);
      console.log(`[SMS bulk job] Startup: queue processor for job ${id}`);
      scheduleProcessSmsBulkJob(id);
    }
    if (jobIds.length > 0) {
      console.log(`[SMS bulk job] Startup: re-scheduled ${jobIds.length} job(s) with pending SMS`);
    }
  } catch (e) {
    console.error('[SMS bulk job] Startup resume failed (non-fatal):', e?.message || e);
  }
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
    const out = await withTimeout(
      executeSmsSendForLead(pool, userId, leadId, nums, [
        { templateId, variables: Array.isArray(variables) ? variables : [] },
      ]),
      SMS_ITEM_MAX_MS,
      'executeSmsSendForLead'
    );
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
    const [uDone] = await pool.execute(
      `UPDATE sms_bulk_job_items SET
        status = ?,
        response_text = ?,
        error_message = ?,
        communication_ids = ?,
        provider_message_ids = ?,
        completed_at = NOW() WHERE id = ? AND status = 'processing'`,
      [
        anyOk ? 'success' : 'failed',
        respText,
        errMsg,
        JSON.stringify(out.savedCommunicationIds || []),
        JSON.stringify(mids),
        itemId,
      ]
    );
    if (uDone.affectedRows > 0) {
      const failC = anyOk ? 0 : 1;
      const succC = anyOk ? 1 : 0;
      await pool.execute(
        `UPDATE sms_bulk_jobs SET
          done_count = done_count + 1,
          success_count = success_count + ?,
          fail_count = fail_count + ? WHERE id = ?`,
        [succC, failC, jobId]
      );
    }
  } catch (e) {
    const msg = (e?.message || 'Unknown error').slice(0, 2000);
    const [fRows] = await pool.execute(
      `UPDATE sms_bulk_job_items
       SET status = 'failed', error_message = ?, response_text = NULL, completed_at = NOW()
       WHERE id = ? AND status = 'processing'`,
      [msg, itemId]
    );
    if (fRows.affectedRows > 0) {
      await pool.execute(
        `UPDATE sms_bulk_jobs SET done_count = done_count + 1, fail_count = fail_count + 1, last_error = ? WHERE id = ?`,
        [msg, jobId]
      );
    }
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} jobId
 */
export async function reconcileJobCountersFromItems(pool, jobId) {
  const [agg] = await pool.execute(
    `SELECT
       COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),0) AS succ,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0) AS fl,
       COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END),0) AS skp
     FROM sms_bulk_job_items WHERE job_id = ?`,
    [jobId]
  );
  const row = agg[0] || { n: 0, succ: 0, fl: 0, skp: 0 };
  const n = Number(row.n) || 0;
  const succ = Number(row.succ) || 0;
  const fl = Number(row.fl) || 0;
  const skp = Number(row.skp) || 0;
  const done = succ + fl + skp;
  await pool.execute(
    `UPDATE sms_bulk_jobs SET
       success_count = ?,
       fail_count = ?,
       done_count = ?
     WHERE id = ?`,
    [succ + skp, fl, done, jobId]
  );
  return { n, successCount: succ + skp, failCount: fl, doneCount: done };
}

/**
 * Only when no pending/processing: finish as completed, or as failed (missing rows), or not yet.
 * @returns {Promise<'completed'|'not_yet'|'failed'|'inconsistent'|'noop'>}
 */
export async function tryMarkJobCompleteIfFullyProcessed(pool, jobId) {
  const [jobRows] = await pool.execute('SELECT * FROM sms_bulk_jobs WHERE id = ?', [jobId]);
  if (jobRows.length === 0) {
    return 'noop';
  }
  const job = jobRows[0];
  if (String(job.status) === 'cancelled') {
    return 'noop';
  }
  const [wRow] = await pool.execute(
    `SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ? AND status IN ('pending','processing')`,
    [jobId]
  );
  const w = Number(wRow[0]?.c) || 0;
  if (w > 0) {
    return 'not_yet';
  }
  const [nItemRow] = await pool.execute(`SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ?`, [jobId]);
  const nItem = Number(nItemRow[0]?.c) || 0;
  const totalExpected = Number(job.total_items) || 0;
  if (nItem < totalExpected) {
    const msg = `Inconsistent job: only ${nItem} line item(s) in the database, but total_items is ${totalExpected}. Cannot mark complete.`;
    await pool.execute(
      `UPDATE sms_bulk_jobs SET status = 'failed', last_error = ?, completed_at = NOW() WHERE id = ? AND status != 'cancelled'`,
      [msg, jobId]
    );
    return 'failed';
  }
  if (nItem > totalExpected) {
    const msg = 'Line item count exceeds total_items; please contact support to repair this job row.';
    await pool.execute(
      `UPDATE sms_bulk_jobs SET status = 'failed', last_error = ?, completed_at = NOW() WHERE id = ? AND status != 'cancelled'`,
      [msg, jobId]
    );
    return 'failed';
  }
  const [nTerm] = await pool.execute(
    `SELECT COUNT(*) AS c FROM sms_bulk_job_items
     WHERE job_id = ? AND status IN ('success','failed','skipped')`,
    [jobId]
  );
  if (Number(nTerm[0]?.c) < nItem) {
    return 'inconsistent';
  }
  await reconcileJobCountersFromItems(pool, jobId);
  if (nItem === 0) {
    await pool.execute(
      `UPDATE sms_bulk_jobs SET status = 'failed', last_error = 'No line items', completed_at = NOW() WHERE id = ?`,
      [jobId]
    );
    return 'failed';
  }
  await pool.execute(
    `UPDATE sms_bulk_jobs SET
       status = 'completed',
       last_error = NULL,
       completed_at = NOW()
     WHERE id = ? AND status NOT IN ('cancelled', 'failed')`,
    [jobId]
  );
  return 'completed';
}

/**
 * "Completed" in DB can be wrong: pending rows still exist. Re-open the job so the worker can continue.
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} jobId
 * @returns {Promise<boolean>} true if job was re-opened
 */
export async function reopenCompletedIfPendingWorkRemains(pool, jobId) {
  const [rows] = await pool.execute('SELECT id, status FROM sms_bulk_jobs WHERE id = ?', [jobId]);
  if (rows.length === 0) {
    return false;
  }
  if (String(rows[0].status) !== 'completed') {
    return false;
  }
  const [wRow] = await pool.execute(
    `SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ? AND status IN ('pending','processing')`,
    [jobId]
  );
  if (Number(wRow[0]?.c) < 1) {
    return false;
  }
  const [r] = await pool.execute(
    `UPDATE sms_bulk_jobs
     SET status = 'running', completed_at = NULL, last_error = NULL
     WHERE id = ? AND status = 'completed'`,
    [jobId]
  );
  const n = typeof r.affectedRows === 'bigint' ? Number(r.affectedRows) : r.affectedRows || 0;
  return n > 0;
}

export async function processSmsBulkJob(jobId) {
  if (runningJobIds.has(jobId)) {
    return;
  }
  const pool = getPool();
  const [jobRows0] = await pool.execute('SELECT * FROM sms_bulk_jobs WHERE id = ?', [jobId]);
  if (jobRows0.length === 0) {
    return;
  }
  let job = jobRows0[0];
  if (String(job.status) === 'failed' || String(job.status) === 'cancelled') {
    return;
  }
  if (String(job.status) === 'completed') {
    const reopened = await reopenCompletedIfPendingWorkRemains(pool, jobId);
    if (reopened) {
      const [j2] = await pool.execute('SELECT * FROM sms_bulk_jobs WHERE id = ?', [jobId]);
      if (j2.length > 0) {
        job = j2[0];
      }
    } else {
      // Repair a bogus "completed" (wrong counters / not enough line rows) or re-sync done counts
      await tryMarkJobCompleteIfFullyProcessed(pool, jobId);
      return;
    }
  }
  runningJobIds.add(jobId);
  try {
    if (String(job.status) === 'queued') {
      await pool.execute(`UPDATE sms_bulk_jobs SET status = 'running', started_at = NOW() WHERE id = ? AND status = 'queued'`, [jobId]);
    }
    await releaseStuckProcessingItems(pool, jobId);
    const [itemRows] = await pool.execute(
      `SELECT * FROM sms_bulk_job_items WHERE job_id = ? AND status = 'pending' ORDER BY sort_order ASC`,
      [jobId]
    );
    if (itemRows.length === 0) {
      const [wRow2] = await pool.execute(
        `SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ? AND status IN ('pending','processing')`,
        [jobId]
      );
      if (Number(wRow2[0]?.c) > 0) {
        setTimeout(() => scheduleProcessSmsBulkJob(jobId), 30_000);
        return;
      }
      const [jc] = await pool.execute(`SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ?`, [jobId]);
      if (Number(jc[0]?.c) === 0) {
        await pool.execute(
          `UPDATE sms_bulk_jobs SET status = 'failed', last_error = 'No line items', completed_at = NOW() WHERE id = ?`,
          [jobId]
        );
      } else {
        const outcome = await tryMarkJobCompleteIfFullyProcessed(pool, jobId);
        if (outcome === 'inconsistent') {
          setTimeout(() => scheduleProcessSmsBulkJob(jobId), 30_000);
        } else if (outcome === 'not_yet') {
          setTimeout(() => scheduleProcessSmsBulkJob(jobId), 30_000);
        }
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
      const outcome = await tryMarkJobCompleteIfFullyProcessed(pool, jobId);
      if (outcome === 'inconsistent' || outcome === 'not_yet') {
        const [pend2] = await pool.execute(
          `SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ? AND status = 'pending'`,
          [jobId]
        );
        if (Number(pend2[0].c) > 0) {
          scheduleProcessSmsBulkJob(jobId);
        } else {
          setTimeout(() => scheduleProcessSmsBulkJob(jobId), 30_000);
        }
      }
    } else {
      const [pend] = await pool.execute(
        `SELECT COUNT(*) AS c FROM sms_bulk_job_items WHERE job_id = ? AND status = 'pending'`,
        [jobId]
      );
      if (Number(pend[0].c) > 0) {
        scheduleProcessSmsBulkJob(jobId);
      } else {
        setTimeout(() => scheduleProcessSmsBulkJob(jobId), 30_000);
      }
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
 * @param {object} [p.reportContext] – optional, stored for `user_specific_leads` (selected users, student group, etc.)
 */
export async function createSmsBulkJobRecord({ pool, userId, source, templateId, items, reportContext: rawContext }) {
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
  const reportContext = normalizeReportContextForInsert(source, rawContext);
  await pool.execute(
    `INSERT INTO sms_bulk_jobs (
      id, created_by, source, report_context, template_id, template_name, status, total_items, done_count, success_count, fail_count
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0)`,
    [
      jobId,
      userId,
      source,
      reportContext == null ? null : JSON.stringify(reportContext),
      template.id,
      template.name,
      insItems.length,
    ]
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
  let reportContext = null;
  if (row.report_context != null && row.report_context !== '') {
    if (typeof row.report_context === 'string') {
      try {
        reportContext = JSON.parse(row.report_context);
      } catch {
        reportContext = null;
      }
    } else if (typeof row.report_context === 'object') {
      reportContext = row.report_context;
    }
  }
  const workRemaining = row.work_remaining != null ? Number(row.work_remaining) : undefined;
  const st = String(row.status);
  const done = Number(row.done_count) || 0;
  const tot = Number(row.total_items) || 0;
  const wr = workRemaining == null || Number.isNaN(workRemaining) ? 0 : workRemaining;
  const displayStatus =
    st === 'completed' && (wr > 0 || done < tot) ? 'incomplete' : st;
  return {
    id: row.id,
    source: row.source,
    reportContext,
    templateId: row.template_id,
    templateName: row.template_name,
    status: row.status,
    displayStatus,
    workRemaining,
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
