/**
 * Delete draft joinings for given enquiry numbers (joinings with no admission row).
 *
 * Usage (from backend-admission):
 *   node src/scripts/deleteJoiningsByEnquiryOnce.js ENQ26840983 ENQ26840963
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { JOINING_STUDENT_FEE_MONGO_COLLECTION } from '../services/joiningStudentFeeMongoSync.service.js';

dotenv.config();

const ENQUIRIES = process.argv
  .slice(2)
  .map((s) => String(s).trim())
  .filter(Boolean);

async function main() {
  if (ENQUIRIES.length === 0) {
    console.error('Usage: node src/scripts/deleteJoiningsByEnquiryOnce.js <ENQ...>');
    process.exit(1);
  }
  const pool = getPool();
  const ph = ENQUIRIES.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT j.id, j.status, j.lead_id, l.enquiry_number, l.name
     FROM joinings j
     INNER JOIN leads l ON l.id = j.lead_id
     WHERE l.enquiry_number IN (${ph})
       AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.joining_id = j.id)`,
    ENQUIRIES
  );

  const ids = rows.map((r) => r.id);
  console.log(JSON.stringify({ matched: rows, joiningIds: ids }, null, 2));
  if (ids.length === 0) {
    process.exit(0);
    return;
  }

  const idPh = ids.map(() => '?').join(',');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM joining_public_edit_tokens WHERE route_key IN (${idPh})`, ids);
    const [del] = await conn.execute(`DELETE FROM joinings WHERE id IN (${idPh})`, ids);
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
      const mr = await m.db.collection(JOINING_STUDENT_FEE_MONGO_COLLECTION).deleteMany({ joiningId: { $in: ids } });
      console.log(JSON.stringify({ feeMongoDeleted: mr.deletedCount }, null, 2));
    } catch (e) {
      console.warn(e?.message || e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
