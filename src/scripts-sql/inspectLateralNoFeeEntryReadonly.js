/**
 * READ-ONLY: inspect why Mattaparthi Bala sireesha (lateral CSE) shows as no fee entry.
 */
import dotenv from 'dotenv';
dotenv.config();

import { getPool, closeDB } from '../config-sql/database.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { classifyAdmissionQuotaCategory } from '../utils/quotaClassification.util.js';
import {
  isLateralDeskFeeQuota,
  resolveDeskFeeStudentYears,
  buildTuitionAndOtherFeeSummariesForAdmissionRows,
  buildTuitionAndOtherFeeSummariesByAdmissionNumbers,
  TUI_FEE_HEAD_CODE,
  SPECIAL_FEE_HEAD_CODE,
  LATERAL_FEE_STUDENT_YEARS,
  resolveTuitionAndOtherFeeHeadRefs,
} from '../utils/tuitionPaid.util.js';

const TARGET_NAME = 'Mattaparthi Bala sireesha';
const TARGET_ADM = '20260743';
const ENQUIRY = 'ENQ261019599';

async function main() {
  const pool = getPool();

  const [admRows] = await pool.execute(
    `SELECT a.id, a.admission_number, a.student_name, a.quota, a.course, a.branch, a.status,
            a.joining_id, a.lead_id
     FROM admissions a
     WHERE a.admission_number = ?
        OR a.student_name = ?
     ORDER BY a.updated_at DESC
     LIMIT 5`,
    [TARGET_ADM, TARGET_NAME]
  );

  console.log('=== ADMISSIONS (MySQL) ===');
  console.log(JSON.stringify(admRows, null, 2));

  if (!admRows.length) {
    console.log('No admission found.');
    await closeDB();
    return;
  }

  const admission =
    admRows.find((r) => String(r.admission_number) === TARGET_ADM) || admRows[0];
  const admissionNumber = String(admission.admission_number || '').trim();
  const quota = admission.quota;
  const course = admission.course;
  const category = classifyAdmissionQuotaCategory(quota);
  const isLateral = isLateralDeskFeeQuota(quota);
  const years = resolveDeskFeeStudentYears(quota);

  console.log('\n=== QUOTA / YEAR RESOLUTION (current code: quota-only) ===');
  console.log({
    admissionNumber,
    student_name: admission.student_name,
    quota,
    course,
    category,
    isLateralDeskFeeQuota: isLateral,
    deskFeeStudentYears: years,
    note: 'isLateralDeskFeeQuota ignores course "(LATERAL)" — only quota LATER/LSPOT',
  });

  const summaryMapY1 = await buildTuitionAndOtherFeeSummariesForAdmissionRows([
    { admission_number: admissionNumber, quota },
  ]);
  console.log('\n=== DESK FEE SUMMARY (actual path: years from quota) ===');
  console.log(JSON.stringify(summaryMapY1.get(admissionNumber), null, 2));

  const summaryMapY2 = await buildTuitionAndOtherFeeSummariesByAdmissionNumbers(
    [admissionNumber],
    LATERAL_FEE_STUDENT_YEARS
  );
  console.log('\n=== DESK FEE SUMMARY IF treated as lateral (Years 2-6) ===');
  console.log(JSON.stringify(summaryMapY2.get(admissionNumber), null, 2));

  const conn = await connectFeeManagement();
  const refs = await resolveTuitionAndOtherFeeHeadRefs();
  console.log('\n=== FEE HEAD REFS ===');
  console.log({
    tuitionIds: refs.tuitionIds,
    otherIds: refs.otherIds,
    codes: [TUI_FEE_HEAD_CODE, SPECIAL_FEE_HEAD_CODE],
  });

  const feeHeadsCol = conn.db.collection('feeheads');
  const allHeads = await feeHeadsCol
    .find({})
    .project({ _id: 1, code: 1, name: 1 })
    .limit(500)
    .toArray();
  const headById = new Map(allHeads.map((h) => [String(h._id), h]));

  const studentFees = await conn.db
    .collection('studentfees')
    .find({ studentId: admissionNumber, isActive: { $ne: false } })
    .project({
      studentId: 1,
      studentYear: 1,
      amount: 1,
      feeHead: 1,
      feeHeadId: 1,
      feeHeadCode: 1,
      code: 1,
      isActive: 1,
    })
    .toArray();

  console.log('\n=== ALL studentfees FOR studentId=' + admissionNumber + ' ===');
  console.log(
    JSON.stringify(
      studentFees.map((f) => ({
        ...f,
        resolvedHead: headById.get(String(f.feeHead || f.feeHeadId || '')),
      })),
      null,
      2
    )
  );
  console.log('count:', studentFees.length);

  const txns = await conn.db
    .collection('transactions')
    .find({ studentId: admissionNumber })
    .project({
      studentId: 1,
      studentYear: 1,
      amount: 1,
      transactionType: 1,
      status: 1,
      feeHead: 1,
      feeHeadId: 1,
      feeHeadCode: 1,
      code: 1,
      paymentMode: 1,
      createdAt: 1,
    })
    .toArray();

  console.log('\n=== ALL transactions FOR studentId=' + admissionNumber + ' ===');
  console.log(
    JSON.stringify(
      txns.map((t) => ({
        ...t,
        resolvedHead: headById.get(String(t.feeHead || t.feeHeadId || '')),
      })),
      null,
      2
    )
  );
  console.log('count:', txns.length);

  const altIds = [
    String(admission.joining_id || '').trim(),
    String(admission.id || '').trim(),
    ENQUIRY,
  ].filter(Boolean);

  for (const alt of altIds) {
    if (alt === admissionNumber) continue;
    const altFees = await conn.db.collection('studentfees').countDocuments({ studentId: alt });
    const altTx = await conn.db.collection('transactions').countDocuments({ studentId: alt });
    console.log(`\nAlt studentId=${alt} studentfees=${altFees} transactions=${altTx}`);
  }

  const yearBreakdown = {};
  for (const doc of studentFees) {
    const y = String(doc.studentYear ?? 'null');
    const hid = String(doc.feeHead || doc.feeHeadId || '');
    const head = headById.get(hid);
    yearBreakdown[y] = yearBreakdown[y] || { fees: 0, txns: 0, heads: [] };
    yearBreakdown[y].fees += 1;
    yearBreakdown[y].heads.push({
      type: 'fee',
      amount: doc.amount,
      code: head?.code || doc.feeHeadCode || doc.code,
      name: head?.name,
      headId: hid,
    });
  }
  for (const doc of txns) {
    const y = String(doc.studentYear ?? 'null');
    const hid = String(doc.feeHead || doc.feeHeadId || '');
    const head = headById.get(hid);
    yearBreakdown[y] = yearBreakdown[y] || { fees: 0, txns: 0, heads: [] };
    yearBreakdown[y].txns += 1;
    yearBreakdown[y].heads.push({
      type: 'txn',
      amount: doc.amount,
      txnType: doc.transactionType,
      code: head?.code || doc.feeHeadCode || doc.code,
      name: head?.name,
      headId: hid,
    });
  }
  console.log('\n=== YEAR BREAKDOWN ===');
  console.log(JSON.stringify(yearBreakdown, null, 2));

  const tuiIds = new Set(refs.tuitionIds.map(String));
  const othIds = new Set(refs.otherIds.map(String));
  const isDeskHead = (doc) => {
    const hid = String(doc.feeHead || doc.feeHeadId || '');
    return tuiIds.has(hid) || othIds.has(hid);
  };
  const y1Desk = [...studentFees, ...txns].filter(
    (d) => String(d.studentYear) === '1' && isDeskHead(d)
  );
  const y2Desk = [...studentFees, ...txns].filter(
    (d) => String(d.studentYear) === '2' && isDeskHead(d)
  );
  console.log('\n=== DESK HEADS (TUI01/OTH1) BY YEAR ===');
  console.log({
    year1_desk_docs: y1Desk.length,
    year2_desk_docs: y2Desk.length,
    year1: y1Desk.map((d) => ({
      year: d.studentYear,
      amount: d.amount,
      head: headById.get(String(d.feeHead || d.feeHeadId || '')),
    })),
    year2: y2Desk.map((d) => ({
      year: d.studentYear,
      amount: d.amount,
      type: d.transactionType || 'fee',
      head: headById.get(String(d.feeHead || d.feeHeadId || '')),
    })),
  });

  await closeDB();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDB();
  } catch {}
  process.exit(1);
});
