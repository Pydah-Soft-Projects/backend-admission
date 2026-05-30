/**
 * Compare confirmed leads: assigned counsellor vs last user who marked Confirmed in activity_logs.
 *
 * Usage: node src/scripts-sql/analyze-confirmed-lead-references.js [--limit=50]
 */
import { getPool } from '../config-sql/database.js';

const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 100);

const CONFIRMER_SUBQUERY = `
  SELECT a.lead_id, u.name AS confirmer_name, a.created_at AS confirmed_at,
         a.new_status, a.metadata
  FROM activity_logs a
  INNER JOIN users u ON u.id = a.performed_by
  WHERE a.type = 'status_change'
    AND LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.callStatus')), ''))) = 'confirmed'
`;

async function main() {
  const pool = getPool();

  const [summary] = await pool.execute(
    `SELECT
       COUNT(*) AS total_confirmed,
       SUM(CASE WHEN conf.confirmer_name IS NOT NULL THEN 1 ELSE 0 END) AS with_confirmer_log,
       SUM(CASE WHEN conf.confirmer_name IS NULL THEN 1 ELSE 0 END) AS without_confirmer_log,
       SUM(CASE WHEN conf.confirmer_name IS NOT NULL AND u.name IS NOT NULL
                AND LOWER(TRIM(conf.confirmer_name)) = LOWER(TRIM(u.name)) THEN 1 ELSE 0 END) AS confirmer_matches_assigned,
       SUM(CASE WHEN conf.confirmer_name IS NOT NULL AND u.name IS NOT NULL
                AND LOWER(TRIM(conf.confirmer_name)) <> LOWER(TRIM(u.name)) THEN 1 ELSE 0 END) AS confirmer_differs_assigned,
       SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.reference1')) IS NOT NULL
                AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.reference1'))) <> '' THEN 1 ELSE 0 END) AS with_reference1_set
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     LEFT JOIN (
       SELECT c.lead_id, c.confirmer_name
       FROM (${CONFIRMER_SUBQUERY}) c
       INNER JOIN (
         SELECT lead_id, MAX(confirmed_at) AS max_at
         FROM (${CONFIRMER_SUBQUERY}) x
         GROUP BY lead_id
       ) latest ON latest.lead_id = c.lead_id AND latest.max_at = c.confirmed_at
     ) conf ON conf.lead_id = l.id
     WHERE LOWER(TRIM(l.lead_status)) = 'confirmed'`
  );

  console.log('\n=== Confirmed leads — call_status Confirmed vs assignee ===\n');
  console.table(summary);

  const [samples] = await pool.execute(
    `SELECT
       l.enquiry_number,
       l.name AS student_name,
       u.name AS assigned_counsellor,
       conf.confirmer_name AS last_call_status_confirmed_by,
       conf.confirmed_at,
       JSON_UNQUOTE(JSON_EXTRACT(l.dynamic_fields, '$.reference1')) AS stored_reference1,
       CASE
         WHEN conf.confirmer_name IS NULL THEN 'no_confirmer_log'
         WHEN u.name IS NULL THEN 'unassigned'
         WHEN LOWER(TRIM(conf.confirmer_name)) = LOWER(TRIM(u.name)) THEN 'same'
         ELSE 'different'
       END AS confirmer_vs_assigned
     FROM leads l
     LEFT JOIN users u ON u.id = l.assigned_to
     LEFT JOIN (
       SELECT c.lead_id, c.confirmer_name, c.confirmed_at
       FROM (${CONFIRMER_SUBQUERY}) c
       INNER JOIN (
         SELECT lead_id, MAX(confirmed_at) AS max_at
         FROM (${CONFIRMER_SUBQUERY}) x
         GROUP BY lead_id
       ) latest ON latest.lead_id = c.lead_id AND latest.max_at = c.confirmed_at
     ) conf ON conf.lead_id = l.id
     WHERE LOWER(TRIM(l.lead_status)) = 'confirmed'
     ORDER BY l.updated_at DESC
     LIMIT ${Number(limit)}`
  );

  console.log(`\nSample of ${samples.length} most recently updated confirmed leads:\n`);
  console.table(samples);

  const [channelBreakdown] = await pool.execute(
    `SELECT
       'call_status' AS confirm_channel,
       COUNT(*) AS events
     FROM activity_logs a
     WHERE a.type = 'status_change'
       AND LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.callStatus')), ''))) = 'confirmed'`
  );

  console.log('\ncall_status → Confirmed events in activity_logs:\n');
  console.table(channelBreakdown);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
