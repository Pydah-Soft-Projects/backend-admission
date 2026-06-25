/**
 * Branch-based student roll numbers on the secondary student database.
 * Format: {BRANCH_PREFIX}{3-digit serial} e.g. CSE001, AGRD042.
 * Serial resets per intake batch + branch prefix.
 */

import { deriveAdmissionSeriesYear } from './lateralBatch.util.js';

const PREFIX_FALLBACK = 'UNKN';

/** Uppercase alphanumeric branch code (spaces/punctuation stripped). */
export function normalizeBranchCodePart(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  const normalized = raw.replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  return normalized || raw.replace(/\s+/g, '');
}

/** First four letters from branch name when catalog code is missing. */
export function branchNameToPrefixFallback(branchName) {
  const letters = String(branchName ?? '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  return letters.slice(0, 4) || PREFIX_FALLBACK;
}

export function formatStudentRollNumber(branchPrefix, serial) {
  const prefix = normalizeBranchCodePart(branchPrefix) || PREFIX_FALLBACK;
  return `${prefix}${String(serial).padStart(3, '0')}`;
}

export function parseStudentRollNumber(rollNumber) {
  const raw = String(rollNumber ?? '').trim();
  const match = raw.match(/^([A-Z0-9]+)(\d{3})$/i);
  if (!match) return null;
  return {
    branchPrefix: normalizeBranchCodePart(match[1]),
    serial: Number(match[2]),
  };
}

export function resolveRollBatch({ batch, admissionNumber } = {}) {
  const fromBatch = String(batch ?? '').trim().match(/^(19|20)\d{2}$/);
  if (fromBatch) return Number(fromBatch[0]);
  const fromAdmission = deriveAdmissionSeriesYear(admissionNumber);
  if (fromAdmission) return Number(fromAdmission);
  return new Date().getFullYear();
}

/** Roll numbers are issued only for 2026-series admission numbers (e.g. 20260001). */
export function isRollEligibleAdmissionNumber(admissionNumber) {
  return /^2026/.test(String(admissionNumber ?? '').trim());
}

/**
 * Resolve branch prefix: course_branches.code → name match → first 4 letters of branch label.
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
         WHERE name = ? OR code = ? OR UPPER(TRIM(name)) = UPPER(?)
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

async function ensureRollCounterRow(connection, batch, branchPrefix) {
  const prefix = normalizeBranchCodePart(branchPrefix) || PREFIX_FALLBACK;
  await connection.execute(
    `INSERT INTO student_roll_counters (batch, branch_prefix, last_serial)
     VALUES (?, ?, 0)
     ON DUPLICATE KEY UPDATE batch = batch`,
    [batch, prefix]
  );
  const [rows] = await connection.execute(
    `SELECT last_serial FROM student_roll_counters
     WHERE batch = ? AND branch_prefix = ?
     FOR UPDATE`,
    [batch, prefix]
  );
  return {
    batch,
    branchPrefix: prefix,
    lastSerial: Number(rows[0]?.last_serial || 0),
  };
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

  const [existing] = await secondaryPool.execute(
    `SELECT roll_number, branch_prefix, serial, batch, managed_branch_id
     FROM student_roll_numbers
     WHERE student_id = ? OR admission_number = ?
     LIMIT 1`,
    [sid, admission]
  );
  if (existing.length > 0) {
    return {
      roll_number: existing[0].roll_number,
      branch_prefix: existing[0].branch_prefix,
      serial: Number(existing[0].serial),
      batch: Number(existing[0].batch),
      managed_branch_id: existing[0].managed_branch_id,
      assigned: false,
    };
  }

  const resolvedBatch = resolveRollBatch({ batch, admissionNumber: admission });
  const { prefix, managedBranchId: resolvedManagedBranchId } =
    await resolveBranchPrefixForRollNumber(secondaryPool, {
      managedBranchId,
      branchLabel,
    });

  const connection = await secondaryPool.getConnection();
  try {
    await connection.beginTransaction();

    const counter = await ensureRollCounterRow(connection, resolvedBatch, prefix);
    const nextSerial = counter.lastSerial + 1;
    const rollNumber = formatStudentRollNumber(counter.branchPrefix, nextSerial);

    await connection.execute(
      `UPDATE student_roll_counters
       SET last_serial = ?
       WHERE batch = ? AND branch_prefix = ?`,
      [nextSerial, counter.batch, counter.branchPrefix]
    );

    await connection.execute(
      `INSERT INTO student_roll_numbers (
         student_id, admission_number, roll_number, branch_prefix, serial, batch, managed_branch_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sid,
        admission,
        rollNumber,
        counter.branchPrefix,
        nextSerial,
        counter.batch,
        resolvedManagedBranchId,
      ]
    );

    await connection.commit();

    return {
      roll_number: rollNumber,
      branch_prefix: counter.branchPrefix,
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
      batch SMALLINT UNSIGNED NOT NULL,
      branch_prefix VARCHAR(20) NOT NULL,
      last_serial INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (batch, branch_prefix)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await secondaryPool.execute(`
    CREATE TABLE IF NOT EXISTS student_roll_numbers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      student_id BIGINT UNSIGNED NOT NULL,
      admission_number VARCHAR(50) NOT NULL,
      roll_number VARCHAR(30) NOT NULL,
      branch_prefix VARCHAR(20) NOT NULL,
      serial INT UNSIGNED NOT NULL,
      batch SMALLINT UNSIGNED NOT NULL,
      managed_branch_id INT UNSIGNED NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_student_roll_admission (admission_number),
      UNIQUE KEY uk_student_roll_student_id (student_id),
      UNIQUE KEY uk_student_roll_batch_number (batch, roll_number),
      INDEX idx_student_roll_batch_branch (batch, branch_prefix)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  tablesEnsured = true;
}
