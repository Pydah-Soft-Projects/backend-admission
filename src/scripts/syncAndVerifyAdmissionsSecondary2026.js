/**
 * Compare primary 2026 admissions vs secondary students, resync from primary,
 * audit foreign roll numbers, then rebuild roll numbers.
 *
 * Usage:
 *   node src/scripts/syncAndVerifyAdmissionsSecondary2026.js [--dry-run] [--skip-roll-repair]
 */

import dotenv from 'dotenv';
import { getPool as getPrimaryPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import { parseStudentRollNumber } from '../utils/studentRollNumber.util.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function norm(s) {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function branchEquivalent(primaryBranch, secondaryBranch) {
  const p = norm(primaryBranch);
  const s = norm(secondaryBranch);
  if (!p || !s) return p === s;
  if (p === s) return true;
  // Secondary sync stores catalog codes; primary may store full names.
  if (p.startsWith(s) || s.startsWith(p)) return true;
  const pairs = [
    ['AGRICULTURERURALDEVELOPMENT', 'AGRD'],
    ['PHARMACEUTICALQUALITYASSURANCE', 'PQA'],
    ['FOODSCIENCETECHNOLOGY', 'FOODSCIE'],
    ['FORENSICSCIENCE', 'FORENSIC'],
    ['FISHERIES', 'FISHERIE'],
    ['DCSEAIML', 'DAIML'],
    ['DAPPTV', 'DAP'],
  ];
  return pairs.some(([a, b]) => (p.includes(a) && s.includes(b)) || (p.includes(b) && s.includes(a)));
}

function courseEquivalent(primaryCourse, secondaryCourse) {
  const p = norm(primaryCourse).replace(/\(LATERAL\)/g, '').trim();
  const s = norm(secondaryCourse).replace(/\(LATERAL\)/g, '').trim();
  return p === s || p.replace(/\./g, '') === s.replace(/\./g, '');
}

function parseLeadEmail(row) {
  try {
    const ld =
      typeof row.lead_data === 'string' ? JSON.parse(row.lead_data || '{}') : row.lead_data || {};
    return String(ld.email || '').trim();
  } catch {
    return '';
  }
}

async function comparePrimarySecondary(primaryPool, secondaryPool) {
  const [primaryRows] = await primaryPool.execute(
    `SELECT admission_number, student_name, status, course, branch, student_phone
     FROM admissions WHERE admission_number LIKE '2026%'
     ORDER BY CAST(admission_number AS UNSIGNED)`
  );

  const [secondaryRows] = await secondaryPool.execute(
    `SELECT s.admission_number, s.student_name, s.course, s.branch, s.student_mobile,
            s.student_status, s.pin_no, r.roll_number
     FROM students s
     LEFT JOIN student_roll_numbers r ON r.student_id = s.id
     WHERE s.admission_number LIKE '2026%'
     ORDER BY CAST(s.admission_number AS UNSIGNED)`
  );

  const primaryMap = new Map(primaryRows.map((r) => [String(r.admission_number).trim(), r]));
  const secondaryMap = new Map(secondaryRows.map((r) => [String(r.admission_number).trim(), r]));

  const mismatches = [];
  const missingSecondary = [];
  const extraSecondary = [];

  for (const [num, p] of primaryMap) {
    const s = secondaryMap.get(num);
    if (!s) {
      if (p.status !== 'Admission Cancelled') {
        missingSecondary.push({ admission_number: num, student_name: p.student_name });
      }
      continue;
    }
    const issues = [];
    if (norm(p.student_name) !== norm(s.student_name)) {
      issues.push({ field: 'name', primary: p.student_name, secondary: s.student_name });
    }
    if (!courseEquivalent(p.course, s.course)) {
      issues.push({ field: 'course', primary: p.course, secondary: s.course });
    }
    if (!branchEquivalent(p.branch, s.branch)) {
      issues.push({ field: 'branch', primary: p.branch, secondary: s.branch });
    }
    const expectedStatus =
      String(p.status).trim() === 'Admission Cancelled' ? 'Admission Cancelled' : null;
    if (
      expectedStatus &&
      norm(s.student_status) !== norm(expectedStatus)
    ) {
      issues.push({ field: 'status', primary: p.status, secondary: s.student_status });
    }
    if (issues.length) mismatches.push({ admission_number: num, issues });
  }

  for (const [num, s] of secondaryMap) {
    if (!primaryMap.has(num)) extraSecondary.push({ admission_number: num, student_name: s.student_name });
  }

  return {
    primaryCount: primaryRows.length,
    secondaryCount: secondaryRows.length,
    mismatches,
    missingSecondary,
    extraSecondary,
  };
}

async function auditForeignRollNumbers(secondaryPool) {
  const [ours] = await secondaryPool.execute(
    `SELECT admission_number, roll_number FROM student_roll_numbers WHERE admission_number LIKE '2026%'`
  );
  const ourMap = new Map(ours.map((r) => [String(r.admission_number).trim(), r.roll_number]));

  const [students] = await secondaryPool.execute(
    `SELECT admission_number, student_name, pin_no, student_data
     FROM students WHERE admission_number LIKE '2026%'`
  );

  const pinNoRollLike = [];
  const studentDataRoll = [];
  const pinConflictsWithOurRoll = [];

  const rollLikePin = /^[A-Z0-9]{2,}[0-9]{3}$/i;
  const ourRollPattern = /^\d{2}[A-Z0-9]+\d{3}$/i;

  for (const row of students) {
    const adm = String(row.admission_number).trim();
    const pin = String(row.pin_no ?? '').trim();
    const ourRoll = ourMap.get(adm) || null;

    if (pin && (rollLikePin.test(pin.replace(/[\s-]/g, '')) || ourRollPattern.test(pin))) {
      pinNoRollLike.push({ admission_number: adm, pin_no: pin, our_roll: ourRoll });
      if (ourRoll && pin !== ourRoll) {
        pinConflictsWithOurRoll.push({ admission_number: adm, pin_no: pin, our_roll: ourRoll });
      }
    }

    let payload = row.student_data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (payload && typeof payload === 'object') {
      for (const key of ['roll_number', 'rollNumber', 'roll_no', 'rollNo']) {
        const val = String(payload[key] ?? '').trim();
        if (!val) continue;
        const parsed = parseStudentRollNumber(val);
        if (parsed || ourRollPattern.test(val)) {
          studentDataRoll.push({
            admission_number: adm,
            field: key,
            value: val,
            our_roll: ourRoll,
            matches_our_table: val === ourRoll,
          });
        }
      }
    }
  }

  const [legacyRollsNotOurs] = await secondaryPool.execute(
    `SELECT s.admission_number, s.pin_no
     FROM students s
     LEFT JOIN student_roll_numbers r ON r.student_id = s.id
     WHERE s.admission_number LIKE '2026%'
       AND s.pin_no IS NOT NULL AND TRIM(s.pin_no) <> ''
       AND r.id IS NULL`
  );

  return {
    ourRollCount: ours.length,
    pinNoRollLikeCount: pinNoRollLike.length,
    pinNoRollLikeSample: pinNoRollLike.slice(0, 15),
    pinConflictsWithOurRoll,
    studentDataRollCount: studentDataRoll.length,
    studentDataRollSample: studentDataRoll.slice(0, 15),
    legacyPinWithoutOurRoll: legacyRollsNotOurs,
  };
}

async function resyncAll2026(primaryPool, dryRun) {
  const [rows] = await primaryPool.execute(
    `SELECT * FROM admissions WHERE admission_number LIKE '2026%'
     ORDER BY CAST(admission_number AS UNSIGNED)`
  );

  const results = { total: rows.length, synced: 0, failed: [] };

  for (const row of rows) {
    if (dryRun) {
      results.synced += 1;
      continue;
    }
    try {
      const formatted = await formatAdmission(row, primaryPool);
      const syncResult = await syncToSecondaryDatabase(formatted, formatted.admissionNumber, {
        leadId: row.lead_id || undefined,
        joiningId: row.joining_id || undefined,
        email: parseLeadEmail(row),
        reconcileRollNumber: true,
      });
      if (syncResult?.ok) results.synced += 1;
      else results.failed.push({ admission_number: row.admission_number, reason: 'sync_failed' });
    } catch (err) {
      results.failed.push({
        admission_number: row.admission_number,
        reason: err?.message || String(err),
      });
    }
  }

  return results;
}

function runRollRepair() {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'repairSecondaryStudentRollNumbers2026.js');
    const child = spawn(process.execPath, [script], { stdio: 'inherit', cwd: path.join(__dirname, '../..') });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`roll repair exited with code ${code}`));
    });
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const skipRollRepair = process.argv.includes('--skip-roll-repair');

  const primaryPool = getPrimaryPool();
  const secondaryPool = getSecondaryPool();

  const before = await comparePrimarySecondary(primaryPool, secondaryPool);
  const rollAuditBefore = await auditForeignRollNumbers(secondaryPool);

  console.log(
    JSON.stringify(
      {
        phase: 'before',
        comparison: {
          primaryCount: before.primaryCount,
          secondaryCount: before.secondaryCount,
          mismatchCount: before.mismatches.length,
          mismatchSample: before.mismatches.slice(0, 20),
          missingSecondary: before.missingSecondary,
        },
        rollAudit: rollAuditBefore,
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log('DRY_RUN — no resync or roll repair executed.');
    return;
  }

  const resync = await resyncAll2026(primaryPool, false);
  console.log(JSON.stringify({ phase: 'resync', resync }, null, 2));

  if (!skipRollRepair) {
    await runRollRepair();
  }

  const after = await comparePrimarySecondary(primaryPool, secondaryPool);
  const rollAuditAfter = await auditForeignRollNumbers(secondaryPool);

  console.log(
    JSON.stringify(
      {
        phase: 'after',
        comparison: {
          mismatchCount: after.mismatches.length,
          mismatchSample: after.mismatches.slice(0, 20),
          missingSecondary: after.missingSecondary,
        },
        rollAudit: rollAuditAfter,
      },
      null,
      2
    )
  );

  const exitCode =
    after.mismatches.length > 0 || resync.failed.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
