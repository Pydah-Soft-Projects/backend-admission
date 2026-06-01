/**
 * Set B.Tech lateral entry (prior-year batch, 2-1) on primary joining + resync secondary.
 *
 *   node src/scripts/applyBtechLateralEntry.js 20260056
 *   node src/scripts/applyBtechLateralEntry.js 20260056 --dry-run
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import { deriveAdmissionSeriesYear } from '../utils/lateralBatch.util.js';

dotenv.config();

const DRY = process.argv.includes('--dry-run');
const admNo = process.argv.find((a) => /^202\d{5,}$/.test(a));

const parseJson = (v) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : { ...(v || {}) };
  } catch {
    return {};
  }
};

async function main() {
  if (!admNo) {
    console.error('Usage: node src/scripts/applyBtechLateralEntry.js <admission_number> [--dry-run]');
    process.exit(1);
  }

  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT a.*, j.id AS joining_id, j.lead_data AS joining_lead_data
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     WHERE a.admission_number = ?
     LIMIT 1`,
    [admNo]
  );
  if (!rows.length) {
    console.error(JSON.stringify({ ok: false, error: 'not_found' }));
    process.exit(1);
  }

  const row = rows[0];
  const seriesYear = Number(deriveAdmissionSeriesYear(admNo) || new Date().getFullYear());
  const intakeYear = String(seriesYear - 1);
  const sem = '2-1';
  const remark = `B.Tech lateral entry — academic year ${intakeYear}, semester ${sem} (reference cycle ${seriesYear}).`;

  const patchExtras = (extras) => ({
    ...extras,
    batch: intakeYear,
    academic_year: intakeYear,
    academicYear: intakeYear,
    current_year: 2,
    currentYear: 2,
    semester: sem,
    current_semester: sem,
    currentSemester: sem,
    semister: sem,
    student_status: 'Lateral',
    studentStatus: 'Lateral',
    remarks: remark,
  });

  const jld = parseJson(row.joining_lead_data);
  const before = { ...(jld._joiningRegistrationExtras || {}) };
  jld._joiningRegistrationExtras = patchExtras(before);

  const ald = parseJson(row.lead_data);
  ald._joiningRegistrationExtras = patchExtras(ald._joiningRegistrationExtras || {});

  if (!DRY) {
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

  let syncOk = null;
  if (!DRY) {
    const [fresh] = await pool.execute('SELECT * FROM admissions WHERE id = ? LIMIT 1', [row.id]);
    const formatted = await formatAdmission(fresh[0], pool);
    let email = '';
    try {
      const ld = parseJson(fresh[0].lead_data);
      email = String(ld.email || '').trim();
    } catch {
      email = '';
    }
    syncOk = await syncToSecondaryDatabase(formatted, admNo, {
      leadId: fresh[0].lead_id,
      joiningId: fresh[0].joining_id,
      email,
    });
  }

  const { getPool: getSecondaryPool } = await import('../config-sql/database-secondary.js');
  const secondary = getSecondaryPool();
  const [sec] = await secondary.execute(
    'SELECT batch, current_year, student_status, course, branch FROM students WHERE admission_number = ? LIMIT 1',
    [admNo]
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: DRY,
        admissionNumber: admNo,
        intakeYear,
        semester: sem,
        before: {
          batch: before.batch,
          current_year: before.current_year ?? before.currentYear,
          semester: before.semester ?? before.current_semester,
          student_status: before.student_status ?? before.studentStatus,
        },
        afterExtras: jld._joiningRegistrationExtras,
        syncToSecondary: syncOk,
        secondary: sec[0] || null,
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
