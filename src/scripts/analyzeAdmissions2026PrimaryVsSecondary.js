/**
 * Cross-check primary `admissions` (2026+) vs secondary `courses` / `course_branches`.
 *
 * Usage (from backend-admission):
 *   node src/scripts/analyzeAdmissions2026PrimaryVsSecondary.js
 *
 * Requires .env: DB_* and DB_SECONDARY_* (same as the API).
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const YEAR_START = '2026-01-01';

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
  const issues = [];
  const notes = [];

  let primary;
  let secondary;
  try {
    primary = await connectPrimary();
  } catch (e) {
    console.error('Primary DB connection failed:', e.message);
    process.exit(1);
  }
  try {
    secondary = await connectSecondary();
  } catch (e) {
    console.error('Secondary DB connection failed:', e.message);
    issues.push({ code: 'SECONDARY_UNREACHABLE', detail: e.message });
    await primary.end();
    printReport({ issues, notes, summary: null });
    process.exit(1);
  }

  const [dbPrimary] = await primary.execute('SELECT DATABASE() AS db');
  const [dbSecondary] = await secondary.execute('SELECT DATABASE() AS db');
  notes.push(`Primary database: ${dbPrimary[0]?.db}`);
  notes.push(`Secondary database: ${dbSecondary[0]?.db}`);

  const [admissions] = await primary.execute(
    `SELECT
       a.id,
       a.admission_number,
       a.status,
       a.course_id,
       a.branch_id,
       a.course,
       a.branch,
       a.created_at
     FROM admissions a
     WHERE a.created_at >= ?
     ORDER BY a.created_at ASC`,
    [YEAR_START]
  );

  const [secCourses] = await secondary.execute(
    'SELECT id, name, is_active FROM courses ORDER BY name ASC'
  );

  let secBranches = [];
  try {
    const [rows] = await secondary.execute(
      'SELECT id, course_id, name, is_active FROM course_branches ORDER BY course_id, name ASC'
    );
    secBranches = rows || [];
  } catch {
    notes.push('Secondary: no `course_branches` table or query failed — branch checks skipped.');
  }

  const activeCourseById = new Map();
  const anyCourseById = new Map();
  const nameNormToActiveIds = new Map();

  for (const c of secCourses) {
    const id = String(c.id);
    anyCourseById.set(id, c);
    if (c.is_active === 1 || c.is_active === true) {
      activeCourseById.set(id, c);
      const nk = normLabel(c.name);
      if (!nameNormToActiveIds.has(nk)) nameNormToActiveIds.set(nk, []);
      nameNormToActiveIds.get(nk).push(id);
    }
  }

  const activeBranchById = new Map();
  for (const b of secBranches) {
    const id = String(b.id);
    if (b.is_active === 1 || b.is_active === true) {
      activeBranchById.set(id, b);
    }
  }

  const duplicateActiveNames = [];
  for (const [nk, ids] of nameNormToActiveIds) {
    if (ids.length > 1) {
      duplicateActiveNames.push({
        normalizedName: nk,
        courseIds: ids,
        names: ids.map((i) => anyCourseById.get(i)?.name),
      });
    }
  }
  if (duplicateActiveNames.length) {
    issues.push({
      code: 'SECONDARY_DUPLICATE_ACTIVE_COURSE_NAMES',
      count: duplicateActiveNames.length,
      examples: duplicateActiveNames.slice(0, 15),
    });
  }

  const byStatus = {};
  let nullCourseId = 0;
  let emptyCourseText = 0;
  const courseIdNotInSecondary = [];
  const courseIdInactiveInSecondary = [];
  const textVsSecondaryNameMismatch = [];
  const branchMissingOrUnknown = [];
  const branchCourseMismatch = [];

  for (const a of admissions) {
    const st = a.status || 'unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;

    const cid =
      a.course_id != null && String(a.course_id).trim() !== '' ? String(a.course_id).trim() : null;
    const ctext = String(a.course || '').trim();

    if (!cid) {
      nullCourseId += 1;
      const bid =
        a.branch_id != null && String(a.branch_id).trim() !== '' ? String(a.branch_id).trim() : null;
      if (bid) {
        const br = activeBranchById.get(bid) || secBranches.find((x) => String(x.id) === bid);
        if (!br) {
          branchMissingOrUnknown.push({
            admission_number: a.admission_number,
            branch_id: bid,
            branch_text: String(a.branch || '').trim() || null,
            note: 'course_id also null',
          });
        }
      }
      continue;
    }

    if (!ctext) emptyCourseText += 1;

    const secRow = anyCourseById.get(cid);
    if (!secRow) {
      courseIdNotInSecondary.push({
        admission_number: a.admission_number,
        course_id: cid,
        course_text: ctext || null,
        status: a.status,
        created_at: a.created_at,
      });
      continue;
    }

    const active = secRow.is_active === 1 || secRow.is_active === true;
    if (!active) {
      courseIdInactiveInSecondary.push({
        admission_number: a.admission_number,
        course_id: cid,
        secondary_name: secRow.name,
        admission_course_text: ctext || null,
        status: a.status,
      });
    }

    if (ctext && normLabel(ctext) !== normLabel(secRow.name)) {
      textVsSecondaryNameMismatch.push({
        admission_number: a.admission_number,
        course_id: cid,
        admission_course_text: ctext,
        secondary_course_name: secRow.name,
        status: a.status,
      });
    }

    const bid =
      a.branch_id != null && String(a.branch_id).trim() !== '' ? String(a.branch_id).trim() : null;
    if (bid) {
      const br = activeBranchById.get(bid) || secBranches.find((x) => String(x.id) === bid);
      if (!br) {
        branchMissingOrUnknown.push({
          admission_number: a.admission_number,
          branch_id: bid,
          branch_text: String(a.branch || '').trim() || null,
        });
      } else if (String(br.course_id) !== String(cid)) {
        branchCourseMismatch.push({
          admission_number: a.admission_number,
          admission_course_id: cid,
          branch_id: bid,
          branch_course_id: String(br.course_id),
          branch_name: br.name,
        });
      }
    }
  }

  if (nullCourseId) {
    issues.push({
      code: 'ADMISSIONS_MISSING_COURSE_ID',
      count: nullCourseId,
      hint: 'Pivot by course_id cannot distribute counts; all rows share NULL. Fix by backfilling from joinings / branch resolution or correcting INSERT on approval.',
    });
  }
  if (emptyCourseText) {
    issues.push({
      code: 'ADMISSIONS_EMPTY_COURSE_TEXT',
      count: emptyCourseText,
      hint: 'Reports that fall back to secondary name are OK; pure text reports may show Unknown.',
    });
  }
  if (courseIdNotInSecondary.length) {
    issues.push({
      code: 'ADMISSION_COURSE_ID_NOT_IN_SECONDARY',
      count: courseIdNotInSecondary.length,
      examples: courseIdNotInSecondary.slice(0, 20),
    });
  }
  if (courseIdInactiveInSecondary.length) {
    issues.push({
      code: 'ADMISSION_POINTS_TO_INACTIVE_SECONDARY_COURSE',
      count: courseIdInactiveInSecondary.length,
      examples: courseIdInactiveInSecondary.slice(0, 15),
    });
  }
  if (textVsSecondaryNameMismatch.length) {
    issues.push({
      code: 'ADMISSION_COURSE_TEXT_DIFFERS_FROM_SECONDARY_COURSE_NAME',
      count: textVsSecondaryNameMismatch.length,
      hint: 'Often benign (abbreviation); breaks naive label-only joins.',
      examples: textVsSecondaryNameMismatch.slice(0, 20),
    });
  }
  if (branchMissingOrUnknown.length) {
    issues.push({
      code: 'ADMISSION_BRANCH_ID_NOT_FOUND_IN_SECONDARY_BRANCHES',
      count: branchMissingOrUnknown.length,
      examples: branchMissingOrUnknown.slice(0, 15),
    });
  }
  if (branchCourseMismatch.length) {
    issues.push({
      code: 'ADMISSION_BRANCH_BELONGS_TO_DIFFERENT_COURSE_THAN_ADMISSION_COURSE_ID',
      count: branchCourseMismatch.length,
      examples: branchCourseMismatch.slice(0, 15),
    });
  }

  const [distinctPrimary] = await primary.execute(
    `SELECT a.course_id, MAX(a.course) AS course_text, COUNT(*) AS cnt
     FROM admissions a
     WHERE a.created_at >= ?
     GROUP BY a.course_id`,
    [YEAR_START]
  );

  const [distinctTextBranch] = await primary.execute(
    `SELECT a.course, a.branch, COUNT(*) AS cnt
     FROM admissions a
     WHERE a.created_at >= ? AND (a.course_id IS NULL OR TRIM(CAST(a.course_id AS CHAR)) = '')
     GROUP BY a.course, a.branch
     ORDER BY cnt DESC`,
    [YEAR_START]
  );

  const [joiningSample] = await primary.execute(
    `SELECT j.id, j.course_id AS joining_course_id, j.branch_id AS joining_branch_id,
            j.course AS joining_course, j.branch AS joining_branch
     FROM joinings j
     INNER JOIN admissions a ON a.joining_id = j.id
     WHERE a.created_at >= ?
     LIMIT 5`,
    [YEAR_START]
  );

  const [joiningFkStats] = await primary.execute(
    `SELECT
       SUM(CASE WHEN j.course_id IS NULL OR TRIM(CAST(j.course_id AS CHAR)) = '' THEN 1 ELSE 0 END) AS joining_null_course,
       SUM(CASE WHEN j.branch_id IS NULL OR TRIM(CAST(j.branch_id AS CHAR)) = '' THEN 1 ELSE 0 END) AS joining_null_branch,
       COUNT(*) AS total
     FROM admissions a
     INNER JOIN joinings j ON j.id = a.joining_id
     WHERE a.created_at >= ?`,
    [YEAR_START]
  );

  const jstat = joiningFkStats[0] || {};
  if (Number(jstat.total) > 0 && Number(jstat.joining_null_course) === Number(jstat.total)) {
    issues.push({
      code: 'JOININGS_MISSING_COURSE_ID_FOR_ALL_2026_ADMISSIONS',
      count: Number(jstat.total),
      hint: 'Source joinings rows also lack course_id; approval path resolvePrimaryCourseBranchFkIds only accepts ids present in primary `courses` / `branches`, while UI uses student DB ids — FKs stay NULL and only denormalized course/branch text is filled.',
    });
  }

  const summary = {
    filter: { created_at_from: YEAR_START },
    admissions_2026_plus: admissions.length,
    by_status: byStatus,
    secondary_active_courses: activeCourseById.size,
    secondary_total_courses: anyCourseById.size,
    duplicate_active_normalized_course_names: duplicateActiveNames.length,
    distinct_admission_course_id_rows: distinctPrimary.length,
    joining_fk_null_stats: {
      rows: Number(jstat.total || 0),
      joining_null_course_id: Number(jstat.joining_null_course || 0),
      joining_null_branch_id: Number(jstat.joining_null_branch || 0),
    },
    counts: {
      missing_course_id: nullCourseId,
      empty_denormalized_course_text: emptyCourseText,
      course_id_not_found_secondary: courseIdNotInSecondary.length,
      inactive_secondary_course: courseIdInactiveInSecondary.length,
      text_vs_secondary_name_mismatch: textVsSecondaryNameMismatch.length,
      branch_id_unknown: branchMissingOrUnknown.length,
      branch_course_mismatch: branchCourseMismatch.length,
    },
  };

  if (distinctPrimary?.length === 1 && distinctPrimary[0].course_id == null) {
    notes.push(
      'When every row has NULL course_id, GROUP BY course_id is a single bucket — MAX(course) is not a reliable summary of a mix (lexicographic max can hide B.Tech/B.Sc). Use denormalized (course, branch) breakdown below.'
    );
  }

  await primary.end();
  await secondary.end();

  printReport({ issues, notes, summary, distinctPrimary, distinctTextBranch, joiningSample });
}

function printReport({ issues, notes, summary, distinctPrimary, distinctTextBranch, joiningSample }) {
  console.log('\n=== Admissions (primary) vs Secondary — analysis ===\n');
  for (const n of notes) console.log(`• ${n}`);
  console.log('\n--- Summary (JSON) ---\n');
  console.log(JSON.stringify(summary, null, 2));

  if (distinctPrimary?.length) {
    console.log('\n--- Distinct course_id on admissions (2026+) ---\n');
    console.log(
      JSON.stringify(
        distinctPrimary.map((r) => ({
          course_id: r.course_id != null ? String(r.course_id) : null,
          course_text: r.course_text,
          cnt: Number(r.cnt),
        })),
        null,
        2
      )
    );
  }

  if (distinctTextBranch?.length) {
    console.log('\n--- Denormalized (course, branch) when course_id is NULL (2026+) ---\n');
    console.log(JSON.stringify(distinctTextBranch, null, 2));
  }

  if (joiningSample?.length) {
    console.log('\n--- Sample joinings linked to 2026+ admissions (course_id on joining) ---\n');
    console.log(JSON.stringify(joiningSample, null, 2));
  }

  console.log('\n--- Issues found ---\n');
  if (!issues.length) {
    console.log('No structural issues detected by this script.');
  } else {
    console.log(JSON.stringify(issues, null, 2));
  }
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
