/**
 * Delete draft joinings that have no enquiry number (neither on linked `leads` nor in `joinings.lead_data.enquiryNumber`).
 * Skips rows linked to `admissions` (FK RESTRICT).
 *
 * From backend-admission:
 *   node src/scripts/deleteDraftJoiningsWithoutEnquiry.js --dry-run
 *   node src/scripts/deleteDraftJoiningsWithoutEnquiry.js --apply
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { JOINING_STUDENT_FEE_MONGO_COLLECTION } from '../services/joiningStudentFeeMongoSync.service.js';

dotenv.config();

const dryRun = !process.argv.includes('--apply');

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT j.id
     FROM joinings j
     LEFT JOIN leads l ON j.lead_id = l.id
     WHERE j.status = 'draft'
       AND NOT (
         (l.id IS NOT NULL AND TRIM(COALESCE(l.enquiry_number, '')) <> '')
         OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.enquiryNumber')), '')) <> ''
       )
       AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.joining_id = j.id)`
  );

  const ids = rows.map((r) => r.id);
  console.log(JSON.stringify({ dryRun, count: ids.length, ids }, null, 2));

  if (dryRun || ids.length === 0) {
    process.exit(0);
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `DELETE FROM joining_public_edit_tokens WHERE route_key IN (${placeholders})`,
      ids
    );
    const [del] = await conn.execute(`DELETE FROM joinings WHERE id IN (${placeholders})`, ids);
    await conn.commit();
    console.log(JSON.stringify({ deletedJoinings: del.affectedRows }, null, 2));
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (uri) {
    try {
      const m = await connectFeeManagement();
      const coll = m.db.collection(JOINING_STUDENT_FEE_MONGO_COLLECTION);
      const mr = await coll.deleteMany({ joiningId: { $in: ids } });
      console.log(JSON.stringify({ feeMongoDeleted: mr.deletedCount }, null, 2));
    } catch (e) {
      console.warn('Fee Mongo cleanup failed (SQL already committed):', e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
