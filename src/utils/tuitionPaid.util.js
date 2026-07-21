import mongoose from 'mongoose';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';

/** Tuition fee head in Fee Management (TUI01). */
export const TUI_FEE_HEAD_ID = '6996e24c2e1678e398839187';
export const TUI_FEE_HEAD_CODE = 'TUI01';

/** Special Fee head included with tuition in the Student Info Paid amount. */
export const SPECIAL_FEE_HEAD_CODE = 'OTH1';

/** Admissions desk reports use Year 1 tuition only. */
export const TUI_STUDENT_YEAR = 1;

const FEE_PENDING_TOLERANCE = 0.5;

const feeHeadMatchValues = (feeHeadId) => {
  const raw = String(feeHeadId || '').trim();
  if (!raw) return [];
  const values = [raw];
  try {
    values.push(new mongoose.Types.ObjectId(raw));
  } catch {
    // Non-ObjectId fee heads are matched as-is.
  }
  return values;
};

/** Mongo may store studentYear as number or string. */
const studentYearMatchFilter = (studentYear = TUI_STUDENT_YEAR) => {
  const numeric = Number(studentYear);
  const text = String(studentYear).trim();
  const values = [text];
  if (Number.isFinite(numeric)) values.unshift(numeric);
  return { $in: [...new Set(values)] };
};

/**
 * Sum payments across exactly the two Student Info fee heads for a student year:
 * Tuition (TUI01) + Special Fee (OTH1). Application, school, other, transport,
 * hostel, and every other fee head are intentionally excluded.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchPaidByAdmissionNumbersForStudentYear(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map();
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    // Resolve OTH1 from the fee-head master instead of hard-coding an environment-specific
    // ObjectId. Transactions normally store feeHead as that master row's ObjectId/string.
    const includedCodes = [TUI_FEE_HEAD_CODE, SPECIAL_FEE_HEAD_CODE];
    const codeMatchers = includedCodes.map(
      (code) => new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    );
    const specialHeads = await conn.db
      .collection('feeheads')
      .find({
        $or: [
          { code: { $in: codeMatchers } },
          { feeHeadCode: { $in: codeMatchers } },
        ],
      })
      .project({ _id: 1 })
      .toArray();
    const includedHeadIds = [
      TUI_FEE_HEAD_ID,
      ...specialHeads.map((head) => String(head._id || '').trim()).filter(Boolean),
    ];
    const includedFeeHeadValues = [
      ...new Set(includedHeadIds.flatMap((id) => feeHeadMatchValues(id))),
    ];
    const docs = await conn.db
      .collection('transactions')
      .find({
        studentId: { $in: ids },
        studentYear: studentYearMatchFilter(studentYear),
        $or: [
          { feeHead: { $in: includedFeeHeadValues } },
          { feeHeadId: { $in: includedHeadIds } },
          { feeHeadCode: { $in: codeMatchers } },
        ],
      })
      .project({ studentId: 1, amount: 1, transactionType: 1, status: 1 })
      .toArray();

    for (const doc of docs) {
      if (String(doc.status || '').toLowerCase() === 'cancelled') continue;
      const amount = Number(doc.amount) || 0;
      if (amount <= 0) continue;
      const multiplier = doc.transactionType === 'CREDIT' ? -1 : 1;
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      result.set(studentId, (result.get(studentId) || 0) + amount * multiplier);
    }
  } catch (error) {
    console.error('[fetchPaidByAdmissionNumbersForStudentYear]', error?.message || error);
  }

  return result;
}

const emptyTuitionSummary = () => ({
  payable: 0,
  paid: 0,
  pending: 0,
  hasFeeEntry: false,
  feeStatus: 'no_entry',
  displayAmount: 0,
  displayLabel: 'Pending',
});

/**
 * Sum Year-1 tuition payable per admission from Fee Management `studentfees` ledger.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, { payable: number; hasFeeEntry: boolean }>>}
 */
export async function fetchTuitionPayableByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map();
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const feeHeadValues = feeHeadMatchValues(TUI_FEE_HEAD_ID);
    const docs = await conn.db
      .collection('studentfees')
      .find({
        studentId: { $in: ids },
        isActive: { $ne: false },
        studentYear: studentYearMatchFilter(studentYear),
        $or: [{ feeHead: { $in: feeHeadValues } }, { feeHeadId: TUI_FEE_HEAD_ID }],
      })
      .project({ studentId: 1, amount: 1 })
      .toArray();

    for (const doc of docs) {
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      const amount = Number(doc.amount) || 0;
      const prev = result.get(studentId) || { payable: 0, hasFeeEntry: false };
      prev.payable += amount;
      prev.hasFeeEntry = true;
      result.set(studentId, prev);
    }
  } catch (error) {
    console.error('[fetchTuitionPayableByAdmissionNumbers]', error?.message || error);
  }

  return result;
}

/**
 * Sum Year-1 tuition fee-head payments per admission from Fee Management MongoDB.
 * Mirrors JoiningLeadFormWorkspace feeMongoPaidByHeadYear for studentYear 1.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchTuitionPaidByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const result = new Map();
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const feeHeadValues = feeHeadMatchValues(TUI_FEE_HEAD_ID);
    const docs = await conn.db
      .collection('transactions')
      .find({
        studentId: { $in: ids },
        feeHead: { $in: feeHeadValues },
        studentYear: studentYearMatchFilter(studentYear),
      })
      .project({ studentId: 1, amount: 1, transactionType: 1, status: 1 })
      .toArray();

    for (const doc of docs) {
      if (String(doc.status || '').toLowerCase() === 'cancelled') continue;
      const amount = Number(doc.amount) || 0;
      if (amount <= 0) continue;
      const multiplier = doc.transactionType === 'CREDIT' ? -1 : 1;
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      result.set(studentId, (result.get(studentId) || 0) + amount * multiplier);
    }
  } catch (error) {
    console.error('[fetchTuitionPaidByAdmissionNumbers]', error?.message || error);
  }

  return result;
}

/**
 * Build Year-1 tuition fee summary per admission (payable, paid, pending, display label).
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, ReturnType<typeof emptyTuitionSummary>>>}
 */
export async function buildTuitionFeeSummariesByAdmissionNumbers(
  admissionNumbers,
  studentYear = TUI_STUDENT_YEAR
) {
  const ids = [
    ...new Set(
      (Array.isArray(admissionNumbers) ? admissionNumbers : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
  const summaries = new Map(ids.map((id) => [id, emptyTuitionSummary()]));
  if (ids.length === 0) return summaries;

  const [paidMap, payableMap] = await Promise.all([
    fetchTuitionPaidByAdmissionNumbers(ids, studentYear),
    fetchTuitionPayableByAdmissionNumbers(ids, studentYear),
  ]);

  for (const id of ids) {
    const paid = paidMap.get(id) || 0;
    const payableInfo = payableMap.get(id) || { payable: 0, hasFeeEntry: false };
    const payable = payableInfo.payable;
    const hasFeeEntry = payableInfo.hasFeeEntry || paid > 0 || payable > 0;
    const pending = Math.max(payable - paid, 0);

    if (!hasFeeEntry) {
      summaries.set(id, emptyTuitionSummary());
      continue;
    }

    // Any recorded payment counts as Paid (partial payments included).
    if (paid > FEE_PENDING_TOLERANCE) {
      summaries.set(id, {
        payable,
        paid,
        pending,
        hasFeeEntry: true,
        feeStatus: 'paid',
        displayAmount: paid,
        displayLabel: 'Paid',
      });
      continue;
    }

    summaries.set(id, {
      payable,
      paid,
      pending,
      hasFeeEntry: true,
      feeStatus: 'unpaid',
      displayAmount: pending > 0 ? pending : payable,
      displayLabel: 'Unpaid',
    });
  }

  return summaries;
}
