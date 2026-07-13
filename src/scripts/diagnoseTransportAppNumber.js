/**
 * Diagnose transport application number preview vs transport_requests.
 *
 * Usage:
 *   node src/scripts/diagnoseTransportAppNumber.js --academic-year=2026-2027 --course=B.Tech
 *   node src/scripts/diagnoseTransportAppNumber.js --college-id=1 --managed-course-id=5 --academic-year=2026
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database-secondary.js';
import {
  peekNextTransportApplicationNumber,
  resolveTransportApplicationCodes,
  parseTransportApplicationNumber,
  transportApplicationScopeMatches,
  calendarYearToAcademicYearSession,
} from '../utils/transportApplicationNumber.util.js';

dotenv.config();

const academicYearArg = process.argv.find((a) => a.startsWith('--academic-year='))?.split('=')[1];
const courseNameArg = process.argv.find((a) => a.startsWith('--course='))?.split('=')[1];
const collegeIdArg = process.argv.find((a) => a.startsWith('--college-id='))?.split('=')[1];
const managedCourseIdArg = process.argv.find((a) => a.startsWith('--managed-course-id='))?.split('=')[1];

async function main() {
  const pool = getPool();
  const academicYear = calendarYearToAcademicYearSession(academicYearArg || '2026');

  const { collegeCode, courseCode } = await resolveTransportApplicationCodes(pool, {
    collegeId: collegeIdArg ? Number(collegeIdArg) : null,
    managedCourseId: managedCourseIdArg ? Number(managedCourseIdArg) : null,
    courseName: courseNameArg || 'B.Tech',
  });

  console.log('Resolved codes:', { collegeCode, courseCode, academicYear });

  const [counters] = await pool.query(
    `SELECT * FROM transport_application_counters
     WHERE academic_year = ? AND college_code = ? AND course_code = ?`,
    [academicYear, collegeCode, courseCode]
  );
  console.log('\n--- transport_application_counters ---');
  console.log(counters);

  const [allBtech] = await pool.query(
    `SELECT application_number, application_serial, academic_year, status, admission_number
     FROM transport_requests
     WHERE application_number LIKE ?
     ORDER BY application_serial DESC, id DESC
     LIMIT 30`,
    [`${collegeCode}-${courseCode}-%`]
  );
  console.log(`\n--- transport_requests matching ${collegeCode}-${courseCode}-* (all AY) ---`);
  console.log('count:', allBtech.length);
  for (const row of allBtech) {
    console.log(row);
  }

  const [forAy] = await pool.query(
    `SELECT application_number, application_serial, academic_year, status
     FROM transport_requests
     WHERE academic_year = ?
       AND application_number IS NOT NULL
     ORDER BY application_serial DESC`,
    [academicYear]
  );
  console.log(`\n--- transport_requests for AY ${academicYear} ---`);
  let scoped = 0;
  let maxSerial = 0;
  for (const row of forAy) {
    if (transportApplicationScopeMatches(row.application_number, collegeCode, courseCode)) {
      scoped += 1;
      const parsed = parseTransportApplicationNumber(row.application_number);
      const serial = row.application_serial != null ? Number(row.application_serial) : parsed?.serial;
      if (serial > maxSerial) maxSerial = serial;
    }
  }
  console.log('scoped to college/course:', scoped, 'max serial:', maxSerial);

  const peek = await peekNextTransportApplicationNumber(pool, academicYear, collegeCode, courseCode);
  console.log('\n--- peekNextTransportApplicationNumber (current code) ---');
  console.log(peek);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
