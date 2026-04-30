/**
 * Re-run secondary DB sync for one admission number (refreshes student_data shape, etc.).
 *
 * Usage:
 *   node src/scripts/resyncSecondaryStudentByAdmissionNumber.js 20260009
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';

dotenv.config();

const admissionNumberArg = process.argv[2] || process.env.ADMISSION_NUMBER;

async function main() {
  const admissionNumber = String(admissionNumberArg || '').trim();
  if (!admissionNumber) {
    console.error('Usage: node src/scripts/resyncSecondaryStudentByAdmissionNumber.js <admission_number>');
    process.exit(1);
  }

  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT * FROM admissions WHERE admission_number = ? LIMIT 1',
    [admissionNumber]
  );
  if (rows.length === 0) {
    console.error(JSON.stringify({ ok: false, error: 'admission_not_found', admissionNumber }));
    process.exit(1);
  }

  const row = rows[0];
  let email = '';
  try {
    const ld =
      typeof row.lead_data === 'string' ? JSON.parse(row.lead_data || '{}') : row.lead_data || {};
    email = String(ld.email || '').trim();
  } catch {
    email = '';
  }

  const formatted = await formatAdmission(row, pool);
  const ok = await syncToSecondaryDatabase(formatted, formatted.admissionNumber, {
    leadId: row.lead_id || undefined,
    joiningId: row.joining_id || undefined,
    email,
  });

  // Peek at secondary row after sync
  const { getPool: getSecondaryPool } = await import('../config-sql/database-secondary.js');
  const secondary = getSecondaryPool();
  const [secRows] = await secondary.execute(
    'SELECT admission_number, student_data, LENGTH(student_data) AS student_data_len, student_address FROM students WHERE admission_number = ? LIMIT 1',
    [admissionNumber]
  );

  let studentDataHasNestedAddress = null;
  if (secRows.length > 0 && secRows[0].student_data) {
    try {
      const parsed =
        typeof secRows[0].student_data === 'string'
          ? JSON.parse(secRows[0].student_data)
          : secRows[0].student_data;
      studentDataHasNestedAddress = Boolean(parsed && typeof parsed === 'object' && 'address' in parsed);
    } catch {
      studentDataHasNestedAddress = 'parse_error';
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: Boolean(ok),
        admissionNumber,
        syncToSecondaryDatabase: ok,
        secondaryRow: secRows[0] || null,
        student_data_still_has_nested_address: studentDataHasNestedAddress,
      },
      null,
      2
    )
  );

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
