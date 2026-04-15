import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

async function main() {
  const pool = getPool();

  const [rows] = await pool.execute(`
    WITH reclaim_events AS (
      SELECT
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status AS status_before_reclaim,
        a.new_status AS status_at_reclaim,
        CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousCycle')) AS UNSIGNED) AS previous_cycle,
        CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.newCycle')) AS UNSIGNED) AS new_cycle
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
    ),
    next_status AS (
      SELECT
        re.lead_id,
        re.reclaimed_at,
        al.new_status,
        ROW_NUMBER() OVER (
          PARTITION BY re.lead_id, re.reclaimed_at
          ORDER BY al.created_at ASC
        ) AS rn
      FROM reclaim_events re
      JOIN activity_logs al
        ON al.lead_id = re.lead_id
       AND al.created_at > re.reclaimed_at
       AND al.type = 'status_change'
    )
    SELECT
      re.lead_id,
      l.enquiry_number,
      l.name AS lead_name,
      l.target_date,
      re.reclaimed_at,
      re.previous_cycle,
      re.new_cycle,
      re.status_before_reclaim,
      re.status_at_reclaim,
      ns.new_status AS first_status_in_next_cycle,
      l.lead_status AS current_status,
      l.cycle_number AS current_cycle
    FROM reclaim_events re
    LEFT JOIN leads l ON l.id = re.lead_id
    LEFT JOIN next_status ns
      ON ns.lead_id = re.lead_id
     AND ns.reclaimed_at = re.reclaimed_at
     AND ns.rn = 1
    ORDER BY re.reclaimed_at DESC
    LIMIT 300
  `);

  console.log('\n=== Reclaimed Leads (Latest 300) ===');
  console.log('Rows:', rows.length);
  console.table(rows.slice(0, 120));

  const [summary] = await pool.execute(`
    WITH reclaim_events AS (
      SELECT
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status AS status_before_reclaim,
        a.new_status AS status_at_reclaim
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
    ),
    next_status AS (
      SELECT
        re.lead_id,
        re.reclaimed_at,
        al.new_status,
        ROW_NUMBER() OVER (
          PARTITION BY re.lead_id, re.reclaimed_at
          ORDER BY al.created_at ASC
        ) AS rn
      FROM reclaim_events re
      JOIN activity_logs al
        ON al.lead_id = re.lead_id
       AND al.created_at > re.reclaimed_at
       AND al.type = 'status_change'
    )
    SELECT
      re.status_before_reclaim,
      re.status_at_reclaim,
      COALESCE(ns.new_status, '(no further status)') AS first_status_in_next_cycle,
      COUNT(*) AS count
    FROM reclaim_events re
    LEFT JOIN next_status ns
      ON ns.lead_id = re.lead_id
     AND ns.reclaimed_at = re.reclaimed_at
     AND ns.rn = 1
    GROUP BY
      re.status_before_reclaim,
      re.status_at_reclaim,
      COALESCE(ns.new_status, '(no further status)')
    ORDER BY count DESC
  `);

  console.log('\n=== Status Movement After Reclaim ===');
  console.table(summary);

  await closeDB();
}

main().catch(async (err) => {
  console.error(err);
  await closeDB();
  process.exit(1);
});

