/**
 * Delete leads (and dependent rows) by enquiry numbers.
 *
 * Why this script exists:
 * - `leads` has ON DELETE CASCADE dependents (activity_logs, communications, lead_status_logs, etc.)
 * - but `joinings.lead_id` is ON DELETE SET NULL, so joinings won't be removed automatically.
 * - `admissions.joining_id` is ON DELETE RESTRICT, so admissions must be deleted before joinings.
 *
 * Usage (from backend-admission):
 *   node src/scripts/deleteLeadsByEnquiryOnce.js ENQ26840983 ENQ26840963
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

const ENQUIRIES = process.argv
  .slice(2)
  .map((s) => String(s).trim())
  .filter(Boolean);

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function main() {
  if (ENQUIRIES.length === 0) {
    console.error('Usage: node src/scripts/deleteLeadsByEnquiryOnce.js <ENQ...>');
    process.exit(1);
  }

  const pool = getPool();
  const ph = ENQUIRIES.map(() => '?').join(',');

  const [leadRows] = await pool.execute(
    `SELECT id, enquiry_number, name, phone, lead_status
     FROM leads
     WHERE enquiry_number IN (${ph})`,
    ENQUIRIES
  );

  if (!leadRows || leadRows.length === 0) {
    console.log(JSON.stringify({ requested: ENQUIRIES, matchedLeads: [] }, null, 2));
    process.exit(0);
    return;
  }

  const leadIds = leadRows.map((r) => r.id);

  const [joiningRows] = await pool.execute(
    `SELECT id, lead_id, status
     FROM joinings
     WHERE lead_id IN (${leadIds.map(() => '?').join(',')})`,
    leadIds
  );
  const joiningIds = joiningRows.map((r) => r.id);

  // Admissions can link by lead_id OR enquiry_number (lead_id may be NULL after lead deletions).
  const [admissionRows] = await pool.execute(
    `SELECT id, joining_id, lead_id, enquiry_number, admission_number, status
     FROM admissions
     WHERE (lead_id IN (${leadIds.map(() => '?').join(',')}) OR enquiry_number IN (${ph}))`,
    [...leadIds, ...ENQUIRIES]
  );
  const admissionIds = admissionRows.map((r) => r.id);

  console.log(
    JSON.stringify(
      {
        requested: ENQUIRIES,
        matchedLeads: leadRows,
        matchedJoinings: joiningRows,
        matchedAdmissions: admissionRows,
      },
      null,
      2
    )
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Admissions (must be removed before joinings due to ON DELETE RESTRICT on admissions.joining_id)
    if (admissionIds.length > 0) {
      for (const ids of chunk(admissionIds, 500)) {
        const p = ids.map(() => '?').join(',');
        await conn.execute(`DELETE FROM admissions WHERE id IN (${p})`, ids);
      }
    }

    // 2) Joinings + their public edit tokens (tokens route_key can be joining id or lead id)
    const tokenKeys = [...new Set([...joiningIds, ...leadIds])];
    if (tokenKeys.length > 0) {
      for (const keys of chunk(tokenKeys, 500)) {
        const p = keys.map(() => '?').join(',');
        await conn.execute(`DELETE FROM joining_public_edit_tokens WHERE route_key IN (${p})`, keys);
      }
    }

    if (joiningIds.length > 0) {
      for (const ids of chunk(joiningIds, 200)) {
        const p = ids.map(() => '?').join(',');
        await conn.execute(`DELETE FROM joinings WHERE id IN (${p})`, ids);
      }
    }

    // 3) WhatsApp tables are not FK-constrained to leads; remove conversations by lead_id.
    if (leadIds.length > 0) {
      for (const ids of chunk(leadIds, 500)) {
        const p = ids.map(() => '?').join(',');
        await conn.execute(`DELETE FROM whatsapp_conversations WHERE lead_id IN (${p})`, ids);
      }
    }

    // 4) Leads (CASCADE cleans communications/activity_logs/lead_status_logs/sms_bulk_job_items/etc.)
    for (const ids of chunk(leadIds, 200)) {
      const p = ids.map(() => '?').join(',');
      await conn.execute(`DELETE FROM leads WHERE id IN (${p})`, ids);
    }

    await conn.commit();
    console.log(JSON.stringify({ deletedLeadIds: leadIds, deletedJoiningIds: joiningIds, deletedAdmissionIds: admissionIds }, null, 2));
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

