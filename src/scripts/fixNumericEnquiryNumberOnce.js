/**
 * Fix a lead whose enquiry_number is a plain numeric application number (e.g. 3879)
 * instead of ENQ{YY}{6-digit}. Preserves the old value in dynamic_fields.applicationNumber.
 *
 * Usage (from backend-admission):
 *   node src/scripts/fixNumericEnquiryNumberOnce.js 3879
 *   node src/scripts/fixNumericEnquiryNumberOnce.js --lead-id 048756e5-7ffd-42b4-b733-75d877a5f6ea
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { generateEnquiryNumber } from '../utils/generateEnquiryNumber.js';

dotenv.config();

function parseArgs(argv) {
  const args = { enquiryNumber: null, leadId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lead-id' && argv[i + 1]) {
      args.leadId = String(argv[++i]).trim();
    } else if (!a.startsWith('-')) {
      args.enquiryNumber = String(a).trim();
    }
  }
  return args;
}

async function main() {
  const { enquiryNumber, leadId } = parseArgs(process.argv);
  if (!enquiryNumber && !leadId) {
    console.error('Usage: node src/scripts/fixNumericEnquiryNumberOnce.js <numeric-enquiry> | --lead-id <uuid>');
    process.exit(1);
  }

  const pool = getPool();
  const [rows] = leadId
    ? await pool.execute(
        `SELECT id, enquiry_number, name, phone, admission_number, hall_ticket_number, dynamic_fields
         FROM leads WHERE id = ? LIMIT 1`,
        [leadId]
      )
    : await pool.execute(
        `SELECT id, enquiry_number, name, phone, admission_number, hall_ticket_number, dynamic_fields
         FROM leads WHERE enquiry_number = ? LIMIT 1`,
        [enquiryNumber]
      );

  if (!rows.length) {
    console.log(JSON.stringify({ error: 'lead_not_found', enquiryNumber, leadId }, null, 2));
    process.exit(1);
  }

  const lead = rows[0];
  const oldEnquiry = String(lead.enquiry_number || '').trim();
  if (!oldEnquiry) {
    console.log(JSON.stringify({ error: 'lead_has_no_enquiry_number', leadId: lead.id }, null, 2));
    process.exit(1);
  }
  if (/^ENQ/i.test(oldEnquiry)) {
    console.log(JSON.stringify({ skipped: true, reason: 'already_enq_format', lead }, null, 2));
    process.exit(0);
  }

  let dynamicFields = {};
  try {
    dynamicFields =
      typeof lead.dynamic_fields === 'string'
        ? JSON.parse(lead.dynamic_fields || '{}')
        : lead.dynamic_fields || {};
  } catch {
    dynamicFields = {};
  }
  if (!dynamicFields || typeof dynamicFields !== 'object' || Array.isArray(dynamicFields)) {
    dynamicFields = {};
  }

  if (!dynamicFields.applicationNumber) {
    dynamicFields.applicationNumber = oldEnquiry;
  }

  const newEnquiryNumber = await generateEnquiryNumber();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE leads
       SET enquiry_number = ?, dynamic_fields = ?, updated_at = NOW()
       WHERE id = ?`,
      [newEnquiryNumber, JSON.stringify(dynamicFields), lead.id]
    );

    await conn.execute(
      `UPDATE admissions
       SET enquiry_number = ?, updated_at = NOW()
       WHERE lead_id = ?`,
      [newEnquiryNumber, lead.id]
    );

    const [joinings] = await conn.execute(
      'SELECT id, lead_data FROM joinings WHERE lead_id = ?',
      [lead.id]
    );
    for (const joining of joinings) {
      let leadData = {};
      try {
        leadData =
          typeof joining.lead_data === 'string'
            ? JSON.parse(joining.lead_data || '{}')
            : joining.lead_data || {};
      } catch {
        leadData = {};
      }
      if (!leadData || typeof leadData !== 'object' || Array.isArray(leadData)) {
        leadData = {};
      }
      leadData.enquiryNumber = newEnquiryNumber;
      if (!leadData.applicationNumber) {
        leadData.applicationNumber = oldEnquiry;
      }
      await conn.execute(
        'UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?',
        [JSON.stringify(leadData), joining.id]
      );
    }

    await conn.commit();

    console.log(
      JSON.stringify(
        {
          leadId: lead.id,
          name: lead.name,
          phone: lead.phone,
          admission_number: lead.admission_number,
          hall_ticket_number: lead.hall_ticket_number,
          before: { enquiry_number: oldEnquiry },
          after: {
            enquiry_number: newEnquiryNumber,
            dynamic_fields_applicationNumber: dynamicFields.applicationNumber,
          },
          joiningsUpdated: joinings.length,
        },
        null,
        2
      )
    );
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
