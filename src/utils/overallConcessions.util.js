/**
 * overall_concessions.revised_fees JSON lines.
 * Source of truth: concessionType + amount (builder input).
 * actual / payable amounts are resolved at read time from Fee Management catalog.
 */

export const normalizeOverallConcessionType = (raw) => {
  const type = String(raw || '').trim().toUpperCase();
  if (type === 'CONCESSION') return 'CONCESSION';
  if (type === 'REVISED_FEE' || type === 'REVISED') return 'REVISED_FEE';
  return null;
};

const readPositiveAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** True when builder line has an explicit concession/revised amount for a year. */
export const isPersistableBuilderConcessionLine = (line) => {
  const concessionType = normalizeOverallConcessionType(line?.concessionType);
  if (!concessionType) return false;
  return readPositiveAmount(line?.amount) !== null;
};

/** Canonical overall_concessions.revised_fees JSON line (no catalog computed fields). */
export const formatOverallConcessionStorageLine = ({
  feeHeadId = null,
  feeHeadCode = '',
  studentYear = 1,
  concessionType,
  amount,
}) => ({
  semester: null,
  feeHeadId: feeHeadId ? String(feeHeadId).trim() : null,
  feeHeadCode: feeHeadCode ? String(feeHeadCode).trim() : '',
  studentYear: Number(studentYear) > 0 ? Number(studentYear) : 1,
  concessionType,
  amount,
});

/** Builder line (_joiningStudentFeeDetails.lines) → overall_concessions row. */
export const buildOverallConcessionLineFromBuilderLine = (line) => {
  if (!isPersistableBuilderConcessionLine(line)) return null;

  const concessionType = normalizeOverallConcessionType(line.concessionType);
  const amount = readPositiveAmount(line.amount);

  return formatOverallConcessionStorageLine({
    feeHeadId: line?.feeHeadId,
    feeHeadCode: line?.feeHeadCode,
    studentYear: line?.studentYear,
    concessionType,
    amount,
  });
};

/** All builder override lines for overall_concessions.revised_fees. */
export const buildOverallConcessionLinesFromBuilder = (studentFeeDetails) => {
  const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  return linesIn.map(buildOverallConcessionLineFromBuilderLine).filter(Boolean);
};

/**
 * Legacy fee-request portal line (actualAmount + revisedAmount) → builder-style row.
 * Used when student_fee_details is missing on an old request.
 */
export const buildOverallConcessionLineFromPortalLine = (line) => {
  const concessionType = normalizeOverallConcessionType(line?.concessionType);
  const actualAmount = Number(line?.actualAmount) || 0;
  const revisedAmount = Number(line?.revisedAmount) || 0;

  let resolvedType = concessionType;
  if (!resolvedType && actualAmount > 0 && revisedAmount > 0 && revisedAmount < actualAmount) {
    resolvedType = 'CONCESSION';
  }
  if (!resolvedType && revisedAmount > 0) {
    resolvedType = 'REVISED_FEE';
  }
  if (!resolvedType) return null;

  let amount = null;
  if (resolvedType === 'CONCESSION') {
    const raw = readPositiveAmount(line?.amount);
    if (raw !== null) {
      amount = raw;
    } else if (readPositiveAmount(line?.concessionAmount) !== null) {
      amount = readPositiveAmount(line.concessionAmount);
    } else if (actualAmount > 0 && revisedAmount >= 0 && revisedAmount < actualAmount) {
      amount = actualAmount - revisedAmount;
    }
  } else {
    const explicit = readPositiveAmount(line?.amount);
    if (explicit !== null) {
      amount = explicit;
    } else if (
      actualAmount > 0 &&
      readPositiveAmount(revisedAmount) !== null &&
      revisedAmount !== actualAmount
    ) {
      amount = readPositiveAmount(revisedAmount);
    }
  }

  if (amount === null) return null;

  return formatOverallConcessionStorageLine({
    feeHeadId: line?.feeHeadId,
    feeHeadCode: line?.feeHeadCode,
    studentYear: line?.studentYear,
    concessionType: resolvedType,
    amount,
  });
};

export const buildOverallConcessionLinesFromPortalLines = (portalLines) => {
  const linesIn = Array.isArray(portalLines) ? portalLines : [];
  return linesIn.map(buildOverallConcessionLineFromPortalLine).filter(Boolean);
};

/** Normalize any stored/API line (new or legacy) → canonical storage shape. */
export const normalizeOverallConcessionLineForStorage = (line) => {
  if (!line || typeof line !== 'object') return null;
  return buildOverallConcessionLineFromBuilderLine(line) || buildOverallConcessionLineFromPortalLine(line);
};

export const normalizeOverallConcessionLinesForStorage = (lines = []) =>
  (Array.isArray(lines) ? lines : []).map(normalizeOverallConcessionLineForStorage).filter(Boolean);
