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

    const [before] = await conn.execute(
      `SELECT id, admission_number, joining_id, lead_id
       FROM admissions
       WHERE admission_number IN (?,?,?)
       ORDER BY admission_number`,
      TARGET_ADMISSION_NUMBERS
    );

    const [deleted] = await conn.execute(
      `DELETE FROM admissions
       WHERE admission_number IN (?,?,?)`,
      TARGET_ADMISSION_NUMBERS
    );

    await conn.commit();

    const [after] = await conn.execute(
      `SELECT id, admission_number
       FROM admissions
       WHERE admission_number IN (?,?,?)`,
      TARGET_ADMISSION_NUMBERS
    );

    console.log(
      JSON.stringify(
        {
          targetAdmissionNumbers: TARGET_ADMISSION_NUMBERS,
          matchedBeforeDelete: before.length,
          deletedRows: Number(deleted.affectedRows || 0),
          remainingAfterDelete: after.length,
          deletedAdmissions: before,
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

