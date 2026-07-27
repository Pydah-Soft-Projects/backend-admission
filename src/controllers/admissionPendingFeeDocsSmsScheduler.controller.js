import { successResponse, errorResponse } from '../utils/response.util.js';
import {
  getAdmissionPendingFeeDocsSmsSchedulerConfig,
  upsertAdmissionPendingFeeDocsSmsSchedulerConfigAndReschedule,
} from '../services/admissionPendingFeeDocsSmsScheduler.service.js';

function pad2(n) {
  return String(n ?? '0').padStart(2, '0');
}

function toTimeString(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '09:00';
  return `${pad2(h)}:${pad2(m)}`;
}

export const getAdmissionPendingFeeDocsSmsScheduler = async (req, res) => {
  try {
    const row = await getAdmissionPendingFeeDocsSmsSchedulerConfig();
    const out = {
      id: row.id,
      enabled: Boolean(row._enabled),
      period: row._period === 'pm' ? 'pm' : 'am',
      time: toTimeString(row._hour, row._minute),
      lastRunDate: row._last_run_date || null,
      updatedAt: row.updated_at || row.created_at || null,
    };
    return successResponse(res, out, 'Pending fee & documents SMS scheduler config retrieved', 200);
  } catch (e) {
    return errorResponse(res, e?.message || 'Failed to get scheduler config', 500);
  }
};

export const upsertAdmissionPendingFeeDocsSmsScheduler = async (req, res) => {
  try {
    const { enabled, period, time } = req.body || {};
    if (!time) return errorResponse(res, 'time is required', 400);
    const periodNorm = String(period || '').trim().toLowerCase() === 'pm' ? 'pm' : 'am';

    const updated = await upsertAdmissionPendingFeeDocsSmsSchedulerConfigAndReschedule({
      enabled: Boolean(enabled),
      period: periodNorm,
      time: String(time),
    });

    return successResponse(
      res,
      { ok: true, id: updated.id },
      'Scheduler config saved. Once-daily worker rescheduled.',
      200
    );
  } catch (e) {
    console.error('upsertAdmissionPendingFeeDocsSmsScheduler', e);
    return errorResponse(res, e?.message || 'Failed to save scheduler config', 500);
  }
};
