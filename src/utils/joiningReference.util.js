/**
 * Reference 1 mirrors the staff member who last marked call_status as Confirmed.
 * Stored at lead_data.reference1, dynamic_fields.reference1 (leads), and admission records.
 */

/** Activity log row where call_status was set to Confirmed (metadata.callStatus). */
const CALL_STATUS_CONFIRMED_SQL = `
  LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.callStatus')), ''))) = 'confirmed'
`;

export const isCallStatusConfirmedValue = (value) =>
  String(value ?? '').trim().toLowerCase() === 'confirmed';

export const readReference1FromDynamicFields = (dynamicFields) => {
  if (!dynamicFields || typeof dynamicFields !== 'object') return '';
  return String(dynamicFields.reference1 ?? '').trim();
};

/** Last user who marked call_status as Confirmed (from activity_logs). */
export async function fetchLastCallStatusConfirmedByUserName(pool, leadId) {
  if (!leadId || typeof leadId !== 'string') return '';

  const [rows] = await pool.execute(
    `SELECT u.name AS confirmer_name
     FROM activity_logs a
     INNER JOIN users u ON u.id = a.performed_by
     WHERE a.lead_id = ?
       AND a.type = 'status_change'
       AND (${CALL_STATUS_CONFIRMED_SQL})
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [leadId]
  );

  return String(rows[0]?.confirmer_name ?? '').trim();
}

/** Resolve reference1 from stored fields, optional override, or call-status confirmer log. */
export async function resolveReference1ForLead(pool, leadOrSnapshot, options = {}) {
  const { confirmerNameOverride = '' } = options;
  if (!leadOrSnapshot || typeof leadOrSnapshot !== 'object') return '';

  const dyn = leadOrSnapshot.dynamicFields ?? leadOrSnapshot.dynamic_fields;
  const fromDyn = readReference1FromDynamicFields(dyn);
  if (fromDyn) return fromDyn;

  const fromSnap = String(leadOrSnapshot.reference1 ?? '').trim();
  if (fromSnap) return fromSnap;

  const override = String(confirmerNameOverride ?? '').trim();
  if (override) return override;

  const leadId = String(leadOrSnapshot.id ?? leadOrSnapshot._id ?? '').trim();
  if (leadId && pool) {
    return fetchLastCallStatusConfirmedByUserName(pool, leadId);
  }

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

/** Lead snapshot for joinings — ensures reference1 is set from call-status confirmer when missing. */
export async function buildJoiningLeadDataSnapshot(pool, lead, options = {}) {
  const snapshot = { ...(lead || {}) };
  delete snapshot._id;
  delete snapshot.id;
  delete snapshot.__v;

  const reference1 = await resolveReference1ForLead(pool, snapshot, options);
  if (!reference1) return snapshot;

  return applyReference1ToSnapshot(snapshot, reference1);
}

/**
 * When call_status is marked Confirmed, persist the acting user as reference1 if not already set.
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

  if (readReference1FromDynamicFields(dyn)) return;

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
