/**
 * Uses .env (DB_* and DB_SECONDARY_*):
 * 1) Ensures `managed_course_id` / `managed_branch_id` exist on joinings + admissions (idempotent).
 * 2) Backfills from `lead_data._joiningManagedCourseId` / `_joiningManagedBranchId`.
 * 3) For rows still missing managed course id, resolves ids from secondary `courses` / `course_branches`
 *    by normalized name match against admission `course` / `branch` text (and optional student row).
 * 4) Copies managed ids from admissions → joinings where joining is still empty.
 * 5) Merges `_crm_managed_course_id` / `_crm_managed_branch_id` into secondary `students.student_data`
 *    when primary admissions have managed ids.
 * 6) Prints a verification object including admission `20260001` on secondary + primary slice.
 *
 * Usage (from backend-admission):
 *   node src/scripts/syncManagedCourseBranchIdsAndVerifySecondary.js
 *   node src/scripts/syncManagedCourseBranchIdsAndVerifySecondary.js --dry-run
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import {
  isLateralRegistrationExtras,
  resolveExpectedBatchYear,
  resolveSecondaryYearOfStudy,
} from '../utils/lateralBatch.util.js';

dotenv.config();

const DRY = process.argv.includes('--dry-run');

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

async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function ensureSchema(primary) {
  const out = { joinings: false, admissions: false, indexes: [] };
  if (!(await columnExists(primary, 'joinings', 'managed_course_id'))) {
    await primary.execute(`
      ALTER TABLE joinings
        ADD COLUMN managed_course_id VARCHAR(64) NULL COMMENT 'Secondary student DB course id' AFTER branch_id,
        ADD COLUMN managed_branch_id VARCHAR(64) NULL COMMENT 'Secondary student DB branch id' AFTER managed_course_id
    `);
    out.joinings = true;
  }
  if (!(await columnExists(primary, 'admissions', 'managed_course_id'))) {
    await primary.execute(`
      ALTER TABLE admissions
        ADD COLUMN managed_course_id VARCHAR(64) NULL COMMENT 'Secondary student DB course id' AFTER branch_id,
        ADD COLUMN managed_branch_id VARCHAR(64) NULL COMMENT 'Secondary student DB branch id' AFTER managed_course_id
    `);
    out.admissions = true;
  }
  const idxStatements = [
    'ALTER TABLE joinings ADD INDEX idx_joinings_managed_course_id (managed_course_id)',
    'ALTER TABLE admissions ADD INDEX idx_admissions_managed_course_id (managed_course_id)',
  ];
  for (const sql of idxStatements) {
    try {
      await primary.execute(sql);
      out.indexes.push(sql.split('INDEX')[1]?.trim() || 'index');
    } catch (e) {
      if (String(e?.code) !== 'ER_DUP_KEYNAME') throw e;
    }
  }
  return out;
}

async function backfillFromLeadData(primary) {
  if (DRY) return { joinings: 0, admissions: 0 };
  const [j] = await primary.execute(`
    UPDATE joinings j
    SET
      managed_course_id = NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$._joiningManagedCourseId'))), ''),
      managed_branch_id = NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$._joiningManagedBranchId'))), '')
    WHERE
      (j.managed_course_id IS NULL OR TRIM(j.managed_course_id) = '')
      AND JSON_EXTRACT(j.lead_data, '$._joiningManagedCourseId') IS NOT NULL
      AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$._joiningManagedCourseId'))) != ''
  `);
  const [a] = await primary.execute(`
    UPDATE admissions a
    INNER JOIN joinings j ON j.id = a.joining_id
    SET
      a.managed_course_id = COALESCE(NULLIF(TRIM(a.managed_course_id), ''), NULLIF(TRIM(j.managed_course_id), '')),
      a.managed_branch_id = COALESCE(NULLIF(TRIM(a.managed_branch_id), ''), NULLIF(TRIM(j.managed_branch_id), ''))
    WHERE
      a.managed_course_id IS NULL
      OR TRIM(a.managed_course_id) = ''
  `);
  return { joinings: j.affectedRows ?? 0, admissions: a.affectedRows ?? 0 };
}

function pickCourseIdByName(normName, secCourses) {
  if (!normName) return null;
  const active = (secCourses || []).filter(
    (c) => normLabel(c.name) === normName && (c.is_active === 1 || c.is_active === true)
  );
  const pool = active.length ? active : (secCourses || []).filter((c) => normLabel(c.name) === normName);
  if (!pool.length) return null;
  pool.sort((x, y) => Number(x.id) - Number(y.id));
  return String(pool[0].id);
}

function pickBranchIdByName(courseIdStr, normBranch, secBranches) {
  if (!courseIdStr || !normBranch) return null;
  const active = (secBranches || []).filter(
    (b) =>
      String(b.course_id) === String(courseIdStr) &&
      normLabel(b.name) === normBranch &&
      (b.is_active === 1 || b.is_active === true)
  );
  const pool = active.length
    ? active
    : (secBranches || []).filter(
        (b) => String(b.course_id) === String(courseIdStr) && normLabel(b.name) === normBranch
      );
  if (!pool.length) return null;
  pool.sort((x, y) => Number(x.id) - Number(y.id));
  return String(pool[0].id);
}

async function resolveFromSecondaryNames(primary, secondary, secCourses, secBranches) {
  const [rows] = await primary.execute(`
    SELECT id, admission_number, joining_id, course, branch, managed_course_id, managed_branch_id
    FROM admissions
    WHERE (managed_course_id IS NULL OR TRIM(managed_course_id) = '')
      AND TRIM(COALESCE(course, '')) != ''
  `);
  let updated = 0;
  for (const r of rows) {
    const nc = normLabel(r.course);
    const nb = normLabel(r.branch);
    const mc = pickCourseIdByName(nc, secCourses);
    const mb = mc ? pickBranchIdByName(mc, nb, secBranches) : null;
    if (!mc) continue;
    if (!DRY) {
      await primary.execute(
        `UPDATE admissions SET managed_course_id = ?, managed_branch_id = ? WHERE id = ?`,
        [mc, mb, r.id]
      );
    }
    updated += 1;
  }
  return { candidates: rows.length, updated };
}

async function copyAdmissionManagedToJoinings(primary) {
  if (DRY) return 0;
  const [r] = await primary.execute(`
    UPDATE joinings j
    INNER JOIN admissions a ON a.joining_id = j.id
    SET
      j.managed_course_id = COALESCE(NULLIF(TRIM(j.managed_course_id), ''), NULLIF(TRIM(a.managed_course_id), '')),
      j.managed_branch_id = COALESCE(NULLIF(TRIM(j.managed_branch_id), ''), NULLIF(TRIM(a.managed_branch_id), ''))
    WHERE
      (j.managed_course_id IS NULL OR TRIM(j.managed_course_id) = '')
      AND a.managed_course_id IS NOT NULL
      AND TRIM(a.managed_course_id) != ''
  `);
  return r.affectedRows ?? 0;
}

function parseJson(val) {
  if (val == null) return {};
  if (typeof val === 'object') return { ...val };
  try {
    const o = JSON.parse(String(val));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function batchNeedsFix(current, expected) {
  const cur = String(current ?? '').trim();
  if (!expected) return false;
  if (!cur) return true;
  if (cur === expected) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(cur)) return true;
  if (/^(19|20)\d{2}$/.test(cur) && cur !== expected) return true;
  return false;
}

function registrationExtrasFromJoiningLeadData(joiningLeadData) {
  const jld = parseJson(joiningLeadData);
  return jld._joiningRegistrationExtras && typeof jld._joiningRegistrationExtras === 'object'
    ? jld._joiningRegistrationExtras
    : {};
}

async function backfillBatchFor2026Admissions(primary, secondary) {
  const [rows] = await primary.execute(`
    SELECT a.id, a.admission_number, a.joining_id, a.lead_data, j.lead_data AS joining_lead_data
    FROM admissions a
    LEFT JOIN joinings j ON j.id = a.joining_id
    WHERE a.admission_number LIKE '202600%'
  `);
  let primaryUpdated = 0;
  let joiningUpdated = 0;
  let secondaryUpdated = 0;
  const lateralFixed = [];

  for (const r of rows) {
    const num = String(r.admission_number).trim();
    const jex = registrationExtrasFromJoiningLeadData(r.joining_lead_data);
    const expected = resolveExpectedBatchYear(jex, num);
    if (!expected) continue;

    const ld = parseJson(r.lead_data);
    const admEx =
      ld._joiningRegistrationExtras && typeof ld._joiningRegistrationExtras === 'object'
        ? { ...ld._joiningRegistrationExtras }
        : { ...jex };
    if (batchNeedsFix(admEx.batch, expected)) {
      admEx.batch = expected;
      ld._joiningRegistrationExtras = admEx;
      if (!DRY) {
        await primary.execute('UPDATE admissions SET lead_data = ? WHERE id = ?', [
          JSON.stringify(ld),
          r.id,
        ]);
      }
      primaryUpdated += 1;
      if (isLateralRegistrationExtras(jex, num)) lateralFixed.push(num);
    }

    if (r.joining_id) {
      const jld = parseJson(r.joining_lead_data);
      const jexLocal =
        jld._joiningRegistrationExtras && typeof jld._joiningRegistrationExtras === 'object'
          ? { ...jld._joiningRegistrationExtras }
          : {};
      if (batchNeedsFix(jexLocal.batch, expected)) {
        jexLocal.batch = expected;
        jld._joiningRegistrationExtras = jexLocal;
        if (!DRY) {
          await primary.execute('UPDATE joinings SET lead_data = ? WHERE id = ?', [
            JSON.stringify(jld),
            r.joining_id,
          ]);
        }
        joiningUpdated += 1;
      }
    }

    const [sec] = await secondary.execute(
      'SELECT batch, current_year, student_status, student_data FROM students WHERE admission_number = ? LIMIT 1',
      [num]
    );
    if (!sec.length) continue;

    const lateral = isLateralRegistrationExtras(jex, num);
    const secBatchBad = batchNeedsFix(sec[0].batch, expected);
    const yearOfStudy = resolveSecondaryYearOfStudy(jex);
    const secYearBad =
      yearOfStudy != null && Number(sec[0].current_year) !== yearOfStudy;
    const secStatusBad =
      lateral && !/lateral/i.test(String(sec[0].student_status ?? ''));

    if (!secBatchBad && !secYearBad && !secStatusBad) continue;

    const sd = parseJson(sec[0].student_data);
    if (secBatchBad) {
      sd.batch = expected;
      if (sd.registrationFormData && typeof sd.registrationFormData === 'object') {
        sd.registrationFormData.batch = expected;
      }
    }
    if (!DRY) {
      await secondary.execute(
        `UPDATE students SET
           batch = COALESCE(?, batch),
           current_year = CASE WHEN ? THEN ? ELSE current_year END,
           student_status = CASE WHEN ? THEN 'Lateral' ELSE student_status END,
           student_data = ?,
           updated_at = NOW()
         WHERE admission_number = ?`,
        [
          secBatchBad ? expected : null,
          secYearBad ? 1 : 0,
          yearOfStudy,
          secStatusBad ? 1 : 0,
          JSON.stringify(sd),
          num,
        ]
      );
    }
    secondaryUpdated += 1;
    if (lateral) lateralFixed.push(num);
  }

  return {
    scanned: rows.length,
    primaryUpdated,
    joiningUpdated,
    secondaryUpdated,
    lateralAdmissionNumbers: [...new Set(lateralFixed)],
  };
}

async function backfillSecondaryStudentCollege(primary, secondary) {
  /** Fill `students.college` from managed course id when registration extras omitted college. */
  const [rows] = await primary.execute(`
    SELECT a.admission_number, a.managed_course_id
    FROM admissions a
    WHERE a.admission_number IS NOT NULL
      AND TRIM(a.admission_number) != ''
      AND a.managed_course_id IS NOT NULL
      AND TRIM(a.managed_course_id) != ''
  `);
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const num = String(r.admission_number).trim();
    const mc = String(r.managed_course_id).trim();
    const [sec] = await secondary.execute(
      `SELECT admission_number, college, student_data
       FROM students WHERE admission_number = ? LIMIT 1`,
      [num]
    );
    if (!sec.length) {
      skipped += 1;
      continue;
    }
    if (sec[0].college != null && String(sec[0].college).trim() !== '') {
      skipped += 1;
      continue;
    }
    const [courseRows] = await secondary.execute(
      'SELECT college_id FROM courses WHERE id = ? LIMIT 1',
      [mc]
    );
    if (!courseRows.length || courseRows[0].college_id == null) {
      skipped += 1;
      continue;
    }
    const collegeId = Number.parseInt(String(courseRows[0].college_id), 10);
    if (!Number.isFinite(collegeId)) {
      skipped += 1;
      continue;
    }
    const [collegeRows] = await secondary.execute(
      'SELECT name FROM colleges WHERE id = ? LIMIT 1',
      [collegeId]
    );
    const collegeName =
      collegeRows.length > 0 && collegeRows[0].name != null
        ? String(collegeRows[0].name).trim()
        : '';
    if (!collegeName) {
      skipped += 1;
      continue;
    }
    const sd = parseJson(sec[0].student_data);
    sd._crm_managed_college_id = String(collegeId);
    if (!DRY) {
      await secondary.execute(
        'UPDATE students SET college = ?, student_data = ?, updated_at = NOW() WHERE admission_number = ?',
        [collegeName, JSON.stringify(sd), num]
      );
    }
    updated += 1;
  }
  return { admissionsScanned: rows.length, updated, skipped };
}

async function mergeCrmManagedIntoSecondaryStudentData(primary, secondary) {
  const [rows] = await primary.execute(`
    SELECT admission_number, managed_course_id, managed_branch_id
    FROM admissions
    WHERE admission_number IS NOT NULL
      AND TRIM(admission_number) != ''
      AND managed_course_id IS NOT NULL
      AND TRIM(managed_course_id) != ''
  `);
  let touched = 0;
  for (const r of rows) {
    const num = String(r.admission_number).trim();
    const [sec] = await secondary.execute(
      'SELECT admission_number, student_data FROM students WHERE admission_number = ? LIMIT 1',
      [num]
    );
    if (!sec.length) continue;
    const sd = parseJson(sec[0].student_data);
    const mc = String(r.managed_course_id).trim();
    const mb = r.managed_branch_id != null && String(r.managed_branch_id).trim() !== '' ? String(r.managed_branch_id).trim() : null;
    if (sd._crm_managed_course_id === mc && sd._crm_managed_branch_id === mb) continue;
    sd._crm_managed_course_id = mc;
    if (mb) sd._crm_managed_branch_id = mb;
    else delete sd._crm_managed_branch_id;
    if (!DRY) {
      await secondary.execute('UPDATE students SET student_data = ? WHERE admission_number = ?', [
        JSON.stringify(sd),
        num,
      ]);
    }
    touched += 1;
  }
  return { admissionsWithManaged: rows.length, secondaryRowsUpdated: touched };
}

async function verifySample(primary, secondary, hasManagedColumns) {
  const target = '20260001';
  let primaryRow = null;
  let cntNull = null;
  if (hasManagedColumns) {
    const [p] = await primary.execute(
      `SELECT admission_number, course_id, branch_id, managed_course_id, managed_branch_id, course, branch, status
       FROM admissions WHERE admission_number = ?`,
      [target]
    );
    primaryRow = p[0] || null;
    const [[row]] = await primary.execute(`
      SELECT COUNT(*) AS c FROM admissions
      WHERE status != 'Admission Cancelled'
        AND (managed_course_id IS NULL OR TRIM(managed_course_id) = '')
        AND TRIM(COALESCE(course, '')) != ''
    `);
    cntNull = Number(row?.c ?? 0);
  } else {
    const [p] = await primary.execute(
      `SELECT admission_number, course_id, branch_id, course, branch, status
       FROM admissions WHERE admission_number = ?`,
      [target]
    );
    primaryRow = p[0] || null;
  }
  const [s] = await secondary.execute(
    `SELECT admission_number, course, branch, student_name,
            JSON_UNQUOTE(JSON_EXTRACT(student_data, '$._crm_managed_course_id')) AS crm_mc,
            JSON_UNQUOTE(JSON_EXTRACT(student_data, '$._crm_managed_branch_id')) AS crm_mb
     FROM students WHERE admission_number = ? LIMIT 1`,
    [target]
  );
  return {
    target_primary_admission: primaryRow,
    target_secondary_student: s[0] || null,
    active_admissions_with_course_text_but_null_managed: cntNull,
  };
}

async function inferManagedIdsForSecondaryOnlyStudents(secondary, secCourses, secBranches) {
  /** Secondary rows missing `_crm_managed_*` — infer from `students.course` / `branch` text (e.g. other-app imports). */
  const limit = Math.min(
    Math.max(1, parseInt(process.env.SECONDARY_INFER_MANAGED_LIMIT || '800', 10)),
    50000
  );
  const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : 800;
  const [nums] = await secondary.query(
    `
    SELECT s.admission_number, s.course, s.branch, s.student_data
    FROM students s
    WHERE TRIM(COALESCE(s.course, '')) != ''
      AND s.admission_number REGEXP '^202[0-9]'
      AND (
        JSON_EXTRACT(s.student_data, '$._crm_managed_course_id') IS NULL
        OR TRIM(JSON_UNQUOTE(JSON_EXTRACT(s.student_data, '$._crm_managed_course_id'))) = ''
      )
    ORDER BY s.admission_number ASC
    LIMIT ${safeLimit}
  `
  );
  let updated = 0;
  for (const row of nums) {
    const num = String(row.admission_number).trim();
    const nc = normLabel(row.course);
    const nb = normLabel(row.branch);
    const mc = pickCourseIdByName(nc, secCourses);
    const mb = mc ? pickBranchIdByName(mc, nb, secBranches) : null;
    if (!mc) continue;
    const sd = parseJson(row.student_data);
    if (String(sd._crm_managed_course_id || '').trim() === mc && (!mb || String(sd._crm_managed_branch_id || '').trim() === mb))
      continue;
    sd._crm_managed_course_id = mc;
    if (mb) sd._crm_managed_branch_id = mb;
    else delete sd._crm_managed_branch_id;
    if (!DRY) {
      await secondary.execute('UPDATE students SET student_data = ? WHERE admission_number = ?', [
        JSON.stringify(sd),
        num,
      ]);
    }
    updated += 1;
  }
  return { scanned: nums.length, updated, limit: safeLimit };
}

async function main() {
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
    await primary.end();
    process.exit(1);
  }

  const report = { dryRun: DRY, steps: {} };

  let hasManaged = await columnExists(primary, 'admissions', 'managed_course_id');
  if (!hasManaged && DRY) {
    report.note =
      'Primary DB has no managed_course_id yet; re-run without --dry-run once to apply ALTER + backfill, or run sql/migrations/20260513_managed_course_branch_ids.sql.';
    const [secCourses] = await secondary.execute('SELECT id, name, is_active FROM courses ORDER BY id ASC LIMIT 5');
    report.steps.secondaryCoursesSample = secCourses;
    report.verification = await verifySample(primary, secondary, false);
    await primary.end();
    await secondary.end();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!DRY) {
    report.steps.schema = await ensureSchema(primary);
  }
  hasManaged = await columnExists(primary, 'admissions', 'managed_course_id');

  const [secCourses] = await secondary.execute('SELECT id, name, is_active FROM courses ORDER BY id ASC');
  let secBranches = [];
  try {
    const [b] = await secondary.execute(
      'SELECT id, course_id, name, is_active FROM course_branches ORDER BY course_id, id ASC'
    );
    secBranches = b || [];
  } catch (e) {
    report.steps.secondaryBranchesNote = `course_branches unreadable: ${e.message}`;
  }

  if (DRY) {
    report.steps.leadDataBackfill = 'skipped (--dry-run)';
    report.steps.nameResolve = 'skipped (--dry-run)';
    report.steps.joiningsCopyFromAdmissions = 'skipped (--dry-run)';
    report.steps.secondaryStudentDataMerge = 'skipped (--dry-run)';
    report.steps.secondaryCollegeBackfill = 'skipped (--dry-run)';
    report.steps.batch2026Backfill = 'skipped (--dry-run)';
    report.steps.secondaryOnlyInfer = 'skipped (--dry-run)';
  } else {
    report.steps.leadDataBackfill = await backfillFromLeadData(primary);
    report.steps.nameResolve = await resolveFromSecondaryNames(primary, secondary, secCourses, secBranches);
    report.steps.joiningsCopyFromAdmissions = await copyAdmissionManagedToJoinings(primary);
    report.steps.secondaryStudentDataMerge = await mergeCrmManagedIntoSecondaryStudentData(primary, secondary);
    report.steps.secondaryCollegeBackfill = await backfillSecondaryStudentCollege(primary, secondary);
    report.steps.batch2026Backfill = await backfillBatchFor2026Admissions(primary, secondary);
    report.steps.secondaryOnlyInfer = await inferManagedIdsForSecondaryOnlyStudents(
      secondary,
      secCourses,
      secBranches
    );
  }

  report.verification = await verifySample(primary, secondary, hasManaged);

  await primary.end();
  await secondary.end();

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
