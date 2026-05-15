/**
 * Override admission numbers + lead source on primary CRM and secondary students DB.
 *
 * Spreadsheet columns:
 *   Admission No     → admissionNumber + leads.hall_ticket_number (e.g. 20260001)
 *   Application No   → optional reference only (not written to hall_ticket_number)
 *   Quota            → source + quota + secondary stud_type (e.g. Management)
 *
 * Data lives in src/data/studentAdmissionOverrides.js (update when you share photo rows).
 *
 * Usage (from backend-admission):
 *   npm run sync:admission-source-map:dry
 *   npm run sync:admission-source-map:apply
 */
import dotenv from 'dotenv';
import { ADMISSIONS_MASTER_LIST_2026 } from '../data/admissionsMasterList2026.js';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';

dotenv.config();

const normalizePhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
};

const normalizeName = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

const normalizeStudTypeFromSource = (sourceValue) => {
  const s = String(sourceValue ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('manag') || s === 'mang') return 'MANG';
  if (s.includes('conven') || s.includes('conv') || s === 'conv') return 'CONV';
  if (s.includes('spot')) return 'SPOT';
  return null;
};

const mapSourceToLeadQuota = (sourceValue) => {
  const raw = String(sourceValue ?? '').trim();
  if (!raw) return null;
  const stud = normalizeStudTypeFromSource(raw);
  if (stud === 'MANG') return 'Management';
  if (stud === 'CONV') return 'Convenor';
  if (stud === 'SPOT') return 'Spot';
  return raw;
};

const mapSourceToLeadSource = (sourceValue) => String(sourceValue ?? '').trim() || null;

/** Normalize override entry from data file. */
function normalizeEntry(raw) {
  return {
    studentName: String(raw.studentName ?? raw.student_name ?? '').trim(),
    phone: normalizePhone(raw.phone ?? raw.mobile),
    enquiryNumber: String(raw.enquiryNumber ?? raw.enquiry_number ?? '').trim(),
    currentCrmAdmission: String(
      raw.currentCrmAdmission ?? raw.current_crm_admission ?? raw.crm_admission ?? ''
    ).trim(),
    admissionNumber: String(
      raw.admissionNumber ?? raw.admission_number ?? raw.legacy_admission_number ?? ''
    ).trim(),
    applicationNumber: String(
      raw.applicationNumber ?? raw.application_number ?? raw.application_no ?? ''
    ).trim(),
    source: String(raw.source ?? raw.lead_source ?? raw.quota ?? '').trim(),
    status: String(raw.status ?? '').trim(),
  };
}

const mapAdmissionStatus = (sheetStatus) => {
  const s = String(sheetStatus ?? '').trim().toLowerCase();
  if (s.includes('cancel')) return 'Admission Cancelled';
  return 'active';
};

function parseArgs(argv) {
  const args = { dryRun: true, force: false, verbose: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
  }
  return args;
}

function pickBestLeadCandidate(candidates, entry) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];

  const targetName = normalizeName(entry.studentName);
  const nameMatches = targetName
    ? candidates.filter((c) => normalizeName(c.name) === targetName)
    : [];
  const pool = nameMatches.length ? nameMatches : candidates;

  const crm = String(entry.currentCrmAdmission || '').trim();
  const targetAdm = String(entry.admissionNumber || '').trim();
  if (crm) {
    const byCrm = pool.filter((c) => String(c.admission_number || '').trim() === crm);
    if (byCrm.length === 1) return byCrm[0];
  }
  if (targetAdm) {
    const byTarget = pool.filter((c) => String(c.admission_number || '').trim() === targetAdm);
    if (byTarget.length === 1) return byTarget[0];
  }

  const admitted = pool.filter((c) => String(c.lead_status || '').toLowerCase() === 'admitted');
  const withAdmission = pool.filter((c) => String(c.admission_number || '').trim());
  if (admitted.length === 1) return admitted[0];
  if (withAdmission.length === 1) return withAdmission[0];
  if (pool.length === 1) return pool[0];
  return null;
}

async function findLead(pool, entry) {
  const crm = String(entry.currentCrmAdmission || '').trim();
  const enquiry = String(entry.enquiryNumber || '').trim();
  const phone = normalizePhone(entry.phone);
  const targetAdm = String(entry.admissionNumber || '').trim();
  const appNo = String(entry.applicationNumber || '').trim();
  const targetName = normalizeName(entry.studentName);

  if (targetAdm && phone && targetName) {
    const [byAdmIdentity] = await pool.execute(
      `SELECT l.id, l.enquiry_number, l.name, l.phone, l.source, l.quota, l.admission_number, l.lead_status
       FROM admissions a
       INNER JOIN leads l ON l.id = a.lead_id
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(a.student_phone, ''), '[^0-9]', ''), 10) = ?
         AND UPPER(TRIM(a.student_name)) = ?
         AND a.admission_number = ?
       LIMIT 2`,
      [phone, targetName, targetAdm]
    );
    if (byAdmIdentity.length === 1) {
      return { lead: byAdmIdentity[0], matchedBy: 'admission_phone_name' };
    }
  }

  if (targetAdm) {
    const [byTargetLead] = await pool.execute(
      `SELECT id, enquiry_number, name, phone, source, quota, admission_number, lead_status
       FROM leads WHERE admission_number = ? LIMIT 5`,
      [targetAdm]
    );
    const picked = pickBestLeadCandidate(byTargetLead, entry);
    if (picked) return { lead: picked, matchedBy: 'target_admission_on_lead' };
  }

  if (appNo) {
    const [byMisplacedApp] = await pool.execute(
      `SELECT id, enquiry_number, name, phone, source, quota, admission_number, lead_status
       FROM leads WHERE admission_number = ? OR hall_ticket_number = ? LIMIT 10`,
      [appNo, appNo]
    );
    const picked = pickBestLeadCandidate(byMisplacedApp, entry);
    if (picked) return { lead: picked, matchedBy: 'application_no_misplaced_as_admission' };

    const [byMisplacedAdm] = await pool.execute(
      `SELECT l.id, l.enquiry_number, l.name, l.phone, l.source, l.quota, l.admission_number, l.lead_status
       FROM admissions a
       INNER JOIN leads l ON l.id = a.lead_id
       WHERE a.admission_number = ?
       LIMIT 10`,
      [appNo]
    );
    const pickedAdm = pickBestLeadCandidate(byMisplacedAdm, entry);
    if (pickedAdm) return { lead: pickedAdm, matchedBy: 'application_no_on_admission_row' };
  }

  if (crm) {
    const [byLeadAdm] = await pool.execute(
      `SELECT id, enquiry_number, name, phone, source, quota, admission_number, lead_status
       FROM leads WHERE admission_number = ? LIMIT 5`,
      [crm]
    );
    const picked = pickBestLeadCandidate(byLeadAdm, entry);
    if (picked) return { lead: picked, matchedBy: 'current_crm_admission_on_lead' };

    const [byAdmRow] = await pool.execute(
      `SELECT l.id, l.enquiry_number, l.name, l.phone, l.source, l.quota, l.admission_number, l.lead_status
       FROM admissions a
       INNER JOIN leads l ON l.id = a.lead_id
       WHERE a.admission_number = ?
       LIMIT 5`,
      [crm]
    );
    const pickedAdm = pickBestLeadCandidate(byAdmRow, entry);
    if (pickedAdm) return { lead: pickedAdm, matchedBy: 'current_crm_admission_on_admission' };
  }

  if (enquiry) {
    const [byEnquiry] = await pool.execute(
      `SELECT id, enquiry_number, name, phone, source, quota, admission_number, lead_status
       FROM leads WHERE enquiry_number = ? LIMIT 5`,
      [enquiry]
    );
    const picked = pickBestLeadCandidate(byEnquiry, entry);
    if (picked) return { lead: picked, matchedBy: 'enquiry_number' };
    if (byEnquiry.length > 1) return { error: 'ambiguous_enquiry', leads: byEnquiry };
  }

  if (phone) {
    const [byPhone] = await pool.execute(
      `SELECT id, enquiry_number, name, phone, source, quota, admission_number, lead_status
       FROM leads
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 10) = ?
       ORDER BY updated_at DESC
       LIMIT 10`,
      [phone]
    );
    const picked = pickBestLeadCandidate(byPhone, entry);
    if (picked) return { lead: picked, matchedBy: 'phone' };
    if (byPhone.length > 1) return { error: 'ambiguous_phone', leads: byPhone };
  }

  return { error: 'lead_not_found' };
}

async function loadPrimaryContext(pool, leadId) {
  const [admissions] = await pool.execute(
    `SELECT id, admission_number, quota, status, lead_id, joining_id
     FROM admissions WHERE lead_id = ? ORDER BY created_at DESC`,
    [leadId]
  );
  const [joinings] = await pool.execute(
    `SELECT id, status, quota, lead_data FROM joinings WHERE lead_id = ? ORDER BY updated_at DESC`,
    [leadId]
  );
  return { admissions, joinings };
}

async function admissionNumberTaken(pool, admissionNumber, excludeLeadId) {
  const [leads] = await pool.execute(
    `SELECT id, name, admission_number FROM leads
     WHERE admission_number = ? AND id <> ? LIMIT 1`,
    [admissionNumber, excludeLeadId]
  );
  if (leads.length) return { table: 'leads', row: leads[0] };
  const [adm] = await pool.execute(
    `SELECT id, lead_id, admission_number, student_name FROM admissions
     WHERE admission_number = ? AND (lead_id IS NULL OR lead_id <> ?) LIMIT 1`,
    [admissionNumber, excludeLeadId]
  );
  if (adm.length) return { table: 'admissions', row: adm[0] };
  return null;
}

async function loadSecondaryStudent(
  secondaryPool,
  { admissionNumber, applicationNumber, phone, studentName, currentCrmAdmission }
) {
  const tryAdmission = async (num) => {
    if (!num) return null;
    const [rows] = await secondaryPool.execute(
      `SELECT id, admission_number, student_name, student_mobile, stud_type, course, branch
       FROM students WHERE admission_number = ? OR admission_no = ? LIMIT 3`,
      [num, num]
    );
    if (rows.length === 0) return null;
    if (rows.length > 1) return { ambiguous: true, rows };
    return rows[0];
  };

  let row =
    (await tryAdmission(admissionNumber)) ||
    (await tryAdmission(currentCrmAdmission)) ||
    (await tryAdmission(applicationNumber)) ||
    null;

  if (!row && phone) {
    const [byPhone] = await secondaryPool.execute(
      `SELECT id, admission_number, student_name, student_mobile, stud_type, course, branch
       FROM students
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(student_mobile, ''), '[^0-9]', ''), 10) = ?
       ORDER BY updated_at DESC
       LIMIT 10`,
      [phone]
    );
    const targetName = normalizeName(studentName);
    const filtered = targetName
      ? byPhone.filter((s) => normalizeName(s.student_name) === targetName)
      : byPhone;
    const poolRows = filtered.length ? filtered : byPhone;
    if (poolRows.length === 1) row = poolRows[0];
    else if (poolRows.length > 1) row = { ambiguous: true, rows: poolRows };
  }

  return row;
}

async function secondaryAdmissionTaken(secondaryPool, admissionNumber, excludeStudentId) {
  const [rows] = await secondaryPool.execute(
    `SELECT id, admission_number, student_name FROM students
     WHERE (admission_number = ? OR admission_no = ?) AND id <> ? LIMIT 1`,
    [admissionNumber, admissionNumber, excludeStudentId]
  );
  return rows[0] || null;
}

function buildOverridePlan(entry, lead, primaryCtx, secondaryRow) {
  const targetAdmission = entry.admissionNumber;
  const targetSource = mapSourceToLeadSource(entry.source);
  const targetQuota = mapSourceToLeadQuota(entry.source);
  const targetStudType = normalizeStudTypeFromSource(entry.source);

  const currentAdmission =
    String(lead.admission_number || '').trim() ||
    String(primaryCtx.admissions[0]?.admission_number || '').trim() ||
    '';

  return {
    override: true,
    targetAdmission,
    targetSource,
    targetQuota,
    targetStudType,
    before: {
      lead: {
        admission_number: lead.admission_number,
        source: lead.source,
        quota: lead.quota,
      },
      admissions: primaryCtx.admissions.map((a) => ({
        id: a.id,
        admission_number: a.admission_number,
        quota: a.quota,
      })),
      joinings: primaryCtx.joinings.map((j) => ({ id: j.id, quota: j.quota })),
      secondary: secondaryRow && !secondaryRow.ambiguous
        ? {
            id: secondaryRow.id,
            admission_number: secondaryRow.admission_number,
            stud_type: secondaryRow.stud_type,
          }
        : secondaryRow?.ambiguous
          ? { ambiguous: true }
          : null,
    },
    after: {
      lead: {
        admission_number: targetAdmission || currentAdmission,
        source: targetSource ?? lead.source,
        quota: targetQuota ?? lead.quota,
      },
      admission_number: targetAdmission,
      source: targetSource,
      quota: targetQuota,
      stud_type: targetStudType,
    },
  };
}

/** Force-set primary CRM fields (complete override). */
async function applyPrimaryOverride(conn, lead, entry, primaryCtx) {
  const targetAdmission = String(entry.admissionNumber || '').trim();
  const targetSource = mapSourceToLeadSource(entry.source);
  const targetQuota = mapSourceToLeadQuota(entry.source);
  const targetStatus = entry.status ? mapAdmissionStatus(entry.status) : null;

  if (!targetAdmission && !targetSource && !targetQuota && !targetStatus) {
    throw new Error('Nothing to override — set admissionNumber and/or source');
  }

  const leadSets = ['updated_at = NOW()'];
  const leadParams = [];
  if (targetAdmission) {
    leadSets.unshift('hall_ticket_number = ?', 'admission_number = ?');
    leadParams.unshift(targetAdmission, targetAdmission);
  }
  if (targetSource) {
    leadSets.unshift('source = ?');
    leadParams.unshift(targetSource);
  }
  if (targetQuota) {
    leadSets.unshift('quota = ?');
    leadParams.unshift(targetQuota);
  }
  await conn.execute(`UPDATE leads SET ${leadSets.join(', ')} WHERE id = ?`, [...leadParams, lead.id]);

  for (const adm of primaryCtx.admissions) {
    const admSets = ['updated_at = NOW()'];
    const admParams = [];
    if (targetAdmission) {
      admSets.unshift('admission_number = ?');
      admParams.unshift(targetAdmission);
    }
    if (targetQuota) {
      admSets.unshift('quota = ?');
      admParams.unshift(targetQuota);
    }
    if (targetStatus) {
      admSets.unshift('status = ?');
      admParams.unshift(targetStatus);
    }
    if (targetAdmission || targetQuota || targetStatus) {
      await conn.execute(`UPDATE admissions SET ${admSets.join(', ')} WHERE id = ?`, [
        ...admParams,
        adm.id,
      ]);
    }
  }

  for (const joining of primaryCtx.joinings) {
    if (targetQuota) {
      await conn.execute('UPDATE joinings SET quota = ?, updated_at = NOW() WHERE id = ?', [
        targetQuota,
        joining.id,
      ]);
    }

    const patches = [];
    if (targetAdmission) {
      patches.push(['$.admissionNumber', targetAdmission]);
      patches.push(['$.hallTicketNumber', targetAdmission]);
    }
    if (targetSource) patches.push(['$.source', targetSource]);
    if (targetQuota) patches.push(['$.quota', targetQuota]);

    if (patches.length) {
      let expr = `COALESCE(
        CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END,
        JSON_OBJECT()
      )`;
      const params = [];
      for (const [pathKey, val] of patches) {
        expr = `JSON_SET(${expr}, ?, ?)`;
        params.push(pathKey, val);
      }
      await conn.execute(
        `UPDATE joinings SET lead_data = ${expr}, updated_at = NOW() WHERE id = ?`,
        [...params, joining.id]
      );
    }
  }
}

/** Force-set secondary student row (complete override of admission # + stud_type). */
async function applySecondaryOverride(secondaryPool, secondaryRow, entry) {
  const targetAdmission = String(entry.admissionNumber || '').trim();
  const targetStudType = normalizeStudTypeFromSource(entry.source);
  const targetQuota = mapSourceToLeadQuota(entry.source);
  const targetSource = mapSourceToLeadSource(entry.source);

  const sets = ['updated_at = NOW()'];
  const params = [];

  if (targetAdmission) {
    sets.unshift('admission_no = ?', 'admission_number = ?');
    params.unshift(targetAdmission, targetAdmission);
  }
  if (targetStudType) {
    sets.unshift('stud_type = ?');
    params.unshift(targetStudType);
  }

  await secondaryPool.execute(`UPDATE students SET ${sets.join(', ')} WHERE id = ?`, [
    ...params,
    secondaryRow.id,
  ]);

  const [sdRows] = await secondaryPool.execute(
    'SELECT student_data FROM students WHERE id = ? LIMIT 1',
    [secondaryRow.id]
  );
  let payload = {};
  try {
    if (sdRows[0]?.student_data) {
      payload =
        typeof sdRows[0].student_data === 'string'
          ? JSON.parse(sdRows[0].student_data)
          : sdRows[0].student_data || {};
    }
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== 'object') payload = {};

  if (targetAdmission) {
    payload.admission_number = targetAdmission;
    payload.hall_ticket_number = targetAdmission;
  }
  if (targetSource) payload.source = targetSource;
  if (targetQuota) {
    payload.quota = targetQuota;
    if (!payload.courseInfo || typeof payload.courseInfo !== 'object') payload.courseInfo = {};
    payload.courseInfo.quota = targetQuota;
  }
  if (targetStudType) payload.stud_type = targetStudType;

  await secondaryPool.execute(
    'UPDATE students SET student_data = ?, updated_at = NOW() WHERE id = ?',
    [JSON.stringify(payload), secondaryRow.id]
  );

  return { updated: true, studentId: secondaryRow.id };
}

async function resyncSecondaryFromPrimary(pool, admissionNumber) {
  const [rows] = await pool.execute('SELECT * FROM admissions WHERE admission_number = ? LIMIT 1', [
    admissionNumber,
  ]);
  if (!rows.length) return { ok: false, reason: 'admission_not_found' };
  const row = rows[0];
  let email = '';
  try {
    const ld =
      typeof row.lead_data === 'string' ? JSON.parse(row.lead_data || '{}') : row.lead_data || {};
    email = String(ld.email || '').trim();
  } catch {
    email = '';
  }
  const formatted = await formatAdmission(row, pool);
  const ok = await syncToSecondaryDatabase(formatted, formatted.admissionNumber, {
    leadId: row.lead_id || undefined,
    joiningId: row.joining_id || undefined,
    email,
  });
  return { ok: Boolean(ok) };
}

async function processEntry(pool, secondaryPool, rawEntry, options) {
  const entry = normalizeEntry(rawEntry);
  const result = {
    input: entry,
    ok: false,
    matchedBy: null,
    leadId: null,
    dryRun: options.dryRun,
    plan: null,
    applied: null,
    error: null,
  };

  if (!entry.admissionNumber && !entry.source) {
    result.error = 'missing_override_values';
    return result;
  }
  if (!entry.phone && !entry.enquiryNumber && !entry.currentCrmAdmission && !entry.applicationNumber) {
    result.error = 'missing_match_key';
    return result;
  }
  if (!entry.studentName && !entry.phone) {
    result.error = 'missing_student_identity';
    return result;
  }

  const leadLookup = await findLead(pool, entry);
  if (leadLookup.error) {
    result.error = leadLookup.error;
    if (leadLookup.leads) result.candidates = leadLookup.leads;
    return result;
  }

  const { lead, matchedBy } = leadLookup;
  result.matchedBy = matchedBy;
  result.leadId = lead.id;

  const primaryCtx = await loadPrimaryContext(pool, lead.id);
  const secondaryRow = await loadSecondaryStudent(secondaryPool, entry);

  let secondaryConflict = null;
  if (entry.admissionNumber) {
    const takenPrimary = await admissionNumberTaken(pool, entry.admissionNumber, lead.id);
    if (takenPrimary && !options.force) {
      result.error = 'primary_admission_number_taken';
      result.conflict = takenPrimary;
      return result;
    }

    if (secondaryRow && !secondaryRow.ambiguous) {
      const takenSecondary = await secondaryAdmissionTaken(
        secondaryPool,
        entry.admissionNumber,
        secondaryRow.id
      );
      if (takenSecondary && !options.force) {
        secondaryConflict = {
          code: 'secondary_admission_number_taken',
          row: takenSecondary,
        };
      }
    }
  }

  result.plan = buildOverridePlan(entry, lead, primaryCtx, secondaryRow);
  if (secondaryConflict) result.secondaryConflict = secondaryConflict;

  if (options.dryRun) {
    result.ok = true;
    result.wouldApply = true;
    if (secondaryConflict) result.secondaryBlocked = true;
    return result;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await applyPrimaryOverride(conn, lead, entry, primaryCtx);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    result.error = 'primary_update_failed';
    result.detail = e.message;
    conn.release();
    return result;
  }
  conn.release();

  let secondaryResult = { skipped: 'not_found' };
  if (secondaryConflict) {
    secondaryResult = { skipped: 'blocked_conflict', conflict: secondaryConflict.row };
  } else if (secondaryRow && !secondaryRow.ambiguous) {
    try {
      secondaryResult = await applySecondaryOverride(secondaryPool, secondaryRow, entry);
    } catch (e) {
      result.ok = true;
      result.partial = true;
      result.applied = { primary: true, secondary: { error: e.message } };
      result.warning = 'secondary_update_failed';
      return result;
    }
  } else if (secondaryRow?.ambiguous) {
    secondaryResult = { skipped: 'ambiguous_secondary' };
  }

  let resync = { ok: false, reason: 'skipped' };
  if (entry.admissionNumber && !secondaryConflict) {
    resync = await resyncSecondaryFromPrimary(pool, entry.admissionNumber);
  }

  result.ok = true;
  result.partial = Boolean(secondaryConflict);
  result.applied = { primary: true, secondary: secondaryResult, resync };
  if (secondaryConflict) result.warning = secondaryConflict.code;
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = ADMISSIONS_MASTER_LIST_2026.map(normalizeEntry).filter(
    (r) => r.admissionNumber || r.source
  );

  if (rows.length === 0) {
    console.error('No rows in src/data/admissionsMasterList2026.js');
    process.exit(1);
  }

  const pool = getPool();
  const secondaryPool = getSecondaryPool();

  const summary = {
    mode: args.dryRun ? 'dry-run' : 'apply',
    force: args.force,
    totalRows: rows.length,
    wouldApply: 0,
    applied: 0,
    errors: 0,
    results: [],
  };

  for (const row of rows) {
    const result = await processEntry(pool, secondaryPool, row, {
      dryRun: args.dryRun,
      force: args.force,
    });
    summary.results.push(result);
    if (result.error) summary.errors += 1;
    else if (result.wouldApply) summary.wouldApply += 1;
    else if (result.applied) summary.applied += 1;
  }

  console.log(
    JSON.stringify(
      {
        mode: summary.mode,
        totalRows: summary.totalRows,
        wouldApply: summary.wouldApply,
        applied: summary.applied,
        errors: summary.errors,
      },
      null,
      2
    )
  );

  if (args.verbose) {
    console.log(JSON.stringify({ results: summary.results }, null, 2));
  }

  const partial = summary.results.filter((r) => r.partial).length;
  if (partial) {
    console.error(
      `\n${partial} row(s) updated PRIMARY only — secondary blocked (another student already has that admission number). Add/fix that conflicting student in studentAdmissionOverrides.js too.`
    );
  }
  if (summary.errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
