import { getPool } from './src/config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

async function restoreCallbacks() {
  let pool;
  try {
    pool = getPool();
    console.log("🚀 LIVE RUN: Finding and restoring recently reclaimed 'Call Back' leads...");
    
    // Fetch leads that were reclaimed from 'Call Back' to 'New'
    // We only fetch leads that are STILL 'New'. If a counselor already manually
    // claimed it again, we skip it to prevent overriding their new work.
    const [logs] = await pool.execute(`
      SELECT al.lead_id, al.metadata, l.lead_status, l.assigned_to, l.assigned_to_pro
      FROM activity_logs al
      JOIN leads l ON al.lead_id = l.id
      WHERE al.type = 'status_change'
        AND al.old_status = 'Call Back'
        AND al.new_status = 'New'
        AND al.comment LIKE '%reclaim%'
        AND al.created_at >= DATE_SUB(NOW(), INTERVAL 5 DAY)
        AND l.lead_status = 'New'
    `);
    
    console.log(`Found ${logs.length} restoration logs for leads that are still 'New'.`);
    
    // Import PQueue dynamically (since the project uses it)
    const { default: PQueue } = await import('p-queue');
    const queue = new PQueue({ concurrency: 50 }); // Process 50 queries at a time
    
    let restoredCount = 0;
    let processedCount = 0;
    
    const tasks = logs.map((log, index) => async () => {
      // Safely parse metadata if it's a string, otherwise use the object directly
      let meta = typeof log.metadata === 'string' ? JSON.parse(log.metadata) : (log.metadata || {});
      
      const previousAssignee = meta?.reclamation?.previousAssignee;
      const role = meta?.reclamation?.reclaimedRole;
      
      if (!previousAssignee) return;
      
      let updated = false;
      
      // Restore to Counselor
      if (role === 'counsellor') {
        await pool.execute(`
          UPDATE leads 
          SET assigned_to = ?, 
              assigned_at = NOW(),
              lead_status = 'Call Back'
          WHERE id = ?
        `, [previousAssignee, log.lead_id]);
        updated = true;
      } 
      // Restore to PRO
      else if (role === 'pro') {
        await pool.execute(`
          UPDATE leads 
          SET assigned_to_pro = ?, 
              pro_assigned_at = NOW(),
              lead_status = 'Call Back'
          WHERE id = ?
        `, [previousAssignee, log.lead_id]);
        updated = true;
      }

      // Log the restoration so there's an audit trail
      if (updated) {
        await pool.execute(`
          INSERT INTO activity_logs (
            id, lead_id, type, old_status, new_status, comment, performed_by, created_at, updated_at
          ) VALUES (?, ?, 'status_change', 'New', 'Call Back', ?, '00000000-0000-0000-0000-000000000000', NOW(), NOW())
        `, [
          uuidv4(),
          log.lead_id, 
          `System restore: Re-assigned to ${role} after automated reclamation.`
        ]);
        
        restoredCount++;
      }

      processedCount++;
      if (processedCount % 500 === 0) {
        console.log(`Progress: Processed ${processedCount} / ${logs.length} logs...`);
      }
    });

    // Wait for all tasks to complete
    await queue.addAll(tasks);
    
    console.log(`✅ Successfully restored ${restoredCount} slots back to their original assignees!`);
    
  } catch(e) {
    console.error("Error during restoration:", e);
  } finally {
    if (pool) process.exit(0);
  }
}

restoreCallbacks();
