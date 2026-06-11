/**
 * Shared admission quota classification for stats SQL and student sync.
 * Aligns with frontend `joiningScholarshipQuotaDefault` (Management / Convenor labels
 * from secondary `student_quotas`, e.g. "MANAGEMENT QUOTA", "CONVENOR QUOTA").
 */

/** Normalized quota string for comparisons (trimmed uppercase). */
export const normalizeQuotaUpper = (quota) => String(quota ?? '').trim().toUpperCase();

/**
 * Classify a stored quota label into abstract seat buckets.
 * @returns {'CONV' | 'MANG' | 'SPOT' | null}
 */
export const classifyAdmissionQuotaCategory = (quota) => {
  const q = normalizeQuotaUpper(quota);
  if (!q) return null;

  // Lateral variants map to underlying seat type (matches admissions abstract SQL).
  if (q.includes('LATERAL') && q.includes('ENTRY')) return 'CONV';
  if (
    q === 'LATERAL SPOT' ||
    q.includes('LATERAL SPOT') ||
    (q.includes('LATERAL') && (q.includes('SPOT') || q.includes('MANG')))
  ) {
    return 'MANG';
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

/** Convenor quota (CQ / CONV) — matches catalog labels like "CONVENOR QUOTA". */
export const SQL_IS_CONV_QUOTA = `(
  ${SQL_LATERAL_ENTRY}
  OR ${SQL_QUOTA_UPPER} IN ('CONV', 'CONVENOR', 'CONVENER')
  OR ${SQL_QUOTA_UPPER} LIKE '%CONVENOR%'
  OR ${SQL_QUOTA_UPPER} LIKE '%CONVENER%'
  OR (
    ${SQL_QUOTA_UPPER} LIKE '%CONV%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%MANG%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%MANAGEMENT%'
  )
)`;

/** Management quota (MQ / MANG) — matches catalog labels like "MANAGEMENT QUOTA". */
export const SQL_IS_MANG_QUOTA = `(
  ${SQL_LATERAL_SPOT}
  OR ${SQL_QUOTA_UPPER} IN ('MANG', 'MANAGEMENT')
  OR ${SQL_QUOTA_UPPER} LIKE '%MANAGEMENT%'
  OR (
    ${SQL_QUOTA_UPPER} LIKE '%MANG%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONV%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONVENOR%'
    AND ${SQL_QUOTA_UPPER} NOT LIKE '%CONVENER%'
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
