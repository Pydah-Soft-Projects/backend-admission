/**
 * List joinings that appear on the Joining Pipeline UI (draft / pending_approval + enquiry).
 * Read-only unless --apply deletes selected joining rows (leads are kept).
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';

dotenv.config();

const PIPELINE_STATUSES = ['draft', 'pending_approval'];

async function main() {
  const pool = getPool();
  const ph = PIPELINE_STATUSES.map(() => '?').join(',');

  const [rows] = await pool.execute(
    `SELECT j.id AS joining_id, j.status, j.lead_id, j.created_at, j.updated_at,
            l.enquiry_number, l.name, l.phone, l.lead_status, l.source,
            EXISTS (SELECT 1 FROM admissions a WHERE a.joining_id = j.id) AS has_admission
     FROM joinings j
     LEFT JOIN leads l ON l.id = j.lead_id
     WHERE j.status IN (${ph})
       AND (
         (l.id IS NOT NULL AND TRIM(COALESCE(l.enquiry_number, '')) <> '')
         OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.enquiryNumber')), '')) <> ''
       )
     ORDER BY j.updated_at DESC`,
    PIPELINE_STATUSES
  );

  console.log(JSON.stringify({ count: rows.length, pipelineJoinings: rows }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
