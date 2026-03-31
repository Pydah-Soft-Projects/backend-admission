import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Reclaims leads that have reached their target date and are marked as 'Not Interested'.
 * These leads are moved back to the unassigned pool and their cycle count is incremented.
 */
export const reclaimExpiredLeads = async () => {
  let pool;
  try {
    pool = getPool();
    console.log('[LeadReclaimer] Starting automated lead reclamation...');

    // 1. Find leads to reclaim: 
    // - status is 'Not Interested'
    // - target_date is today or earlier
    // - currently assigned to someone
    const [leadsToReclaim] = await pool.execute(`
      SELECT id, lead_status, assigned_to, assigned_to_pro, cycle_number 
      FROM leads 
      WHERE (target_date <= CURRENT_DATE) 
        AND (lead_status = 'Not Interested')
        AND (assigned_to IS NOT NULL OR assigned_to_pro IS NOT NULL)
    `);

    if (leadsToReclaim.length === 0) {
      console.log('[LeadReclaimer] No leads found for reclamation.');
      return 0;
    }

    console.log(`[LeadReclaimer] Found ${leadsToReclaim.length} leads to reclaim.`);

    let reclaimedCount = 0;

    for (const lead of leadsToReclaim) {
      const newCycle = (lead.cycle_number || 1) + 1;
      const oldStatus = lead.lead_status;
      
      // Update the lead record
      await pool.execute(`
        UPDATE leads 
        SET 
          assigned_to = NULL, 
          assigned_at = NULL, 
          assigned_by = NULL,
          assigned_to_pro = NULL,
          pro_assigned_at = NULL,
          pro_assigned_by = NULL,
          lead_status = 'New',
          target_date = NULL,
          cycle_number = ?,
          updated_at = NOW()
        WHERE id = ?
      `, [newCycle, lead.id]);

      // Create activity log
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (
          id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'status_change',
          oldStatus,
          'New',
          `Automated Reassignment: Cycle ${newCycle}. Reclaimed from counselor due to 'Not Interested' status and target date reached.`,
          '00000000-0000-0000-0000-000000000000', // Special identifier for automated tasks
          JSON.stringify({
            reclamation: {
              previousCycle: lead.cycle_number || 1,
              newCycle: newCycle,
              previousAssignee: lead.assigned_to || lead.assigned_to_pro
            },
          }),
        ]
      );

      reclaimedCount++;
    }

    console.log(`[LeadReclaimer] Successfully reclaimed ${reclaimedCount} leads.`);
    return reclaimedCount;
  } catch (error) {
    console.error('[LeadReclaimer] Error during lead reclamation:', error);
    throw error;
  }
};

/**
 * Starts a periodic pulse to check for leads to reclaim.
 * Runs every 24 hours by default.
 */
export const initLeadReclaimer = (intervalMs = 24 * 60 * 60 * 1000) => {
  // Run once on startup after a short delay to ensure DB is connected
  setTimeout(() => {
    reclaimExpiredLeads().catch(console.error);
  }, 10000);

  // Then run periodically
  setInterval(() => {
    reclaimExpiredLeads().catch(console.error);
  }, intervalMs);

  console.log(`[LeadReclaimer] Initialized with interval of ${intervalMs / 3600000} hours.`);
};
