/**
 * List leads that appear on Confirmed Leads page (same filters as GET /leads?leadStatus=Confirmed).
 * Read-only.
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT l.id, l.enquiry_number, l.name, l.phone, l.lead_status, l.call_status, l.visit_status,
            l.source, l.created_at, l.updated_at,
            EXISTS (SELECT 1 FROM joinings j WHERE j.lead_id = l.id) AS has_joining,
            (SELECT j.status FROM joinings j WHERE j.lead_id = l.id ORDER BY j.updated_at DESC LIMIT 1) AS joining_status,
            EXISTS (
              SELECT 1 FROM joinings j2
              INNER JOIN admissions a ON a.joining_id = j2.id
              WHERE j2.lead_id = l.id AND j2.status = 'approved'
                AND TRIM(COALESCE(a.admission_number, '')) <> ''
            ) AS completed_joining
     FROM leads l
     WHERE l.lead_status = 'Confirmed'
       AND NOT EXISTS (
         SELECT 1 FROM joinings j_stale
         INNER JOIN admissions a_stale ON a_stale.joining_id = j_stale.id
         WHERE j_stale.lead_id = l.id
           AND j_stale.status = 'approved'
           AND TRIM(COALESCE(a_stale.admission_number, '')) <> ''
       )
       AND NOT EXISTS (
         SELECT 1
         FROM leads l_phone_dup
         INNER JOIN joinings j_phone_dup ON j_phone_dup.lead_id = l_phone_dup.id AND j_phone_dup.status = 'approved'
         INNER JOIN admissions a_phone_dup ON a_phone_dup.joining_id = j_phone_dup.id
         WHERE l_phone_dup.id <> l.id
           AND TRIM(COALESCE(l.phone, '')) <> ''
           AND l_phone_dup.phone = l.phone
           AND TRIM(COALESCE(a_phone_dup.admission_number, '')) <> ''
       )
     ORDER BY l.updated_at DESC`
  );

  console.log(JSON.stringify({ count: rows.length, confirmedLeads: rows }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
