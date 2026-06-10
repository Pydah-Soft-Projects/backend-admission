/**
 * One-off: compare all 2026 admissions (primary) vs secondary students.
 * Usage: node src/scripts/verify2026SecondarySyncOnce.js
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

function normName(s) {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function normLabel(s) {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
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

async function main() {
  const primary = await connectPrimary();
  const secondary = await connectSecondary();

  const [primaryRows] = await primary.execute(
    `SELECT admission_number, student_name, status, course, branch,
            managed_course_id, managed_branch_id, created_at
     FROM admissions
     WHERE admission_number LIKE '2026%'
     ORDER BY CAST(admission_number AS UNSIGNED)`
  );

  const [secondaryRows] = await secondary.execute(
    `SELECT admission_number, student_name, course, branch, stud_type,
            batch, current_year, student_status
     FROM students
     WHERE admission_number LIKE '2026%'
     ORDER BY CAST(admission_number AS UNSIGNED)`
  );

  const primaryMap = new Map(primaryRows.map((r) => [String(r.admission_number).trim(), r]));
  const secondaryMap = new Map(secondaryRows.map((r) => [String(r.admission_number).trim(), r]));

  const missingInSecondary = [];
  const missingInPrimary = [];
  const nameMismatches = [];
  const courseMismatches = [];
  const branchMismatches = [];

  for (const [num, p] of primaryMap) {
    const s = secondaryMap.get(num);
    if (!s) {
      if (p.status !== 'Admission Cancelled') {
        missingInSecondary.push({
          admission_number: num,
          student_name: p.student_name,
          status: p.status,
          course: p.course,
          branch: p.branch,
        });
      }
      continue;
    }

    const pn = normName(p.student_name);
    const sn = normName(s.student_name);
    if (pn && sn && pn !== sn) {
      nameMismatches.push({
        admission_number: num,
        primary_name: p.student_name,
        secondary_name: s.student_name,
      });
    }

    const pc = normLabel(p.course);
    const sc = normLabel(s.course);
    const lateralPrimary = /LATERAL/.test(pc);
    const secondaryMatchesLateralBase =
      lateralPrimary && sc === normLabel(String(p.course || '').replace(/\(LATERAL\)/i, '').trim());
    if (pc && sc && pc !== sc && !secondaryMatchesLateralBase) {
      courseMismatches.push({
        admission_number: num,
        primary_course: p.course,
        secondary_course: s.course,
      });
    }

    const pb = normLabel(p.branch);
    const sb = normLabel(s.branch);
    if (pb && sb && pb !== sb) {
      branchMismatches.push({
        admission_number: num,
        primary_branch: p.branch,
        secondary_branch: s.branch,
      });
    }
  }

  for (const [num, s] of secondaryMap) {
    if (!primaryMap.has(num)) {
      missingInPrimary.push({
        admission_number: num,
        student_name: s.student_name,
        course: s.course,
        branch: s.branch,
      });
    }
  }

  const activePrimary = primaryRows.filter((r) => r.status !== 'Admission Cancelled');
  const synced = activePrimary.length - missingInSecondary.length;

  const report = {
    ok:
      missingInSecondary.length === 0 &&
      nameMismatches.length === 0 &&
      courseMismatches.length === 0 &&
      branchMismatches.length === 0,
    summary: {
      primary_2026_total: primaryRows.length,
      primary_2026_active: activePrimary.length,
      secondary_2026_total: secondaryRows.length,
      synced_active: synced,
      missing_in_secondary: missingInSecondary.length,
      missing_in_primary: missingInPrimary.length,
      name_mismatches: nameMismatches.length,
      course_mismatches: courseMismatches.length,
      branch_mismatches: branchMismatches.length,
    },
    missing_in_secondary: missingInSecondary,
    missing_in_primary: missingInPrimary,
    name_mismatches: nameMismatches,
    course_mismatches: courseMismatches,
    branch_mismatches: branchMismatches,
  };

  console.log(JSON.stringify(report, null, 2));

  await primary.end();
  await secondary.end();
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
