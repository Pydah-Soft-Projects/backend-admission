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

const emptyHeadAmounts = () => ({
  payable: 0,
  paid: 0,
  pending: 0,
  hasFeeEntry: false,
});

/**
 * Resolve Fee Management head ids/codes for Step 4 tuition + other (Special Fee).
 * Matches admission view-details pivot: TUI01 + OTH1 / Special Fee.
 */
export async function resolveTuitionAndOtherFeeHeadRefs() {
  const includedCodes = [TUI_FEE_HEAD_CODE, SPECIAL_FEE_HEAD_CODE];
  const codeMatchers = includedCodes.map(
    (code) => new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  );

  const conn = await connectFeeManagement();
  const heads = await conn.db
    .collection('feeheads')
    .find({
      $or: [
        { code: { $in: codeMatchers } },
        { feeHeadCode: { $in: codeMatchers } },
      ],
    })
    .project({ _id: 1, code: 1, feeHeadCode: 1, name: 1 })
    .toArray();

  const tuitionIds = new Set([TUI_FEE_HEAD_ID]);
  const otherIds = new Set();

  for (const head of heads) {
    const id = String(head._id || '').trim();
    if (!id) continue;
    const code = String(head.code || head.feeHeadCode || '')
      .trim()
      .toUpperCase();
    const name = String(head.name || '')
      .trim()
      .toUpperCase();
    if (code === TUI_FEE_HEAD_CODE) {
      tuitionIds.add(id);
    } else if (code === SPECIAL_FEE_HEAD_CODE || name === 'SPECIAL FEE') {
      otherIds.add(id);
    }
  }

  return {
    tuitionIds: [...tuitionIds],
    otherIds: [...otherIds],
    allIds: [...new Set([...tuitionIds, ...otherIds])],
    codeMatchers,
  };
}

const classifyHeadBucket = (doc, refs) => {
  const code = String(doc.feeHeadCode || doc.code || '')
    .trim()
    .toUpperCase();
  if (code === TUI_FEE_HEAD_CODE) return 'tuition';
  if (code === SPECIAL_FEE_HEAD_CODE) return 'other';

  const normalizeId = (value) => {
    if (value == null) return '';
    if (typeof value === 'object') {
      if (value._id) return String(value._id).trim();
      if (typeof value.toHexString === 'function') return value.toHexString();
    }
    return String(value).trim();
  };

  const feeHeadStr = normalizeId(doc.feeHead);
  const feeHeadIdStr = normalizeId(doc.feeHeadId);
  if (refs.tuitionIds.includes(feeHeadStr) || refs.tuitionIds.includes(feeHeadIdStr)) {
    return 'tuition';
  }
  if (refs.otherIds.includes(feeHeadStr) || refs.otherIds.includes(feeHeadIdStr)) {
    return 'other';
  }
  return null;
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
    const refs = await resolveTuitionAndOtherFeeHeadRefs();
    const includedFeeHeadValues = [
      ...new Set(refs.allIds.flatMap((id) => feeHeadMatchValues(id))),
    ];
    const docs = await conn.db
      .collection('transactions')
      .find({
        studentId: { $in: ids },
        studentYear: studentYearMatchFilter(studentYear),
        $or: [
          { feeHead: { $in: includedFeeHeadValues } },
          { feeHeadId: { $in: refs.allIds } },
          { feeHeadCode: { $in: refs.codeMatchers } },
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
  tuition: emptyHeadAmounts(),
  other: emptyHeadAmounts(),
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
 * Year-1 payable + paid for Tuition (TUI01) and Other/Special (OTH1), matching Step 4
 * admission view-details heads (excluding transport/hostel/application).
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, { tuition: object; other: object }>>}
 */
export async function fetchTuitionAndOtherAmountsByAdmissionNumbers(
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
  const result = new Map(
    ids.map((id) => [id, { tuition: emptyHeadAmounts(), other: emptyHeadAmounts() }])
  );
  if (ids.length === 0) return result;

  try {
    const conn = await connectFeeManagement();
    const refs = await resolveTuitionAndOtherFeeHeadRefs();
    const includedFeeHeadValues = [
      ...new Set(refs.allIds.flatMap((id) => feeHeadMatchValues(id))),
    ];

    const [payableDocs, paidDocs] = await Promise.all([
      conn.db
        .collection('studentfees')
        .find({
          studentId: { $in: ids },
          isActive: { $ne: false },
          studentYear: studentYearMatchFilter(studentYear),
          $or: [
            { feeHead: { $in: includedFeeHeadValues } },
            { feeHeadId: { $in: refs.allIds } },
            { feeHeadCode: { $in: refs.codeMatchers } },
          ],
        })
        .project({
          studentId: 1,
          amount: 1,
          feeHead: 1,
          feeHeadId: 1,
          feeHeadCode: 1,
          code: 1,
        })
        .toArray(),
      conn.db
        .collection('transactions')
        .find({
          studentId: { $in: ids },
          studentYear: studentYearMatchFilter(studentYear),
          $or: [
            { feeHead: { $in: includedFeeHeadValues } },
            { feeHeadId: { $in: refs.allIds } },
            { feeHeadCode: { $in: refs.codeMatchers } },
          ],
        })
        .project({
          studentId: 1,
          amount: 1,
          transactionType: 1,
          status: 1,
          feeHead: 1,
          feeHeadId: 1,
          feeHeadCode: 1,
          code: 1,
        })
        .toArray(),
    ]);

    for (const doc of payableDocs) {
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      const bucket = classifyHeadBucket(doc, refs);
      if (!bucket) continue;
      const entry = result.get(studentId) || {
        tuition: emptyHeadAmounts(),
        other: emptyHeadAmounts(),
      };
      entry[bucket].payable += Number(doc.amount) || 0;
      entry[bucket].hasFeeEntry = true;
      result.set(studentId, entry);
    }

    for (const doc of paidDocs) {
      if (String(doc.status || '').toLowerCase() === 'cancelled') continue;
      const amount = Number(doc.amount) || 0;
      if (amount <= 0) continue;
      const studentId = String(doc.studentId || '').trim();
      if (!studentId) continue;
      const bucket = classifyHeadBucket(doc, refs);
      if (!bucket) continue;
      const multiplier = doc.transactionType === 'CREDIT' ? -1 : 1;
      const entry = result.get(studentId) || {
        tuition: emptyHeadAmounts(),
        other: emptyHeadAmounts(),
      };
      entry[bucket].paid += amount * multiplier;
      entry[bucket].hasFeeEntry = true;
      result.set(studentId, entry);
    }

    for (const [studentId, entry] of result.entries()) {
      for (const key of ['tuition', 'other']) {
        const head = entry[key];
        head.pending = Math.max(head.payable - head.paid, 0);
        if (head.paid > 0 || head.payable > 0) head.hasFeeEntry = true;
      }
      result.set(studentId, entry);
    }
  } catch (error) {
    console.error('[fetchTuitionAndOtherAmountsByAdmissionNumbers]', error?.message || error);
  }

  return result;
}

/**
 * Build Year-1 tuition fee summary per admission (payable, paid, pending, display label).
 * Kept for callers that still need tuition-only.
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
        ...emptyTuitionSummary(),
        payable,
        paid,
        pending,
        hasFeeEntry: true,
        feeStatus: 'paid',
        displayAmount: paid,
        displayLabel: 'Paid',
        tuition: {
          payable,
          paid,
          pending,
          hasFeeEntry: true,
        },
      });
      continue;
    }

    summaries.set(id, {
      ...emptyTuitionSummary(),
      payable,
      paid,
      pending,
      hasFeeEntry: true,
      feeStatus: 'unpaid',
      displayAmount: pending > 0 ? pending : payable,
      displayLabel: 'Unpaid',
      tuition: {
        payable,
        paid,
        pending,
        hasFeeEntry: true,
      },
    });
  }

  return summaries;
}

/**
 * Build Year-1 Step 4 fee summary (Tuition TUI01 + Other/Special OTH1) per admission.
 * Combined totals drive paid/unpaid; per-head amounts are included for UI/export/print.
 *
 * Paid uses the same Student Info lookup (TUI01 + OTH1 transactions).
 * Unpaid = remaining balance (payable − paid) > tolerance — partial payments stay in the pending list.
 *
 * @param {string[]} admissionNumbers
 * @param {number} [studentYear=1]
 * @returns {Promise<Map<string, ReturnType<typeof emptyTuitionSummary>>>}
 */
export async function buildTuitionAndOtherFeeSummariesByAdmissionNumbers(
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

  const [amountsMap, combinedPaidMap] = await Promise.all([
    fetchTuitionAndOtherAmountsByAdmissionNumbers(ids, studentYear),
    fetchPaidByAdmissionNumbersForStudentYear(ids, studentYear),
  ]);

  for (const id of ids) {
    const amounts = amountsMap.get(id) || {
      tuition: emptyHeadAmounts(),
      other: emptyHeadAmounts(),
    };
    const tuition = { ...emptyHeadAmounts(), ...amounts.tuition };
    const other = { ...emptyHeadAmounts(), ...amounts.other };

    // Authoritative combined paid (same source as Student Info PAID column).
    const combinedPaid = Math.max(0, Number(combinedPaidMap.get(id) || 0));
    const classifiedPaid = Math.max(0, (tuition.paid || 0) + (other.paid || 0));

    // Prefer Student Info paid total; fall back to classified per-head sum.
    const paid = combinedPaid > FEE_PENDING_TOLERANCE ? combinedPaid : classifiedPaid;

    // If per-head paid didn't classify but combined paid exists, attribute paid to tuition
    // for display (combined columns are primary).
    if (paid > FEE_PENDING_TOLERANCE && classifiedPaid <= FEE_PENDING_TOLERANCE) {
      tuition.paid = paid;
      other.paid = 0;
    }

    tuition.pending = Math.max(tuition.payable - tuition.paid, 0);
    other.pending = Math.max(other.payable - other.paid, 0);

    const payable = tuition.payable + other.payable;
    const pending = Math.max(payable - paid, 0);
    const hasFeeEntry =
      tuition.hasFeeEntry || other.hasFeeEntry || payable > 0 || paid > 0;

    if (!hasFeeEntry) {
      summaries.set(id, emptyTuitionSummary());
      continue;
    }

    // Fully paid when little/no balance remains.
    if (pending <= FEE_PENDING_TOLERANCE) {
      summaries.set(id, {
        payable,
        paid,
        pending: 0,
        hasFeeEntry: true,
        feeStatus: 'paid',
        displayAmount: paid,
        displayLabel: 'Paid',
        tuition,
        other,
      });
      continue;
    }

    // Still owes — include partial payers with paid + remaining unpaid.
    summaries.set(id, {
      payable,
      paid,
      pending,
      hasFeeEntry: true,
      feeStatus: 'unpaid',
      displayAmount: pending,
      displayLabel: 'Unpaid',
      tuition,
      other,
    });
  }

  return summaries;
}
