import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';

const TZ_IST = 'Asia/Kolkata';
const SINGLETON_SCHEDULER_ID = '00000000-0000-0000-0000-000000000001';

function makeFakeRes() {
  return {
    status: () => ({
      json: (payload) => payload,
    }),
  };
}

/** Lazy-load admission controller handlers to avoid circular init issues. */
async function loadAdmissionSmsHandlers() {
  const mod = await import('../controllers/admission.controller.js');
  return {
    sendDocumentNotificationSmsBulk: mod.sendDocumentNotificationSmsBulk,
    listPendingFees: mod.listPendingFees,
    listPendingCertificates: mod.listPendingCertificates,
  };
}

function formatDateIST(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function istHms(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_IST,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const n = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { h: n('hour'), m: n('minute'), s: n('second') };
}

function istMatchesWallTime(d, hour, minute) {
  const { h, m, s } = istHms(d);
  return h === hour && m === minute && s === 0;
}

/** Next run at `hour`:`minute`:00 Asia/Kolkata (strictly after `from`). */
function msUntilNextWallTimeIST(from, hour, minute) {
  const start = from.getTime();
  let t = Math.floor(start / 1000) * 1000 + 1000;
  const limit = t + 2 * 24 * 60 * 60 * 1000;
  while (t <= limit) {
    const d = new Date(t);
    if (istMatchesWallTime(d, hour, minute) && d.getTime() > start) {
      return Math.max(d.getTime() - start, 1000);
    }
    t += 1000;
  }
  return 24 * 60 * 60 * 1000;
}

function normalizeLower(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}

function normalizePeriod(raw) {
  return String(raw || '').trim().toLowerCase() === 'pm' ? 'pm' : 'am';
}

/**
 * Parse HH:MM and clamp into the selected 12-hour window.
 * AM → 00:00–11:59, PM → 12:00–23:59.
 */
function normalizeTimeForPeriod(timeStr, period) {
  const s = String(timeStr ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  let hour = period === 'pm' ? 17 : 9;
  let minute = 0;
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (Number.isFinite(h) && h >= 0 && h <= 23 && Number.isFinite(min) && min >= 0 && min <= 59) {
      hour = h;
      minute = min;
    }
  }

  if (period === 'am') {
    if (hour >= 12) hour = hour % 12; // 13:00 → 01:00 style fallback into AM
  } else if (hour < 12) {
    hour = hour + 12; // 9:00 with PM → 21:00
  }

  return { hour, minute, period };
}

function resolveMinimumFeeAmount(configs, match) {
  if (!Array.isArray(configs) || configs.length === 0) return 0;

  const quota = normalizeLower(match?.quota);
  const courseId = String(match?.courseId ?? '').trim();
  const collegeId = String(match?.collegeId ?? '').trim();
  const courseName = normalizeLower(match?.courseName);
  const branchId = String(match?.branchId ?? '').trim();
  const branchName = normalizeLower(match?.branchName);

  if (collegeId && courseId && branchId && quota) {
    const exact = configs.find(
      (c) =>
        String(c.collegeId ?? '').trim() === collegeId &&
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === branchId &&
        normalizeLower(c.quota) === quota
    );
    if (exact) return Number(exact.amount) || 0;
  }

  if (courseId && branchId && quota) {
    const byCourseId = configs.find(
      (c) =>
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === branchId &&
        normalizeLower(c.quota) === quota
    );
    if (byCourseId) return Number(byCourseId.amount) || 0;
  }

  if (courseName && branchName && quota) {
    const byCourseName = configs.find(
      (c) =>
        normalizeLower(c.courseName) === courseName &&
        normalizeLower(c.branchName) === branchName &&
        normalizeLower(c.quota) === quota
    );
    if (byCourseName) return Number(byCourseName.amount) || 0;
  }

  if (branchId && quota) {
    const byBranch = configs.filter(
      (c) => String(c.branchId ?? '').trim() === branchId && normalizeLower(c.quota) === quota
    );
    if (byBranch.length === 1) return Number(byBranch[0].amount) || 0;
  }

  if (collegeId && courseId && quota) {
    const courseLevel = configs.find(
      (c) =>
        String(c.collegeId ?? '').trim() === collegeId &&
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === '' &&
        normalizeLower(c.quota) === quota
    );
    if (courseLevel) return Number(courseLevel.amount) || 0;
  }

  if (courseId && quota) {
    const byCourse = configs.find(
      (c) =>
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === '' &&
        normalizeLower(c.quota) === quota
    );
    if (byCourse) return Number(byCourse.amount) || 0;
  }

  if (courseName && quota) {
    const byCourseName = configs.find(
      (c) =>
        normalizeLower(c.courseName) === courseName &&
        String(c.branchId ?? '').trim() === '' &&
        normalizeLower(c.quota) === quota
    );
    if (byCourseName) return Number(byCourseName.amount) || 0;
  }

  return 0;
}

const FEE_UNPAID_TOLERANCE = 0.5;

function resolvePendingFeeAmounts(row, minimumFeeConfigs, matchContext) {
  const totalPaid = Number(row?.totalPaid ?? row?.tuitionPaid ?? 0) || 0;
  const fullPayable =
    Number(row?.totalPayable ?? Number(row?.tuitionPayable || 0) + Number(row?.otherPayable || 0)) ||
    0;

  const minimumFeeRequired = resolveMinimumFeeAmount(minimumFeeConfigs, {
    collegeId: matchContext?.collegeId,
    courseId: matchContext?.courseId,
    courseName: matchContext?.courseName ?? row?.course,
    branchId: matchContext?.branchId,
    branchName: matchContext?.branchName ?? row?.branch,
    quota: row?.quota ?? matchContext?.quota,
  });

  const usingMinFee = minimumFeeRequired > FEE_UNPAID_TOLERANCE;
  const requiredAmount = usingMinFee ? minimumFeeRequired : fullPayable;
  const unpaid = usingMinFee
    ? Math.max(requiredAmount - totalPaid, 0)
    : Number(row?.totalPending ?? Math.max(fullPayable - totalPaid, 0)) || 0;

  return { unpaid, usingMinFee, minimumFeeRequired };
}

function isFeeStillPending(row, minimumFeeConfigs, matchContext) {
  if (!Array.isArray(minimumFeeConfigs) || minimumFeeConfigs.length === 0) {
    return row?.feeStatus === 'unpaid' || Number(row?.totalPending || 0) > FEE_UNPAID_TOLERANCE;
  }

  const { unpaid, usingMinFee } = resolvePendingFeeAmounts(row, minimumFeeConfigs, matchContext);
  if (usingMinFee) return unpaid > FEE_UNPAID_TOLERANCE;
  return false;
}

/**
 * Config shape used by API / worker:
 * - enabled: one daily job on/off
 * - period: 'am' | 'pm' (12-hour window)
 * - hour/minute: wall clock within that window
 * - last_run_date: once-per-day guard
 *
 * Stored in existing columns for compatibility:
 *   enabled_am / enabled_pm (mutually exclusive when enabled)
 *   am_* or pm_* for the active time
 *   last_run_date_am as the single last-run marker
 */
function configFromRow(row) {
  const enabledPm = Boolean(row.enabled_pm);
  const enabledAm = Boolean(row.enabled_am);
  const enabled = enabledAm || enabledPm;
  const period = enabledPm && !enabledAm ? 'pm' : 'am';
  const hour = period === 'pm' ? Number(row.pm_hour) || 17 : Number(row.am_hour) || 9;
  const minute = period === 'pm' ? Number(row.pm_minute) || 0 : Number(row.am_minute) || 0;
  const lastRun =
    row.last_run_date_am != null
      ? row.last_run_date_am
      : row.last_run_date_pm != null
        ? row.last_run_date_pm
        : null;

  return {
    ...row,
    _enabled: enabled,
    _period: period,
    _hour: hour,
    _minute: minute,
    _last_run_date: lastRun,
  };
}

async function ensureAdmissionPendingSmsSchedulerTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admission_pending_fee_documents_sms_scheduler (
      id CHAR(36) PRIMARY KEY,
      enabled_am BOOLEAN NOT NULL DEFAULT FALSE,
      enabled_pm BOOLEAN NOT NULL DEFAULT FALSE,
      am_hour INT NOT NULL DEFAULT 9 CHECK (am_hour >= 0 AND am_hour <= 23),
      am_minute INT NOT NULL DEFAULT 0 CHECK (am_minute >= 0 AND am_minute <= 59),
      pm_hour INT NOT NULL DEFAULT 17 CHECK (pm_hour >= 0 AND pm_hour <= 23),
      pm_minute INT NOT NULL DEFAULT 0 CHECK (pm_minute >= 0 AND pm_minute <= 59),

      scope_college_id VARCHAR(64) NULL,
      scope_course_id VARCHAR(64) NULL,
      scope_course_name VARCHAR(255) NULL,
      scope_branch_id VARCHAR(64) NULL,
      scope_branch_name VARCHAR(255) NULL,
      scope_start_date VARCHAR(32) NULL,
      scope_end_date VARCHAR(32) NULL,

      last_run_date_am DATE NULL,
      last_run_date_pm DATE NULL,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

async function loadSchedulerConfig(pool) {
  await ensureAdmissionPendingSmsSchedulerTable(pool);
  const [rows] = await pool.execute(
    'SELECT * FROM admission_pending_fee_documents_sms_scheduler WHERE id = ?',
    [SINGLETON_SCHEDULER_ID]
  );
  if (rows.length > 0) return configFromRow(rows[0]);

  await pool.execute(
    `INSERT INTO admission_pending_fee_documents_sms_scheduler
      (id, enabled_am, enabled_pm, am_hour, am_minute, pm_hour, pm_minute)
     VALUES (?, FALSE, FALSE, 9, 0, 17, 0)`,
    [SINGLETON_SCHEDULER_ID]
  );
  const [rows2] = await pool.execute(
    'SELECT * FROM admission_pending_fee_documents_sms_scheduler WHERE id = ?',
    [SINGLETON_SCHEDULER_ID]
  );
  return configFromRow(rows2[0]);
}

async function upsertSchedulerConfig(pool, { enabled, period, time }) {
  const periodNorm = normalizePeriod(period);
  const { hour, minute } = normalizeTimeForPeriod(time, periodNorm);
  const isEnabled = Boolean(enabled);
  const enabledAm = isEnabled && periodNorm === 'am';
  const enabledPm = isEnabled && periodNorm === 'pm';

  await ensureAdmissionPendingSmsSchedulerTable(pool);

  // One daily job only — clear scopes and dual last-run markers.
  await pool.execute(
    `INSERT INTO admission_pending_fee_documents_sms_scheduler
      (id, enabled_am, enabled_pm, am_hour, am_minute, pm_hour, pm_minute,
       scope_college_id, scope_course_id, scope_course_name,
       scope_branch_id, scope_branch_name, scope_start_date, scope_end_date,
       last_run_date_am, last_run_date_pm)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
     ON DUPLICATE KEY UPDATE
       enabled_am = VALUES(enabled_am),
       enabled_pm = VALUES(enabled_pm),
       am_hour = VALUES(am_hour),
       am_minute = VALUES(am_minute),
       pm_hour = VALUES(pm_hour),
       pm_minute = VALUES(pm_minute),
       scope_college_id = NULL,
       scope_course_id = NULL,
       scope_course_name = NULL,
       scope_branch_id = NULL,
       scope_branch_name = NULL,
       scope_start_date = NULL,
       scope_end_date = NULL,
       last_run_date_am = NULL,
       last_run_date_pm = NULL
    `,
    [
      SINGLETON_SCHEDULER_ID,
      enabledAm,
      enabledPm,
      periodNorm === 'am' ? hour : 9,
      periodNorm === 'am' ? minute : 0,
      periodNorm === 'pm' ? hour : 17,
      periodNorm === 'pm' ? minute : 0,
    ]
  );

  return loadSchedulerConfig(pool);
}

async function loadMinimumFeeConfigs(pool) {
  try {
    const [rows] = await pool.execute(
      `SELECT id, college_id, college_name, course_id, course_name, quota, amount
       FROM admission_minimum_fee_configs
       ORDER BY college_name ASC, course_name ASC, quota ASC`
    );
    return (rows || []).map((r) => ({
      id: r.id,
      collegeId: String(r.college_id ?? ''),
      collegeName: String(r.college_name ?? ''),
      courseId: String(r.course_id ?? ''),
      courseName: String(r.course_name ?? ''),
      branchId: String(r.branch_id ?? ''),
      branchName: String(r.branch_name ?? ''),
      quota: String(r.quota ?? ''),
      amount: Number(r.amount) || 0,
    }));
  } catch {
    return [];
  }
}

async function loadAdmissionMeta(pool, admissionIds) {
  if (!admissionIds || admissionIds.length === 0) return new Map();
  const out = new Map();
  const CHUNK = 500;
  const managedCourseIds = new Set();

  for (let i = 0; i < admissionIds.length; i += CHUNK) {
    const chunk = admissionIds.slice(i, i + CHUNK);
    const inMarks = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT id, managed_course_id, course_id, managed_branch_id, branch_id, course, branch
       FROM admissions
       WHERE id IN (${inMarks})`,
      chunk
    );
    for (const r of rows || []) {
      const managedCourseId = String(r.managed_course_id ?? '').trim();
      if (managedCourseId) managedCourseIds.add(managedCourseId);
      out.set(String(r.id), {
        collegeId: '',
        courseId: managedCourseId || String(r.course_id ?? '').trim(),
        branchId: String(r.managed_branch_id ?? r.branch_id ?? '').trim(),
        courseName: String(r.course ?? ''),
        branchName: String(r.branch ?? ''),
        managedCourseId,
      });
    }
  }

  if (managedCourseIds.size > 0) {
    try {
      const secondaryPool = getSecondaryPool();
      const ids = Array.from(managedCourseIds);
      const collegeByCourseId = new Map();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const inMarks = chunk.map(() => '?').join(',');
        const [courseRows] = await secondaryPool.execute(
          `SELECT id, college_id FROM courses WHERE id IN (${inMarks})`,
          chunk
        );
        for (const c of courseRows || []) {
          collegeByCourseId.set(String(c.id), String(c.college_id ?? '').trim());
        }
      }
      for (const meta of out.values()) {
        if (meta.managedCourseId && collegeByCourseId.has(meta.managedCourseId)) {
          meta.collegeId = collegeByCourseId.get(meta.managedCourseId) || '';
        }
      }
    } catch (e) {
      console.warn(
        '[Admission Pending SMS Scheduler] Failed to resolve college ids:',
        e?.message || e
      );
    }
  }

  return out;
}

/** Send once per day to all pending fee/docs students (no college/desk scope). */
async function dispatchDailySms({ todayYmd, configRow }) {
  const pool = getPool();
  if (!configRow._enabled) return;

  const lastRunNormalized =
    configRow._last_run_date instanceof Date
      ? formatDateIST(configRow._last_run_date)
      : String(configRow._last_run_date || '').slice(0, 10);
  if (lastRunNormalized === todayYmd) return;

  const {
    sendDocumentNotificationSmsBulk,
    listPendingFees,
    listPendingCertificates,
  } = await loadAdmissionSmsHandlers();

  const pendingQuery = { all: 'true' };
  const minFeeConfigs = await loadMinimumFeeConfigs(pool);
  const minFeeActive = minFeeConfigs.length > 0;

  const fakeRes = makeFakeRes();
  const feeOut = await listPendingFees({ query: pendingQuery }, fakeRes);
  const feeRows = feeOut?.data?.rows || [];

  let admissionIds = [];
  let pendingFeeAmountsByAdmissionId = {};

  if (minFeeActive) {
    const admissionIdsAll = feeRows.map((r) => String(r.id));
    const admissionMeta = await loadAdmissionMeta(pool, admissionIdsAll);

    const pendingFeeRows = [];
    for (const r of feeRows) {
      const admissionId = String(r.id);
      const meta = admissionMeta.get(admissionId) || {};
      const matchContext = {
        collegeId: meta.collegeId,
        courseId: meta.courseId,
        courseName: String(r.course ?? meta.courseName ?? ''),
        branchId: meta.branchId,
        branchName: String(r.branch ?? meta.branchName ?? ''),
        quota: r.quota,
      };
      if (isFeeStillPending(r, minFeeConfigs, matchContext)) {
        pendingFeeRows.push(r);
      }
    }

    admissionIds = pendingFeeRows.map((r) => String(r.id));
    pendingFeeAmountsByAdmissionId = {};
    for (const r of pendingFeeRows) {
      const admissionId = String(r.id);
      const meta = admissionMeta.get(admissionId) || {};
      const { unpaid } = resolvePendingFeeAmounts(r, minFeeConfigs, {
        collegeId: meta.collegeId,
        courseId: meta.courseId,
        courseName: String(r.course ?? meta.courseName ?? ''),
        branchId: meta.branchId,
        branchName: String(r.branch ?? meta.branchName ?? ''),
        quota: r.quota,
      });
      pendingFeeAmountsByAdmissionId[String(admissionId)] = Number(unpaid) || 0;
    }
  } else {
    const docOut = await listPendingCertificates({ query: pendingQuery }, fakeRes);
    const docRows = docOut?.data?.rows || [];
    const feeIdSet = new Set(feeRows.map((r) => String(r.id)));
    const docIdSet = new Set(docRows.map((r) => String(r.id)));
    admissionIds = Array.from(new Set([...feeIdSet, ...docIdSet]));

    pendingFeeAmountsByAdmissionId = {};
    for (const r of feeRows) {
      pendingFeeAmountsByAdmissionId[String(r.id)] = Number(r.totalPending ?? 0) || 0;
    }
  }

  if (admissionIds.length === 0) {
    console.log(`[Admission Pending SMS Scheduler] ${todayYmd}: no pending recipients`);
    return;
  }

  console.log(
    `[Admission Pending SMS Scheduler] ${todayYmd} (${String(configRow._period).toUpperCase()}): sending to ${admissionIds.length} admission(s)`
  );

  const CHUNK = 500;
  for (let i = 0; i < admissionIds.length; i += CHUNK) {
    const chunkIds = admissionIds.slice(i, i + CHUNK);
    const chunkMap = {};
    for (const id of chunkIds) {
      chunkMap[String(id)] = pendingFeeAmountsByAdmissionId[String(id)] ?? 0;
    }

    await sendDocumentNotificationSmsBulk(
      {
        body: {
          admissionIds: chunkIds,
          pendingFeeAmountsByAdmissionId: chunkMap,
        },
      },
      fakeRes
    );
  }
}

let dailyTimer = null;

export async function initAdmissionPendingFeeDocsSmsScheduler() {
  let pool;
  try {
    pool = getPool();
  } catch {
    return;
  }

  const scheduleDaily = async () => {
    const configRow = await loadSchedulerConfig(pool);
    if (dailyTimer) {
      clearTimeout(dailyTimer);
      dailyTimer = null;
    }

    if (!configRow._enabled) return;

    const delay = msUntilNextWallTimeIST(new Date(), configRow._hour, configRow._minute);
    dailyTimer = setTimeout(async () => {
      try {
        const pool2 = getPool();
        const latest = await loadSchedulerConfig(pool2);
        const todayYmd = formatDateIST(new Date());
        await dispatchDailySms({ todayYmd, configRow: latest });

        await pool2.execute(
          `UPDATE admission_pending_fee_documents_sms_scheduler
           SET last_run_date_am = ?, last_run_date_pm = NULL
           WHERE id = ?`,
          [todayYmd, SINGLETON_SCHEDULER_ID]
        );
      } catch (e) {
        console.error('[Admission Pending SMS Scheduler] daily run failed:', e?.message || e);
      } finally {
        scheduleDaily().catch((err) =>
          console.error('[Admission Pending SMS Scheduler] reschedule failed:', err?.message || err)
        );
      }
    }, delay);

    console.log(
      `[Admission Pending SMS Scheduler] Next once-daily run ${String(configRow._hour).padStart(2, '0')}:${String(configRow._minute).padStart(2, '0')} IST (${String(configRow._period).toUpperCase()} window, ~${Math.round(delay / 60000)} min)`
    );
  };

  await scheduleDaily();
}

export async function upsertAdmissionPendingFeeDocsSmsSchedulerConfigAndReschedule(payload) {
  const pool = getPool();
  const updatedConfig = await upsertSchedulerConfig(pool, payload);

  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
  await initAdmissionPendingFeeDocsSmsScheduler();
  return updatedConfig;
}

export async function getAdmissionPendingFeeDocsSmsSchedulerConfig() {
  const pool = getPool();
  return loadSchedulerConfig(pool);
}
