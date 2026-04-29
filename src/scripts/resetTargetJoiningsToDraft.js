import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const TARGET_ADMISSION_NUMBERS = ['20260003', '20260006', '20260007'];

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

    const [rows] = await conn.execute(
      `SELECT id, admission_number, joining_id
       FROM admissions
       WHERE admission_number IN (?,?,?)`,
      TARGET_ADMISSION_NUMBERS
    );

    const joiningIds = rows.map((r) => r.joining_id).filter(Boolean);

    let updatedJoinings = 0;
    for (const joiningId of joiningIds) {
      const [result] = await conn.execute(
        `UPDATE joinings
         SET
           status = 'draft',
           submitted_at = NULL,
           submitted_by = NULL,
           approved_at = NULL,
           approved_by = NULL,
           draft_updated_at = NOW(),
           updated_at = NOW()
         WHERE id = ?`,
        [joiningId]
      );
      updatedJoinings += Number(result.affectedRows || 0);
    }

    await conn.commit();

    const [verification] = await conn.execute(
      `SELECT a.admission_number, j.id AS joining_id, j.status, j.submitted_at, j.approved_at
       FROM admissions a
       LEFT JOIN joinings j ON j.id = a.joining_id
       WHERE a.admission_number IN (?,?,?)
       ORDER BY a.admission_number`,
      TARGET_ADMISSION_NUMBERS
    );

    console.log(
      JSON.stringify(
        {
          targetAdmissionNumbers: TARGET_ADMISSION_NUMBERS,
          matchedAdmissions: rows.length,
          updatedJoinings,
          verification,
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

