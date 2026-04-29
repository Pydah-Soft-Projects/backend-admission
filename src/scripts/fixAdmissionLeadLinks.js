import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const TARGET_NUMBERS = ['20260001', '20260003', '20260006', '20260007'];

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    await conn.beginTransaction();

    const [admissions] = await conn.execute(
      `SELECT
        a.id, a.admission_number, a.joining_id, a.lead_id, a.lead_data,
        a.student_name, a.student_phone, a.father_name, a.father_phone, a.mother_name,
        a.course, a.quota, a.address_village_city, a.address_district, a.address_mandal
      FROM admissions a
      WHERE a.admission_number IN (?,?,?,?)
      ORDER BY a.admission_number`,
      TARGET_NUMBERS
    );

    const found = new Set(admissions.map((a) => a.admission_number));
    const missingAdmissions = TARGET_NUMBERS.filter((num) => !found.has(num));

    const actions = [];

    for (const admission of admissions) {
      if (admission.lead_id) {
        actions.push({
          admissionNumber: admission.admission_number,
          action: 'already-linked',
          leadId: admission.lead_id,
        });
        continue;
      }

      const leadData =
        typeof admission.lead_data === 'string'
          ? JSON.parse(admission.lead_data || '{}')
          : admission.lead_data || {};

      const [existingByAdmission] = await conn.execute(
        'SELECT id FROM leads WHERE admission_number = ? LIMIT 1',
        [admission.admission_number]
      );

      if (existingByAdmission.length > 0) {
        const leadId = existingByAdmission[0].id;
        await conn.execute('UPDATE admissions SET lead_id = ?, updated_at = NOW() WHERE id = ?', [
          leadId,
          admission.id,
        ]);
        await conn.execute('UPDATE joinings SET lead_id = ?, updated_at = NOW() WHERE id = ?', [
          leadId,
          admission.joining_id,
        ]);
        actions.push({
          admissionNumber: admission.admission_number,
          action: 'linked-existing-lead-by-admission',
          leadId,
        });
        continue;
      }

      let enquiryNumber = '';
      if (leadData?.enquiryNumber && String(leadData.enquiryNumber).trim()) {
        const candidate = String(leadData.enquiryNumber).trim();
        const [enqConflict] = await conn.execute(
          'SELECT id FROM leads WHERE enquiry_number = ? LIMIT 1',
          [candidate]
        );
        if (enqConflict.length === 0) {
          enquiryNumber = candidate;
        }
      }

      const newLeadId = uuidv4();
      await conn.execute(
        `INSERT INTO leads (
          id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
          village, district, mandal, state, gender, quota, course_interested, dynamic_fields,
          lead_status, admission_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          newLeadId,
          enquiryNumber || null,
          admission.student_name || leadData?.name || 'Unknown Student',
          admission.student_phone || leadData?.phone || '0000000000',
          leadData?.email || null,
          admission.father_name || leadData?.fatherName || 'Not Provided',
          admission.mother_name || leadData?.motherName || '',
          admission.father_phone || leadData?.fatherPhone || admission.student_phone || '0000000000',
          admission.address_village_city || leadData?.village || 'Not Provided',
          admission.address_district || leadData?.district || 'Not Provided',
          admission.address_mandal || leadData?.mandal || 'Not Provided',
          leadData?.state || '',
          leadData?.gender || 'Not Specified',
          admission.quota || leadData?.quota || 'Not Applicable',
          admission.course || leadData?.courseInterested || '',
          JSON.stringify(leadData?.dynamicFields && typeof leadData.dynamicFields === 'object' ? leadData.dynamicFields : {}),
          'Admitted',
          admission.admission_number,
        ]
      );

      await conn.execute('UPDATE admissions SET lead_id = ?, updated_at = NOW() WHERE id = ?', [
        newLeadId,
        admission.id,
      ]);
      await conn.execute('UPDATE joinings SET lead_id = ?, updated_at = NOW() WHERE id = ?', [
        newLeadId,
        admission.joining_id,
      ]);

      actions.push({
        admissionNumber: admission.admission_number,
        action: 'created-and-linked-new-lead',
        leadId: newLeadId,
      });
    }

    await conn.commit();
    console.log(
      JSON.stringify(
        {
          targetNumbers: TARGET_NUMBERS,
          missingAdmissions,
          actions,
        },
        null,
        2
      )
    );
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
