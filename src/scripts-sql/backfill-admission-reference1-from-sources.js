/**
 * Copy resolved Reference 1 onto admissions.lead_data (and align joining when admission wins).
 *
 * Effective reference = admission.lead_data.reference1 → joining.lead_data → lead.dynamic_fields
 *
 * Usage:
 *   node src/scripts-sql/backfill-admission-reference1-from-sources.js
 *   node src/scripts-sql/backfill-admission-reference1-from-sources.js --apply
 */
import { getPool } from '../config-sql/database.js';
import { resolveAdmissionReference1 } from '../utils/joiningReference.util.js';

const apply = process.argv.includes('--apply');

const SQL_A_LEAD_DATA = `COALESCE(CASE WHEN JSON_VALID(a.lead_data) THEN a.lead_data ELSE JSON_OBJECT() END, JSON_OBJECT())`;
const SQL_A_REF = `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${SQL_A_LEAD_DATA}, '$.reference1'))), '')`;

async function main() {
  const pool = getPool();

  const [rows] = await pool.execute(
    `SELECT a.id, a.lead_id, a.joining_id, a.admission_number, a.lead_data,
            j.lead_data AS joining_lead_data,
            l.dynamic_fields AS lead_dynamic_fields
     FROM admissions a
     LEFT JOIN joinings j ON j.id = a.joining_id
     LEFT JOIN leads l ON l.id = a.lead_id`
  );

  const toUpdate = [];

  for (const row of rows) {
    let leadDataRaw = {};
    try {
      const raw = row.lead_data;
      leadDataRaw =
        typeof raw === 'string' ? JSON.parse(raw || '{}') : raw && typeof raw === 'object' ? raw : {};
    } catch {
      leadDataRaw = {};
    }

    const effective = await resolveAdmissionReference1(pool, {
      leadDataRaw,
      joiningId: row.joining_id,
      leadId: row.lead_id,
    });

    const onAdmission = String(leadDataRaw.reference1 ?? leadDataRaw.referenceName ?? '').trim();
    if (!effective) continue;
    if (onAdmission && onAdmission.toLowerCase() === effective.toLowerCase()) continue;

    toUpdate.push({
      admissionId: row.id,
      admissionNumber: row.admission_number,
      leadId: row.lead_id,
      before: onAdmission || '(empty)',
      after: effective,
    });
  }

  console.log('\n=== Backfill admissions.lead_data.reference1 ===\n');
  console.log(`Total admissions: ${rows.length}`);
  console.log(`Need update: ${toUpdate.length}\n`);

  if (toUpdate.length) {
    console.table(toUpdate.slice(0, 40));
    if (toUpdate.length > 40) {
      console.log(`… and ${toUpdate.length - 40} more\n`);
    }
  }

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.\n');
    await pool.end();
    return;
  }

  let updated = 0;
  for (const row of toUpdate) {
    await pool.execute(
      `UPDATE admissions SET
         lead_data = JSON_SET(
           COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
           '$.reference1', ?
         ),
         updated_at = NOW()
       WHERE id = ?`,
      [row.after, row.admissionId]
    );
    updated += 1;
  }

  console.log(`Updated ${updated} admission row(s).\n`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
