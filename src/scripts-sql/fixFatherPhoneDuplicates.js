/**
 * Fix father_phone on joinings/admissions when it incorrectly equals student_phone
 * but a distinct father number exists on the linked lead or joining lead_data snapshot.
 *
 * Also backfills preferred_mobile_number (father when distinct, else student/father/mother).
 *
 * Usage (from backend-admission folder):
 *   node src/scripts-sql/fixFatherPhoneDuplicates.js --dry-run
 *   node src/scripts-sql/fixFatherPhoneDuplicates.js --apply
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, closeDB } from '../config-sql/database.js';
import {
  normalizeMobileDigits,
  suggestPreferredMobileDigits,
} from '../utils/parentPhone.util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const dryRun = !process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

const N = (col) =>
  `NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 10), '')`;

const SQL_J_LEAD_DATA = `COALESCE(CASE WHEN JSON_VALID(j.lead_data) THEN j.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_J_LD_FATHER = `NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J_LEAD_DATA}, '$.fatherPhone')), ''), '[^0-9]', ''), 10), '')`;

const SQL_J2_LEAD_DATA = SQL_J_LEAD_DATA.replace(/j\.lead_data/g, 'j2.lead_data');
const SQL_J2_LD_FATHER = `NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${SQL_J2_LEAD_DATA}, '$.fatherPhone')), ''), '[^0-9]', ''), 10), '')`;

function pickDistinctFatherPhone(studentDigits, ...candidates) {
  for (const raw of candidates) {
    const d = normalizeMobileDigits(raw);
    if (d.length === 10 && d !== studentDigits) return d;
  }
  return '';
}

async function main() {
  const pool = getPool();
  console.log(dryRun ? '\n*** DRY RUN — no writes ***\n' : '\n*** APPLYING UPDATES ***\n');

  const limitSql = limit != null && Number.isFinite(limit) ? `LIMIT ${Number(limit)}` : '';

  const [joiningRows] = await pool.execute(`
    SELECT
      j.id,
      j.lead_id,
      j.status,
      j.student_name,
      ${N('j.student_phone')} AS student_digits,
      ${N('j.father_phone')} AS joining_father_digits,
      ${N('j.mother_phone')} AS joining_mother_digits,
      ${N('j.preferred_mobile_number')} AS preferred_digits,
      ${N('l.father_phone')} AS lead_father_digits,
      ${N('l.alternate_mobile')} AS lead_alternate_digits,
      ${SQL_J_LD_FATHER} AS lead_data_father_digits,
      l.enquiry_number
    FROM joinings j
    LEFT JOIN leads l ON l.id = j.lead_id
    WHERE ${N('j.student_phone')} = ${N('j.father_phone')}
      AND ${N('j.student_phone')} IS NOT NULL
    ${limitSql}
  `);

  const joiningUpdates = [];
  const joiningSkipped = [];

  for (const row of joiningRows) {
    const student = String(row.student_digits || '');
    const correctedFather = pickDistinctFatherPhone(
      student,
      row.lead_father_digits,
      row.lead_data_father_digits,
      row.lead_alternate_digits
    );

    if (!correctedFather) {
      joiningSkipped.push({
        id: row.id,
        enquiry: row.enquiry_number,
        student,
        reason: 'no_distinct_father_on_lead_or_snapshot',
      });
      continue;
    }

    const mother = String(row.joining_mother_digits || '');
    const preferred =
      String(row.preferred_digits || '').length === 10
        ? String(row.preferred_digits)
        : suggestPreferredMobileDigits(student, correctedFather, mother);

    joiningUpdates.push({
      id: row.id,
      enquiry: row.enquiry_number,
      student,
      oldFather: String(row.joining_father_digits || ''),
      newFather: correctedFather,
      newPreferred: preferred,
      status: row.status,
    });
  }

  console.log(`Joinings with student=father scanned: ${joiningRows.length}`);
  console.log(`Joinings to fix (distinct father found): ${joiningUpdates.length}`);
  console.log(`Joinings skipped (no distinct father source): ${joiningSkipped.length}`);

  if (joiningUpdates.length) {
    console.log('\nJoining updates:');
    console.table(joiningUpdates);
  }

  if (joiningSkipped.length) {
    console.log('\nSkipped joinings (student=father is correct — no other father number in lead):');
    console.table(joiningSkipped.slice(0, 30));
    if (joiningSkipped.length > 30) {
      console.log(`... and ${joiningSkipped.length - 30} more`);
    }
  }

  let joiningApplied = 0;

  if (!dryRun) {
    const [bulkJoining] = await pool.execute(`
      UPDATE joinings j
      INNER JOIN leads l ON l.id = j.lead_id
      SET
        j.father_phone = RIGHT(REGEXP_REPLACE(l.father_phone, '[^0-9]', ''), 10),
        j.preferred_mobile_number = RIGHT(REGEXP_REPLACE(l.father_phone, '[^0-9]', ''), 10),
        j.updated_at = NOW()
      WHERE ${N('j.student_phone')} = ${N('j.father_phone')}
        AND ${N('j.student_phone')} IS NOT NULL
        AND ${N('l.father_phone')} IS NOT NULL
        AND ${N('l.father_phone')} <> ${N('j.student_phone')}
    `);
    joiningApplied = bulkJoining.affectedRows || 0;

    for (const u of joiningUpdates) {
      if (u.newFather === u.student) continue;
      const [exists] = await pool.execute(
        `SELECT id FROM joinings WHERE id = ? AND ${N('father_phone')} = ${N('student_phone')}`,
        [u.id]
      );
      if (!exists.length) continue;
      await pool.execute(
        `UPDATE joinings SET father_phone = ?, preferred_mobile_number = ?, updated_at = NOW() WHERE id = ?`,
        [u.newFather, u.newPreferred || '', u.id]
      );
      joiningApplied += 1;
    }

    await pool.execute(`
      UPDATE admissions a
      INNER JOIN joinings j ON j.id = a.joining_id
      SET
        a.father_phone = j.father_phone,
        a.preferred_mobile_number = CASE
          WHEN j.preferred_mobile_number IS NOT NULL AND TRIM(j.preferred_mobile_number) <> ''
          THEN j.preferred_mobile_number
          ELSE a.preferred_mobile_number
        END,
        a.updated_at = NOW()
      WHERE ${N('a.student_phone')} = ${N('a.father_phone')}
        AND ${N('j.father_phone')} IS NOT NULL
        AND ${N('j.father_phone')} <> ${N('j.student_phone')}
    `);
  }

  const joiningFixById = new Map(joiningUpdates.map((u) => [u.id, u]));

  const [admissionRows] = await pool.execute(`
    SELECT
      a.id,
      a.joining_id,
      a.admission_number,
      a.enquiry_number,
      ${N('a.student_phone')} AS student_digits,
      ${N('a.father_phone')} AS admission_father_digits,
      ${N('a.mother_phone')} AS admission_mother_digits,
      ${N('a.preferred_mobile_number')} AS preferred_digits,
      ${N('l.father_phone')} AS lead_father_digits,
      ${N('l.alternate_mobile')} AS lead_alternate_digits,
      ${SQL_J2_LD_FATHER} AS lead_data_father_digits
    FROM admissions a
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN joinings j2 ON j2.id = a.joining_id
    WHERE ${N('a.student_phone')} = ${N('a.father_phone')}
      AND ${N('a.student_phone')} IS NOT NULL
    ${limitSql}
  `);

  const admissionUpdates = [];

  for (const row of admissionRows) {
    const student = String(row.student_digits || '');
    const fromJoiningFix = row.joining_id ? joiningFixById.get(row.joining_id) : null;
    const correctedFather =
      fromJoiningFix?.newFather ||
      pickDistinctFatherPhone(
        student,
        row.lead_father_digits,
        row.lead_data_father_digits,
        row.lead_alternate_digits
      );

    if (!correctedFather) continue;

    const mother = String(row.admission_mother_digits || '');
    const preferred =
      String(row.preferred_digits || '').length === 10
        ? String(row.preferred_digits)
        : suggestPreferredMobileDigits(student, correctedFather, mother);

    admissionUpdates.push({
      id: row.id,
      admission_number: row.admission_number,
      enquiry: row.enquiry_number,
      student,
      oldFather: String(row.admission_father_digits || ''),
      newFather: correctedFather,
      newPreferred: preferred,
    });
  }

  console.log(`\nAdmissions with student=father scanned: ${admissionRows.length}`);
  console.log(`Admissions to fix: ${admissionUpdates.length}`);

  if (admissionUpdates.length) {
    console.log('\nAdmission updates:');
    console.table(admissionUpdates);
  }

  let admissionApplied = 0;

  if (!dryRun) {
    const [bulkAdmission] = await pool.execute(`
      UPDATE admissions a
      INNER JOIN leads l ON l.id = a.lead_id
      SET
        a.father_phone = RIGHT(REGEXP_REPLACE(l.father_phone, '[^0-9]', ''), 10),
        a.preferred_mobile_number = RIGHT(REGEXP_REPLACE(l.father_phone, '[^0-9]', ''), 10),
        a.updated_at = NOW()
      WHERE ${N('a.student_phone')} = ${N('a.father_phone')}
        AND ${N('a.student_phone')} IS NOT NULL
        AND ${N('l.father_phone')} IS NOT NULL
        AND ${N('l.father_phone')} <> ${N('a.student_phone')}
    `);
    admissionApplied = bulkAdmission.affectedRows || 0;
  }

  const [prefJoiningCount] = await pool.execute(`
    SELECT COUNT(*) AS c FROM joinings j
    WHERE (${N('j.preferred_mobile_number')} IS NULL OR ${N('j.preferred_mobile_number')} = '')
      AND ${N('j.student_phone')} IS NOT NULL
  `);
  const prefJoiningWould = Number(prefJoiningCount[0]?.c || 0);

  let prefJoiningApplied = 0;
  if (!dryRun && prefJoiningWould > 0) {
    const [r1] = await pool.execute(`
      UPDATE joinings j
      SET j.preferred_mobile_number = ${N('j.father_phone')}, j.updated_at = NOW()
      WHERE (${N('j.preferred_mobile_number')} IS NULL OR ${N('j.preferred_mobile_number')} = '')
        AND ${N('j.student_phone')} IS NOT NULL
        AND ${N('j.father_phone')} IS NOT NULL
        AND ${N('j.father_phone')} <> ${N('j.student_phone')}
    `);
    const [r2] = await pool.execute(`
      UPDATE joinings j
      SET j.preferred_mobile_number = ${N('j.mother_phone')}, j.updated_at = NOW()
      WHERE (${N('j.preferred_mobile_number')} IS NULL OR ${N('j.preferred_mobile_number')} = '')
        AND ${N('j.student_phone')} IS NOT NULL
        AND ${N('j.mother_phone')} IS NOT NULL
        AND ${N('j.mother_phone')} <> ${N('j.student_phone')}
    `);
    const [r3] = await pool.execute(`
      UPDATE joinings j
      SET j.preferred_mobile_number = ${N('j.student_phone')}, j.updated_at = NOW()
      WHERE (${N('j.preferred_mobile_number')} IS NULL OR ${N('j.preferred_mobile_number')} = '')
        AND ${N('j.student_phone')} IS NOT NULL
    `);
    prefJoiningApplied =
      (r1.affectedRows || 0) + (r2.affectedRows || 0) + (r3.affectedRows || 0);
  }

  const [prefAdmissionCount] = await pool.execute(`
    SELECT COUNT(*) AS c FROM admissions a
    WHERE (${N('a.preferred_mobile_number')} IS NULL OR ${N('a.preferred_mobile_number')} = '')
      AND ${N('a.student_phone')} IS NOT NULL
  `);
  const prefAdmissionWould = Number(prefAdmissionCount[0]?.c || 0);

  let prefAdmissionApplied = 0;
  if (!dryRun && prefAdmissionWould > 0) {
    const [r1] = await pool.execute(`
      UPDATE admissions a
      SET a.preferred_mobile_number = ${N('a.father_phone')}, a.updated_at = NOW()
      WHERE (${N('a.preferred_mobile_number')} IS NULL OR ${N('a.preferred_mobile_number')} = '')
        AND ${N('a.student_phone')} IS NOT NULL
        AND ${N('a.father_phone')} IS NOT NULL
        AND ${N('a.father_phone')} <> ${N('a.student_phone')}
    `);
    const [r2] = await pool.execute(`
      UPDATE admissions a
      SET a.preferred_mobile_number = ${N('a.mother_phone')}, a.updated_at = NOW()
      WHERE (${N('a.preferred_mobile_number')} IS NULL OR ${N('a.preferred_mobile_number')} = '')
        AND ${N('a.student_phone')} IS NOT NULL
        AND ${N('a.mother_phone')} IS NOT NULL
        AND ${N('a.mother_phone')} <> ${N('a.student_phone')}
    `);
    const [r3] = await pool.execute(`
      UPDATE admissions a
      SET a.preferred_mobile_number = ${N('a.student_phone')}, a.updated_at = NOW()
      WHERE (${N('a.preferred_mobile_number')} IS NULL OR ${N('a.preferred_mobile_number')} = '')
        AND ${N('a.student_phone')} IS NOT NULL
    `);
    prefAdmissionApplied =
      (r1.affectedRows || 0) + (r2.affectedRows || 0) + (r3.affectedRows || 0);
  }

  console.log('\n=== Summary ===');
  console.log(
    JSON.stringify(
      {
        mode: dryRun ? 'dry-run' : 'apply',
        joiningsScannedSameAsFather: joiningRows.length,
        joiningsFatherCorrected: dryRun ? 0 : joiningApplied,
        joiningsWouldCorrectFather: joiningUpdates.length,
        joiningsSkippedNoDistinctFather: joiningSkipped.length,
        admissionsScannedSameAsFather: admissionRows.length,
        admissionsFatherCorrected: dryRun ? 0 : admissionApplied,
        admissionsWouldCorrectFather: admissionUpdates.length,
        joiningsPreferredBackfilled: dryRun ? 0 : prefJoiningApplied,
        joiningsWouldBackfillPreferred: prefJoiningWould,
        admissionsPreferredBackfilled: dryRun ? 0 : prefAdmissionApplied,
        admissionsWouldBackfillPreferred: prefAdmissionWould,
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log('\nRe-run with --apply to write changes.\n');
  } else {
    console.log('\nDone.\n');
  }

  await closeDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
