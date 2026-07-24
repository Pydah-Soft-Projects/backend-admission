/**
 * READ-ONLY: why 20260448 shows no_entry while Step 4 Collect has Year 1 fees.
 */
import dotenv from 'dotenv';
dotenv.config();

import { getPool, closeDB } from '../config-sql/database.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { mapCourseLabel } from '../data/admissionsCourseBranchMap2026.js';
import {
  mapQuotaToFeeCategory,
  classifyAdmissionQuotaCategory,
} from '../utils/quotaClassification.util.js';
import {
  resolveTuitionAndOtherFeeHeadRefs,
  isLateralDeskFeeStudent,
  buildTuitionAndOtherFeeSummariesForAdmissionRows,
} from '../utils/tuitionPaid.util.js';

const ADM = '20260448';

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT admission_number, student_name, quota, course, branch
     FROM admissions WHERE admission_number = ?`,
    [ADM]
  );
  const row = rows[0];
  console.log('ADMISSION', row);

  const course = mapCourseLabel(row.course) || row.course;
  const branch = String(row.branch || '').trim();
  const lateral = isLateralDeskFeeStudent(row.quota, row.course);
  const batch = String(ADM).slice(0, 4);
  const category =
    mapQuotaToFeeCategory(row.quota, lateral ? 'lateral' : '', batch) ||
    classifyAdmissionQuotaCategory(row.quota) ||
    '';
  console.log({ course, branch, lateral, batch, category });

  const summaryMap = await buildTuitionAndOtherFeeSummariesForAdmissionRows([row]);
  console.log('SUMMARY', summaryMap.get(ADM));

  const conn = await connectFeeManagement();
  const refs = await resolveTuitionAndOtherFeeHeadRefs();
  console.log('HEAD REFS', refs);

  const allYear1 = await conn.db
    .collection('feestructures')
    .find({
      course: new RegExp(`^${String(course).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      studentYear: { $in: [1, '1'] },
    })
    .project({
      course: 1,
      branch: 1,
      category: 1,
      batch: 1,
      studentYear: 1,
      amount: 1,
      feeHead: 1,
      feeHeadCode: 1,
    })
    .limit(120)
    .toArray();

  console.log('year1 structures for course count', allYear1.length);
  console.log('distinct branches', [...new Set(allYear1.map((d) => d.branch))]);
  console.log('distinct categories', [...new Set(allYear1.map((d) => d.category))]);
  console.log('distinct batches', [...new Set(allYear1.map((d) => d.batch))]);

  const branchHits = allYear1.filter((d) => {
    const b = String(d.branch || '').toUpperCase();
    const target = branch.toUpperCase();
    return b === target || b.includes('CSE') || target.includes(b) || b === 'BCSE';
  });
  console.log('branch-ish hits', branchHits.length);
  console.log(JSON.stringify(branchHits.slice(0, 30), null, 2));

  // What Step 4 often does: quota as CONV category variants
  const convHits = allYear1.filter((d) => {
    const c = String(d.category || '').toUpperCase();
    return c.includes('CONV') || c === 'CQ' || c === 'CONVENOR';
  });
  console.log('conv category sample', JSON.stringify(convHits.slice(0, 15), null, 2));

  await closeDB();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closeDB();
  } catch {}
  process.exit(1);
});
