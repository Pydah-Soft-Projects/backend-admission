import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const DEFAULT_GENERAL_RESERVATION = 'oc';

async function generateAdmissionNumber(conn) {
  const currentYear = new Date().getFullYear();
  const [sequences] = await conn.execute(
    'SELECT * FROM admission_sequences WHERE year = ?',
    [currentYear]
  );
  let sequenceNumber = 1;
  if (sequences.length > 0) {
    sequenceNumber = Number(sequences[0].last_sequence || 0) + 1;
    await conn.execute(
      'UPDATE admission_sequences SET last_sequence = ?, updated_at = NOW() WHERE year = ?',
      [sequenceNumber, currentYear]
    );
  } else {
    await conn.execute(
      'INSERT INTO admission_sequences (id, year, last_sequence, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [uuidv4(), currentYear, sequenceNumber]
    );
  }
  return `${currentYear}${String(sequenceNumber).padStart(4, '0')}`;
}

async function main() {
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

    const [missing] = await conn.execute(
      `SELECT j.*
       FROM joinings j
       LEFT JOIN admissions a ON a.joining_id = j.id
       WHERE j.status = 'approved'
         AND a.id IS NULL`
    );

    const created = [];
    for (const j of missing) {
      const admissionNumber = await generateAdmissionNumber(conn);
      const admissionId = uuidv4();

      await conn.execute(
        `INSERT INTO admissions (
          id, lead_id, enquiry_number, lead_data, joining_id, admission_number, status,
          course_id, branch_id, course, branch, quota,
          student_name, student_phone, student_gender, student_date_of_birth, student_notes, student_aadhaar_number,
          father_name, father_phone, father_aadhaar_number,
          mother_name, mother_phone, mother_aadhaar_number,
          reservation_general, reservation_other,
          address_door_street, address_landmark, address_village_city, address_mandal, address_district, address_pin_code,
          qualification_ssc, qualification_inter_diploma, qualification_ug, qualification_merit, qualification_mediums, qualification_other_medium_label,
          document_ssc, document_inter, document_ug_pg_cmm, document_transfer_certificate, document_study_certificate,
          document_aadhaar_card, document_photos, document_income_certificate, document_caste_certificate,
          document_cet_rank_card, document_cet_hall_ticket, document_allotment_letter, document_joining_report,
          document_bank_passbook, document_ration_card,
          admission_date, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW())`,
        [
          admissionId,
          j.lead_id || null,
          '', // enquiry_number
          j.lead_data || JSON.stringify({}),
          j.id,
          admissionNumber,
          'active',
          j.course_id || null,
          j.branch_id || null,
          j.course || '',
          j.branch || '',
          j.quota || '',
          j.student_name || '',
          j.student_phone || '',
          j.student_gender || '',
          j.student_date_of_birth || '',
          j.student_notes || '',
          j.student_aadhaar_number || null,
          j.father_name || '',
          j.father_phone || '',
          j.father_aadhaar_number || null,
          j.mother_name || '',
          j.mother_phone || '',
          j.mother_aadhaar_number || null,
          j.reservation_general || DEFAULT_GENERAL_RESERVATION,
          j.reservation_other || JSON.stringify([]),
          j.address_door_street || '',
          j.address_landmark || '',
          j.address_village_city || '',
          j.address_mandal || '',
          j.address_district || '',
          j.address_pin_code || '',
          j.qualification_ssc || 0,
          j.qualification_inter_diploma || 0,
          j.qualification_ug || 0,
          j.qualification_merit != null ? j.qualification_merit : null,
          j.qualification_mediums || JSON.stringify([]),
          j.qualification_other_medium_label || '',
          j.document_ssc || 'pending',
          j.document_inter || 'pending',
          j.document_ug_pg_cmm || 'pending',
          j.document_transfer_certificate || 'pending',
          j.document_study_certificate || 'pending',
          j.document_aadhaar_card || 'pending',
          j.document_photos || 'pending',
          j.document_income_certificate || 'pending',
          j.document_caste_certificate || 'pending',
          j.document_cet_rank_card || 'pending',
          j.document_cet_hall_ticket || 'pending',
          j.document_allotment_letter || 'pending',
          j.document_joining_report || 'pending',
          j.document_bank_passbook || 'pending',
          j.document_ration_card || 'pending',
          j.created_by || null,
          j.updated_by || null,
        ]
      );

      if (j.lead_id) {
        await conn.execute(
          'UPDATE leads SET admission_number = ?, lead_status = ?, updated_at = NOW() WHERE id = ?',
          [admissionNumber, 'Admitted', j.lead_id]
        );
      }

      created.push({ joiningId: j.id, admissionId, admissionNumber });
    }

    await conn.commit();
    console.log(JSON.stringify({ missingApprovedJoinings: missing.length, created }, null, 2));
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

