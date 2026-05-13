import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function main() {
  const s = await mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const [[total]] = await s.execute('SELECT COUNT(*) AS c FROM students');
  let by2026Admission = null;
  try {
    const [[r]] = await s.execute(
      "SELECT COUNT(*) AS c FROM students WHERE admission_number REGEXP '^2026'"
    );
    by2026Admission = Number(r.c);
  } catch {
    by2026Admission = 'query_failed';
  }

  const p = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const [[admTotal]] = await p.execute('SELECT COUNT(*) AS c FROM admissions');
  const [[adm2026]] = await p.execute(
    "SELECT COUNT(*) AS c FROM admissions WHERE created_at >= '2026-01-01'"
  );

  console.log(
    JSON.stringify(
      {
        secondary_students_table_total: Number(total.c),
        secondary_students_admission_number_like_2026xxxx: by2026Admission,
        primary_admissions_total: Number(admTotal.c),
        primary_admissions_created_2026_onwards: Number(adm2026.c),
      },
      null,
      2
    )
  );

  await s.end();
  await p.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
