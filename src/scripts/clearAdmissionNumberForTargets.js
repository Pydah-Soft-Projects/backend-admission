import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const TARGET_NUMBERS = ['20260003', '20260006', '20260007'];
const TARGET_JOINING_IDS = [
  '56e88e9e-66b2-4438-ab0c-a40ffc98a5df',
  '16e4e45b-1ba9-45af-99af-63381fa21d15',
  '474748d8-70da-46f1-b8ed-c2a74da35c2f',
];

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

    const [leadRowsBefore] = await conn.execute(
      `SELECT id, admission_number, lead_status
       FROM leads
       WHERE admission_number IN (?,?,?)
       ORDER BY admission_number`,
      TARGET_NUMBERS
    );

    const [joiningRowsBefore] = await conn.execute(
      `SELECT id, status, lead_data
       FROM joinings
       WHERE id IN (?,?,?)`,
      TARGET_JOINING_IDS
    );

    const [leadUpdate] = await conn.execute(
      `UPDATE leads
       SET admission_number = NULL, updated_at = NOW()
       WHERE admission_number IN (?,?,?)`,
      TARGET_NUMBERS
    );

    const [joiningUpdate] = await conn.execute(
      `UPDATE joinings
       SET
         lead_data = JSON_SET(
           COALESCE(
             CASE
               WHEN JSON_VALID(lead_data) THEN lead_data
               ELSE JSON_OBJECT()
             END,
             JSON_OBJECT()
           ),
           '$.admissionNumber',
           CAST(NULL AS JSON)
         ),
         updated_at = NOW()
       WHERE id IN (?,?,?)`,
      TARGET_JOINING_IDS
    );

    await conn.commit();

    const [leadRowsAfter] = await conn.execute(
      `SELECT id, admission_number
       FROM leads
       WHERE id IN (${leadRowsBefore.map(() => '?').join(',') || "''"})`,
      leadRowsBefore.map((r) => r.id)
    );

    const [joiningRowsAfter] = await conn.execute(
      `SELECT id, JSON_EXTRACT(lead_data, '$.admissionNumber') AS lead_data_admission_number
       FROM joinings
       WHERE id IN (?,?,?)`,
      TARGET_JOINING_IDS
    );

    console.log(
      JSON.stringify(
        {
          targetNumbers: TARGET_NUMBERS,
          leadRowsMatched: leadRowsBefore.length,
          joiningRowsMatched: joiningRowsBefore.length,
          leadRowsUpdated: Number(leadUpdate.affectedRows || 0),
          joiningRowsUpdated: Number(joiningUpdate.affectedRows || 0),
          leadRowsAfter,
          joiningRowsAfter,
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

