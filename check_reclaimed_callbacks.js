import { getPool } from './src/config-sql/database.js';

async function checkReclaimedCallbacks() {
  let pool;
  try {
    // We get the database pool from your existing configuration
    pool = getPool();
    console.log("Checking for leads reclaimed in the last 10 days whose last counselor status was 'Interested'...\n");

    // Query 1: Get the aggregate count
    const [summary] = await pool.execute(`
      WITH reclaimed_leads AS (
        SELECT 
            al.lead_id,
            (
              SELECT al2.new_status 
              FROM activity_logs al2 
              WHERE al2.lead_id = al.lead_id 
                AND al2.created_at < al.created_at
                AND al2.type IN ('status_change', 'follow_up')
                AND al2.performed_by <> '00000000-0000-0000-0000-000000000000'
              ORDER BY al2.created_at DESC 
              LIMIT 1
            ) as last_user_set_status
        FROM activity_logs al
        WHERE al.type = 'status_change'
          AND al.old_status = 'Assigned'
          AND al.new_status = 'New'
          AND al.comment LIKE '%reclaim%'
          AND al.created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY)
      )
      SELECT 
          COUNT(*) as total_reclaimed,
          COUNT(DISTINCT lead_id) as unique_leads_affected
      FROM reclaimed_leads
      WHERE last_user_set_status = 'Interested';
    `);

    console.log("=== SUMMARY ===");
    console.log(`Total 'Interested' leads reclaimed: ${summary[0].total_reclaimed}`);
    console.log(`Unique Leads affected: ${summary[0].unique_leads_affected}\n`);

    // Query 2: Get the detailed list of leads affected
    if (summary[0].total_reclaimed > 0) {
      const [details] = await pool.execute(`
        WITH reclaimed_leads AS (
          SELECT 
              l.id as lead_id,
              l.name as student_name,
              l.phone,
              l.call_status as current_call_status,
              l.visit_status as current_visit_status,
              al.created_at as reclaimed_at,
              (
                SELECT al2.new_status 
                FROM activity_logs al2 
                WHERE al2.lead_id = al.lead_id 
                  AND al2.created_at < al.created_at
                  AND al2.type IN ('status_change', 'follow_up')
                  AND al2.performed_by <> '00000000-0000-0000-0000-000000000000'
                ORDER BY al2.created_at DESC 
                LIMIT 1
              ) as last_user_set_status
          FROM activity_logs al
          JOIN leads l ON al.lead_id = l.id
          WHERE al.type = 'status_change'
            AND al.old_status = 'Assigned'
            AND al.new_status = 'New'
            AND al.comment LIKE '%reclaim%'
            AND al.created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY)
        )
        SELECT 
            lead_id,
            student_name,
            phone,
            last_user_set_status as status_before_reclaim,
            current_call_status,
            current_visit_status,
            reclaimed_at
        FROM reclaimed_leads
        WHERE last_user_set_status = 'Interested'
        ORDER BY reclaimed_at DESC;
      `);

      console.log("=== DETAILED LEADS ===");
      console.table(details);
    } else {
      console.log("Good news: No leads marked 'Interested' by counselors were reclaimed in the last 10 days!");
    }

  } catch (error) {
    console.error("Error executing query:", error);
  } finally {
    if (pool) {
      // Exit the process cleanly
      process.exit(0);
    }
  }
}

checkReclaimedCallbacks();
