/**
 * Compare primary vs secondary for 2026 B.Tech lateral + Degree rows; fix DB in place.
 *
 *   node src/scripts/fixLateralAndDegreeSecondarySync2026.js           # report only
 *   node src/scripts/fixLateralAndDegreeSecondarySync2026.js --apply   # write + resync
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import {
  deriveAdmissionSeriesYear,
  isLateralRegistrationExtras,
  SQL_IS_BTECH_LATERAL_ADMISSION,
} from '../utils/lateralBatch.util.js';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const DEGREE_ADM_NOS = ['20260009', '20260012', '20260024'];

const parseJson = (v) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : { ...(v || {}) };
  } catch {
    return {};
  }
};

const patchLateralExtras = (extras, admissionNumber) => {
  const seriesYear = Number(deriveAdmissionSeriesYear(admissionNumber) || 2026);
  const intakeYear = String(seriesYear - 1);
  const sem = '2-1';
  return {
    ...extras,
    batch: intakeYear,
    academic_year: intakeYear,
    academicYear: intakeYear,
    semester: sem,
    current_semester: sem,
    currentSemester: sem,
    semister: sem,
    current_year: 2,
    currentYear: 2,
    student_status: 'Lateral',
    studentStatus: 'Lateral',
  };
};

async function fetchSecondaryRow(secondary, admissionNumber) {
  const [rows] = await secondary.execute(
    `SELECT admission_number, course, branch, batch, current_year, student_status
     FROM students WHERE admission_number = ? LIMIT 1`,
    [admissionNumber]
  );
  return rows[0] || null;
}

async function patchPrimaryLateral(pool, row) {
  const admNo = row.admission_number;
  const jld = parseJson(row.joining_lead_data);
  jld._joiningRegistrationExtras = patchLateralExtras(
    jld._joiningRegistrationExtras || {},
    admNo
  );
  const ald = parseJson(row.lead_data);
  ald._joiningRegistrationExtras = patchLateralExtras(
    ald._joiningRegistrationExtras || {},
    admNo
  );

  if (row.joining_id) {
    await pool.execute('UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?', [
      JSON.stringify(jld),
      row.joining_id,
    ]);
  }
  await pool.execute('UPDATE admissions SET lead_data = ?, updated_at = NOW() WHERE id = ?', [
    JSON.stringify(ald),
    row.id,
  ]);
}

async function resyncAdmission(pool, admissionNumber) {
  const [rows] = await pool.execute('SELECT * FROM admissions WHERE admission_number = ? LIMIT 1', [
    admissionNumber,
  ]);
  if (!rows.length) return { ok: false, error: 'not_found' };
  const row = rows[0];
  let email = '';
  try {
    const ld = parseJson(row.lead_data);
    email = String(ld.email || '').trim();
  } catch {
    email = '';
  }
  const formatted = await formatAdmission(row, pool);
  const syncResult = await syncToSecondaryDatabase(formatted, admissionNumber, {
    leadId: row.lead_id,
    joiningId: row.joining_id,
    email,
  });
  return syncResult;
}

async function fixDegreeCourseOnly(secondary, admissionNumber) {
  await secondary.execute(
    `UPDATE students SET course = 'B.Sc', updated_at = NOW()
     WHERE admission_number = ?`,
    [admissionNumber]
  );
  const [rows] = await secondary.execute(
    'SELECT student_data FROM students WHERE admission_number = ? LIMIT 1',
    [admissionNumber]
  );
  if (!rows.length) return;
  const data = parseJson(rows[0].student_data);
  if (data && typeof data === 'object') {
    if (data.courseInfo && typeof data.courseInfo === 'object') {
      data.courseInfo.course = 'B.Sc';
    }
    data._crm_secondary_course = 'B.Sc';
    await secondary.execute(
      'UPDATE students SET student_data = ?, updated_at = NOW() WHERE admission_number = ?',
      [JSON.stringify(data), admissionNumber]
    );
  }
}

function summarizeExtras(row) {
  const ld = parseJson(row.lead_data);
  const ex = ld._joiningRegistrationExtras || {};
  return {
    batch: ex.batch,
    semester: ex.semester ?? ex.current_semester,
    current_year: ex.current_year ?? ex.currentYear,
    student_status: ex.student_status ?? ex.studentStatus,
  };
}

async function main() {
  const pool = getPool();
  const secondary = getSecondaryPool();

  const lateralWhere = SQL_IS_BTECH_LATERAL_ADMISSION.replace(
    /COALESCE\(course/g,
    'COALESCE(a.course'
  )
    .replace(/COALESCE\(quota/g, 'COALESCE(a.quota')
    .replace(/JSON_VALID\(lead_data/g, 'JSON_VALID(a.lead_data')
    .replace(/JSON_EXTRACT\(lead_data/g, 'JSON_EXTRACT(a.lead_data')
    .replace(/TRIM\(admission_number\)/g, 'TRIM(a.admission_number)');

  const lateralSql = `
    SELECT a.id, a.admission_number, a.course, a.branch, a.quota, a.lead_data, a.joining_id,
      j.lead_data AS joining_lead_data
    FROM admissions a
    LEFT JOIN joinings j ON j.id = a.joining_id
    WHERE a.admission_number LIKE '2026%'
      AND (${lateralWhere})
    ORDER BY a.admission_number
  `;

  const [lateralRows] = await pool.execute(lateralSql);
  const [degreeRows] = await pool.execute(
    `SELECT a.id, a.admission_number, a.course, a.branch, a.lead_data, a.joining_id
     FROM admissions a
     WHERE a.admission_number IN (${DEGREE_ADM_NOS.map(() => '?').join(',')})`,
    DEGREE_ADM_NOS
  );

  const report = {
    apply: APPLY,
    btechLateral: [],
    degree: [],
    errors: [],
  };

  console.log(`\n=== B.Tech Lateral (${lateralRows.length} on primary) ===\n`);

  for (const row of lateralRows) {
    const admNo = row.admission_number;
    const seriesYear = deriveAdmissionSeriesYear(admNo);
    const expectedBatch = String(Number(seriesYear) - 1);
    const primaryBefore = summarizeExtras(row);
    const secondaryBefore = await fetchSecondaryRow(secondary, admNo);

    const entry = {
      admissionNumber: admNo,
      course: row.course,
      branch: row.branch,
      primary: primaryBefore,
      secondaryBefore,
      expected: {
        course: 'B.Tech',
        batch: expectedBatch,
        current_year: 2,
        semester: '2-1',
        student_status: 'Regular',
      },
    };

    if (APPLY) {
      try {
        await patchPrimaryLateral(pool, row);
        await resyncAdmission(pool, admNo);
        entry.secondaryAfter = await fetchSecondaryRow(secondary, admNo);
        entry.primaryAfter = summarizeExtras(
          (await pool.execute('SELECT lead_data FROM admissions WHERE id = ?', [row.id]))[0][0]
        );
      } catch (err) {
        entry.error = err.message;
        report.errors.push({ admNo, error: err.message });
      }
    }

    report.btechLateral.push(entry);
    console.log(JSON.stringify(entry, null, 2));
  }

  console.log(`\n=== Degree / B.Sc (${degreeRows.length}) — course name only ===\n`);

  for (const row of degreeRows) {
    const admNo = row.admission_number;
    const secondaryBefore = await fetchSecondaryRow(secondary, admNo);
    const entry = {
      admissionNumber: admNo,
      course: row.course,
      branch: row.branch,
      secondaryBefore,
      expected: { course: 'B.Sc', batch: '2026', semester: '1-1', current_year: 1 },
    };

    if (APPLY) {
      try {
        await fixDegreeCourseOnly(secondary, admNo);
        entry.secondaryAfter = await fetchSecondaryRow(secondary, admNo);
      } catch (err) {
        entry.error = err.message;
        report.errors.push({ admNo, error: err.message });
      }
    }

    report.degree.push(entry);
    console.log(JSON.stringify(entry, null, 2));
  }

  // Explicit lateral admission from user report
  const explicit = '20260082';
  if (!lateralRows.find((r) => r.admission_number === explicit)) {
    const [extra] = await pool.execute(
      `SELECT a.id, a.admission_number, a.course, a.branch, a.quota, a.lead_data, a.joining_id,
        j.lead_data AS joining_lead_data
       FROM admissions a
       LEFT JOIN joinings j ON j.id = a.joining_id
       WHERE a.admission_number = ?`,
      [explicit]
    );
    if (extra.length) {
      console.log(`\n=== Extra check ${explicit} ===\n`);
      const row = extra[0];
      const isLateral = isLateralRegistrationExtras(
        parseJson(row.lead_data)._joiningRegistrationExtras || {},
        explicit
      );
      console.log({ admissionNumber: explicit, isLateral, course: row.course });
      if (APPLY && (isLateral || /lateral/i.test(row.course))) {
        await patchPrimaryLateral(pool, row);
        await resyncAdmission(pool, explicit);
        console.log('secondaryAfter', await fetchSecondaryRow(secondary, explicit));
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(
    JSON.stringify(
      {
        apply: APPLY,
        lateralCount: report.btechLateral.length,
        degreeCount: report.degree.length,
        errors: report.errors,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
