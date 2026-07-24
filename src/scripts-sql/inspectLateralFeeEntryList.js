import dotenv from 'dotenv';
dotenv.config();
import { getPool, closeDB } from '../config-sql/database.js';
import {
  buildTuitionAndOtherFeeSummariesForAdmissionRows,
  isLateralDeskFeeStudent,
} from '../utils/tuitionPaid.util.js';

const pool = getPool();
const [rows] = await pool.execute(`
  SELECT admission_number, student_name, quota, course, branch, managed_branch_id
  FROM admissions
  WHERE LOWER(course) LIKE '%lateral%'
     OR UPPER(TRIM(COALESCE(quota,''))) LIKE '%LATERAL%'
  ORDER BY updated_at DESC
  LIMIT 30
`);
console.log('lateral rows', rows.length);
const map = await buildTuitionAndOtherFeeSummariesForAdmissionRows(rows);
for (const r of rows) {
  const s = map.get(String(r.admission_number));
  console.log(
    JSON.stringify({
      adm: r.admission_number,
      name: r.student_name,
      course: r.course,
      branch: r.branch,
      managed_branch_id: r.managed_branch_id,
      quota: r.quota,
      lateralDetect: isLateralDeskFeeStudent(r.quota, r.course),
      hasFeeEntry: s?.hasFeeEntry,
      feeStatus: s?.feeStatus,
      payable: s?.payable,
      paid: s?.paid,
    })
  );
}

// Also BCSE sample
const [bcse] = await pool.execute(`
  SELECT admission_number, course, branch, managed_branch_id
  FROM admissions
  WHERE UPPER(branch) IN ('BCSE','CSE') OR UPPER(branch) LIKE '%CSE%'
  ORDER BY updated_at DESC
  LIMIT 15
`);
console.log('CSE/BCSE branch samples', JSON.stringify(bcse, null, 2));
await closeDB();
