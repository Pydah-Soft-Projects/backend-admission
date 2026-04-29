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
    ssl:
      process.env.DB_SECONDARY_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
  });

  const [columns] = await conn.execute('SHOW COLUMNS FROM students');
  const [allAdmissionNumbers] = await conn.execute(
    'SELECT admission_number FROM students WHERE admission_number LIKE ? ORDER BY admission_number',
    ['202600%']
  );
  const [rows] = await conn.execute(
    'SELECT * FROM students WHERE admission_number IN (?, ?, ?, ?, ?, ?) ORDER BY admission_number',
    ['2026001', '20260001', '2026003', '20260003', '20260006', '20260007']
  );

  console.log(
    JSON.stringify(
      {
        columns: columns.map((c) => ({
          Field: c.Field,
          Type: c.Type,
          Null: c.Null,
          Default: c.Default,
        })),
        available202600: allAdmissionNumbers.map((r) => r.admission_number),
        rows,
      },
      null,
      2
    )
  );

  await conn.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
