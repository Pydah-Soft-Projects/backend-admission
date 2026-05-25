/**
 * Renumber 20260099 → 20260098 on primary + secondary, then set sequence for next = 99.
 *
 * Usage: node src/scripts/renumber20260099To20260098Once.js
 *        node src/scripts/renumber20260099To20260098Once.js --dry-run
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';
import { syncAdmissionSequenceFromAdmissions } from '../utils/admissionNumber.util.js';

dotenv.config();

const FROM = '20260099';
const TO = '20260098';
const DRY = process.argv.includes('--dry-run');

function parseJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return {};
  }
}

async function main() {
  const pool = getPool();
  const secondary = getSecondaryPool();

  const [primaryFrom] = await pool.execute(
    'SELECT * FROM admissions WHERE admission_number = ? LIMIT 1',
    [FROM]
  );
  if (primaryFrom.length === 0) {
    throw new Error(`Primary admission ${FROM} not found`);
  }

  const admission = primaryFrom[0];
  const leadId = admission.lead_id;
  const joiningId = admission.joining_id;

  const [primaryTo] = await pool.execute(
    'SELECT id, admission_number, student_name FROM admissions WHERE admission_number = ? LIMIT 1',
    [TO]
  );

  const [secFrom] = await secondary.execute(
    'SELECT id, admission_number, student_name FROM students WHERE admission_number = ?',
    [FROM]
  );
  const [secTo] = await secondary.execute(
    'SELECT id, admission_number, student_name FROM students WHERE admission_number = ?',
    [TO]
  );

  const plan = {
    dryRun: DRY,
    from: FROM,
    to: TO,
    primaryAdmission: {
      id: admission.id,
      student_name: admission.student_name,
      enquiry_number: admission.enquiry_number,
    },
    primaryConflict98: primaryTo[0] || null,
    secondaryFrom: secFrom[0] || null,
    secondaryConflict98: secTo[0] || null,
  };

  console.log(JSON.stringify(plan, null, 2));

  if (DRY) {
    process.exit(0);
  }

  if (primaryTo.length > 0) {
    throw new Error(`Cannot renumber: primary already has ${TO}`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      'UPDATE admissions SET admission_number = ?, updated_at = NOW() WHERE id = ?',
      [TO, admission.id]
    );

    if (leadId) {
      await conn.execute(
        'UPDATE leads SET admission_number = ?, updated_at = NOW() WHERE id = ?',
        [TO, leadId]
      );
    }

    if (joiningId) {
      const [jRows] = await conn.execute('SELECT lead_data FROM joinings WHERE id = ?', [joiningId]);
      if (jRows.length > 0) {
        const jd = parseJson(jRows[0].lead_data);
        jd.admissionNumber = TO;
        await conn.execute('UPDATE joinings SET lead_data = ?, updated_at = NOW() WHERE id = ?', [
          JSON.stringify(jd),
          joiningId,
        ]);
      }
    }

    const admLd = parseJson(admission.lead_data);
    admLd.admissionNumber = TO;
    await conn.execute(
      'UPDATE admissions SET lead_data = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(admLd), admission.id]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (secTo.length > 0) {
    console.log(`Removing orphan secondary row ${TO} (id ${secTo[0].id}) before renumber`);
    await secondary.execute('DELETE FROM students WHERE admission_number = ?', [TO]);
  }

  if (secFrom.length > 0) {
    await secondary.execute(
      'UPDATE students SET admission_number = ?, admission_no = ?, updated_at = NOW() WHERE admission_number = ?',
      [TO, TO, FROM]
    );
    const [row] = await secondary.execute(
      'SELECT student_data FROM students WHERE admission_number = ? LIMIT 1',
      [TO]
    );
    if (row.length > 0) {
      const sd = parseJson(row[0].student_data);
      sd.admission_number = TO;
      sd.admissionNumber = TO;
      if (sd.leadData && typeof sd.leadData === 'object') {
        sd.leadData.admissionNumber = TO;
      }
      await secondary.execute(
        'UPDATE students SET student_data = ?, updated_at = NOW() WHERE admission_number = ?',
        [JSON.stringify(sd), TO]
      );
    }
  } else {
    const [rows] = await pool.execute('SELECT * FROM admissions WHERE admission_number = ?', [TO]);
    const formatted = await formatAdmission(rows[0], pool);
    await syncToSecondaryDatabase(formatted, TO, {
      leadId: rows[0].lead_id || undefined,
      joiningId: rows[0].joining_id || undefined,
    });
  }

  await syncAdmissionSequenceFromAdmissions(pool);

  const [verify] = await pool.execute(
    `SELECT admission_number, student_name, enquiry_number FROM admissions
     WHERE admission_number IN (?, ?) ORDER BY admission_number`,
    [FROM, TO]
  );
  const [seq] = await pool.execute(
    'SELECT last_sequence FROM admission_sequences WHERE year = 2026'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        verify,
        sequence: seq[0],
        nextNumberWillBe: '20260099',
      },
      null,
      2
    )
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
