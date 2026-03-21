import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

/**
 * Normalization function used by the system.
 */
const norm = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+/g, ' ').toLowerCase());
const superNorm = (s) => norm(s).replace(/[^a-z0-9]/g, '');

const TARGET_GROUP_PARAM = process.argv[2] || '10th';
const TARGET_YEAR = parseInt(process.argv[3]) || 2026;

async function deleteDuplicates() {
    let pool;
    try {
        pool = getPool();
        
        let groups = [TARGET_GROUP_PARAM];
        if (TARGET_GROUP_PARAM.toLowerCase() === 'inter') {
            groups = ['Inter', 'inter-bipc', 'inter-mpc', 'INTER-BIPC', 'INTER-MPC', 'INTER-MEC'];
        }

        console.log(`--- STARTING DUPLICATE CLEANUP (${groups.join(', ')}, ${TARGET_YEAR}) ---`);

        // 1. Fetch all leads for the target parameters
        const [leads] = await pool.execute(`
            SELECT id, name, phone, father_phone, alternate_mobile, lead_status, created_at, updated_at, enquiry_number
            FROM leads
            WHERE student_group IN (${groups.map(() => '?').join(',')}) AND academic_year = ?
        `, [...groups, TARGET_YEAR]);

        console.log(`Found ${leads.length} total leads.`);

        // 2. Group by super-normalized name first
        const nameGroups = new Map();
        for (const lead of leads) {
            const sn = superNorm(lead.name);
            if (!nameGroups.has(sn)) nameGroups.set(sn, []);
            nameGroups.get(sn).push(lead);
        }

        let totalDeleted = 0;
        let skippedRisk = 0;

        // 3. Process each name group
        for (const [nameKey, groupLeads] of nameGroups.entries()) {
            if (groupLeads.length < 2) continue;

            // Sort group by updated_at DESC so we always compare against the most recent
            groupLeads.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at));

            for (let i = 0; i < groupLeads.length; i++) {
                for (let j = i + 1; j < groupLeads.length; j++) {
                    const l1 = groupLeads[i]; // Most recent candidate
                    const l2 = groupLeads[j]; // Potential to-delete candidate

                    const p1 = new Set([l1.phone, l1.father_phone, l1.alternate_mobile].filter(p => p && p.trim().length >= 5));
                    const p2 = new Set([l2.phone, l2.father_phone, l2.alternate_mobile].filter(p => p && p.trim().length >= 5));

                    let hasOverlap = false;
                    for (const num of p1) {
                        if (p2.has(num)) {
                            hasOverlap = true;
                            break;
                        }
                    }

                    if (hasOverlap) {
                        // Priority: Keep l1 (because it's more recently updated)
                        // But wait, what if l2 is NOT 'New'? 
                        // If l1 is 'New' but l2 is 'Interested', we should keep l2 even if l1 is technically "updated" more recently (e.g. system update).
                        
                        let keep = l1;
                        let toDelete = l2;

                        // Check if l2 has a more advanced status than l1
                        if (l1.lead_status?.toLowerCase() === 'new' && l2.lead_status?.toLowerCase() !== 'new') {
                             keep = l2;
                             toDelete = l1;
                        }

                        console.log(`\nDuplicate Found: "${keep.name}"`);
                        
                        // Condition: Can only delete if the record is in 'New' status OR if both are identical status and we keep the newer one.
                        if (toDelete.lead_status?.toLowerCase() === 'new' || (keep.lead_status !== 'New' && toDelete.lead_status !== 'New' && new Date(keep.updated_at) > new Date(toDelete.updated_at))) {
                            
                            console.log(`KEEPING: [${keep.enquiry_number}] ${keep.name} (Status: ${keep.lead_status}, Updated: ${new Date(keep.updated_at).toLocaleString()})`);
                            console.log(`DELETING: [${toDelete.enquiry_number}] ${toDelete.name} (Status: ${toDelete.lead_status}, Updated: ${new Date(toDelete.updated_at).toLocaleString()})`);
                            
                            await pool.execute('DELETE FROM leads WHERE id = ?', [toDelete.id]);
                            totalDeleted++;
                            
                            // Remove deleted lead from group
                            groupLeads.splice(groupLeads.indexOf(toDelete), 1);
                            if (toDelete === l1) { i--; break; } // If we deleted l1, restart outer loop for this index
                            else { j--; } // If we deleted l2, continue checking l1 against the next j
                        } else {
                            console.log(`SKIPPING (Manual Check Needed): "${keep.name}" vs "${toDelete.name}" - Both have different statuses or complex history.`);
                            skippedRisk++;
                        }
                    }
                }
            }
        }

        console.log('\n--- CLEANUP COMPLETE ---');
        console.log(`Total Exact Duplicates Deleted: ${totalDeleted}`);
        console.log(`Total Duplicates Skipped (Non-'New' status): ${skippedRisk}`);

    } catch (error) {
        console.error('Error during cleanup:', error);
    } finally {
        if (pool) await closeDB();
    }
}

deleteDuplicates();
