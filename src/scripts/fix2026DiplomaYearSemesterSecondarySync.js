/**
 * Backfill + resync 2026 Diploma students: batch 2026, year 1, semester 1-1.
 *
 *   node src/scripts/fix2026DiplomaYearSemesterSecondarySync.js           # report
 *   node src/scripts/fix2026DiplomaYearSemesterSecondarySync.js --apply  # write
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import {
  resolveSecondarySemesterForSync,
  resolveSecondaryYearOfStudy,
} from '../utils/lateralBatch.util.js';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const TRUNCATED_ONLY = process.argv.includes('--truncated-only');
const EXPECTED_BATCH = '2026';
const EXPECTED_SEM = '1-1';

function parseJson(v) {
  try {
    return typeof v === 'string' ? JSON.parse(v || '{}') : { ...(v || {}) };
  } catch {
    return {};
  }
}

function patchDiplomaExtras(extras, admissionNumber, course) {
  const next = { ...(extras || {}) };
  const batch = String(next.batch ?? next.academic_year ?? next.academicYear ?? '').trim();
  if (!batch || batch !== EXPECTED_BATCH) {
    next.batch = EXPECTED_BATCH;
    next.academic_year = EXPECTED_BATCH;
    next.academicYear = EXPECTED_BATCH;
  }

  const sem = resolveSecondarySemesterForSync(next, admissionNumber, course) || EXPECTED_SEM;
  next.semester = sem;
  next.current_semester = sem;
  next.currentSemester = sem;
  next.semister = sem;

  const yearOfStudy =
    resolveSecondaryYearOfStudy(next) ??
    resolveSecondaryYearOfStudy({ semester: sem, current_semester: sem }) ??
    1;
  next.current_year = yearOfStudy;
  next.currentYear = yearOfStudy;

  return next;
}

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(`
    SELECT a.*, j.lead_data AS joining_lead_data
    FROM admissions a
    LEFT JOIN joinings j ON j.id = a.joining_id
    WHERE a.admission_number LIKE '2026%'
      AND LOWER(TRIM(a.course)) = 'diploma'
      AND a.status != 'Admission Cancelled'
  `);

  const report = { apply: APPLY, truncatedOnly: TRUNCATED_ONLY, scanned: rows.length, primaryPatched: 0, resynced: 0, skipped: 0, errors: [] };

  let truncatedSet = null;
  if (TRUNCATED_ONLY) {
    const secondary = getSecondaryPool();
    const [secRows] = await secondary.execute(`
      SELECT admission_number FROM students
      WHERE admission_number LIKE '2026%'
        AND LOWER(TRIM(course)) = 'diploma'
        AND LENGTH(student_data) >= 64000
    `);
    truncatedSet = new Set(secRows.map((r) => String(r.admission_number).trim()));
    report.truncatedCandidates = truncatedSet.size;
  }

  for (const row of rows) {
    const num = String(row.admission_number).trim();
    if (truncatedSet && !truncatedSet.has(num)) {
      report.skipped += 1;
      continue;
    }
    try {
      const ld = parseJson(row.lead_data);
      const before = ld._joiningRegistrationExtras;
      const patched = patchDiplomaExtras(before, num, row.course);
      const primaryNeedsPatch =
        JSON.stringify(before || {}) !== JSON.stringify(patched);

      if (primaryNeedsPatch && APPLY) {
        ld._joiningRegistrationExtras = patched;
        await pool.execute('UPDATE admissions SET lead_data = ?, updated_at = NOW() WHERE id = ?', [
          JSON.stringify(ld),
          row.id,
        ]);
        if (row.joining_id) {
          const jld = parseJson(row.joining_lead_data);
          jld._joiningRegistrationExtras = patchDiplomaExtras(
            jld._joiningRegistrationExtras,
            num,
            row.course
          );
          await pool.execute('UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?', [
            JSON.stringify(jld),
            row.joining_id,
          ]);
        }
        report.primaryPatched += 1;
        row.lead_data = JSON.stringify(ld);
      } else if (primaryNeedsPatch) {
        report.primaryPatched += 1;
      }

      if (!APPLY) continue;

      let email = '';
      try {
        email = String(parseJson(row.lead_data).email || '').trim();
      } catch {
        email = '';
      }

      const formatted = await formatAdmission(row, pool);
      const syncResult = await syncToSecondaryDatabase(formatted, num, {
        leadId: row.lead_id,
        joiningId: row.joining_id,
        email,
      });
      if (!syncResult?.ok) {
        report.errors.push({ admission_number: num, error: 'sync_failed' });
      } else {
        report.resynced += 1;
      }
    } catch (e) {
      report.errors.push({ admission_number: num, error: e.message });
    }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
