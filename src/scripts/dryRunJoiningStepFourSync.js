/**
 * Dry-run Step 4 fee sync: preview what would be written to
 * - Fee Management Mongo (`crm_joining_student_fee_details`)
 * - Transport Mongo (`studentfees`)
 * - Hostel HMS Mongo (`users`)
 *
 * Usage:
 *   node src/scripts/dryRunJoiningStepFourSync.js --latest-approved
 *   node src/scripts/dryRunJoiningStepFourSync.js --joining-id=<uuid>
 *   node src/scripts/dryRunJoiningStepFourSync.js --lead-id=<uuid>
 *   node src/scripts/dryRunJoiningStepFourSync.js --admission-number=20260056
 *   node src/scripts/dryRunJoiningStepFourSync.js --btech
 */
import dns from 'dns';
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { buildJoiningStepFourSyncPlan } from '../services/joiningStudentFeeMongoSync.service.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const parseArgs = (argv) => {
  const out = {
    joiningId: null,
    leadId: null,
    admissionNumber: null,
    latestApproved: false,
    btech: false,
    verbose: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--latest-approved') out.latestApproved = true;
    else if (arg === '--btech') out.btech = true;
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg.startsWith('--joining-id=')) out.joiningId = arg.split('=')[1]?.trim() || null;
    else if (arg.startsWith('--lead-id=')) out.leadId = arg.split('=')[1]?.trim() || null;
    else if (arg.startsWith('--admission-number=')) {
      out.admissionNumber = arg.split('=')[1]?.trim() || null;
    }
  }
  return out;
};

const parseLeadData = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
};

const resolveAdmissionNumber = (joiningRow, leadData) => {
  const fromLead =
    leadData?.admissionNumber ||
    leadData?.admission_number ||
    leadData?.enquiryNumber ||
    '';
  if (String(fromLead).trim()) return String(fromLead).trim();
  const extras = leadData?._joiningRegistrationExtras;
  if (extras && typeof extras === 'object') {
    const n = extras.admission_number || extras.admissionNumber;
    if (n) return String(n).trim();
  }
  return '';
};

const buildJoiningFeeSyncContext = (joiningRow, leadData, studentFeeDetails, registrationExtras) => {
  const transportDetails =
    registrationExtras?.transport_details &&
    typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null;
  return {
    course: joiningRow?.course || '',
    branch: joiningRow?.branch || '',
    quota: joiningRow?.quota || '',
    batch:
      studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
        ? String(studentFeeDetails.batch).trim()
        : '',
    admissionNumber: resolveAdmissionNumber(joiningRow, leadData),
    studentName: joiningRow?.student_name || '',
    studentPhone: joiningRow?.student_phone || '',
    studentGender: joiningRow?.student_gender || '',
    fatherPhone: joiningRow?.father_phone || '',
    transportDetails,
    programTotalYears: resolveProgramTotalYearsFromExtras(registrationExtras),
    intakeBatch: resolveIntakeBatchFromExtras(registrationExtras, studentFeeDetails),
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
  };
};

const resolveIntakeBatchFromExtras = (registrationExtras, studentFeeDetails) => {
  const fromFees = normalizeCalendarAcademicYear(studentFeeDetails?.batch ?? '');
  if (fromFees) return fromFees;
  return normalizeCalendarAcademicYear(
    registrationExtras?.academic_year ?? registrationExtras?.academicYear ?? ''
  );
};

const resolveProgramTotalYearsFromExtras = (registrationExtras) => {
  const raw =
    registrationExtras?.program_total_years ??
    registrationExtras?.programTotalYears ??
    null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(8, Math.trunc(n));
  return 4;
};

const loadJoining = async (pool, args) => {
  if (args.joiningId) {
    const [rows] = await pool.execute('SELECT * FROM joinings WHERE id = ? LIMIT 1', [args.joiningId]);
    return rows[0] || null;
  }
  if (args.leadId) {
    const [rows] = await pool.execute(
      'SELECT * FROM joinings WHERE lead_id = ? OR id = ? ORDER BY updated_at DESC LIMIT 1',
      [args.leadId, args.leadId]
    );
    return rows[0] || null;
  }
  if (args.admissionNumber) {
    const like = `%${args.admissionNumber}%`;
    const [rows] = await pool.execute(
      `SELECT * FROM joinings
       WHERE lead_data LIKE ?
       ORDER BY updated_at DESC LIMIT 1`,
      [like]
    );
    return rows[0] || null;
  }
  if (args.latestApproved) {
    const [rows] = await pool.execute(
      `SELECT * FROM joinings WHERE status = 'approved'
       ORDER BY updated_at DESC LIMIT 1`
    );
    return rows[0] || null;
  }
  return null;
};

const summarizeTarget = (label, target) => {
  if (!target) return { label, status: 'missing' };
  if (target.skipped) return { label, status: 'skipped', reason: target.reason };
  return {
    label,
    status: 'would_write',
    database: target.database,
    collection: target.collection,
    operation: target.operation,
    filter: target.filter || target.lookup,
    documentPreview: target.document
      ? {
          keys: Object.keys(target.document),
          lineCount: Array.isArray(target.document.lines) ? target.document.lines.length : undefined,
          admissionNumber: target.document.admissionNumber,
          studentName: target.document.name || target.document.studentName,
        }
      : undefined,
  };
};

const resolveStudentFeeDetails = (joining, leadData, registrationExtras) => {
  let studentFeeDetails =
    leadData._joiningStudentFeeDetails && typeof leadData._joiningStudentFeeDetails === 'object'
      ? leadData._joiningStudentFeeDetails
      : { lines: [] };

  if (!studentFeeDetails.batch) {
    const academicYear =
      leadData.academicYear ??
      leadData.academic_year ??
      registrationExtras.academicYear ??
      registrationExtras.academic_year;
    if (academicYear != null && String(academicYear).trim() !== '') {
      studentFeeDetails = { ...studentFeeDetails, batch: String(academicYear).trim() };
    } else {
      studentFeeDetails = {
        ...studentFeeDetails,
        batch: String(new Date().getFullYear()),
      };
    }
  }
  return studentFeeDetails;
};

const runDryRunForJoining = async (joining, { verbose = false } = {}) => {
  const leadData = parseLeadData(joining.lead_data);
  const registrationExtras =
    leadData._joiningRegistrationExtras && typeof leadData._joiningRegistrationExtras === 'object'
      ? leadData._joiningRegistrationExtras
      : {};
  const studentFeeDetails = resolveStudentFeeDetails(joining, leadData, registrationExtras);
  const joiningContext = buildJoiningFeeSyncContext(
    joining,
    leadData,
    studentFeeDetails,
    registrationExtras
  );

  const plan = await buildJoiningStepFourSyncPlan({
    joiningId: joining.id,
    leadId: joining.lead_id || null,
    studentFeeDetails,
    joiningContext,
  });

  const report = {
    mode: 'dry-run',
    joining: {
      id: joining.id,
      leadId: joining.lead_id,
      status: joining.status,
      admissionNumber: joiningContext.admissionNumber || null,
      studentName: joining.student_name,
      course: joining.course,
      branch: joining.branch,
      quota: joining.quota,
    },
    step4Input: {
      batch: studentFeeDetails.batch || joiningContext.batch || null,
      overrideLineCount: (studentFeeDetails.lines || []).length,
      accommodationType: joiningContext.transportDetails?.accommodationType || null,
      transportSummary: joiningContext.transportDetails
        ? {
            route: joiningContext.transportDetails.routeName,
            stage: joiningContext.transportDetails.stageName,
            hostel: joiningContext.transportDetails.hostelName,
            category: joiningContext.transportDetails.categoryName,
            room: joiningContext.transportDetails.roomNumber,
          }
        : null,
    },
    buildSummary: {
      catalogLookup: plan.catalogLookup,
      catalogRowCount: plan.catalogRowCount,
      accommodationRowCount: plan.accommodationRowCount,
      portalLineCount: plan.lineCount,
      revisedLineCount: plan.revisedLineCount,
    },
    targets: [
      summarizeTarget('Fee Management Mongo (CRM mirror)', plan.feePortal),
      summarizeTarget('Fee Management Mongo (studentfees ledger)', plan.studentFees),
      summarizeTarget('Transport Mongo', plan.transport),
      summarizeTarget('Hostel HMS Mongo', plan.hostel),
    ],
  };

  if (verbose) {
    report.portalLines = plan.lines;
    report.feePortalDocument = plan.feePortal?.document || null;
    report.transportDocument = plan.transport?.document || null;
    report.hostelDocument = plan.hostel?.document || null;
  } else {
    report.revisedLines = (plan.lines || [])
      .filter((line) => line.isRevised)
      .map((line) => ({
        feeHead: line.feeHeadName || line.feeHeadCode,
        studentYear: line.studentYear,
        actualAmount: line.actualAmount,
        revisedAmount: line.revisedAmount,
      }));
    report.samplePortalLines = (plan.lines || []).slice(0, 8).map((line) => ({
      feeHead: line.feeHeadName || line.feeHeadCode,
      studentYear: line.studentYear,
      actualAmount: line.actualAmount,
      revisedAmount: line.revisedAmount,
      isRevised: line.isRevised,
      accommodationType: line.accommodationType,
    }));
  }

  return report;
};

async function main() {
  const args = parseArgs(process.argv);
  if (
    !args.joiningId &&
    !args.leadId &&
    !args.admissionNumber &&
    !args.latestApproved &&
    !args.btech
  ) {
    console.error(
      'Usage: node src/scripts/dryRunJoiningStepFourSync.js (--btech | --latest-approved | --joining-id= | --lead-id= | --admission-number=)'
    );
    process.exit(1);
  }

  const pool = getPool();

  if (args.btech) {
    console.log('\n*** DRY RUN — All approved B.Tech admissions (no writes) ***\n');
    const [rows] = await pool.execute(
      `SELECT * FROM joinings
       WHERE status = 'approved' AND course = 'B.Tech' AND branch != ''
       ORDER BY branch, student_name`
    );

    const results = [];
    for (const joining of rows) {
      const report = await runDryRunForJoining(joining, { verbose: false });
      results.push({
        studentName: report.joining.studentName,
        branch: report.joining.branch,
        quota: report.joining.quota,
        batch: report.step4Input.batch,
        catalogLookup: report.buildSummary.catalogLookup,
        portalLineCount: report.buildSummary.portalLineCount,
        feePortal: report.targets[0]?.status,
        transport: report.targets[1]?.status,
        hostel: report.targets[2]?.status,
        issue:
          report.buildSummary.portalLineCount === 0
            ? 'No fee catalog match — add feestructures for this branch/quota/batch'
            : null,
      });
    }

    const summary = {
      mode: 'dry-run',
      course: 'B.Tech',
      total: results.length,
      withFeeLines: results.filter((r) => r.portalLineCount > 0).length,
      withoutFeeLines: results.filter((r) => r.portalLineCount === 0).length,
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
    await closeDB();
    return;
  }

  const joining = await loadJoining(pool, args);
  if (!joining) {
    console.error('No joining record found for the given selector.');
    process.exit(1);
  }

  console.log('\n*** DRY RUN — Step 4 external DB sync (no writes) ***\n');
  const report = await runDryRunForJoining(joining, { verbose: args.verbose });
  console.log(JSON.stringify(report, null, 2));
  await closeDB();
}

main().catch(async (err) => {
  console.error('Dry run failed:', err?.message || err);
  try {
    await closeDB();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
