import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
  });

  const targetNumbers = ['20260001', '20260003', '20260006', '20260007'];
  const [availableRows] = await conn.execute(
    'SELECT admission_number FROM admissions WHERE admission_number LIKE ? ORDER BY admission_number',
    ['2026000%']
  );

  const [rows] = await conn.execute(
    `SELECT
      a.admission_number,
      a.id AS admission_id,
      a.joining_id,
      a.lead_id,
      a.student_name AS a_student_name,
      a.student_phone AS a_student_phone,
      a.student_date_of_birth AS a_dob,
      a.father_name AS a_father_name,
      a.father_phone AS a_father_phone,
      a.mother_name AS a_mother_name,
      a.mother_phone AS a_mother_phone,
      a.course AS a_course,
      a.branch AS a_branch,
      a.quota AS a_quota,
      a.address_village_city AS a_village,
      a.address_mandal AS a_mandal,
      a.address_district AS a_district,
      a.address_pin_code AS a_pin,
      l.id AS lead_row_id,
      l.name AS l_name,
      l.phone AS l_phone,
      l.father_name AS l_father_name,
      l.father_phone AS l_father_phone,
      l.mother_name AS l_mother_name,
      l.course_interested AS l_course,
      l.quota AS l_quota,
      l.village AS l_village,
      l.mandal AS l_mandal,
      l.district AS l_district,
      j.id AS joining_row_id,
      j.student_name AS j_student_name,
      j.student_phone AS j_student_phone,
      j.student_date_of_birth AS j_dob,
      j.father_name AS j_father_name,
      j.father_phone AS j_father_phone,
      j.mother_name AS j_mother_name,
      j.mother_phone AS j_mother_phone,
      j.course AS j_course,
      j.branch AS j_branch,
      j.quota AS j_quota,
      j.address_village_city AS j_village,
      j.address_mandal AS j_mandal,
      j.address_district AS j_district,
      j.address_pin_code AS j_pin,
      j.lead_data
    FROM admissions a
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN joinings j ON j.id = a.joining_id
    WHERE a.admission_number IN (?,?,?,?)
    ORDER BY a.admission_number`,
    targetNumbers
  );

  const output = {
    availableAdmissionNumbers: availableRows.map((r) => r.admission_number),
    rows,
  };

  console.log(JSON.stringify(output, null, 2));
  await conn.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
