/**
 * Rebuild 2026 roll numbers:
 * - Sync cancelled status from primary → secondary
 * - Order by admission_number (first generated = 001) per branch
 * - Format: {YY}{BRANCH}{001} e.g. 26DCSE001
 * - Purge non-2026 CRM roll rows before rebuild
 *
 * Run: node src/scripts/repairSecondaryStudentRollNumbers2026.js [--dry-run]
 */

import dotenv from 'dotenv';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { getPool as getPrimaryPool } from '../config-sql/database.js';
import {
  assignStudentRollNumber,
  ensureStudentRollNumberTables,
  isAdmissionCancelledStatus,
  purgeNonCrmStudentRollNumbers,
  resolveBranchScope,
  resolveRollBatch,
  revokeStudentRollNumber,
} from '../utils/studentRollNumber.util.js';
import { deriveSecondaryStudentStatus } from '../utils/studentSync.util.js';

dotenv.config();

const ADMISSION_CANCELLED = 'Admission Cancelled';

function parseManagedBranchIdFromStudentData(studentData) {
  if (!studentData) return null;
  let payload = studentData;
  if (typeof studentData === 'string') {
    try {
      payload = JSON.parse(studentData);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const raw =
    payload._crm_managed_branch_id ??
    payload?.courseInfo?.branchId ??
    payload?.courseInfo?.branch_id ??
    null;
  const id = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(id) ? id : null;
}

async function loadPrimaryAdmissionStatusMap(primaryPool) {
  const [rows] = await primaryPool.execute(
    `SELECT admission_number, status FROM admissions WHERE admission_number LIKE '2026%'`
  );
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.admission_number).trim(), String(row.status || '').trim());
  }
  return map;
}

async function syncCancelledStatuses(secondaryPool, statusMap, dryRun) {
  let updated = 0;
  for (const [admissionNumber, status] of statusMap.entries()) {
    if (!isAdmissionCancelledStatus(status)) continue;
    const secondaryStatus = deriveSecondaryStudentStatus(status, null);
    if (!dryRun) {
      const [result] = await secondaryPool.execute(
        `UPDATE students SET student_status = ?, updated_at = NOW() WHERE admission_number = ?`,
        [secondaryStatus, admissionNumber]
      );
      updated += Number(result.affectedRows || 0);
      await revokeStudentRollNumber(secondaryPool, { admissionNumber });
    } else {
      updated += 1;
    }
  }
  return updated;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const secondaryPool = getSecondaryPool();
  const primaryPool = getPrimaryPool();
  await ensureStudentRollNumberTables(secondaryPool);

  const statusMap = await loadPrimaryAdmissionStatusMap(primaryPool);
  const cancelledSynced = await syncCancelledStatuses(secondaryPool, statusMap, dryRun);

  const purge = dryRun ? null : await purgeNonCrmStudentRollNumbers(secondaryPool);

  if (!dryRun) {
    await secondaryPool.execute(
      `DELETE FROM student_roll_numbers WHERE admission_number LIKE '2026%'`
    );
    await secondaryPool.execute(`DELETE FROM student_roll_counters WHERE batch = 2026`);
  }

  const [students] = await secondaryPool.execute(
    `SELECT s.id, s.admission_number, s.branch, s.batch, s.student_data
     FROM students s
     WHERE s.admission_number LIKE '2026%'
       AND TRIM(s.admission_number) != ''
     ORDER BY s.branch ASC, CAST(s.admission_number AS UNSIGNED) ASC, s.id ASC`
  );

  const report = {
    dryRun,
    purge,
    cancelledStatusSynced: cancelledSynced,
    candidates: students.length,
    assigned: 0,
    skippedCancelled: 0,
    errors: [],
    samples: [],
    branchSeries: {},
  };

  for (const row of students) {
    const admissionNumber = String(row.admission_number || '').trim();
    const primaryStatus = statusMap.get(admissionNumber) || 'active';
    const managedBranchId = parseManagedBranchIdFromStudentData(row.student_data);
    const batch = resolveRollBatch({ admissionNumber });
    const branchScope = resolveBranchScope({ managedBranchId, branchLabel: row.branch });

    if (isAdmissionCancelledStatus(primaryStatus)) {
      report.skippedCancelled += 1;
      continue;
    }

    try {
      if (dryRun) {
        const key = `${row.branch} (${branchScope})`;
        report.branchSeries[key] = (report.branchSeries[key] || 0) + 1;
        report.assigned += 1;
        continue;
      }

      const result = await assignStudentRollNumber(secondaryPool, {
        studentId: row.id,
        admissionNumber,
        managedBranchId,
        branchLabel: row.branch,
        batch,
        admissionStatus: primaryStatus,
        force: true,
      });

      report.assigned += 1;
      const key = `${row.branch} (${result.branch_scope})`;
      if (!report.branchSeries[key]) {
        report.branchSeries[key] = { count: 0, first: result.roll_number, last: result.roll_number };
      }
      report.branchSeries[key].count += 1;
      report.branchSeries[key].last = result.roll_number;

      if (report.samples.length < 20) {
        report.samples.push({
          admission_number: admissionNumber,
          branch: row.branch,
          roll_number: result.roll_number,
          serial: result.serial,
        });
      }
    } catch (err) {
      report.errors.push({
        admission_number: admissionNumber,
        branch: row.branch,
        message: err?.message || String(err),
      });
    }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
