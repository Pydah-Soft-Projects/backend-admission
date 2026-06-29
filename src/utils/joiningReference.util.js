import { v4 as uuidv4 } from 'uuid';
import { isSelfRegistrationLead } from './joiningSelfRegistration.util.js';

/**
 * Reference 1 mirrors the staff member who most recently marked either
 * counsellor call_status or PRO visit_status as Confirmed.
 * Stored at lead_data.reference1, dynamic_fields.reference1 (leads), and admission records.
 */

/** Activity log row where call_status or visit_status was set to Confirmed. */
const CHANNEL_STATUS_CONFIRMED_SQL = `
  (
    LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.callStatus')), ''))) = 'confirmed'
    OR LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.visitStatus')), ''))) = 'confirmed'
  )
`;

export const isCallStatusConfirmedValue = (value) =>
  String(value ?? '').trim().toLowerCase() === 'confirmed';

export const readReference1FromDynamicFields = (dynamicFields) => {
  if (!dynamicFields || typeof dynamicFields !== 'object') return '';
  return String(dynamicFields.reference1 ?? '').trim();
};

/** Last user who marked call_status or visit_status as Confirmed (from activity_logs). */
export async function fetchLastConfirmedStatusByUserName(pool, leadId) {
  if (!leadId || typeof leadId !== 'string') return '';

  const [rows] = await pool.execute(
    `SELECT u.name AS confirmer_name
     FROM activity_logs a
     INNER JOIN users u ON u.id = a.performed_by
     WHERE a.lead_id = ?
       AND a.type = 'status_change'
       AND (${CHANNEL_STATUS_CONFIRMED_SQL})
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [leadId]
  );

  return String(rows[0]?.confirmer_name ?? '').trim();
}

/** @deprecated Use fetchLastConfirmedStatusByUserName. */
export const fetchLastCallStatusConfirmedByUserName = fetchLastConfirmedStatusByUserName;

/** Resolve reference1 from latest confirmed status, optional override, then stored fields. */
export async function resolveReference1ForLead(pool, leadOrSnapshot, options = {}) {
  const { confirmerNameOverride = '', skipReferenceResolution = false } = options;
  if (skipReferenceResolution || isSelfRegistrationLead(leadOrSnapshot)) return '';
  if (!leadOrSnapshot || typeof leadOrSnapshot !== 'object') return '';

  const override = String(confirmerNameOverride ?? '').trim();
  if (override) return override;

  const leadId = String(leadOrSnapshot.id ?? leadOrSnapshot._id ?? '').trim();
  if (leadId && pool) {
    const latestConfirmedBy = await fetchLastConfirmedStatusByUserName(pool, leadId);
    if (latestConfirmedBy) return latestConfirmedBy;
  }

  const dyn = leadOrSnapshot.dynamicFields ?? leadOrSnapshot.dynamic_fields;
  const fromDyn = readReference1FromDynamicFields(dyn);
  if (fromDyn) return fromDyn;

  const fromSnap = String(leadOrSnapshot.reference1 ?? '').trim();
  if (fromSnap) return fromSnap;

  return '';
}

export const applyReference1ToSnapshot = (snapshot, reference1) => {
  const ref = String(reference1 ?? '').trim();
  if (!ref || !snapshot || typeof snapshot !== 'object') return snapshot;

  snapshot.reference1 = ref;

  const dyn =
    snapshot.dynamicFields && typeof snapshot.dynamicFields === 'object'
      ? { ...snapshot.dynamicFields }
      : snapshot.dynamic_fields && typeof snapshot.dynamic_fields === 'object'
        ? { ...snapshot.dynamic_fields }
        : {};

  if (!readReference1FromDynamicFields(dyn)) {
    dyn.reference1 = ref;
  }
  snapshot.dynamicFields = dyn;
  delete snapshot.dynamic_fields;

  return snapshot;
};

/** Lead snapshot for joinings — ensures reference1 follows latest confirmed call/visit status. */
export async function buildJoiningLeadDataSnapshot(pool, lead, options = {}) {
  const snapshot = { ...(lead || {}) };
  delete snapshot._id;
  delete snapshot.id;
  delete snapshot.__v;

  if (options.skipReferenceResolution || isSelfRegistrationLead(snapshot)) {
    delete snapshot.reference1;
    return snapshot;
  }

  const reference1 = await resolveReference1ForLead(pool, snapshot, options);
  if (!reference1) return snapshot;

  return applyReference1ToSnapshot(snapshot, reference1);
}

/**
 * When call_status/visit_status is marked Confirmed, persist the acting user as reference1.
 * Mutates parallel updateFields / updateValues arrays used by lead update handlers.
 */
export async function applyReference1OnCallStatusConfirm(
  pool,
  leadRow,
  updateFields,
  updateValues,
  pendingDynamicMerge = null,
  confirmerUserId = null
) {
  let dyn =
    typeof leadRow.dynamic_fields === 'string'
      ? JSON.parse(leadRow.dynamic_fields || '{}')
      : { ...(leadRow.dynamic_fields || {}) };

  if (pendingDynamicMerge && typeof pendingDynamicMerge === 'object') {
    dyn = { ...dyn, ...pendingDynamicMerge };
  }

  const dynIdx = updateFields.findIndex((f) => f === 'dynamic_fields = ?');
  if (dynIdx >= 0) {
    try {
      const queued = JSON.parse(updateValues[dynIdx]);
      if (queued && typeof queued === 'object') {
        dyn = { ...dyn, ...queued };
      }
    } catch {
      /* ignore malformed queued JSON */
    }
  }

  const actorId = confirmerUserId || null;
  if (!actorId) return;

  const [rows] = await pool.execute('SELECT name FROM users WHERE id = ? LIMIT 1', [actorId]);
  const refName = String(rows[0]?.name ?? '').trim();
  if (!refName) return;

  dyn.reference1 = refName;

  if (dynIdx >= 0) {
    updateValues[dynIdx] = JSON.stringify(dyn);
  } else {
    updateFields.push('dynamic_fields = ?');
    updateValues.push(JSON.stringify(dyn));
  }
}

const parseJsonObject = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
};

/**
 * Resolve Excel Reference 1 for an admission from admission.lead_data, linked joining, then CRM lead.
 */
export async function resolveAdmissionReference1(pool, { leadDataRaw, joiningId, leadId }) {
  const admLd = leadDataRaw && typeof leadDataRaw === 'object' ? leadDataRaw : parseJsonObject(leadDataRaw);
  const fromAdm = String(admLd.reference1 ?? admLd.referenceName ?? '').trim();
  if (fromAdm) return fromAdm;

  if (joiningId) {
    const [joinRows] = await pool.execute('SELECT lead_data FROM joinings WHERE id = ? LIMIT 1', [
      joiningId,
    ]);
    if (joinRows.length) {
      const jLd = parseJsonObject(joinRows[0].lead_data);
      const fromJoin = String(jLd.reference1 ?? jLd.referenceName ?? '').trim();
      if (fromJoin) return fromJoin;
    }
  }

  if (leadId) {
    const [leadRows] = await pool.execute(
      'SELECT id, dynamic_fields FROM leads WHERE id = ? LIMIT 1',
      [leadId]
    );
    if (leadRows.length) {
      const row = leadRows[0];
      const dyn =
        typeof row.dynamic_fields === 'string'
          ? parseJsonObject(row.dynamic_fields)
          : parseJsonObject(row.dynamic_fields);
      const fromLead = await resolveReference1ForLead(pool, {
        id: row.id,
        dynamicFields: dyn,
      });
      if (fromLead) return fromLead;
    }
  }

  return '';
};

/**
 * Write Reference 1 on lead, all joinings, and all admissions for a CRM lead.
 * Used by backfill scripts (no activity log / user audit on admissions beyond updated_at).
 */
export async function persistLeadReference1(pool, leadId, reference1, options = {}) {
  const ref = String(reference1 ?? '').trim();
  const leadKey = String(leadId ?? '').trim();
  if (!ref || !leadKey) {
    return { leadUpdated: false, joiningsUpdated: 0, admissionsUpdated: 0 };
  }

  const [leadResult] = await pool.execute(
    `UPDATE leads SET
       dynamic_fields = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE id = ?`,
    [ref, leadKey]
  );

  const [joinResult] = await pool.execute(
    `UPDATE joinings SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE lead_id = ?`,
    [ref, leadKey]
  );

  let admissionsUpdated = 0;
  if (options.syncAdmissions !== false) {
    const [admRows] = await pool.execute('SELECT id FROM admissions WHERE lead_id = ?', [leadKey]);
    for (const row of admRows) {
      await pool.execute(
        `UPDATE admissions SET
           lead_data = JSON_SET(
             COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
             '$.reference1', ?
           ),
           updated_at = NOW()
         WHERE id = ?`,
        [ref, row.id]
      );
      admissionsUpdated += 1;
    }
  }

  return {
    leadUpdated: (leadResult.affectedRows ?? 0) > 0,
    joiningsUpdated: joinResult.affectedRows ?? 0,
    admissionsUpdated,
  };
};

/** Backfill joinings.lead_data.reference1 from last call_status Confirmed activity. */
export async function backfillJoiningReferenceFromLead(pool, joiningRow, lead) {
  if (!joiningRow?.id || !lead) return false;
  if (isSelfRegistrationLead(lead)) return false;

  const leadId = String(lead.id ?? lead._id ?? joiningRow.lead_id ?? '').trim();
  if (!leadId) return false;

  const callConfirmer = await fetchLastCallStatusConfirmedByUserName(pool, leadId);
  if (!callConfirmer) return false;

  let ld =
    typeof joiningRow.lead_data === 'string'
      ? JSON.parse(joiningRow.lead_data || '{}')
      : { ...(joiningRow.lead_data || {}) };

  const existing = await resolveReference1ForLead(pool, {
    ...ld,
    dynamicFields: ld.dynamicFields ?? lead.dynamicFields,
    id: leadId,
  });

  if (existing && existing.toLowerCase() === callConfirmer.toLowerCase()) return false;

  const assigned = lead.assignedTo ?? lead.assigned_to;
  const assigneeName =
    assigned && typeof assigned === 'object'
      ? String(assigned.name ?? '').trim()
      : String(lead.assigned_to_name ?? '').trim();

  const shouldReplaceStaleAutoRef =
    !existing ||
    (assigneeName && existing.toLowerCase() === assigneeName.toLowerCase());

  if (existing && !shouldReplaceStaleAutoRef) return false;

  const nextLd = await buildJoiningLeadDataSnapshot(pool, { ...lead, ...ld }, {
    confirmerNameOverride: callConfirmer,
  });

  await pool.execute(`UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?`, [
    JSON.stringify(nextLd),
    joiningRow.id,
  ]);
  joiningRow.lead_data = JSON.stringify(nextLd);
  return true;
}

export const normalizeReferenceNameKey = (s) => String(s ?? '').trim().toLowerCase();

const sqlJsonRefEquals = (columnExpr, jsonPath) =>
  `LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(
     COALESCE(CASE WHEN JSON_VALID(${columnExpr}) THEN ${columnExpr} ELSE JSON_OBJECT() END, JSON_OBJECT()),
     '${jsonPath}'
   )))) = ?`;

/**
 * Rename a saved reference name everywhere it is stored (admissions, joinings, leads).
 * Does not change records where the name does not match (case-insensitive trim).
 */
export async function renameReferenceNameGlobally(pool, oldName, newName) {
  const oldTrim = String(oldName ?? '').trim();
  const newTrim = String(newName ?? '').trim();
  if (!oldTrim) {
    const err = new Error('Current reference name is required');
    err.statusCode = 400;
    throw err;
  }
  if (!newTrim) {
    const err = new Error('New reference name is required');
    err.statusCode = 400;
    throw err;
  }
  if (normalizeReferenceNameKey(oldTrim) === normalizeReferenceNameKey(newTrim)) {
    return { admissionsUpdated: 0, joiningsUpdated: 0, leadsUpdated: 0, renamed: false };
  }

  const matchKey = normalizeReferenceNameKey(oldTrim);

  const [admRef1] = await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.reference1')}`,
    [newTrim, matchKey]
  );

  const [admRefName] = await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.referenceName', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.referenceName')}`,
    [newTrim, matchKey]
  );

  const [joinRef1] = await pool.execute(
    `UPDATE joinings SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.reference1')}`,
    [newTrim, matchKey]
  );

  const [joinRefName] = await pool.execute(
    `UPDATE joinings SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.referenceName', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.referenceName')}`,
    [newTrim, matchKey]
  );

  const [leadResult] = await pool.execute(
    `UPDATE leads SET
       dynamic_fields = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('dynamic_fields', '$.reference1')}`,
    [newTrim, matchKey]
  );

  try {
    await pool.execute(
      `UPDATE reference_picker_hidden SET
         name_normalized = ?,
         original_name = ?
       WHERE name_normalized = ?`,
      [normalizeReferenceNameKey(newTrim), newTrim, matchKey]
    );
  } catch {
    /* table may not exist yet */
  }

  return {
    admissionsUpdated: (admRef1.affectedRows ?? 0) + (admRefName.affectedRows ?? 0),
    joiningsUpdated: (joinRef1.affectedRows ?? 0) + (joinRefName.affectedRows ?? 0),
    leadsUpdated: leadResult.affectedRows ?? 0,
    renamed: true,
  };
}

/**
 * Clear reference1 / referenceName everywhere the given name appears.
 */
export async function clearReferenceNameGlobally(pool, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    const err = new Error('Reference name is required');
    err.statusCode = 400;
    throw err;
  }
  const matchKey = normalizeReferenceNameKey(trimmed);
  const empty = '';

  const [admRef1] = await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.reference1')}`,
    [empty, matchKey]
  );

  const [admRefName] = await pool.execute(
    `UPDATE admissions SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.referenceName', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.referenceName')}`,
    [empty, matchKey]
  );

  const [joinRef1] = await pool.execute(
    `UPDATE joinings SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.reference1')}`,
    [empty, matchKey]
  );

  const [joinRefName] = await pool.execute(
    `UPDATE joinings SET
       lead_data = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.referenceName', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('lead_data', '$.referenceName')}`,
    [empty, matchKey]
  );

  const [leadResult] = await pool.execute(
    `UPDATE leads SET
       dynamic_fields = JSON_SET(
         COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
         '$.reference1', ?
       ),
       updated_at = NOW()
     WHERE ${sqlJsonRefEquals('dynamic_fields', '$.reference1')}`,
    [empty, matchKey]
  );

  return {
    admissionsUpdated: (admRef1.affectedRows ?? 0) + (admRefName.affectedRows ?? 0),
    joiningsUpdated: (joinRef1.affectedRows ?? 0) + (joinRefName.affectedRows ?? 0),
    leadsUpdated: leadResult.affectedRows ?? 0,
  };
}

const SQL_USAGE_A_LEAD_DATA = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_USAGE_A_REF1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_USAGE_A_LEAD_DATA}, '$.reference1'))), '')`;
const SQL_USAGE_A_REFNAME = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_USAGE_A_LEAD_DATA}, '$.referenceName'))), '')`;
const SQL_USAGE_J_LEAD_DATA = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_USAGE_J_REF1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_USAGE_J_LEAD_DATA}, '$.reference1'))), '')`;
const SQL_USAGE_J_REFNAME = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_USAGE_J_LEAD_DATA}, '$.referenceName'))), '')`;
const SQL_USAGE_L_DYNAMIC = `COALESCE(CASE WHEN JSON_VALID(l.dynamic_fields) THEN l.dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_USAGE_L_REF1 = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_USAGE_L_DYNAMIC}, '$.reference1'))), '')`;
const SQL_USAGE_EFFECTIVE_REF = `COALESCE(${SQL_USAGE_A_REF1}, ${SQL_USAGE_A_REFNAME}, ${SQL_USAGE_J_REF1}, ${SQL_USAGE_J_REFNAME}, ${SQL_USAGE_L_REF1})`;
const SQL_USAGE_REF_MATCH = `LOWER(TRIM(${SQL_USAGE_EFFECTIVE_REF})) = ?`;

/** Admissions / joinings / leads using this reference name (for manage dialog). */
export async function getReferenceNameUsage(pool, name, { admissionLimit = 50 } = {}) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    const err = new Error('Reference name is required');
    err.statusCode = 400;
    throw err;
  }
  const matchKey = normalizeReferenceNameKey(trimmed);

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE ${SQL_USAGE_REF_MATCH}`,
    [matchKey]
  );
  const admissionsCount = Number(countRows[0]?.total ?? 0);

  const [joinCountRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM joinings j
     WHERE ${sqlJsonRefEquals('lead_data', '$.reference1')} OR ${sqlJsonRefEquals('lead_data', '$.referenceName')}`,
    [matchKey, matchKey]
  );
  const joiningsCount = Number(joinCountRows[0]?.total ?? 0);

  const [leadCountRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM leads l WHERE ${sqlJsonRefEquals('dynamic_fields', '$.reference1')}`,
    [matchKey]
  );
  const leadsCount = Number(leadCountRows[0]?.total ?? 0);

  const limit = Math.min(Math.max(Number(admissionLimit) || 50, 1), 100);
  const [admissionRows] = await pool.execute(
    `SELECT
       a.id,
       a.admission_number AS admissionNumber,
       COALESCE(NULLIF(TRIM(a.student_name), ''), '—') AS studentName,
       a.status,
       COALESCE(NULLIF(TRIM(a.course), ''), '—') AS course,
       COALESCE(NULLIF(TRIM(a.branch), ''), '—') AS branch
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE ${SQL_USAGE_REF_MATCH}
     ORDER BY a.created_at DESC
     LIMIT ${limit}`,
    [matchKey]
  );

  return {
    name: trimmed,
    admissionsCount,
    joiningsCount,
    leadsCount,
    admissions: admissionRows.map((row) => ({
      id: String(row.id ?? ''),
      admissionNumber: String(row.admissionNumber ?? '').trim() || '—',
      studentName: String(row.studentName ?? '').trim() || '—',
      status: String(row.status ?? '').trim() || '—',
      course: String(row.course ?? '').trim() || '—',
      branch: String(row.branch ?? '').trim() || '—',
    })),
    admissionsTruncated: admissionsCount > admissionRows.length,
  };
}

/** Hide a name from the reference picker without clearing stored references on records. */
export async function hideReferenceNameFromPicker(pool, name, userId = null) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    const err = new Error('Reference name is required');
    err.statusCode = 400;
    throw err;
  }
  const normalized = normalizeReferenceNameKey(trimmed);
  const id = uuidv4();
  await pool.execute(
    `INSERT INTO reference_picker_hidden (id, name_normalized, original_name, hidden_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       original_name = VALUES(original_name),
       hidden_by = VALUES(hidden_by),
       hidden_at = NOW()`,
    [id, normalized, trimmed, userId || null]
  );
  return { hidden: true, name: trimmed };
}
