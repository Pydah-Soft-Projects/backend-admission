/**
 * Swap admission numbers between two students in admissions_db + student_database.
 *
 * Usage:
 *   node src/scripts/swapAdmissionNumbersOnce.js 20260272 20260273
 *   node src/scripts/swapAdmissionNumbersOnce.js 20260272 20260273 --dry-run
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';

dotenv.config();

const DRY = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const A = String(args[0] || '').trim();
const B = String(args[1] || '').trim();
const TEMP = `__SWAP_TEMP_${Date.now()}__`;

function parseJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return {};
  }
}

function patchAdmissionNumberInJson(raw, newNumber) {
  const data = parseJson(raw);
  if ('admissionNumber' in data) data.admissionNumber = newNumber;
  if ('admission_number' in data) data.admission_number = newNumber;
  if (data.leadData && typeof data.leadData === 'object') {
    if ('admissionNumber' in data.leadData) data.leadData.admissionNumber = newNumber;
    if ('admission_number' in data.leadData) data.leadData.admission_number = newNumber;
  }
  return JSON.stringify(data);
}

async function loadPrimaryTargets(pool, numbers) {
  const placeholders = numbers.map(() => '?').join(',');
  const [admissions] = await pool.execute(
    `SELECT id, admission_number, student_name, enquiry_number, lead_id, joining_id, lead_data
     FROM admissions WHERE admission_number IN (${placeholders})`,
    numbers
  );
  const [leads] = await pool.execute(
    `SELECT id, admission_number, name FROM leads WHERE admission_number IN (${placeholders})`,
    numbers
  );
  const [feeRequests] = await pool.execute(
    `SELECT id, admission_number, student_name FROM fee_requests WHERE admission_number IN (${placeholders})`,
    numbers
  );
  return { admissions, leads, feeRequests };
}

async function loadSecondaryTargets(secondary, numbers) {
  const placeholders = numbers.map(() => '?').join(',');
  const [students] = await secondary.execute(
    `SELECT id, admission_number, admission_no, student_name, student_data
     FROM students
     WHERE admission_number IN (${placeholders}) OR admission_no IN (${placeholders})`,
    [...numbers, ...numbers]
  );
  const [credentials] = await secondary.execute(
    `SELECT id, student_id, admission_number, username
     FROM student_credentials WHERE admission_number IN (${placeholders})`,
    numbers
  );
  const [transport] = await secondary.execute(
    `SELECT id, admission_number, student_name FROM transport_requests
     WHERE admission_number IN (${placeholders})`,
    numbers
  );
  return { students, credentials, transport };
}

async function swapPrimaryAdmissionNumber(conn, from, to) {
  const [rows] = await conn.execute(
    'SELECT id, lead_id, joining_id, lead_data FROM admissions WHERE admission_number = ? LIMIT 1',
    [from]
  );
  if (rows.length === 0) return { from, to, skipped: true };

  const row = rows[0];
  await conn.execute(
    'UPDATE admissions SET admission_number = ?, lead_data = ?, updated_at = NOW() WHERE id = ?',
    [to, patchAdmissionNumberInJson(row.lead_data, to), row.id]
  );

  if (row.lead_id) {
    await conn.execute(
      'UPDATE leads SET admission_number = ?, updated_at = NOW() WHERE id = ?',
      [to, row.lead_id]
    );
  }

  if (row.joining_id) {
    const [jRows] = await conn.execute('SELECT lead_data FROM joinings WHERE id = ?', [row.joining_id]);
    if (jRows.length > 0) {
      await conn.execute('UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?', [
        patchAdmissionNumberInJson(jRows[0].lead_data, to),
        row.joining_id,
      ]);
    }
  }

  await conn.execute(
    'UPDATE fee_requests SET admission_number = ?, updated_at = NOW() WHERE admission_number = ?',
    [to, from]
  );

  return { from, to, admissionId: row.id, skipped: false };
}

async function swapSecondaryAdmissionNumber(secondary, from, to) {
  const [rows] = await secondary.execute(
    'SELECT id, student_data FROM students WHERE admission_number = ? OR admission_no = ? LIMIT 1',
    [from, from]
  );
  if (rows.length === 0) return { from, to, skipped: true };

  const row = rows[0];
  await secondary.execute(
    `UPDATE students
     SET admission_number = ?, admission_no = ?, student_data = ?, updated_at = NOW()
     WHERE id = ?`,
    [to, to, patchAdmissionNumberInJson(row.student_data, to), row.id]
  );

  await secondary.execute(
    'UPDATE student_credentials SET admission_number = ?, username = ?, updated_at = NOW() WHERE admission_number = ?',
    [to, to, from]
  );

  await secondary.execute(
    'UPDATE transport_requests SET admission_number = ?, updated_at = NOW() WHERE admission_number = ?',
    [to, from]
  );

  return { from, to, studentId: row.id, skipped: false };
}

async function main() {
  if (!A || !B || A === B) {
    throw new Error('Provide two distinct admission numbers, e.g. node swapAdmissionNumbersOnce.js 20260272 20260273');
  }

  const pool = getPool();
  const secondary = getSecondaryPool();
  const numbers = [A, B];

  const before = {
    primary: await loadPrimaryTargets(pool, numbers),
    secondary: await loadSecondaryTargets(secondary, numbers),
  };

  if (before.primary.admissions.length !== 2) {
    throw new Error(`Expected 2 primary admissions, found ${before.primary.admissions.length}`);
  }
  if (before.secondary.students.length !== 2) {
    throw new Error(`Expected 2 secondary students, found ${before.secondary.students.length}`);
  }

  console.log(
    JSON.stringify(
      {
        dryRun: DRY,
        swap: [A, B],
        temp: TEMP,
        before,
      },
      null,
      2
    )
  );

  if (DRY) {
    process.exit(0);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Three-step swap via temp to satisfy UNIQUE constraints.
    await swapPrimaryAdmissionNumber(conn, A, TEMP);
    await swapPrimaryAdmissionNumber(conn, B, A);
    await swapPrimaryAdmissionNumber(conn, TEMP, B);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await swapSecondaryAdmissionNumber(secondary, A, TEMP);
  await swapSecondaryAdmissionNumber(secondary, B, A);
  await swapSecondaryAdmissionNumber(secondary, TEMP, B);

  const after = {
    primary: await loadPrimaryTargets(pool, numbers),
    secondary: await loadSecondaryTargets(secondary, numbers),
  };

  const primaryOk =
    after.primary.admissions.find((r) => r.admission_number === A)?.student_name ===
      before.primary.admissions.find((r) => r.admission_number === B)?.student_name &&
    after.primary.admissions.find((r) => r.admission_number === B)?.student_name ===
      before.primary.admissions.find((r) => r.admission_number === A)?.student_name;

  const secondaryOk =
    after.secondary.students.find((r) => r.admission_number === A)?.student_name ===
      before.secondary.students.find((r) => r.admission_number === B)?.student_name &&
    after.secondary.students.find((r) => r.admission_number === B)?.student_name ===
      before.secondary.students.find((r) => r.admission_number === A)?.student_name;

  console.log(
    JSON.stringify(
      {
        ok: primaryOk && secondaryOk,
        primaryOk,
        secondaryOk,
        after,
      },
      null,
      2
    )
  );

  if (!primaryOk || !secondaryOk) {
    throw new Error('Swap verification failed — review output above');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
