/**
 * Backfill branch-based roll numbers for 2026-series admissions missing an assignment.
 * Run: node src/scripts/backfillSecondaryStudentRollNumbers.js [--dry-run]
 */

import dotenv from 'dotenv';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  assignStudentRollNumber,
  ensureStudentRollNumberTables,
  resolveBranchPrefixForRollNumber,
  resolveRollBatch,
} from '../utils/studentRollNumber.util.js';

dotenv.config();

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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const secondaryPool = getSecondaryPool();
  await ensureStudentRollNumberTables(secondaryPool);

  const [students] = await secondaryPool.execute(
    `SELECT s.id, s.admission_number, s.branch, s.batch, s.admission_date, s.student_data
     FROM students s
     LEFT JOIN student_roll_numbers r ON r.student_id = s.id
     WHERE r.id IS NULL
       AND s.admission_number IS NOT NULL
       AND TRIM(s.admission_number) != ''
       AND s.admission_number LIKE '2026%'
     ORDER BY s.branch ASC, CAST(s.admission_number AS UNSIGNED) ASC, s.id ASC`
  );

  const report = {
    dryRun,
    candidates: students.length,
    assigned: 0,
    skipped: 0,
    errors: [],
    samples: [],
  };

  console.log(`Found ${students.length} 2026-series students without roll numbers.`);

  for (const row of students) {
    const admissionNumber = String(row.admission_number || '').trim();
    const managedBranchId = parseManagedBranchIdFromStudentData(row.student_data);
    const batch = resolveRollBatch({ batch: row.batch, admissionNumber });

    try {
      if (dryRun) {
        const { prefix } = await resolveBranchPrefixForRollNumber(secondaryPool, {
          managedBranchId,
          branchLabel: row.branch,
        });
        report.samples.push({
          admission_number: admissionNumber,
          branch: row.branch,
          batch,
          branch_prefix: prefix,
          dry_run: true,
        });
        report.assigned += 1;
        continue;
      }

      const result = await assignStudentRollNumber(secondaryPool, {
        studentId: row.id,
        admissionNumber,
        managedBranchId,
        branchLabel: row.branch,
        batch,
      });

      report.assigned += 1;
      if (report.samples.length < 15) {
        report.samples.push({
          admission_number: admissionNumber,
          branch: row.branch,
          roll_number: result.roll_number,
          branch_prefix: result.branch_prefix,
          serial: result.serial,
          batch: result.batch,
        });
      }
    } catch (err) {
      report.errors.push({
        admission_number: admissionNumber,
        student_id: row.id,
        message: err?.message || String(err),
      });
    }
  }

  report.skipped = report.candidates - report.assigned - report.errors.length;
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
