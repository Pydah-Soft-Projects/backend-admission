/**
 * Clear wrongly synced address pin codes from secondary `students.pin_no`
 * for all 2026 admission numbers (20260001–20260099 via `202600%`).
 *
 * Usage:
 *   node src/scripts/clearSecondaryPinNoFor2026Admissions.js
 *   DRY_RUN=1 node src/scripts/clearSecondaryPinNoFor2026Admissions.js
 */
import dotenv from 'dotenv';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';

dotenv.config();

/** Matches 20260001, 20260010, 20260056, etc. (not the narrower `2026000%` = 01–09 only). */
const ADMISSION_PATTERN = '202600%';
const DRY_RUN = String(process.env.DRY_RUN ?? '').trim() === '1';

async function main() {
  const secondary = getSecondaryPool();

  const [cohort] = await secondary.execute(
    `SELECT admission_number, pin_no
     FROM students
     WHERE admission_number LIKE ?
     ORDER BY admission_number`,
    [ADMISSION_PATTERN]
  );

  const withPinNo = cohort.filter(
    (row) => row.pin_no != null && String(row.pin_no).trim() !== ''
  );

  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        pattern: ADMISSION_PATTERN,
        total2026Students: cohort.length,
        rowsWithPinNoBefore: withPinNo.length,
        sampleWithPinNo: withPinNo.slice(0, 15),
      },
      null,
      2
    )
  );

  if (DRY_RUN) {
    console.log('DRY_RUN=1 — no UPDATE executed.');
    return;
  }

  const [result] = await secondary.execute(
    `UPDATE students
     SET pin_no = NULL, updated_at = NOW()
     WHERE admission_number LIKE ?`,
    [ADMISSION_PATTERN]
  );

  const [after] = await secondary.execute(
    `SELECT COUNT(*) AS remaining
     FROM students
     WHERE admission_number LIKE ?
       AND pin_no IS NOT NULL
       AND TRIM(pin_no) <> ''`,
    [ADMISSION_PATTERN]
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        affectedRows: result.affectedRows,
        total2026StudentsAfter: cohort.length,
        remainingNonEmptyPinNo: after[0]?.remaining ?? null,
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
