/**
 * Compare primary vs secondary admission numbers for 20260097–99.
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';

dotenv.config();

const NUMBERS = ['20260097', '20260098', '20260099'];

function parseAdmissionFromStudentData(raw) {
  if (!raw) return null;
  try {
    const sd = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return sd?.admission_number ?? sd?.admissionNumber ?? sd?.leadData?.admissionNumber ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const primary = getPool();
  const secondary = getSecondaryPool();
  const report = { numbers: {}, mismatches: [], ok: true };

  for (const n of NUMBERS) {
    const [pRows] = await primary.execute(
      `SELECT id, admission_number, student_name, enquiry_number
       FROM admissions WHERE admission_number = ?`,
      [n]
    );
    const [sRows] = await secondary.execute(
      `SELECT id, admission_number, admission_no, student_name, student_data
       FROM students WHERE admission_number = ? OR admission_no = ?`,
      [n, n]
    );

    const sec = sRows.map((r) => ({
      id: r.id,
      admission_number: r.admission_number,
      admission_no: r.admission_no,
      student_name: r.student_name,
      student_data_admission: parseAdmissionFromStudentData(r.student_data),
    }));

    const match =
      pRows.length === 0 && sec.length === 0
        ? 'both_empty'
        : pRows.length > 0 && sec.length > 0 &&
            pRows[0].student_name === sec[0].student_name &&
            sec[0].admission_number === n &&
            sec[0].admission_no === n
          ? 'synced'
          : 'mismatch';

    if (match === 'mismatch') {
      report.ok = false;
      report.mismatches.push({ number: n, match, primary: pRows, secondary: sec });
    }

    report.numbers[n] = { match, primary: pRows, secondary: sec };
  }

  const [latest] = await secondary.execute(
    `SELECT admission_number, admission_no, student_name
     FROM students
     WHERE admission_number LIKE '202600%'
     ORDER BY CAST(admission_number AS UNSIGNED) DESC
     LIMIT 5`
  );

  report.secondaryTop2026 = latest;
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
