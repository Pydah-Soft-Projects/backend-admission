import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    const targets = ['20260001', '20260003', '20260006', '20260007'];
    const [rows] = await conn.execute(
      `SELECT admission_number, student_photo
       FROM students
       WHERE admission_number IN (?,?,?,?)
       ORDER BY admission_number`,
      targets
    );

    const summary = rows.map((row) => {
      const raw = typeof row.student_photo === 'string' ? row.student_photo : '';
      const trimmed = raw.trim();
      const hasDataUrlPrefix = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(trimmed);
      const looksBase64Only = /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 100;
      return {
        admissionNumber: row.admission_number,
        isNull: row.student_photo == null,
        length: trimmed.length,
        hasDataUrlPrefix,
        looksBase64Only,
        samplePrefix: trimmed.slice(0, 64),
      };
    });

    console.log(JSON.stringify({ summary }, null, 2));
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

