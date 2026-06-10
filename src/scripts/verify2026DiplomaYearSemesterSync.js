/**
 * Verify 2026 Diploma students: batch, year-of-study, semester (primary vs secondary).
 * Usage: node src/scripts/verify2026DiplomaYearSemesterSync.js
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import {
  resolveSecondarySemesterForSync,
  resolveSecondaryYearOfStudy,
} from '../utils/lateralBatch.util.js';
import { resolveSecondaryStudentBatch } from '../utils/studentSync.util.js';

dotenv.config();

const EXPECTED_BATCH = '2026';
const EXPECTED_YEAR_OF_STUDY = 1;
const EXPECTED_SEMESTER = '1-1';

function parseJson(v) {
  try {
    return typeof v === 'string' ? JSON.parse(v || '{}') : { ...(v || {}) };
  } catch {
    return {};
  }
}

function registrationExtrasFromLeadData(leadData) {
  const ld = parseJson(leadData);
  const ex = ld._joiningRegistrationExtras;
  return ex && typeof ex === 'object' ? ex : {};
}

function isDiplomaCourse(course) {
  const c = String(course ?? '').trim().toLowerCase();
  return c === 'diploma';
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

function normBatch(v) {
  return String(v ?? '').trim();
}

async function main() {
  const primary = await connectPrimary();
  const secondary = await connectSecondary();

  const [primaryRows] = await primary.execute(`
    SELECT a.id, a.admission_number, a.student_name, a.course, a.branch, a.status,
           a.lead_data, a.joining_id
    FROM admissions a
    WHERE a.admission_number LIKE '2026%'
      AND LOWER(TRIM(a.course)) = 'diploma'
  `);

  primaryRows.sort(
    (a, b) =>
      Number.parseInt(String(a.admission_number), 10) -
      Number.parseInt(String(b.admission_number), 10)
  );

  const [secondaryRows] = await secondary.execute(`
    SELECT admission_number, student_name, course, branch, batch, current_year, student_status, student_data
    FROM students
    WHERE admission_number LIKE '2026%'
      AND LOWER(TRIM(course)) = 'diploma'
  `);
  const secondaryMap = new Map(
    secondaryRows.map((r) => [String(r.admission_number).trim(), r])
  );

  const activeRows = primaryRows.filter((r) => r.status !== 'Admission Cancelled');

  const issues = [];
  const summary = {
    total_diploma: primaryRows.length,
    active_diploma: activeRows.length,
    missing_in_secondary: 0,
    batch_mismatch: 0,
    year_mismatch: 0,
    semester_mismatch: 0,
    primary_missing_semester: 0,
  };

  for (const row of activeRows) {
    const num = String(row.admission_number).trim();
    const extras = registrationExtrasFromLeadData(row.lead_data);
    const expectedBatch =
      resolveSecondaryStudentBatch(extras, num) || EXPECTED_BATCH;
    const expectedYear =
      resolveSecondaryYearOfStudy(extras) ?? EXPECTED_YEAR_OF_STUDY;
    const expectedSem =
      resolveSecondarySemesterForSync(extras, num, row.course) || EXPECTED_SEMESTER;

    const primaryBatch = normBatch(extras.batch ?? extras.academic_year ?? extras.academicYear);
    const primarySem = normBatch(
      extras.semester ?? extras.current_semester ?? extras.currentSemester ?? extras.semister
    );
    const primaryYearRaw = extras.current_year ?? extras.currentYear;

    if (!primarySem) summary.primary_missing_semester += 1;

    const sec = secondaryMap.get(num);
    if (!sec) {
      summary.missing_in_secondary += 1;
      issues.push({ admission_number: num, code: 'MISSING_IN_SECONDARY', student_name: row.student_name });
      continue;
    }

    const sd = parseJson(sec.student_data);
    const regForm =
      sd.registrationFormData && typeof sd.registrationFormData === 'object'
        ? sd.registrationFormData
        : {};
    const secBatch = normBatch(sec.batch ?? sd.batch ?? sd.academic_year ?? regForm.batch);
    const secYear = Number(sec.current_year ?? sd.current_year ?? sd.currentYear ?? regForm.current_year);
    const secSem = normBatch(
      sd.semester ??
        sd.current_semester ??
        sd.currentSemester ??
        sd.semister ??
        regForm.semester ??
        regForm.current_semester ??
        regForm.semister
    );

    const batchBad = secBatch !== normBatch(expectedBatch);
    const yearBad = !Number.isFinite(secYear) || secYear !== expectedYear;
    const semBad = secSem !== expectedSem;

    if (batchBad) summary.batch_mismatch += 1;
    if (yearBad) summary.year_mismatch += 1;
    if (semBad) summary.semester_mismatch += 1;

    if (batchBad || yearBad || semBad) {
      issues.push({
        admission_number: num,
        student_name: row.student_name,
        branch: row.branch,
        expected: { batch: expectedBatch, current_year: expectedYear, semester: expectedSem },
        primary_extras: {
          batch: primaryBatch || null,
          current_year: primaryYearRaw ?? null,
          semester: primarySem || null,
        },
        secondary: {
          batch: secBatch || null,
          current_year: Number.isFinite(secYear) ? secYear : null,
          semester: secSem || null,
        },
        flags: { batchBad, yearBad, semBad },
      });
    }
  }

  const ok =
    summary.missing_in_secondary === 0 &&
    summary.batch_mismatch === 0 &&
    summary.year_mismatch === 0 &&
    summary.semester_mismatch === 0;

  console.log(
    JSON.stringify(
      {
        ok,
        expected_defaults: {
          batch: EXPECTED_BATCH,
          current_year: EXPECTED_YEAR_OF_STUDY,
          semester: EXPECTED_SEMESTER,
        },
        summary,
        issues: issues.slice(0, 30),
        issue_count: issues.length,
      },
      null,
      2
    )
  );

  await primary.end();
  await secondary.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
