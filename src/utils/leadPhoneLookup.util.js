/** Last 10 digits — matches joining / admission mobile normalization. */
const phone10Expr = (col) =>
  `NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 10), '')`;

const LEAD_LOOKUP_COLUMNS = `
  id, enquiry_number, name, phone, father_phone, alternate_mobile,
  course_interested, quota, source, dynamic_fields, updated_at
`;

function parseDynamicFields(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatLeadLookupRow(row) {
  if (!row) return null;
  const dynamicFields = parseDynamicFields(row.dynamic_fields);
  return {
    id: row.id,
    enquiryNumber: row.enquiry_number || '',
    name: row.name || '',
    phone: row.phone || '',
    fatherPhone: row.father_phone || '',
    alternateMobile: row.alternate_mobile || '',
    courseInterested: row.course_interested || '',
    quota: row.quota || '',
    source: row.source || '',
    reference1: typeof dynamicFields.reference1 === 'string' ? dynamicFields.reference1.trim() : '',
    managedCourseId:
      typeof dynamicFields._joiningManagedCourseId === 'string'
        ? dynamicFields._joiningManagedCourseId.trim()
        : '',
    managedBranchId:
      typeof dynamicFields._joiningManagedBranchId === 'string'
        ? dynamicFields._joiningManagedBranchId.trim()
        : '',
  };
}

/**
 * Returns the most recently updated CRM lead matching student or parent mobile.
 *
 * @param {import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection} db
 * @param {string} studentPhone 10-digit student mobile
 * @param {string} parentPhone 10-digit parent mobile
 */
export async function findLeadByMobileNumbers(db, studentPhone, parentPhone) {
  const phones = [...new Set([studentPhone, parentPhone].filter((p) => typeof p === 'string' && p.length === 10))];
  if (phones.length === 0) return null;

  const placeholders = phones.map(() => '?').join(', ');
  const exactParams = [...phones, ...phones, ...phones];
  const [exactRows] = await db.execute(
    `SELECT ${LEAD_LOOKUP_COLUMNS} FROM leads
     WHERE phone IN (${placeholders})
        OR father_phone IN (${placeholders})
        OR alternate_mobile IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT 1`,
    exactParams
  );
  if (exactRows.length > 0) return formatLeadLookupRow(exactRows[0]);

  const normalizedMatchSql = phones
    .map(
      () =>
        `(${phone10Expr('phone')} = ? OR ${phone10Expr('father_phone')} = ? OR ${phone10Expr('alternate_mobile')} = ?)`
    )
    .join(' OR ');
  const normalizedParams = phones.flatMap((p) => [p, p, p]);
  const [normalizedRows] = await db.execute(
    `SELECT ${LEAD_LOOKUP_COLUMNS} FROM leads
     WHERE ${normalizedMatchSql}
     ORDER BY updated_at DESC
     LIMIT 1`,
    normalizedParams
  );
  return normalizedRows.length > 0 ? formatLeadLookupRow(normalizedRows[0]) : null;
}

/** @deprecated use findLeadByMobileNumbers */
export async function leadExistsByMobileNumbers(db, studentPhone, parentPhone) {
  const lead = await findLeadByMobileNumbers(db, studentPhone, parentPhone);
  return Boolean(lead);
}
