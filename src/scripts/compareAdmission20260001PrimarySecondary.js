import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function main() {
  const p = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const s = await mysql.createConnection({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const target = '20260001';
  const [primaryExact] = await p.execute(
    'SELECT admission_number, course_id, branch_id, managed_course_id, managed_branch_id, course, branch, status, created_at FROM admissions WHERE admission_number = ?',
    [target]
  );
  const [primaryLike] = await p.execute(
    `SELECT admission_number, course_id, branch_id, managed_course_id, managed_branch_id, course, branch, status
     FROM admissions
     WHERE admission_number LIKE ? OR admission_number = ?
     ORDER BY admission_number`,
    ['202600%', '2026001']
  );

  const [secExact] = await s.execute(
    'SELECT admission_number, course, branch, student_name, stud_type, student_status FROM students WHERE admission_number = ?',
    [target]
  );

  let studentDataKeys = [];
  try {
    const [sd] = await s.execute(
      'SELECT JSON_KEYS(student_data) AS k FROM students WHERE admission_number = ? LIMIT 1',
      [target]
    );
    if (sd[0]?.k) {
      studentDataKeys = typeof sd[0].k === 'string' ? JSON.parse(sd[0].k) : sd[0].k;
    }
  } catch {
    studentDataKeys = ['(could not read JSON_KEYS)'];
  }

  console.log(
    JSON.stringify(
      {
        target_admission_number: target,
        primary_admissions_exact: primaryExact,
        primary_admissions_candidates: primaryLike,
        secondary_students_exact: secExact,
        secondary_student_data_top_level_keys_sample: Array.isArray(studentDataKeys)
          ? studentDataKeys.slice(0, 40)
          : studentDataKeys,
      },
      null,
      2
    )
  );

  await p.end();
  await s.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
