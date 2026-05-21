/**
 * Read-only lookup for enquiry number(s). Does not delete.
 * Usage: node src/scripts/lookupEnquiryOnce.js ENQ26990000
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

const ENQUIRIES = process.argv.slice(2).map((s) => String(s).trim()).filter(Boolean);

async function main() {
  if (ENQUIRIES.length === 0) {
    console.error('Usage: node src/scripts/lookupEnquiryOnce.js <ENQ...>');
    process.exit(1);
  }

  const pool = getPool();
  const ph = ENQUIRIES.map(() => '?').join(',');

  const [leadRows] = await pool.execute(
    `SELECT id, enquiry_number, name, phone, lead_status, source, created_at
     FROM leads WHERE enquiry_number IN (${ph})`,
    ENQUIRIES
  );

  const leadIds = leadRows.map((r) => r.id);

  let joiningRows = [];
  let admissionRows = [];
  let tokenRows = [];
  let waRows = [];

  if (leadIds.length > 0) {
    const jph = leadIds.map(() => '?').join(',');
    const [j] = await pool.execute(
      `SELECT id, lead_id, status, created_at FROM joinings WHERE lead_id IN (${jph})`,
      leadIds
    );
    joiningRows = j;

    const [a] = await pool.execute(
      `SELECT id, joining_id, lead_id, enquiry_number, admission_number, status
       FROM admissions WHERE lead_id IN (${jph}) OR enquiry_number IN (${ph})`,
      [...leadIds, ...ENQUIRIES]
    );
    admissionRows = a;

    const joiningIds = joiningRows.map((r) => r.id);
    const tokenKeys = [...new Set([...joiningIds, ...leadIds])];
    if (tokenKeys.length > 0) {
      const tph = tokenKeys.map(() => '?').join(',');
      const [t] = await pool.execute(
        `SELECT id, route_key FROM joining_public_edit_tokens WHERE route_key IN (${tph})`,
        tokenKeys
      );
      tokenRows = t;
    }

    const [w] = await pool.execute(
      `SELECT id, lead_id FROM whatsapp_conversations WHERE lead_id IN (${jph})`,
      leadIds
    );
    waRows = w;
  } else {
    const [a] = await pool.execute(
      `SELECT id, joining_id, lead_id, enquiry_number, admission_number, status
       FROM admissions WHERE enquiry_number IN (${ph})`,
      ENQUIRIES
    );
    admissionRows = a;
  }

  const [orphanJoinings] = await pool.execute(
    `SELECT j.id, j.lead_id, j.status, JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.enquiryNumber')) AS lead_data_enquiry
     FROM joinings j
     WHERE JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.enquiryNumber')) IN (${ph})`,
    ENQUIRIES
  );

  const prefix = ENQUIRIES[0]?.slice(0, 5) || 'ENQ26';
  const [maxEnq] = await pool.execute(
    `SELECT enquiry_number FROM leads WHERE enquiry_number LIKE ? ORDER BY enquiry_number DESC LIMIT 3`,
    [`${prefix}%`]
  );

  console.log(
    JSON.stringify(
      {
        requested: ENQUIRIES,
        matchedLeads: leadRows,
        matchedJoinings: joiningRows,
        matchedAdmissions: admissionRows,
        matchedTokens: tokenRows,
        matchedWhatsapp: waRows,
        joiningsWithEnquiryInLeadData: orphanJoinings,
        recentEnquiryNumbersForPrefix: maxEnq,
      },
      null,
      2
    )
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
