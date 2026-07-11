/**
 * Remove fee heads synced/added for batch 2026 when no matching LATER catalog exists.
 * Clears Step 4 builder overrides in SQL and stale Fee Management CRM / studentfees rows.
 *
 * Usage:
 *   node src/scripts/cleanupLateral2026OrphanFeesOnce.js --admission-number=20260710
 *   node src/scripts/cleanupLateral2026OrphanFeesOnce.js --admission-number=20260710 --apply
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import mysql from 'mysql2/promise';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import {
  buildJoiningStepFourSyncPlan,
} from '../services/joiningStudentFeeMongoSync.service.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';
import { closeDB, getPool } from '../config-sql/database.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ADMISSION_NUMBER = (() => {
  const arg = process.argv.find((a) => a.startsWith('--admission-number='));
  return arg ? arg.split('=')[1]?.trim() || '' : '';
})();

if (!ADMISSION_NUMBER) {
  console.error('Pass --admission-number=XXXXXXXX');
  process.exit(1);
}

const parseJson = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
};

const resolveIntakeBatchFromExtras = (registrationExtras, studentFeeDetails, admissionNumber = '') => {
  const fromFees = normalizeCalendarAcademicYear(studentFeeDetails?.batch ?? '');
  if (fromFees) return fromFees;
  const fromExtras = normalizeCalendarAcademicYear(
    registrationExtras?.academic_year ?? registrationExtras?.academicYear ?? ''
  );
  if (fromExtras) return fromExtras;
  return deriveAdmissionSeriesYear(admissionNumber) || '';
};

const resolveProgramTotalYearsFromExtras = (registrationExtras, course = '') => {
  const normalizedCourse = String(course || '').trim().toLowerCase();
  if (normalizedCourse === 'diploma' || normalizedCourse === 'polytechnic') return 3;
  const raw =
    registrationExtras?.program_total_years ?? registrationExtras?.programTotalYears ?? null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(8, Math.trunc(n));
  return 4;
};

const buildJoiningFeeSyncContext = (
  joiningRow,
  studentFeeDetails,
  registrationExtras,
  admissionNumber = ''
) => ({
  course: joiningRow?.course || '',
  branch: joiningRow?.branch || '',
  quota: joiningRow?.quota || '',
  studentStatus: String(
    registrationExtras?.student_status ??
      registrationExtras?.studentStatus ??
      joiningRow?.student_status ??
      joiningRow?.studentStatus ??
      ''
  ).trim(),
  batch:
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim()
      : '',
  admissionNumber: admissionNumber || '',
  studentName: joiningRow?.student_name || '',
  studentPhone: joiningRow?.student_phone || '',
  studentGender: joiningRow?.student_gender || '',
  fatherPhone: joiningRow?.father_phone || '',
  managedCourseId:
    joiningRow?.managed_course_id ??
    registrationExtras?.managed_course_id ??
    registrationExtras?.managedCourseId ??
    null,
  collegeId:
    registrationExtras?.college_id ??
    registrationExtras?.collegeId ??
    registrationExtras?.school_or_college_id ??
    registrationExtras?.schoolOrCollegeId ??
    null,
  transportDetails:
    registrationExtras?.transport_details && typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null,
  programTotalYears: resolveProgramTotalYearsFromExtras(registrationExtras, joiningRow?.course || ''),
  intakeBatch: resolveIntakeBatchFromExtras(registrationExtras, studentFeeDetails, admissionNumber),
});

const stripJoiningStudentFeeDetails = (leadData) => {
  if (!leadData || typeof leadData !== 'object') return leadData;
  const next = { ...leadData };
  delete next._joiningStudentFeeDetails;
  return next;
};

async function loadTarget(pool) {
  const [rows] = await pool.execute(
    `SELECT
       a.id AS admission_id,
       a.admission_number,
       a.joining_id,
       a.lead_data AS admission_lead_data,
       j.id AS joining_id_row,
       j.lead_data AS joining_lead_data,
       j.course,
       j.branch,
       j.quota,
       j.student_name,
       j.student_phone,
       j.student_gender,
       j.father_phone,
       j.managed_course_id,
       j.managed_branch_id,
       j.status
     FROM admissions a
     INNER JOIN joinings j ON j.id = a.joining_id
     WHERE a.admission_number = ?
     LIMIT 1`,
    [ADMISSION_NUMBER]
  );
  return rows[0] || null;
}

async function updateLeadDataJson(pool, table, idColumn, id, leadData) {
  await pool.execute(`UPDATE ${table} SET lead_data = ?, updated_at = NOW() WHERE ${idColumn} = ?`, [
    JSON.stringify(leadData),
    id,
  ]);
}

async function main() {
  console.log(`\n*** ${APPLY ? 'APPLY' : 'DRY RUN'} — cleanup lateral 2026 orphan fees for ${ADMISSION_NUMBER} ***\n`);

  const pool = await getPool();
  const row = await loadTarget(pool);
  if (!row) {
    console.error('Admission/joining not found.');
    process.exit(1);
  }

  const joiningId = String(row.joining_id_row || row.joining_id || '').trim();
  const admLeadData = parseJson(row.admission_lead_data);
  const joinLeadData = parseJson(row.joining_lead_data);
  const registrationExtras =
    joinLeadData._joiningRegistrationExtras &&
    typeof joinLeadData._joiningRegistrationExtras === 'object'
      ? joinLeadData._joiningRegistrationExtras
      : admLeadData._joiningRegistrationExtras &&
          typeof admLeadData._joiningRegistrationExtras === 'object'
        ? admLeadData._joiningRegistrationExtras
        : {};

  const beforeFeeDetails =
    joinLeadData._joiningStudentFeeDetails || admLeadData._joiningStudentFeeDetails || null;

  const conn = await connectFeeManagement();
  const db = conn.db;
  const crmBefore = await db.collection('crm_joining_student_fee_details').findOne({ joiningId });
  const studentFeesBefore = await db
    .collection('studentfees')
    .find({ studentId: ADMISSION_NUMBER })
    .toArray();

  const year1CrmLines = (crmBefore?.lines || []).filter((line) => Number(line.studentYear) === 1);
  const year1StudentFees = studentFeesBefore.filter((line) => Number(line.studentYear) === 1);

  console.log('Before:');
  console.log(
    JSON.stringify(
      {
        joiningId,
        builderBatch: beforeFeeDetails?.batch || null,
        builderLineCount: Array.isArray(beforeFeeDetails?.lines) ? beforeFeeDetails.lines.length : 0,
        crmBatch: crmBefore?.batch || null,
        crmLineCount: crmBefore?.lines?.length || 0,
        crmYear1LineCount: year1CrmLines.length,
        studentFeesCount: studentFeesBefore.length,
        studentFeesYear1Count: year1StudentFees.length,
      },
      null,
      2
    )
  );

  const clearedAdmLeadData = stripJoiningStudentFeeDetails(admLeadData);
  const clearedJoinLeadData = stripJoiningStudentFeeDetails(joinLeadData);
  const emptyStudentFeeDetails = { batch: '', lines: [] };

  const joiningContext = buildJoiningFeeSyncContext(
    row,
    emptyStudentFeeDetails,
    registrationExtras,
    ADMISSION_NUMBER
  );

  const plan = await buildJoiningStepFourSyncPlan({
    joiningId,
    leadId: null,
    studentFeeDetails: emptyStudentFeeDetails,
    joiningContext,
  });

  console.log('\nPlanned catalog after cleanup:');
  console.log(
    JSON.stringify(
      {
        catalogLookup: plan.catalogLookup,
        catalogRowCount: plan.catalogRowCount,
        portalLineCount: plan.lineCount,
        portalYears: [...new Set((plan.lines || []).map((line) => line.studentYear))].sort(),
      },
      null,
      2
    )
  );

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write changes.');
    await closeDB();
    process.exit(0);
  }

  await updateLeadDataJson(pool, 'admissions', 'id', row.admission_id, clearedAdmLeadData);
  await updateLeadDataJson(pool, 'joinings', 'id', joiningId, clearedJoinLeadData);
  console.log('Cleared _joiningStudentFeeDetails in admissions + joinings lead_data.');

  if (crmBefore) {
    await db.collection('crm_joining_student_fee_details').deleteOne({ joiningId });
    console.log('Deleted stale crm_joining_student_fee_details document.');
  }

  const sfDelete = await db.collection('studentfees').deleteMany({ studentId: ADMISSION_NUMBER });
  console.log(`Deleted ${sfDelete.deletedCount || 0} studentfees rows for ${ADMISSION_NUMBER}.`);

  console.log(
    'Skipped CRM re-sync — fee lines are shown only for the student batch catalog (no prior-year fallback).'
  );

  const crmAfter = await db.collection('crm_joining_student_fee_details').findOne({ joiningId });
  const studentFeesAfter = await db
    .collection('studentfees')
    .find({ studentId: ADMISSION_NUMBER })
    .toArray();

  console.log('\nAfter:');
  console.log(
    JSON.stringify(
      {
        syncLineCount: 0,
        crmBatch: crmAfter?.batch || null,
        crmRequestedBatch: crmAfter?.requestedBatch || null,
        crmBatchMatchMode: crmAfter?.batchMatchMode || null,
        crmLineCount: crmAfter?.lines?.length || 0,
        crmYears: [...new Set((crmAfter?.lines || []).map((line) => line.studentYear))].sort(),
        studentFeesCount: studentFeesAfter.length,
      },
      null,
      2
    )
  );

  await closeDB();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
