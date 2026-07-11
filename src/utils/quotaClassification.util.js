/**
 * Shared admission quota classification for stats SQL and student sync.
 * Aligns with frontend `joiningScholarshipQuotaDefault` (Management / Convenor labels
 * from secondary `student_quotas`, e.g. "MANAGEMENT QUOTA", "CONVENOR QUOTA").
 */

/** Normalized quota string for comparisons (trimmed uppercase). */
export const normalizeQuotaUpper = (quota) => String(quota ?? '').trim().toUpperCase();

/**
 * Classify a stored quota label into abstract seat / fee buckets.
 * @returns {'CONV' | 'MANG' | 'SPOT' | 'LATER' | 'LSPOT' | null}
 */
export const classifyAdmissionQuotaCategory = (quota) => {
  const q = normalizeQuotaUpper(quota);
  if (!q) return null;

  // Lateral entry is its own track — do not fold into convenor (CONV).
  if (q.includes('LATERAL') && q.includes('ENTRY')) return 'LATER';
  if (
    q === 'LATERAL SPOT' ||
    q.includes('LATERAL SPOT') ||
    (q.includes('LATERAL') && (q.includes('SPOT') || q.includes('MANG')))
  ) {
    return 'LSPOT';
  }

  if (
    q === 'MANG' ||
    q === 'MANAGEMENT' ||
    q.includes('MANAGEMENT') ||
    (q.includes('MANG') && !q.includes('CONV'))
  ) {
    return 'MANG';
  }

  if (
    q === 'CONV' ||
    q === 'CONVENOR' ||
    q === 'CONVENER' ||
    q.includes('CONVENOR') ||
    q.includes('CONVENER') ||
    (q.includes('CONV') && !q.includes('MANG') && !q.includes('MANAGEMENT'))
  ) {
    return 'CONV';
  }

  if (
    q === 'SPOT' ||
    q === 'SPOT ADMISSION' ||
    (q.includes('SPOT') &&
      !q.includes('LATERAL') &&
      !q.includes('MANG') &&
      !q.includes('MANAGEMENT') &&
      !q.includes('CONV') &&
      !q.includes('CONVENOR') &&
      !q.includes('CONVENER'))
  ) {
    return 'SPOT';
  }

  return null;
};

/**
 * Map joining quota (+ optional student status / batch) to Fee Management `feestructures.category`.
 * Lateral Entry → LATER; Lateral Spot → LSPOT; never folded into CONV.
 */
export const mapQuotaToFeeCategory = (quota, studentStatus = null, batch = null) => {
  const fromQuota = classifyAdmissionQuotaCategory(quota);
  if (fromQuota === 'LATER' || fromQuota === 'LSPOT') return fromQuota;

  const key = String(quota ?? '').trim().toLowerCase();
  if (!key) return fromQuota || '';

  const cleanBatch = String(batch ?? '').trim();
  const isLateral = String(studentStatus ?? '').trim().toLowerCase() === 'lateral';

  // B.Tech lateral intake (prior-year batch): convenor CQ rows use LATER fee catalog.
  if (isLateral && cleanBatch === '2025') {
    if (key === 'cq' || key.includes('conv') || key.includes('later')) return 'LATER';
    if (key === 'spot' || key.includes('lspot')) return 'LSPOT';
  }

  return fromQuota || '';
};

/** SQL expression for normalized `quota` column (unqualified `admissions.quota`). */
export const SQL_QUOTA_UPPER = `UPPER(TRIM(COALESCE(quota, '')))`;

const SQL_LATERAL_ENTRY = `(
  ${SQL_QUOTA_UPPER} LIKE '%LATERAL%ENTRY%'
  OR ${SQL_QUOTA_UPPER} = 'LATERAL ENTRY'
)`;

const SQL_LATERAL_SPOT = `(
  ${SQL_QUOTA_UPPER} LIKE '%LATERAL%SPOT%'
  OR ${SQL_QUOTA_UPPER} = 'LATERAL SPOT'
  OR (
    ${SQL_QUOTA_UPPER} LIKE '%LATERAL%'
    AND (${SQL_QUOTA_UPPER} LIKE '%SPOT%' OR ${SQL_QUOTA_UPPER} LIKE '%MANG%')
  )
)`;

/** Lateral entry quota — separate from convenor in stats and fee catalog. */
export const SQL_IS_LATER_QUOTA = SQL_LATERAL_ENTRY;

/** Lateral spot quota — separate from management convenor spot. */
export const SQL_IS_LSPOT_QUOTA = SQL_LATERAL_SPOT;

/** Convenor quota (CQ / CONV) — matches catalog labels like "CONVENOR QUOTA". */
export const SQL_IS_CONV_QUOTA = `(
  ${SQL_QUOTA_UPPER} IN ('CONV', 'CONVENOR', 'CONVENER')
  OR ${SQL_QUOTA_UPPER} LIKE '%CONVENOR%'
  OR ${SQL_QUOTA_UPPER} LIKE '%CONVENER%'
  OR (
    ${SQL_QUOTA_UPPER} LIKE '%CONV%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%MANG%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%MANAGEMENT%'
    AND NOT ${SQL_LATERAL_ENTRY}
  )
)`;

/** Management quota (MQ / MANG) — matches catalog labels like "MANAGEMENT QUOTA". */
export const SQL_IS_MANG_QUOTA = `(
  ${SQL_QUOTA_UPPER} IN ('MANG', 'MANAGEMENT')
  OR ${SQL_QUOTA_UPPER} LIKE '%MANAGEMENT%'
  OR (
    ${SQL_QUOTA_UPPER} LIKE '%MANG%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONV%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONVENOR%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONVENER%'
    AND NOT ${SQL_LATERAL_SPOT}
  )
)`;

/** Spot quota (excludes lateral-spot, which is counted under management). */
export const SQL_IS_SPOT_QUOTA = `(
  ${SQL_QUOTA_UPPER} IN ('SPOT', 'SPOT ADMISSION')
  OR (
    ${SQL_QUOTA_UPPER} LIKE '%SPOT%'
    AND NOT ${SQL_LATERAL_SPOT}
    AND NOT ${SQL_LATERAL_ENTRY}
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%MANAGEMENT%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%MANG%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONV%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONVENOR%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONVENER%'
  )
)`;
