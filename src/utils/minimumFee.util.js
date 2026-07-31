/**
 * Minimum fee config matching + pending-amount helpers.
 * Mirrors frontend MinimumFeeConfigDialog / PendingAdmissionsDownloadModal
 * and admissionPendingFeeDocsSmsScheduler.service.js.
 */

const FEE_UNPAID_TOLERANCE = 0.5;

const normalizeLower = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * Resolve configured minimum fee for a pending row / filter context.
 * Prefer college+course+branch+quota, then course+branch+quota, then branch+quota if unique.
 */
export function resolveMinimumFeeAmount(configs, match) {
  if (!Array.isArray(configs) || configs.length === 0) return 0;

  const quota = normalizeLower(match?.quota);
  const courseId = String(match?.courseId ?? '').trim();
  const collegeId = String(match?.collegeId ?? '').trim();
  const courseName = normalizeLower(match?.courseName);
  const branchId = String(match?.branchId ?? '').trim();
  const branchName = normalizeLower(match?.branchName);

  if (collegeId && courseId && branchId && quota) {
    const exact = configs.find(
      (c) =>
        String(c.collegeId ?? '').trim() === collegeId &&
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === branchId &&
        normalizeLower(c.quota) === quota
    );
    if (exact) return Number(exact.amount) || 0;
  }

  if (courseId && branchId && quota) {
    const byCourseId = configs.find(
      (c) =>
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === branchId &&
        normalizeLower(c.quota) === quota
    );
    if (byCourseId) return Number(byCourseId.amount) || 0;
  }

  if (courseName && branchName && quota) {
    const byCourseName = configs.find(
      (c) =>
        normalizeLower(c.courseName) === courseName &&
        normalizeLower(c.branchName) === branchName &&
        normalizeLower(c.quota) === quota
    );
    if (byCourseName) return Number(byCourseName.amount) || 0;
  }

  if (branchId && quota) {
    const byBranch = configs.filter(
      (c) => String(c.branchId ?? '').trim() === branchId && normalizeLower(c.quota) === quota
    );
    if (byBranch.length === 1) return Number(byBranch[0].amount) || 0;
  }

  // Backward compatibility: old course-level configs without branch scope.
  if (collegeId && courseId && quota) {
    const courseLevel = configs.find(
      (c) =>
        String(c.collegeId ?? '').trim() === collegeId &&
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === '' &&
        normalizeLower(c.quota) === quota
    );
    if (courseLevel) return Number(courseLevel.amount) || 0;
  }

  if (courseId && quota) {
    const byCourse = configs.find(
      (c) =>
        String(c.courseId ?? '').trim() === courseId &&
        String(c.branchId ?? '').trim() === '' &&
        normalizeLower(c.quota) === quota
    );
    if (byCourse) return Number(byCourse.amount) || 0;
  }

  if (courseName && quota) {
    const byCourseName = configs.find(
      (c) =>
        normalizeLower(c.courseName) === courseName &&
        String(c.branchId ?? '').trim() === '' &&
        normalizeLower(c.quota) === quota
    );
    if (byCourseName) return Number(byCourseName.amount) || 0;
  }

  return 0;
}

/**
 * Unpaid uses Year-1 tuition + other by default.
 * When a matching minimum fee config exists, unpaid is max(minFee − paid, 0).
 */
export function resolvePendingFeeAmounts(row, minimumFeeConfigs, matchContext = {}) {
  const totalPaid = Number(row?.totalPaid ?? row?.tuitionPaid ?? 0) || 0;
  const fullPayable =
    Number(
      row?.totalPayable ?? Number(row?.tuitionPayable || 0) + Number(row?.otherPayable || 0)
    ) || 0;

  const minimumFeeRequired = resolveMinimumFeeAmount(minimumFeeConfigs, {
    collegeId: matchContext?.collegeId,
    courseId: matchContext?.courseId,
    courseName: matchContext?.courseName ?? row?.course,
    branchId: matchContext?.branchId,
    branchName: matchContext?.branchName ?? row?.branch,
    quota: row?.quota ?? matchContext?.quota,
  });

  const usingMinFee = minimumFeeRequired > FEE_UNPAID_TOLERANCE;
  const requiredAmount = usingMinFee ? minimumFeeRequired : fullPayable;
  const unpaid = usingMinFee
    ? Math.max(requiredAmount - totalPaid, 0)
    : Number(row?.totalPending ?? Math.max(fullPayable - totalPaid, 0)) || 0;

  return {
    fullPayable,
    requiredAmount,
    totalPaid,
    unpaid,
    usingMinFee,
    minimumFeeRequired,
  };
}

/** True when this row should appear on the fee-pending list (vs min fee when configured). */
export function isFeeStillPending(row, minimumFeeConfigs, matchContext = {}) {
  if (!Array.isArray(minimumFeeConfigs) || minimumFeeConfigs.length === 0) {
    return row?.feeStatus === 'unpaid' || Number(row?.totalPending || 0) > FEE_UNPAID_TOLERANCE;
  }

  const { unpaid, usingMinFee } = resolvePendingFeeAmounts(row, minimumFeeConfigs, matchContext);
  if (usingMinFee) return unpaid > FEE_UNPAID_TOLERANCE;
  // Minimum-fee mode is active, but this student has no matching config — exclude.
  return false;
}

/**
 * When min fee configs exist and this row matches, rewrite payable / pending / Amount
 * fields to use the configured minimum (same as UI + Print PDF).
 */
export function applyMinimumFeeAmountsToPendingRow(row, minimumFeeConfigs, matchContext = {}) {
  if (!Array.isArray(minimumFeeConfigs) || minimumFeeConfigs.length === 0) {
    return row;
  }

  const amounts = resolvePendingFeeAmounts(row, minimumFeeConfigs, matchContext);
  if (!amounts.usingMinFee) return row;

  const unpaid = amounts.unpaid;
  const requiredAmount = amounts.requiredAmount;

  return {
    ...row,
    totalPayable: requiredAmount,
    totalPending: unpaid,
    payable: requiredAmount,
    pending: unpaid,
    displayAmount: unpaid,
    displayLabel: unpaid > FEE_UNPAID_TOLERANCE ? 'Unpaid' : 'Paid',
    feeStatus: unpaid > FEE_UNPAID_TOLERANCE ? 'unpaid' : 'paid',
    feeStatusText: unpaid > FEE_UNPAID_TOLERANCE ? 'Unpaid' : 'Paid',
    feeAmountText:
      unpaid > FEE_UNPAID_TOLERANCE
        ? `Unpaid — ${unpaid}`
        : `Paid — ${amounts.totalPaid}`,
    isPending: unpaid > FEE_UNPAID_TOLERANCE,
    isPaid: unpaid <= FEE_UNPAID_TOLERANCE,
    usingMinFee: true,
    minimumFeeRequired: amounts.minimumFeeRequired,
  };
}

export function mapMinimumFeeConfigRows(rows) {
  return (rows || []).map((row) => ({
    id: row.id,
    collegeId: String(row.college_id ?? ''),
    collegeName: String(row.college_name ?? ''),
    courseId: String(row.course_id ?? ''),
    courseName: String(row.course_name ?? ''),
    branchId: String(row.branch_id ?? ''),
    branchName: String(row.branch_name ?? ''),
    quota: String(row.quota ?? ''),
    amount: Number(row.amount) || 0,
  }));
}

export async function loadMinimumFeeConfigs(pool) {
  try {
    const [rows] = await pool.execute(
      `SELECT id, college_id, college_name, course_id, course_name, branch_id, branch_name, quota, amount
       FROM admission_minimum_fee_configs
       ORDER BY college_name ASC, course_name ASC, branch_name ASC, quota ASC`
    );
    return mapMinimumFeeConfigRows(rows);
  } catch {
    return [];
  }
}

export { FEE_UNPAID_TOLERANCE };
