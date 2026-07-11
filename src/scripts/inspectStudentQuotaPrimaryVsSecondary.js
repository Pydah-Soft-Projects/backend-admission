/**
 * Compare quota / stud_type across admissions DB (primary), student DB (secondary),
 * and Fee Management Mongo (feestructures catalog + studentfees ledger).
 *
 * Usage:
 *   node src/scripts/inspectStudentQuotaPrimaryVsSecondary.js "TUMPALA SRI RAMANJI"
 *   node src/scripts/inspectStudentQuotaPrimaryVsSecondary.js --admission 20260123
 *   node src/scripts/inspectStudentQuotaPrimaryVsSecondary.js --name "TUMPALA SRI RAMANJI"
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { classifyAdmissionQuotaCategory } from '../utils/quotaClassification.util.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';
import {
  buildJoiningStepFourSyncPlan,
  FEE_PORTAL_STUDENT_FEES_COLLECTION,
  JOINING_STUDENT_FEE_MONGO_COLLECTION,
} from '../services/joiningStudentFeeMongoSync.service.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

function parseArgs(argv) {
  const args = { name: '', admissionNumber: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--admission' || token === '-a') {
      args.admissionNumber = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--name' || token === '-n') {
      args.name = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (!args.name && !args.admissionNumber) {
      args.name = String(token).trim();
    }
  }
  return args;
}

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return null;
  }
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function pickQuotaFromRegistration(registrationFormData) {
  const reg =
    registrationFormData && typeof registrationFormData === 'object'
      ? registrationFormData
      : {};
  return (
    String(reg.quota ?? reg.admission_quota ?? reg.quota_type ?? '').trim() || null
  );
}

function extractSecondaryQuota(studentRow) {
  const sd = parseJson(studentRow?.student_data);
  const fromJson =
    sd?.courseInfo?.quota ??
    sd?.quota ??
    sd?.leadData?.quota ??
    null;
  return {
    stud_type: String(studentRow?.stud_type ?? '').trim() || null,
    quotaFromStudentData: fromJson ? String(fromJson).trim() : null,
    syncedAt: sd?._synced_at ? String(sd._synced_at) : null,
    joiningId: sd?._joining_id ? String(sd._joining_id) : null,
    leadId: sd?._lead_id ? String(sd._lead_id) : null,
  };
}

function buildDiagnosis(primaryQuota, secondaryInfo) {
  const expectedStudType = classifyAdmissionQuotaCategory(primaryQuota);
  const actualStudType = secondaryInfo.stud_type;
  const issues = [];

  if (!primaryQuota) {
    issues.push('Primary admissions/joining quota is empty.');
  }
  if (!secondaryInfo.stud_type && !secondaryInfo.quotaFromStudentData) {
    issues.push('Secondary student has no stud_type and no quota in student_data.');
  }
  if (expectedStudType && actualStudType && expectedStudType !== actualStudType) {
    issues.push(
      `stud_type mismatch: admissions quota "${primaryQuota}" classifies as ${expectedStudType}, but secondary stud_type is ${actualStudType}.`
    );
  }
  if (
    primaryQuota &&
    secondaryInfo.quotaFromStudentData &&
    normalizeName(primaryQuota) !== normalizeName(secondaryInfo.quotaFromStudentData)
  ) {
    issues.push(
      `Quota label mismatch: primary="${primaryQuota}" vs secondary student_data.courseInfo.quota="${secondaryInfo.quotaFromStudentData}".`
    );
  }
  if (
    primaryQuota &&
    secondaryInfo.quotaFromStudentData &&
    normalizeName(primaryQuota) === normalizeName(secondaryInfo.quotaFromStudentData) &&
    expectedStudType &&
    actualStudType &&
    expectedStudType === actualStudType
  ) {
    if (normalizeName(primaryQuota).includes('LATERAL') && expectedStudType === 'LATER') {
      issues.push(
        `Stored values match. Quota label stays "${primaryQuota}"; student DB stud_type is LATER (lateral fee track), not CONV.`
      );
    } else {
      issues.push(
        `Stored values match. Admissions shows quota label "${primaryQuota}"; student DB shows stud_type "${actualStudType}" (fee bucket).`
      );
    }
  }
  if (issues.length === 0) {
    issues.push('No obvious mismatch detected from stored values.');
  }

  return {
    expectedStudTypeFromPrimaryQuota: expectedStudType,
    actualSecondaryStudType: actualStudType,
    issues,
  };
}

async function connectPrimary() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

async function connectSecondary() {
  return mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

async function fetchPrimaryByAdmission(primary, admissionNumber) {
  const [admRows] = await primary.execute(
    `SELECT
       a.id, a.admission_number, a.status, a.student_name, a.quota AS admission_quota,
       a.course, a.branch, a.joining_id, a.lead_id, a.updated_at AS admission_updated_at,
       a.managed_course_id, a.managed_branch_id, a.lead_data,
       j.id AS joining_id_row, j.quota AS joining_quota, j.status AS joining_status,
       j.managed_course_id AS joining_managed_course_id,
       j.managed_branch_id AS joining_managed_branch_id,
       j.updated_at AS joining_updated_at, j.lead_data AS joining_lead_data,
       l.id AS lead_row_id, l.enquiry_number, l.quota AS lead_quota, l.source AS lead_source,
       l.updated_at AS lead_updated_at, l.dynamic_fields
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.admission_number = ?
     LIMIT 1`,
    [admissionNumber]
  );
  return admRows[0] || null;
}

async function fetchPrimaryByName(primary, name) {
  const like = `%${name.trim()}%`;
  const [admRows] = await primary.execute(
    `SELECT
       a.id, a.admission_number, a.status, a.student_name, a.quota AS admission_quota,
       a.course, a.branch, a.joining_id, a.lead_id, a.updated_at AS admission_updated_at,
       a.managed_course_id, a.managed_branch_id, a.lead_data,
       j.id AS joining_id_row, j.quota AS joining_quota, j.status AS joining_status,
       j.managed_course_id AS joining_managed_course_id,
       j.managed_branch_id AS joining_managed_branch_id,
       j.updated_at AS joining_updated_at, j.lead_data AS joining_lead_data,
       l.id AS lead_row_id, l.enquiry_number, l.quota AS lead_quota, l.source AS lead_source,
       l.updated_at AS lead_updated_at, l.dynamic_fields
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE UPPER(TRIM(a.student_name)) LIKE UPPER(?)
     ORDER BY a.updated_at DESC
     LIMIT 10`,
    [like]
  );

  const [joinRows] = await primary.execute(
    `SELECT
       j.id, j.lead_id, j.status, j.student_name, j.quota AS joining_quota,
       j.course, j.branch, j.updated_at AS joining_updated_at, j.lead_data,
       l.enquiry_number, l.quota AS lead_quota, l.source AS lead_source
     FROM joinings j
     LEFT JOIN leads l ON l.id = j.lead_id
     WHERE UPPER(TRIM(j.student_name)) LIKE UPPER(?)
     ORDER BY j.updated_at DESC
     LIMIT 10`,
    [like]
  );

  const [leadRows] = await primary.execute(
    `SELECT id, enquiry_number, name, quota AS lead_quota, source, updated_at, dynamic_fields
     FROM leads
     WHERE UPPER(TRIM(name)) LIKE UPPER(?)
     ORDER BY updated_at DESC
     LIMIT 10`,
    [like]
  );

  return { admRows, joinRows, leadRows };
}

async function fetchSecondaryByAdmission(secondary, admissionNumber) {
  const [rows] = await secondary.execute(
    `SELECT
       id, admission_number, admission_no, student_name, course, branch,
       stud_type, batch, college, student_status, updated_at, student_data
     FROM students
     WHERE admission_number = ? OR admission_no = ?
     LIMIT 1`,
    [admissionNumber, admissionNumber]
  );
  return rows[0] || null;
}

async function fetchSecondaryByName(secondary, name) {
  const like = `%${name.trim()}%`;
  const [rows] = await secondary.execute(
    `SELECT
       id, admission_number, admission_no, student_name, course, branch,
       stud_type, batch, college, student_status, updated_at, student_data
     FROM students
     WHERE UPPER(TRIM(student_name)) LIKE UPPER(?)
     ORDER BY updated_at DESC
     LIMIT 10`,
    [like]
  );
  return rows;
}

function summarizePrimaryRow(row) {
  const admLeadData = parseJson(row.lead_data);
  const joinLeadData = parseJson(row.joining_lead_data);
  const regFromAdm = pickQuotaFromRegistration(admLeadData?._joiningRegistrationExtras);
  const regFromJoin = pickQuotaFromRegistration(joinLeadData?._joiningRegistrationExtras);
  const dyn = parseJson(row.dynamic_fields);

  return {
    admission: {
      id: row.id,
      admission_number: row.admission_number,
      status: row.status,
      student_name: row.student_name,
      quota: row.admission_quota || null,
      course: row.course,
      branch: row.branch,
      updated_at: row.admission_updated_at,
    },
    joining: row.joining_id_row
      ? {
          id: row.joining_id_row,
          status: row.joining_status,
          quota: row.joining_quota || null,
          updated_at: row.joining_updated_at,
        }
      : null,
    lead: row.lead_row_id
      ? {
          id: row.lead_row_id,
          enquiry_number: row.enquiry_number,
          quota: row.lead_quota || null,
          source: row.lead_source || null,
          updated_at: row.lead_updated_at,
          dynamic_reference1: dyn?.reference1 || null,
        }
      : null,
    registrationExtrasQuota: {
      fromAdmissionLeadData: regFromAdm,
      fromJoiningLeadData: regFromJoin,
    },
    primaryQuotaSourcesAligned:
      [row.admission_quota, row.joining_quota, row.lead_quota]
        .map((v) => normalizeName(v))
        .filter(Boolean)
        .every((v, _i, arr) => v === arr[0]),
  };
}

function extractRegistrationExtras(primaryRow) {
  const admLeadData = parseJson(primaryRow?.lead_data);
  const joinLeadData = parseJson(primaryRow?.joining_lead_data);
  return {
    ...(joinLeadData?._joiningRegistrationExtras && typeof joinLeadData._joiningRegistrationExtras === 'object'
      ? joinLeadData._joiningRegistrationExtras
      : {}),
    ...(admLeadData?._joiningRegistrationExtras && typeof admLeadData._joiningRegistrationExtras === 'object'
      ? admLeadData._joiningRegistrationExtras
      : {}),
  };
}

function extractStudentFeeDetails(primaryRow) {
  const admLeadData = parseJson(primaryRow?.lead_data);
  const joinLeadData = parseJson(primaryRow?.joining_lead_data);
  return (
    joinLeadData?._joiningStudentFeeDetails ||
    admLeadData?._joiningStudentFeeDetails ||
    null
  );
}

function buildJoiningFeeSyncContext(primaryRow, secondaryRow = null) {
  const registrationExtras = extractRegistrationExtras(primaryRow);
  const studentFeeDetails = extractStudentFeeDetails(primaryRow);
  const transportDetails =
    registrationExtras?.transport_details &&
    typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null;

  const intakeBatch =
    normalizeCalendarAcademicYear(studentFeeDetails?.batch ?? '') ||
    normalizeCalendarAcademicYear(
      registrationExtras.academic_year ?? registrationExtras.academicYear ?? ''
    ) ||
    deriveAdmissionSeriesYear(primaryRow?.admission_number) ||
    (secondaryRow?.batch ? String(secondaryRow.batch).trim() : '');

  return {
    course: primaryRow?.course || '',
    branch: primaryRow?.branch || '',
    quota:
      primaryRow?.admission_quota ||
      primaryRow?.joining_quota ||
      primaryRow?.lead_quota ||
      '',
    studentStatus: String(
      registrationExtras.student_status ??
        registrationExtras.studentStatus ??
        secondaryRow?.student_status ??
        ''
    ).trim(),
    batch: intakeBatch,
    intakeBatch,
    admissionNumber: String(primaryRow?.admission_number || '').trim(),
    studentName: primaryRow?.student_name || '',
    managedCourseId:
      primaryRow?.managed_course_id ||
      primaryRow?.joining_managed_course_id ||
      registrationExtras.managed_course_id ||
      registrationExtras.managedCourseId ||
      null,
    managedBranchId:
      primaryRow?.managed_branch_id ||
      primaryRow?.joining_managed_branch_id ||
      registrationExtras.managed_branch_id ||
      registrationExtras.managedBranchId ||
      null,
    collegeId:
      registrationExtras.college_id ??
      registrationExtras.collegeId ??
      registrationExtras.school_or_college_id ??
      registrationExtras.schoolOrCollegeId ??
      null,
    transportDetails,
  };
}

function summarizePortalLine(line) {
  return {
    structureId: line.structureId || null,
    feeHead: line.feeHeadName || line.feeHeadCode || line.feeHeadId || 'Fee head',
    feeHeadCode: line.feeHeadCode || null,
    studentYear: line.studentYear ?? null,
    catalogAmount: line.actualAmount ?? null,
    payableAmount: line.revisedAmount ?? line.actualAmount ?? null,
    isRevised: Boolean(line.isRevised),
    concessionType: line.concessionType || null,
    accommodationType: line.accommodationType || null,
  };
}

function summarizeFeeStructureDoc(doc) {
  return {
    id: doc._id ? String(doc._id) : null,
    category: doc.category || null,
    course: doc.course || null,
    branch: doc.branch || null,
    college: doc.college || null,
    batch: doc.batch || null,
    studentYear: doc.studentYear ?? null,
    semester: doc.semester ?? null,
    amount: typeof doc.amount === 'number' ? doc.amount : Number(doc.amount) || 0,
    feeHeadId: doc.feeHead ? String(doc.feeHead) : null,
    feeHeadName: doc.feeHeadName || null,
    feeHeadCode: doc.feeHeadCode || null,
  };
}

function summarizeStudentFeeLedgerRow(row) {
  return {
    id: row._id ? String(row._id) : null,
    feeHeadId: row.feeHead ? String(row.feeHead) : null,
    feeHeadName: row.feeHeadName || row.remarks || null,
    academicYear: row.academicYear ?? null,
    studentYear: row.studentYear ?? null,
    semester: row.semester ?? null,
    amount: row.amount ?? row.totalAmount ?? null,
    paidAmount: row.paidAmount ?? row.amountPaid ?? null,
    balance: row.balance ?? null,
    status: row.status ?? null,
    remarks: row.remarks ?? null,
    source: row.source ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

async function fetchCatalogStructures(db, catalogLookup) {
  if (!catalogLookup) return [];
  const filter = {};
  const exact = (value) => {
    const escaped = String(value || '')
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}$`, 'i');
  };
  if (catalogLookup.course) filter.course = exact(catalogLookup.course);
  if (catalogLookup.branch) filter.branch = exact(catalogLookup.branch);
  if (catalogLookup.categoryMapped) filter.category = exact(catalogLookup.categoryMapped);
  if (catalogLookup.resolvedBatch) filter.batch = exact(catalogLookup.resolvedBatch);

  const docs = await db
    .collection('feestructures')
    .find(filter)
    .sort({ studentYear: 1, batch: 1 })
    .toArray();
  return docs.map(summarizeFeeStructureDoc);
}

async function buildFeeManagementReport(primaryRow, secondaryRow = null) {
  const joiningId = String(primaryRow?.joining_id_row || primaryRow?.joining_id || '').trim();
  const admissionNumber = String(primaryRow?.admission_number || '').trim();
  const studentFeeDetails = extractStudentFeeDetails(primaryRow);
  const joiningContext = buildJoiningFeeSyncContext(primaryRow, secondaryRow);

  if (!joiningId) {
    return { error: 'No joining id on admission row — fee catalog cannot be resolved.' };
  }

  if (!process.env.FEE_MANAGEMENT_MONGO_URI?.trim()) {
    return { error: 'FEE_MANAGEMENT_MONGO_URI is not configured in .env' };
  }

  const plan = await buildJoiningStepFourSyncPlan({
    joiningId,
    leadId: primaryRow?.lead_id || null,
    studentFeeDetails,
    joiningContext,
  });

  const conn = await connectFeeManagement();
  const db = conn.db;

  const catalogStructures = await fetchCatalogStructures(db, plan.catalogLookup);

  const crmDoc = await db
    .collection(JOINING_STUDENT_FEE_MONGO_COLLECTION)
    .findOne({ joiningId });

  const studentFeesRows = admissionNumber
    ? await db
        .collection(FEE_PORTAL_STUDENT_FEES_COLLECTION)
        .find({ studentId: admissionNumber })
        .sort({ studentYear: 1, academicYear: 1 })
        .toArray()
    : [];

  const portalLines = (plan.lines || []).map(summarizePortalLine);
  const catalogLines = portalLines.filter((line) => !line.accommodationType);
  const accommodationLines = portalLines.filter((line) => line.accommodationType);
  const revisedLines = portalLines.filter((line) => line.isRevised);

  return {
    step4Input: {
      joiningId,
      leadId: primaryRow?.lead_id || null,
      admissionNumber,
      quota: joiningContext.quota,
      studentStatus: joiningContext.studentStatus || null,
      course: joiningContext.course,
      branch: joiningContext.branch,
      intakeBatch: joiningContext.intakeBatch || null,
      managedCourseId: joiningContext.managedCourseId || null,
      managedBranchId: joiningContext.managedBranchId || null,
      builderBatch: studentFeeDetails?.batch || null,
      builderLineCount: Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines.length : 0,
    },
    feeCatalogLookup: plan.catalogLookup || null,
    feeCatalogMatch: {
      matchedStructureCount: plan.catalogRowCount ?? catalogStructures.length,
      batchMatchMode: plan.catalogLookup?.batchMatchMode || null,
      structures: catalogStructures,
    },
    feeLinesAppliedForStudent: {
      totalPortalLines: plan.lineCount ?? portalLines.length,
      catalogAndTuitionLines: catalogLines,
      accommodationLines,
      revisedOrConcessionLines: revisedLines,
    },
    persistedInFeeManagementMongo: {
      crmJoiningStudentFeeDetails: crmDoc
        ? {
            joiningId: crmDoc.joiningId || null,
            admissionNumber: crmDoc.admissionNumber || null,
            quota: crmDoc.quota || null,
            batch: crmDoc.batch || null,
            requestedBatch: crmDoc.requestedBatch || null,
            batchMatchMode: crmDoc.batchMatchMode || null,
            lineCount: Array.isArray(crmDoc.lines) ? crmDoc.lines.length : 0,
            lines: (crmDoc.lines || []).slice(0, 20).map(summarizePortalLine),
            updatedAt: crmDoc.updatedAt || null,
          }
        : null,
      studentFeesLedger: {
        rowCount: studentFeesRows.length,
        rows: studentFeesRows.map(summarizeStudentFeeLedgerRow),
      },
    },
    feeDiagnosis: (() => {
      const notes = [];
      const lookup = plan.catalogLookup;
      if (!lookup?.categoryMapped) {
        notes.push('Quota did not map to a fee catalog category (CONV/MANG/SPOT/LATER/LSPOT).');
      } else {
        notes.push(
          `Quota "${joiningContext.quota}" maps to fee category "${lookup.categoryMapped}" for catalog lookup (Lateral Entry uses LATER, not CONV).`
        );
      }
      if ((plan.catalogRowCount ?? 0) === 0) {
        notes.push(
          `No feestructures for batch ${lookup?.requestedBatch || '—'} — Step 4 / Fee Mongo mirror stays empty until catalog is added for that batch (no prior-year fallback).`
        );
      }
      if (!crmDoc && (plan.lineCount ?? 0) > 0) {
        notes.push('Catalog matches exist but crm_joining_student_fee_details has no saved document yet.');
      }
      if ((plan.lineCount ?? 0) > 0 && studentFeesRows.length === 0) {
        notes.push('Portal lines were built but studentfees ledger has no rows — fee sync may not have run.');
      }
      if (notes.length === 0) {
        notes.push('Fee catalog, CRM mirror, and ledger appear present for this student.');
      }
      return notes;
    })(),
    dryRunHints: {
      step4DryRun: `node src/scripts/dryRunJoiningStepFourSync.js --admission-number=${admissionNumber}`,
      resyncFees: 'Re-save Step 4 / approve fee request to push studentfees ledger again.',
    },
  };
}

async function buildAdmissionInspectionReport(primaryRow, secondaryRow = null) {
  const secondaryInfo = secondaryRow ? extractSecondaryQuota(secondaryRow) : {};
  const primaryQuota =
    primaryRow?.admission_quota || primaryRow?.joining_quota || primaryRow?.lead_quota || '';

  let feeManagement = null;
  try {
    feeManagement = await buildFeeManagementReport(primaryRow, secondaryRow);
  } catch (error) {
    feeManagement = {
      error: error?.message || String(error),
    };
  }

  return {
    admission_number: primaryRow?.admission_number || null,
    primary: summarizePrimaryRow(primaryRow),
    secondary: secondaryRow
      ? {
          id: secondaryRow.id,
          admission_number: secondaryRow.admission_number,
          student_name: secondaryRow.student_name,
          course: secondaryRow.course,
          branch: secondaryRow.branch,
          stud_type: secondaryRow.stud_type,
          batch: secondaryRow.batch,
          college: secondaryRow.college,
          student_status: secondaryRow.student_status,
          updated_at: secondaryRow.updated_at,
          ...secondaryInfo,
        }
      : null,
    diagnosis: buildDiagnosis(primaryQuota, secondaryInfo),
    feeManagement,
    resyncHint: primaryRow?.admission_number
      ? `node src/scripts/resyncSecondaryStudentByAdmissionNumber.js ${primaryRow.admission_number}`
      : null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.name && !args.admissionNumber) {
    console.error(
      'Usage: node src/scripts/inspectStudentQuotaPrimaryVsSecondary.js "STUDENT NAME"\n' +
        '   or: node src/scripts/inspectStudentQuotaPrimaryVsSecondary.js --admission 20260123'
    );
    process.exit(1);
  }

  const primary = await connectPrimary();
  const secondary = await connectSecondary();

  try {
    if (args.admissionNumber) {
      const primaryRow = await fetchPrimaryByAdmission(primary, args.admissionNumber);
      const secondaryRow = await fetchSecondaryByAdmission(secondary, args.admissionNumber);

      console.log(
        JSON.stringify(
          {
            query: { admissionNumber: args.admissionNumber },
            ...(primaryRow
              ? await buildAdmissionInspectionReport(primaryRow, secondaryRow)
              : { error: 'No admission found for this admission number.' }),
          },
          null,
          2
        )
      );
      return;
    }

    const { admRows, joinRows, leadRows } = await fetchPrimaryByName(primary, args.name);
    const secondaryRows = await fetchSecondaryByName(secondary, args.name);

    const reports = [];
    for (const row of admRows) {
      const admissionNumber = row.admission_number;
      const secondaryRow =
        secondaryRows.find(
          (s) => String(s.admission_number || s.admission_no || '').trim() === admissionNumber
        ) || null;
      reports.push(await buildAdmissionInspectionReport(row, secondaryRow));
    }

    console.log(
      JSON.stringify(
        {
          query: { studentName: args.name },
          primaryMatches: {
            admissions: admRows.length,
            joiningsWithoutAdmissionInResults: joinRows.length,
            leads: leadRows.length,
          },
          primaryJoiningOnly: joinRows
            .filter((j) => !admRows.some((a) => a.joining_id === j.id))
            .map((j) => ({
              joining_id: j.id,
              student_name: j.student_name,
              joining_quota: j.joining_quota,
              lead_quota: j.lead_quota,
              status: j.status,
              enquiry_number: j.enquiry_number,
            })),
          primaryLeadOnly: leadRows
            .filter((l) => !admRows.some((a) => a.lead_id === l.id))
            .map((l) => ({
              lead_id: l.id,
              name: l.name,
              lead_quota: l.lead_quota,
              enquiry_number: l.enquiry_number,
              source: l.source,
            })),
          secondaryMatches: secondaryRows.map((s) => {
            const info = extractSecondaryQuota(s);
            return {
              id: s.id,
              admission_number: s.admission_number,
              student_name: s.student_name,
              stud_type: s.stud_type,
              quotaFromStudentData: info.quotaFromStudentData,
              syncedAt: info.syncedAt,
              updated_at: s.updated_at,
            };
          }),
          admissionReports: reports,
        },
        null,
        2
      )
    );
  } finally {
    await primary.end();
    await secondary.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
