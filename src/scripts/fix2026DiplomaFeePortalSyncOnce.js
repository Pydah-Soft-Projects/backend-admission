/**
 * One-off: resync 2026 Diploma students into the fee portal after catalog/batch fixes.
 *
 * Targets:
 * - Fee Management Mongo `crm_joining_student_fee_details` (CRM mirror)
 * - Fee Management Mongo `studentfees` (live fee portal ledger)
 *
 * Usage:
 *   node src/scripts/fix2026DiplomaFeePortalSyncOnce.js
 *   node src/scripts/fix2026DiplomaFeePortalSyncOnce.js --apply
 *   node src/scripts/fix2026DiplomaFeePortalSyncOnce.js --admission-number=20260268
 *   node src/scripts/fix2026DiplomaFeePortalSyncOnce.js --apply --admission-number=20260268
 */
import dns from 'dns';
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import {
  buildJoiningStepFourSyncPlan,
  syncJoiningStudentFeeDetailsToFeeMongo,
  JOINING_STUDENT_FEE_MONGO_COLLECTION,
  FEE_PORTAL_STUDENT_FEES_COLLECTION,
} from '../services/joiningStudentFeeMongoSync.service.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ADMISSION_FILTER = (() => {
  const arg = process.argv.find((a) => a.startsWith('--admission-number='));
  return arg ? arg.split('=')[1]?.trim() || null : null;
})();

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

const sanitizeStudentFeeDetailsForDb = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const batch =
    raw.batch != null && String(raw.batch).trim() !== ''
      ? String(raw.batch).trim().slice(0, 32)
      : undefined;
  const linesIn = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = linesIn
    .map((line) => {
      const structureId = String(line?.structureId ?? '').trim();
      if (!structureId) return null;
      let amount = null;
      if (line?.amount !== undefined && line?.amount !== null && line?.amount !== '') {
        const n = Number(line.amount);
        if (Number.isFinite(n) && n >= 0) amount = n;
      }
      const remarks = typeof line?.remarks === 'string' ? line.remarks.trim().slice(0, 2000) : '';
      return { structureId, amount, remarks };
    })
    .filter(Boolean);
  if (lines.length === 0 && !batch) return null;
  return { ...(batch ? { batch } : {}), lines };
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
    registrationExtras?.program_total_years ??
    registrationExtras?.programTotalYears ??
    null;
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
    registrationExtras?.transport_details &&
    typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null,
  programTotalYears: resolveProgramTotalYearsFromExtras(
    registrationExtras,
    joiningRow?.course || ''
  ),
  intakeBatch: resolveIntakeBatchFromExtras(
    registrationExtras,
    studentFeeDetails,
    admissionNumber
  ),
});

const loadTargets = async (pool) => {
  const params = [];
  let admissionClause = '';
  if (ADMISSION_FILTER) {
    admissionClause = 'AND a.admission_number = ?';
    params.push(ADMISSION_FILTER);
  }

  const [rows] = await pool.execute(
    `
    SELECT
      a.admission_number,
      a.status AS admission_status,
      j.id AS joining_id,
      j.lead_id,
      j.course,
      j.branch,
      j.quota,
      j.student_name,
      j.student_phone,
      j.student_gender,
      j.father_phone,
      j.managed_course_id,
      j.lead_data AS joining_lead_data
    FROM admissions a
    INNER JOIN joinings j ON j.id = a.joining_id
    WHERE a.admission_number LIKE '2026%'
      AND LOWER(TRIM(a.course)) = 'diploma'
      AND a.status != 'Admission Cancelled'
      ${admissionClause}
    ORDER BY a.admission_number
    `,
    params
  );

  return rows;
};

const readFeePortalCounts = async (db, admissionNumber, joiningId) => {
  const studentId = String(admissionNumber).trim();
  const crmDoc = await db
    .collection(JOINING_STUDENT_FEE_MONGO_COLLECTION)
    .findOne({ $or: [{ joiningId }, { admissionNumber: studentId }] });
  const studentFeesCount = await db
    .collection(FEE_PORTAL_STUDENT_FEES_COLLECTION)
    .countDocuments({ studentId });
  return {
    crmLineCount: Array.isArray(crmDoc?.lines) ? crmDoc.lines.length : 0,
    crmBatch: crmDoc?.batch ?? null,
    studentFeesCount,
  };
};

const purgeStudentFeesLedger = async (db, admissionNumber) => {
  const studentId = String(admissionNumber).trim();
  const result = await db.collection(FEE_PORTAL_STUDENT_FEES_COLLECTION).deleteMany({ studentId });
  return result.deletedCount || 0;
};

async function main() {
  if (!process.env.FEE_MANAGEMENT_MONGO_URI?.trim()) {
    console.error('FEE_MANAGEMENT_MONGO_URI is not set');
    process.exit(1);
  }

  const pool = getPool();
  const targets = await loadTargets(pool);
  const report = {
    mode: APPLY ? 'apply' : 'dry-run',
    admissionFilter: ADMISSION_FILTER,
    scanned: targets.length,
    needsResync: 0,
    synced: 0,
    skipped: 0,
    ledgerPurged: 0,
    errors: [],
    students: [],
  };

  if (targets.length === 0) {
    console.log(JSON.stringify({ ...report, message: 'No matching Diploma admissions found.' }, null, 2));
    await closeDB();
    process.exit(0);
  }

  const feeConn = await connectFeeManagement();
  const feeDb = feeConn.db;

  for (const row of targets) {
    const admissionNumber = String(row.admission_number).trim();
    const joiningId = String(row.joining_id).trim();
    const leadData = parseJson(row.joining_lead_data);
    const registrationExtras = leadData._joiningRegistrationExtras || {};
    const studentFeeDetails = sanitizeStudentFeeDetailsForDb(leadData._joiningStudentFeeDetails);
    const joiningContext = buildJoiningFeeSyncContext(
      row,
      studentFeeDetails,
      registrationExtras,
      admissionNumber
    );

    try {
      const before = await readFeePortalCounts(feeDb, admissionNumber, joiningId);
      const plan = await buildJoiningStepFourSyncPlan({
        joiningId,
        leadId: row.lead_id || null,
        studentFeeDetails,
        joiningContext,
      });

      const plannedLines = plan.lineCount || 0;
      const plannedStudentFees = plan.studentFees?.skipped ? 0 : plan.studentFees?.rowCount || 0;
      const needsResync =
        before.crmLineCount !== plannedLines ||
        before.studentFeesCount !== plannedStudentFees ||
        !before.crmBatch;

      const entry = {
        admissionNumber,
        joiningId,
        branch: row.branch,
        before,
        after: {
          plannedPortalLines: plannedLines,
          plannedStudentFeesRows: plannedStudentFees,
          catalogLookup: plan.catalogLookup,
        },
        needsResync,
      };

      if (!needsResync) {
        report.skipped += 1;
        entry.action = 'skipped';
        report.students.push(entry);
        continue;
      }

      report.needsResync += 1;

      if (!APPLY) {
        entry.action = 'would-resync';
        report.students.push(entry);
        continue;
      }

      const deletedLedgerRows = await purgeStudentFeesLedger(feeDb, admissionNumber);
      report.ledgerPurged += deletedLedgerRows;

      const syncResult = await syncJoiningStudentFeeDetailsToFeeMongo({
        joiningId,
        leadId: row.lead_id || null,
        studentFeeDetails,
        joiningContext,
      });

      const after = await readFeePortalCounts(feeDb, admissionNumber, joiningId);
      entry.action = 'resynced';
      entry.deletedLedgerRows = deletedLedgerRows;
      entry.sync = {
        portalLines: syncResult.lines?.length || 0,
        studentFees: syncResult.studentFees || null,
      };
      entry.afterActual = after;
      report.synced += 1;
      report.students.push(entry);
    } catch (err) {
      report.errors.push({
        admissionNumber,
        joiningId,
        error: err?.message || String(err),
      });
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await closeDB();
  process.exit(report.errors.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDB();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
