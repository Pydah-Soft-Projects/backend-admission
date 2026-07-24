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
  WHERE (
      LOWER(course) LIKE '%(lateral)%'
      OR LOWER(course) LIKE '%lateral%'
    )
    AND UPPER(TRIM(COALESCE(quota,''))) NOT LIKE '%LATERAL%'
  ORDER BY updated_at DESC
  LIMIT 40
`);
console.log('LATERAL COURSE + NON-LATERAL QUOTA', rows.length);
const map = await buildTuitionAndOtherFeeSummariesForAdmissionRows(rows);
for (const r of rows) {
  const s = map.get(String(r.admission_number));
  console.log(
    JSON.stringify({
      adm: r.admission_number,
      name: r.student_name,
      course: r.course,
      branch: r.branch,
      quota: r.quota,
      lateralDetect: isLateralDeskFeeStudent(r.quota, r.course),
      hasFeeEntry: s?.hasFeeEntry,
      feeStatus: s?.feeStatus,
      payable: s?.payable,
      paid: s?.paid,
    })
  );
}

const [bcse] = await pool.execute(`
  SELECT admission_number, student_name, course, branch, managed_branch_id, quota
  FROM admissions
  WHERE UPPER(TRIM(branch)) = 'BCSE'
  ORDER BY updated_at DESC
  LIMIT 20
`);
console.log('BCSE code stored as branch', bcse.length);
console.log(JSON.stringify(bcse, null, 2));

await closeDB();
