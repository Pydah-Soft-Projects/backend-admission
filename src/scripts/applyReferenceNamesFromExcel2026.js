/**
 * Apply Excel "Reference 1" to admissions.lead_data, joinings.lead_data, leads.dynamic_fields.
 *
 *   node src/scripts/applyReferenceNamesFromExcel2026.js --apply
 */
import dotenv from 'dotenv';
import { loadMasterRowsFromExcel } from './importAdmissionsMasterFromExcel.js';
import { getPool } from '../config-sql/database.js';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const rows = loadMasterRowsFromExcel();
  const pool = getPool();
  const conn = await pool.getConnection();
  const report = { apply, updated: [], missing: [] };

  try {
    if (apply) await conn.beginTransaction();

    for (const row of rows) {
      const ref = String(row.reference1 || '').trim();
      const [adm] = await conn.execute(
        `SELECT id, lead_id, joining_id, lead_data FROM admissions WHERE admission_number = ? LIMIT 1`,
        [row.admissionNumber]
      );
      if (!adm.length) {
        report.missing.push(row.admissionNumber);
        continue;
      }
      const a = adm[0];
      if (!apply) {
        report.updated.push({ admissionNumber: row.admissionNumber, reference1: ref });
        continue;
      }

      await conn.execute(
        `UPDATE admissions SET
           lead_data = JSON_SET(
             COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
             '$.reference1', ?
           ),
           updated_at = NOW()
         WHERE id = ?`,
        [ref, a.id]
      );

      if (a.joining_id) {
        await conn.execute(
          `UPDATE joinings SET
             lead_data = JSON_SET(
               COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
               '$.reference1', ?
             ),
             updated_at = NOW()
           WHERE id = ?`,
          [ref, a.joining_id]
        );
      }

      if (a.lead_id) {
        await conn.execute(
          `UPDATE leads SET
             dynamic_fields = JSON_SET(
               COALESCE(CASE WHEN JSON_VALID(dynamic_fields) THEN dynamic_fields ELSE JSON_OBJECT() END, JSON_OBJECT()),
               '$.reference1', ?
             ),
             updated_at = NOW()
           WHERE id = ?`,
          [ref, a.lead_id]
        );
      }

      report.updated.push({ admissionNumber: row.admissionNumber, reference1: ref });
    }

    if (apply) await conn.commit();
  } catch (e) {
    if (apply) await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  console.log(JSON.stringify({ total: rows.length, ...report }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
