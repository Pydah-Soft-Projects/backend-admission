/**
 * Branch-based student roll numbers on the secondary student database.
 * Format: {YY}{BRANCH_PREFIX}{3-digit serial} e.g. 26DCSE001.
 * CRM manages 2026-series admissions only; older batches use legacy pin_no in SDMS.
 */

import { deriveAdmissionSeriesYear } from './lateralBatch.util.js';

/** CRM issues roll numbers only for this admission-number year prefix (e.g. 20260001). */
export const CRM_ROLL_ADMISSION_YEAR_PREFIX = '2026';

const PREFIX_FALLBACK = 'UNKN';

/** Uppercase alphanumeric branch code (spaces/punctuation stripped). */
export function normalizeBranchCodePart(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  const normalized = raw.replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  return normalized || raw.replace(/\s+/g, '');
}

/**
 * Roll-number prefix when catalog code is missing — prefer first 4 letters;
 * use longer normalized name when branches would otherwise share the same prefix.
 */
export function branchNameToPrefixFallback(branchName) {
  const letters = String(branchName ?? '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  const four = letters.slice(0, 4);
  const normalized = normalizeBranchCodePart(branchName);
  if (normalized.length > 4 && four.length === 4 && normalized !== four) {
    return normalized.length <= 8 ? normalized : normalized.slice(0, 8);
  }
  return four || normalized || PREFIX_FALLBACK;
}

/** Stable counter scope — one sequence per branch, not per shared prefix. */
export function resolveBranchScope({ managedBranchId = null, branchLabel = '' } = {}) {
  const branchId = Number.parseInt(String(managedBranchId ?? '').trim(), 10);
  if (Number.isFinite(branchId)) return `id:${branchId}`;
  const labelKey = normalizeBranchCodePart(branchLabel);
  return labelKey ? `label:${labelKey}` : 'label:UNKN';
}

export function formatStudentRollNumber(branchPrefix, serial, batch) {
  const prefix = normalizeBranchCodePart(branchPrefix) || PREFIX_FALLBACK;
  const yearSuffix = resolveRollYearSuffix(batch);
  return `${yearSuffix}${prefix}${String(serial).padStart(3, '0')}`;
}

export function parseStudentRollNumber(rollNumber) {
  const raw = String(rollNumber ?? '').trim();
  const withYear = raw.match(/^(\d{2})([A-Z0-9]+)(\d{3})$/i);
  if (withYear) {
    return {
      yearSuffix: withYear[1],
      branchPrefix: normalizeBranchCodePart(withYear[2]),
      serial: Number(withYear[3]),
    };
  }
  const legacy = raw.match(/^([A-Z0-9]+)(\d{3})$/i);
  if (!legacy) return null;
  return {
    yearSuffix: null,
    branchPrefix: normalizeBranchCodePart(legacy[1]),
    serial: Number(legacy[2]),
  };
}

/** Intake year for counters — admission number year wins over stored student.batch. */
export function resolveRollBatch({ batch, admissionNumber } = {}) {
  const fromAdmission = deriveAdmissionSeriesYear(admissionNumber);
  if (fromAdmission) return Number(fromAdmission);
  const fromBatch = String(batch ?? '').trim().match(/^(19|20)\d{2}$/);
  if (fromBatch) return Number(fromBatch[0]);
  return new Date().getFullYear();
}

/** Two-digit intake year prefix for roll numbers (2026 → 26, 2027 → 27). */
export function resolveRollYearSuffix(batch) {
  const year = Number(batch);
  if (Number.isFinite(year) && year >= 2000 && year <= 2099) {
    return String(year).slice(-2);
  }
  return String(new Date().getFullYear()).slice(-2);
}

export function isAdmissionCancelledStatus(admissionStatus) {
  return String(admissionStatus ?? '').trim().toLowerCase() === 'admission cancelled';
}

/** Roll numbers are issued only for 2026-series admission numbers (e.g. 20260001). */
export function isRollEligibleAdmissionNumber(admissionNumber) {
  return String(admissionNumber ?? '')
    .trim()
    .startsWith(CRM_ROLL_ADMISSION_YEAR_PREFIX);
}

/** CRM roll format: 26DCSE001 (2-digit year + branch + 3-digit serial). */
export function isValidCrmRollNumberFormat(rollNumber) {
  return /^26[A-Z0-9]+\d{3}$/i.test(String(rollNumber ?? '').trim());
}

/**
 * Remove CRM roll rows/counters for non-2026 batches (legacy backfill cleanup).
 * Does not touch students.pin_no or other SDMS fields.
 */
export async function purgeNonCrmStudentRollNumbers(secondaryPool) {
  await ensureStudentRollNumberTables(secondaryPool);

  const [[beforeRolls]] = await secondaryPool.execute(
    'SELECT COUNT(*) AS c FROM student_roll_numbers'
  );
  const [[beforeNonCrm]] = await secondaryPool.execute(
    `SELECT COUNT(*) AS c FROM student_roll_numbers
     WHERE admission_number NOT LIKE ? OR batch <> ?`,
    [`${CRM_ROLL_ADMISSION_YEAR_PREFIX}%`, Number(CRM_ROLL_ADMISSION_YEAR_PREFIX)]
  );

  const [delRolls] = await secondaryPool.execute(
    `DELETE FROM student_roll_numbers
     WHERE admission_number NOT LIKE ? OR batch <> ?`,
    [`${CRM_ROLL_ADMISSION_YEAR_PREFIX}%`, Number(CRM_ROLL_ADMISSION_YEAR_PREFIX)]
  );

  const [delCounters] = await secondaryPool.execute(
    'DELETE FROM student_roll_counters WHERE batch <> ?',
    [Number(CRM_ROLL_ADMISSION_YEAR_PREFIX)]
  );

  const [[afterRolls]] = await secondaryPool.execute(
    'SELECT COUNT(*) AS c FROM student_roll_numbers'
  );

  return {
    crmYear: CRM_ROLL_ADMISSION_YEAR_PREFIX,
    removedRollRows: Number(delRolls.affectedRows || 0),
    removedCounterRows: Number(delCounters.affectedRows || 0),
    removedLegacyFormatRows: 0,
    rollRowsBefore: Number(beforeRolls.c),
    nonCrmRollRowsBefore: Number(beforeNonCrm.c),
    rollRowsAfter: Number(afterRolls.c),
  };
}

/**
 * Remove 2026 rows that use legacy format (e.g. DCSE001 instead of 26DCSE001).
 */
export async function purgeLegacyFormatCrmRollNumbers(secondaryPool) {
  await ensureStudentRollNumberTables(secondaryPool);

  const [legacy] = await secondaryPool.execute(
    `SELECT id, admission_number, roll_number FROM student_roll_numbers
     WHERE batch = ? AND roll_number NOT REGEXP ?`,
    [Number(CRM_ROLL_ADMISSION_YEAR_PREFIX), '^26[A-Z0-9]+[0-9]{3}$']
  );

  if (legacy.length === 0) {
    return { removedLegacyFormatRows: 0, removed: [] };
  }

  const [del] = await secondaryPool.execute(
    `DELETE FROM student_roll_numbers
     WHERE batch = ? AND roll_number NOT REGEXP ?`,
    [Number(CRM_ROLL_ADMISSION_YEAR_PREFIX), '^26[A-Z0-9]+[0-9]{3}$']
  );

  return {
    removedLegacyFormatRows: Number(del.affectedRows || 0),
    removed: legacy,
  };
}

/**
 * Resolve branch prefix: managed branch id catalog wins over students.branch label.
 */
export async function resolveBranchPrefixForRollNumber(
  secondaryPool,
  { managedBranchId = null, branchLabel = '' } = {}
) {
  const branchId = Number.parseInt(String(managedBranchId ?? '').trim(), 10);
  if (Number.isFinite(branchId)) {
    try {
      const [rows] = await secondaryPool.execute(
        'SELECT name, code FROM course_branches WHERE id = ? LIMIT 1',
        [branchId]
      );
      if (rows.length > 0) {
        const code = normalizeBranchCodePart(rows[0].code);
        if (code) return { prefix: code, managedBranchId: branchId };
        const fromName = branchNameToPrefixFallback(rows[0].name);
        if (fromName !== PREFIX_FALLBACK) {
          return { prefix: fromName, managedBranchId: branchId };
        }
      }
    } catch (err) {
      console.warn('[student-roll] course_branches lookup by id failed:', err?.message || err);
    }
  }

  const label = String(branchLabel ?? '').trim();
  if (label) {
    try {
      const [rows] = await secondaryPool.execute(
        `SELECT id, name, code FROM course_branches
         WHERE TRIM(name) = ? OR TRIM(code) = ? OR UPPER(TRIM(name)) = UPPER(?)
         ORDER BY id ASC
         LIMIT 1`,
        [label, label, label]
      );
      if (rows.length > 0) {
        const code = normalizeBranchCodePart(rows[0].code);
        if (code) {
          return { prefix: code, managedBranchId: rows[0].id };
        }
        const fromName = branchNameToPrefixFallback(rows[0].name);
        if (fromName !== PREFIX_FALLBACK) {
          return { prefix: fromName, managedBranchId: rows[0].id };
        }
      }
    } catch (err) {
      console.warn('[student-roll] course_branches lookup by label failed:', err?.message || err);
    }
  }

  return {
    prefix: branchNameToPrefixFallback(label),
    managedBranchId: Number.isFinite(branchId) ? branchId : null,
  };
}

async function ensureRollCounterSchema(secondaryPool) {
  const [cols] = await secondaryPool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'student_roll_counters'`
  );
  const colSet = new Set(cols.map((c) => c.COLUMN_NAME));
  if (!colSet.has('branch_scope')) {
    await secondaryPool.execute(
      `ALTER TABLE student_roll_counters
       ADD COLUMN branch_scope VARCHAR(64) NOT NULL DEFAULT '' AFTER branch_prefix`
    );
    await secondaryPool.execute(
      `UPDATE student_roll_counters
       SET branch_scope = CONCAT('legacy:', branch_prefix)
       WHERE branch_scope = '' OR branch_scope IS NULL`
    );
    const [pkRows] = await secondaryPool.execute(
      `SHOW KEYS FROM student_roll_counters WHERE Key_name = 'PRIMARY'`
    );
    const pkCols = pkRows.map((r) => r.Column_name);
    if (pkCols.includes('branch_prefix') && !pkCols.includes('branch_scope')) {
      await secondaryPool.execute('ALTER TABLE student_roll_counters DROP PRIMARY KEY');
      await secondaryPool.execute(
        'ALTER TABLE student_roll_counters ADD PRIMARY KEY (batch, branch_scope)'
      );
    }
  }

  const [rollCols] = await secondaryPool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'student_roll_numbers'`
  );
  const rollColSet = new Set(rollCols.map((c) => c.COLUMN_NAME));
  if (!rollColSet.has('branch_scope')) {
    await secondaryPool.execute(
      `ALTER TABLE student_roll_numbers
       ADD COLUMN branch_scope VARCHAR(64) NULL AFTER branch_prefix`
    );
  }
}

async function ensureRollCounterRow(connection, batch, branchScope) {
  const scope = String(branchScope || '').trim() || 'label:UNKN';
  await connection.execute(
    `INSERT INTO student_roll_counters (batch, branch_prefix, branch_scope, last_serial)
     VALUES (?, '', ?, 0)
     ON DUPLICATE KEY UPDATE batch = batch`,
    [batch, scope]
  );
  const [rows] = await connection.execute(
    `SELECT last_serial FROM student_roll_counters
     WHERE batch = ? AND branch_scope = ?
     FOR UPDATE`,
    [batch, scope]
  );
  return {
    batch,
    branchScope: scope,
    lastSerial: Number(rows[0]?.last_serial || 0),
  };
}

/** Avoid duplicate roll strings when catalog has multiple branches with the same prefix. */
async function buildUniqueRollNumber(
  connection,
  { batch, branchScope, prefix, serial, managedBranchId }
) {
  let rollNumber = formatStudentRollNumber(prefix, serial, batch);
  const [conflicts] = await connection.execute(
    `SELECT branch_scope FROM student_roll_numbers
     WHERE batch = ? AND roll_number = ? AND branch_scope <> ?
     LIMIT 1`,
    [batch, rollNumber, branchScope]
  );
  const branchId = Number.parseInt(String(managedBranchId ?? '').trim(), 10);
  if (conflicts.length > 0 && Number.isFinite(branchId)) {
    const scopedPrefix = `${normalizeBranchCodePart(prefix) || PREFIX_FALLBACK}${branchId}`;
    rollNumber = formatStudentRollNumber(scopedPrefix, serial, batch);
  }
  return rollNumber;
}

/** Remove roll number when admission is cancelled or being re-sequenced. */
export async function revokeStudentRollNumber(
  secondaryPool,
  { studentId = null, admissionNumber = null } = {}
) {
  const admission = String(admissionNumber ?? '').trim();
  const sid = Number.parseInt(String(studentId ?? '').trim(), 10);
  if (!admission && !Number.isFinite(sid)) return { revoked: false };

  await ensureStudentRollNumberTables(secondaryPool);

  if (Number.isFinite(sid)) {
    const [result] = await secondaryPool.execute(
      'DELETE FROM student_roll_numbers WHERE student_id = ?',
      [sid]
    );
    return { revoked: Number(result.affectedRows || 0) > 0 };
  }

  const [result] = await secondaryPool.execute(
    'DELETE FROM student_roll_numbers WHERE admission_number = ?',
    [admission]
  );
  return { revoked: Number(result.affectedRows || 0) > 0 };
}

/**
 * Assign or return existing roll number for a secondary student row.
 * Safe to call repeatedly — existing assignment is returned unchanged.
 */
export async function assignStudentRollNumber(
  secondaryPool,
  {
    studentId,
    admissionNumber,
    managedBranchId = null,
    branchLabel = '',
    batch = null,
    admissionStatus = null,
    force = false,
  } = {}
) {
  const admission = String(admissionNumber ?? '').trim();
  const sid = Number.parseInt(String(studentId ?? '').trim(), 10);
  if (!admission || !Number.isFinite(sid)) {
    throw new Error('studentId and admissionNumber are required to assign a roll number.');
  }

  if (!isRollEligibleAdmissionNumber(admission)) {
    return { roll_number: null, assigned: false, skipped: true, reason: 'not_2026_admission' };
  }

  await ensureStudentRollNumberTables(secondaryPool);
  await ensureRollCounterSchema(secondaryPool);

  if (isAdmissionCancelledStatus(admissionStatus)) {
    const revoked = await revokeStudentRollNumber(secondaryPool, { studentId: sid, admissionNumber: admission });
    return { roll_number: null, assigned: false, revoked: revoked.revoked, reason: 'admission_cancelled' };
  }

  if (!force) {
    const [existing] = await secondaryPool.execute(
      `SELECT roll_number, branch_prefix, branch_scope, serial, batch, managed_branch_id
       FROM student_roll_numbers
       WHERE student_id = ?
       LIMIT 1`,
      [sid]
    );
    if (existing.length > 0) {
      const row = existing[0];
      const validFormat =
        isValidCrmRollNumberFormat(row.roll_number) &&
        Number(row.batch) === Number(CRM_ROLL_ADMISSION_YEAR_PREFIX);
      if (!force && validFormat) {
        return {
          roll_number: row.roll_number,
          branch_prefix: row.branch_prefix,
          branch_scope: row.branch_scope,
          serial: Number(row.serial),
          batch: Number(row.batch),
          managed_branch_id: row.managed_branch_id,
          assigned: false,
        };
      }
      await revokeStudentRollNumber(secondaryPool, { studentId: sid, admissionNumber: admission });
    }
  } else {
    await revokeStudentRollNumber(secondaryPool, { studentId: sid, admissionNumber: admission });
  }

  const resolvedBatch = resolveRollBatch({ batch, admissionNumber: admission });
  const { prefix, managedBranchId: resolvedManagedBranchId } =
    await resolveBranchPrefixForRollNumber(secondaryPool, {
      managedBranchId,
      branchLabel,
    });
  const branchScope = resolveBranchScope({
    managedBranchId: resolvedManagedBranchId ?? managedBranchId,
    branchLabel: resolvedManagedBranchId ? null : branchLabel,
  });

  const connection = await secondaryPool.getConnection();
  try {
    await connection.beginTransaction();

    const counter = await ensureRollCounterRow(connection, resolvedBatch, branchScope);
    const nextSerial = counter.lastSerial + 1;
    const rollNumber = await buildUniqueRollNumber(connection, {
      batch: counter.batch,
      branchScope: counter.branchScope,
      prefix,
      serial: nextSerial,
      managedBranchId: resolvedManagedBranchId,
    });

    await connection.execute(
      `UPDATE student_roll_counters
       SET last_serial = ?, branch_prefix = ?
       WHERE batch = ? AND branch_scope = ?`,
      [nextSerial, prefix, counter.batch, counter.branchScope]
    );

    await connection.execute(
      `INSERT INTO student_roll_numbers (
         student_id, admission_number, roll_number, branch_prefix, branch_scope,
         serial, batch, managed_branch_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sid,
        admission,
        rollNumber,
        normalizeBranchCodePart(prefix) || PREFIX_FALLBACK,
        counter.branchScope,
        nextSerial,
        counter.batch,
        resolvedManagedBranchId,
      ]
    );

    await connection.commit();

    return {
      roll_number: rollNumber,
      branch_prefix: normalizeBranchCodePart(prefix) || PREFIX_FALLBACK,
      branch_scope: counter.branchScope,
      serial: nextSerial,
      batch: counter.batch,
      managed_branch_id: resolvedManagedBranchId,
      assigned: true,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

let tablesEnsured = false;

/** Create roll-number tables when missing (idempotent). */
export async function ensureStudentRollNumberTables(secondaryPool) {
  if (tablesEnsured) return;
  await secondaryPool.execute(`
    CREATE TABLE IF NOT EXISTS student_roll_counters (
      batch SMALLINT UNSIGNED NOT NULL COMMENT 'Intake calendar year e.g. 2026',
      branch_scope VARCHAR(64) NOT NULL COMMENT 'Stable branch key id:N or label:NAME',
      branch_prefix VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'Last issued prefix for reference',
      last_serial INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (batch, branch_scope)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await secondaryPool.execute(`
    CREATE TABLE IF NOT EXISTS student_roll_numbers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      student_id BIGINT UNSIGNED NOT NULL,
      admission_number VARCHAR(50) NOT NULL,
      roll_number VARCHAR(30) NOT NULL,
      branch_prefix VARCHAR(20) NOT NULL,
      branch_scope VARCHAR(64) NULL,
      serial INT UNSIGNED NOT NULL,
      batch SMALLINT UNSIGNED NOT NULL,
      managed_branch_id INT UNSIGNED NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_student_roll_admission (admission_number),
      UNIQUE KEY uk_student_roll_student_id (student_id),
      UNIQUE KEY uk_student_roll_batch_number (batch, roll_number),
      INDEX idx_student_roll_batch_branch (batch, branch_scope)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  tablesEnsured = true;
}
