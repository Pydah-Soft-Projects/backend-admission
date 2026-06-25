/**
 * Remove CRM roll numbers for all batches except 2026 (admission_number LIKE '2026%').
 *
 * Usage:
 *   node src/scripts/purgeNon2026StudentRollNumbers.js [--dry-run]
 */

import dotenv from 'dotenv';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  CRM_ROLL_ADMISSION_YEAR_PREFIX,
  purgeNonCrmStudentRollNumbers,
} from '../utils/studentRollNumber.util.js';

dotenv.config();

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const secondaryPool = getSecondaryPool();

  const [[nonCrm]] = await secondaryPool.execute(
    `SELECT COUNT(*) AS c FROM student_roll_numbers
     WHERE admission_number NOT LIKE ? OR batch <> ?`,
    [`${CRM_ROLL_ADMISSION_YEAR_PREFIX}%`, Number(CRM_ROLL_ADMISSION_YEAR_PREFIX)]
  );
  const [byBatch] = await secondaryPool.execute(
    `SELECT batch, COUNT(*) AS c FROM student_roll_numbers
     GROUP BY batch ORDER BY batch`
  );

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          crmYear: CRM_ROLL_ADMISSION_YEAR_PREFIX,
          wouldRemoveRollRows: Number(nonCrm.c),
          currentByBatch: byBatch,
        },
        null,
        2
      )
    );
    return;
  }

  const result = await purgeNonCrmStudentRollNumbers(secondaryPool);
  const [remainingByBatch] = await secondaryPool.execute(
    `SELECT batch, COUNT(*) AS c FROM student_roll_numbers GROUP BY batch ORDER BY batch`
  );

  console.log(JSON.stringify({ ...result, remainingByBatch }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
