/**
 * Inspect course/branch columns for an admission number across leads, joinings, admissions.
 * Usage: node src/scripts/inspectAdmissionCourseBranch.js 20260048 [20280047]
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const nums = process.argv.slice(2).filter(Boolean);
if (nums.length === 0) {
  console.error('Usage: node src/scripts/inspectAdmissionCourseBranch.js <admissionNumber> ...');
  process.exit(1);
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

  for (const admissionNumber of nums) {
    console.log('\n==========', admissionNumber, '==========');
    const [adm] = await conn.execute(
      `SELECT id, lead_id, joining_id, admission_number, status,
              course, branch, course_id, branch_id, managed_course_id, managed_branch_id, quota,
              updated_at
       FROM admissions WHERE admission_number = ? LIMIT 5`,
      [admissionNumber]
    );
    console.log('admissions rows:', adm.length);
    for (const row of adm) {
      console.log(JSON.stringify(row, null, 2));
      if (row.joining_id) {
        const [j] = await conn.execute(
          `SELECT id, lead_id, status, course, branch, course_id, branch_id,
                  managed_course_id, managed_branch_id, quota, updated_at
           FROM joinings WHERE id = ? LIMIT 1`,
          [row.joining_id]
        );
        console.log('joining:', j[0] ? JSON.stringify(j[0], null, 2) : 'NOT FOUND');
      }
      if (row.lead_id) {
        const [l] = await conn.execute(
          `SELECT id, enquiry_number, name, course_interested, quota, updated_at
           FROM leads WHERE id = ? LIMIT 1`,
          [row.lead_id]
        );
        console.log('lead:', l[0] ? JSON.stringify(l[0], null, 2) : 'NOT FOUND');
      }
    }
    if (adm.length === 0) {
      const [byLead] = await conn.execute(
        `SELECT a.admission_number FROM admissions a
         INNER JOIN leads l ON l.id = a.lead_id
         WHERE l.name LIKE '%RELANGI SURYA%' LIMIT 10`
      );
      console.log('No admission; similar:', byLead);
    }
  }

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
