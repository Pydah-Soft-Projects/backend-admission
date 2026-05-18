import { getPool } from './src/config-sql/database.js';

async function checkReclaimedCallbacks() {
  let pool;
  try {
    // We get the database pool from your existing configuration
    pool = getPool();
    console.log("Checking for 'Call Back' leads reclaimed in the last 3 days...\n");

    // Query 1: Get the aggregate count
    const [summary] = await pool.execute(`
      SELECT 
          COUNT(*) as total_callbacks_reclaimed,
          COUNT(DISTINCT lead_id) as unique_leads_affected
      FROM activity_logs
      WHERE type = 'status_change'
        AND old_status = 'Call Back'
        AND new_status = 'New'
        AND comment LIKE '%reclaim%'
        AND created_at >= DATE_SUB(NOW(), INTERVAL 3 DAY);
    `);

    console.log("=== SUMMARY ===");
    console.log(`Total 'Call Back' slots reclaimed: ${summary[0].total_callbacks_reclaimed}`);
    console.log(`Unique Leads affected: ${summary[0].unique_leads_affected}\n`);

    // Query 2: Get the detailed list of leads affected
    if (summary[0].total_callbacks_reclaimed > 0) {
      const [details] = await pool.execute(`
        SELECT 
            l.id as lead_id,
            l.name as student_name,
            l.phone,
            l.call_status,
            l.visit_status,
            al.created_at as reclaimed_at,
            al.comment
        FROM activity_logs al
        JOIN leads l ON al.lead_id = l.id
        WHERE al.type = 'status_change'
          AND al.old_status = 'Call Back'
          AND al.new_status = 'New'
          AND al.comment LIKE '%reclaim%'
          AND al.created_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
        ORDER BY al.created_at DESC;
      `);

      console.log("=== DETAILED LEADS ===");
      console.table(details);
    } else {
      console.log("Good news: No active 'Call Back' leads were reclaimed in the last 3 days!");
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
