import { getPool } from '../config-sql/database.js';
import { resolveLeadStatus } from '../utils/leadChannelStatus.util.js';
import dotenv from 'dotenv';

dotenv.config();

async function rectifyData() {
  let pool;
  try {
    pool = getPool();
    const isDryRun = process.argv.includes('--dry-run');
    if (isDryRun) {
      console.log('DRY RUN MODE ENABLED: No changes will be persisted to the database.\n');
    }

    // 1. Fetch leads that are currently 'Assigned' but have some activity in call/visit channels
    const [leads] = await pool.execute(
      `SELECT id, name, lead_status, call_status, visit_status 
       FROM leads 
       WHERE lead_status = 'Assigned' 
         AND (
           (call_status IS NOT NULL AND call_status NOT IN ('Assigned', 'New', ''))
           OR
           (visit_status IS NOT NULL AND visit_status NOT IN ('Assigned', 'New', ''))
         )`
    );

    console.log(`Found ${leads.length} leads to evaluate.`);

    let updatedCount = 0;
    for (const lead of leads) {
      const resolved = resolveLeadStatus('Assigned', lead.call_status, lead.visit_status);
      
      if (resolved !== 'Assigned') {
        if (!isDryRun) {
          await pool.execute(
            'UPDATE leads SET lead_status = ?, updated_at = NOW() WHERE id = ?',
            [resolved, lead.id]
          );
        }
        console.log(`[${isDryRun ? 'DRY RUN' : 'UPDATE'}] Lead ${lead.id} (${lead.name}): Assigned -> ${resolved}`);
        updatedCount++;
      }
    }

    console.log('\n--- Rectification Process Complete ---');
    console.log(`${isDryRun ? 'Potential' : 'Actual'} updates: ${updatedCount}`);
    process.exit(0);
  } catch (error) {
    console.error('Error during rectification:', error);
    process.exit(1);
  }
}

rectifyData();
