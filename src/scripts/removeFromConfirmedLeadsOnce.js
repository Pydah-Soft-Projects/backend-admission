/**
 * Remove leads from Confirmed Leads desk without deleting rows:
 * sets lead_status to match call_status / visit_status when neither channel is Confirmed.
 *
 * Usage:
 *   node src/scripts/removeFromConfirmedLeadsOnce.js --dry-run
 *   node src/scripts/removeFromConfirmedLeadsOnce.js --apply
 */
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';

dotenv.config();

const dryRun = !process.argv.includes('--apply');

const normalize = (v) => String(v ?? '').trim().toLowerCase();

function mapChannelStatusToLeadStatus(status) {
  const s = normalize(status);
  if (!s) return null;
  if (s === 'confirmed') return 'Confirmed';
  if (s === 'visited') return 'Visited';
  if (s === 'interested' || s === 'cet applied' || s === 'cet_applied') return 'Interested';
  if (s === 'not interested') return 'Not Interested';
  if (
    s === 'call back' ||
    s === 'callback' ||
    s === 're-visit' ||
    s === 'revisit' ||
    s === 'scheduled revisit'
  ) {
    return 'Call Back';
  }
  if (s === 'wrong data' || s === 'wrong number' || s === 'invalid number') return 'Wrong Data';
  if (s === 'assigned') return 'Assigned';
  if (s === 'new') return 'New';
  return null;
}

function resolveOffConfirmed(callStatus, visitStatus, joiningStatus) {
  if (String(joiningStatus || '').toLowerCase() === 'approved') {
    return 'Admitted';
  }

  const callConfirmed = normalize(callStatus) === 'confirmed';
  const visitConfirmed = normalize(visitStatus) === 'confirmed';

  // Counsellor call status wins when it is not Confirmed (e.g. Call Back + visit Confirmed).
  if (!callConfirmed) {
    const mappedCall = mapChannelStatusToLeadStatus(callStatus);
    if (mappedCall && mappedCall !== 'Confirmed') return mappedCall;
  }

  if (!callConfirmed && !visitConfirmed) {
    const mappedCall = mapChannelStatusToLeadStatus(callStatus);
    const mappedVisit = mapChannelStatusToLeadStatus(visitStatus);
    return mappedCall || mappedVisit || 'New';
  }

  // Still Confirmed on a channel but should leave joining desk: map to visit/call reality.
  if (callConfirmed || visitConfirmed) {
    const mappedVisit = mapChannelStatusToLeadStatus(visitStatus);
    if (mappedVisit && mappedVisit !== 'Confirmed') return mappedVisit;
    if (!callConfirmed) {
      const mappedCall = mapChannelStatusToLeadStatus(callStatus);
      if (mappedCall && mappedCall !== 'Confirmed') return mappedCall;
    }
    return 'Interested';
  }

  return null;
}

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT l.id, l.enquiry_number, l.name, l.lead_status, l.call_status, l.visit_status,
            (SELECT j.status FROM joinings j WHERE j.lead_id = l.id ORDER BY j.updated_at DESC LIMIT 1) AS joining_status
     FROM leads l
     WHERE l.lead_status = 'Confirmed'
       AND NOT EXISTS (
         SELECT 1 FROM joinings j_stale
         INNER JOIN admissions a_stale ON a_stale.joining_id = j_stale.id
         WHERE j_stale.lead_id = l.id
           AND j_stale.status = 'approved'
           AND TRIM(COALESCE(a_stale.admission_number, '')) <> ''
       )
       AND NOT EXISTS (
         SELECT 1
         FROM leads l_phone_dup
         INNER JOIN joinings j_phone_dup ON j_phone_dup.lead_id = l_phone_dup.id AND j_phone_dup.status = 'approved'
         INNER JOIN admissions a_phone_dup ON a_phone_dup.joining_id = j_phone_dup.id
         WHERE l_phone_dup.id <> l.id
           AND TRIM(COALESCE(l.phone, '')) <> ''
           AND l_phone_dup.phone = l.phone
           AND TRIM(COALESCE(a_phone_dup.admission_number, '')) <> ''
       )`
  );

  const updates = [];
  for (const row of rows) {
    const newStatus = resolveOffConfirmed(row.call_status, row.visit_status, row.joining_status);
    if (newStatus && newStatus !== 'Confirmed') {
      updates.push({ ...row, newStatus });
    }
  }

  console.log(JSON.stringify({ dryRun, toUpdate: updates.length, updates }, null, 2));

  if (dryRun || updates.length === 0) {
    process.exit(0);
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const u of updates) {
      await conn.execute(
        `UPDATE leads SET lead_status = ?, updated_at = NOW() WHERE id = ? AND lead_status = 'Confirmed'`,
        [u.newStatus, u.id]
      );
      await conn.execute(
        `INSERT INTO lead_status_logs (id, lead_id, status, comment, changed_by, changed_at)
         VALUES (?, ?, ?, ?, NULL, NOW())`,
        [
          uuidv4(),
          u.id,
          u.newStatus,
          'Removed from Confirmed Leads desk (was Confirmed; synced to call/visit channel)',
        ]
      );
    }
    await conn.commit();
    console.log(JSON.stringify({ applied: updates.length }, null, 2));
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
