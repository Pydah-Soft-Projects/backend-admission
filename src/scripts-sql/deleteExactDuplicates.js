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

        console.log(`--- STARTING OPTIMIZED DUPLICATE CLEANUP (${groups.join(', ')}, ${TARGET_YEAR}) ---`);

        // 1. Find names that have at least one potential duplicate in SQL
        // This avoids loading hundreds of thousands of unique records.
        console.log('Identifying potential duplicate candidates by name...');
        const [candidates] = await pool.execute(`
            SELECT name
            FROM leads
            WHERE student_group IN (${groups.map(() => '?').join(',')}) AND academic_year = ?
            GROUP BY name
            HAVING COUNT(*) > 1
        `, [...groups, TARGET_YEAR]);

        console.log(`Found ${candidates.length} names with potential duplicates.`);

        if (candidates.length === 0) {
            console.log('No potential duplicates found based on name.');
            return;
        }

        let totalDeleted = 0;
        let skippedRisk = 0;
        let processedNames = 0;

        // 2. Process candidates in batches of 100 names to keep memory low
        const BATCH_SIZE = 100;
        for (let k = 0; k < candidates.length; k += BATCH_SIZE) {
            const batchNames = candidates.slice(k, k + BATCH_SIZE).map(c => c.name);
            
            // Fetch full lead records for this batch of names
            const [leads] = await pool.execute(`
                SELECT id, name, phone, father_phone, alternate_mobile, lead_status, created_at, updated_at, enquiry_number
                FROM leads
                WHERE name IN (${batchNames.map(() => '?').join(',')})
                AND student_group IN (${groups.map(() => '?').join(',')})
                AND academic_year = ?
            `, [...batchNames, ...groups, TARGET_YEAR]);

            // 3. Group by super-normalized name
            const nameGroups = new Map();
            for (const lead of leads) {
                const sn = superNorm(lead.name);
                if (!nameGroups.has(sn)) nameGroups.set(sn, []);
                nameGroups.get(sn).push(lead);
            }

            // 4. Process each group
            for (const [nameKey, groupLeads] of nameGroups.entries()) {
                if (groupLeads.length < 2) continue;

                // Sort group by updated_at DESC (recent first)
                groupLeads.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at));

                for (let i = 0; i < groupLeads.length; i++) {
                    for (let j = i + 1; j < groupLeads.length; j++) {
                        const l1 = groupLeads[i]; 
                        const l2 = groupLeads[j]; 

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
                            let keep = l1;
                            let toDelete = l2;

                            if (l1.lead_status?.toLowerCase() === 'new' && l2.lead_status?.toLowerCase() !== 'new') {
                                 keep = l2;
                                 toDelete = l1;
                            }

                            // Condition: Delete if 'New' OR if matching non-'New' where we keep the newer one
                            if (toDelete.lead_status?.toLowerCase() === 'new' || 
                                (keep.lead_status !== 'New' && toDelete.lead_status !== 'New' && new Date(keep.updated_at) > new Date(toDelete.updated_at))) {
                                
                                await pool.execute('DELETE FROM leads WHERE id = ?', [toDelete.id]);
                                totalDeleted++;
                                
                                // Remove deleted lead from group
                                groupLeads.splice(groupLeads.indexOf(toDelete), 1);
                                if (toDelete === l1) { i--; break; } else { j--; }
                            } else {
                                skippedRisk++;
                            }
                        }
                    }
                }
            }

            processedNames += batchNames.length;
            if (processedNames % 500 === 0 || processedNames === candidates.length) {
                console.log(`Progress: Processed ${processedNames}/${candidates.length} name candidates...`);
            }
        }

        console.log('\n--- CLEANUP COMPLETE ---');
        console.log(`Total Exact Duplicates Deleted: ${totalDeleted}`);
        console.log(`Total Duplicates Skipped (Non-'New' status/Manual only): ${skippedRisk}`);

    } catch (error) {
        console.error('Error during cleanup:', error);
    } finally {
        if (pool) await closeDB();
    }
}

deleteDuplicates();
