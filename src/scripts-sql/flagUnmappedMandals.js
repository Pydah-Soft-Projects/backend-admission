import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { findBestMatch, similarity } from '../utils/fuzzyMatch.util.js';
import pLimit from 'p-limit';

dotenv.config();

/**
 * Normalization function used by the system.
 */
const norm = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+/g, ' ').toLowerCase());

/**
 * Punctuation-agnostic normalization for deep comparison.
 */
const superNorm = (s) => norm(s).replace(/[^a-z0-9]/g, '');

const stripDistrictSuffix = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(dist(rict)?|dt\.?)\s*$/i, '').trim());
const stripMandalSuffix = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(mandal|mandalam|mndl\.?)\s*$/i, '').trim());

const flagUnmappedMandals = async () => {
    let pool;
    try {
        // Parse Command Line Arguments
        const args = process.argv.slice(2);
        const isDryRun = args.includes('--dry-run') || args.includes('-d');
        
        let studentGroup = '10th';
        let academicYear = 2026;
        let targetDistrict = null;

        args.forEach(arg => {
            if (arg.startsWith('--group=')) studentGroup = arg.split('=')[1];
            if (arg.startsWith('--year=')) academicYear = parseInt(arg.split('=')[1], 10);
            if (arg.startsWith('--district=')) targetDistrict = arg.split('=')[1];
        });

        pool = getPool();
        console.log(`--- Student Location Flagging Script ${isDryRun ? '(DRY RUN)' : ''} ---`);
        console.log(`Target: District "${targetDistrict || 'ALL'}", Group "${studentGroup}", Year ${academicYear}\n`);

        // 1. Load Master Data
        console.log('Loading master data...');
        const [statesRows] = await pool.execute('SELECT id, name FROM states WHERE is_active = 1');
        const stateIdByName = new Map();
        statesRows.forEach(r => stateIdByName.set(norm(r.name), String(r.id)));

        const [districtsRows] = await pool.execute('SELECT id, state_id, name FROM districts WHERE is_active = 1');
        const districtsByStateId = new Map();
        const districtNameById = new Map(); // Cache for cross-district matching
        districtsRows.forEach(r => {
            const sId = String(r.state_id);
            if (!districtsByStateId.has(sId)) districtsByStateId.set(sId, new Map());
            const dMap = districtsByStateId.get(sId);
            const nName = norm(r.name);
            const sName = stripDistrictSuffix(nName) || nName;
            dMap.set(nName, { id: String(r.id), name: r.name });
            if (sName !== nName) dMap.set(sName, { id: String(r.id), name: r.name });
            districtNameById.set(String(r.id), r.name);
        });

        const [mandalsRows] = await pool.execute('SELECT id, district_id, name FROM mandals WHERE is_active = 1');
        const mandalsByDistrictId = new Map();
        mandalsRows.forEach(r => {
            const dId = String(r.district_id);
            if (!mandalsByDistrictId.has(dId)) mandalsByDistrictId.set(dId, new Map());
            const mMap = mandalsByDistrictId.get(dId);
            const nName = norm(r.name);
            const sName = stripMandalSuffix(nName) || nName;
            const entry = { id: String(r.id), district_id: dId, name: r.name };
            mMap.set(nName, entry);
            if (sName !== nName) mMap.set(sName, entry);
        });

        // 2. Query ALL leads for this group/district (not just those flagged)
        console.log('Querying leads for analysis...');
        const queryParams = [academicYear];
        let mainQuery = `
            SELECT id, name, state, district, mandal, needs_manual_update 
            FROM leads 
            WHERE academic_year = ?
        `;
        
        if (studentGroup !== 'ALL') {
            mainQuery += ' AND student_group = ?';
            queryParams.push(studentGroup);
        }

        if (targetDistrict) {
            mainQuery += ' AND district = ?';
            queryParams.push(targetDistrict);
        }
        mainQuery += ' ORDER BY created_at DESC';

        const [leads] = await pool.execute(mainQuery, queryParams);

        console.log(`Analyzing ${leads.length} leads...\n`);

        let clearedCount = 0;
        let flaggedCount = 0;
        let skipCount = 0;
        
        const clearedByDistrict = new Map();
        const flaggedByDistrict = new Map();
        
        const limit = pLimit(20); // Process up to 20 updates concurrently
        let processedCount = 0;
        const totalLeads = leads.length;
        const updatePromises = [];

        for (const lead of leads) {
            processedCount++;
            if (processedCount % 500 === 0 || processedCount === totalLeads) {
                console.log(`Processing progress: ${processedCount}/${totalLeads} leads analyzed...`);
            }

            let finalState = lead.state || 'Andhra Pradesh';
            let finalDistrict = lead.district || '';
            let finalMandal = lead.mandal || '';
            let isMapped = false;
            
            const originalDistrictNormalized = finalDistrict; // capture for counting

            const sId = stateIdByName.get(norm(finalState)) 
                      || (norm(finalState) === 'ap' ? stateIdByName.get('andhra pradesh') : null);

            if (sId) {
                const districtMap = districtsByStateId.get(sId);
                const nDist = norm(finalDistrict);
                const sDist = stripDistrictSuffix(nDist) || nDist;
                
                let dMatch = districtMap?.get(nDist) || districtMap?.get(sDist);
                
                // SuperNorm matching for district
                if (!dMatch && districtMap) {
                    const suDist = superNorm(sDist);
                    for (const [key, value] of districtMap.entries()) {
                        if (superNorm(key) === suDist) {
                            dMatch = value;
                            break;
                        }
                    }
                }

                if (dMatch) {
                    finalDistrict = dMatch.name; // Use master data name (correct casing)
                    const mandalMap = mandalsByDistrictId.get(dMatch.id);
                    const nMandal = norm(finalMandal);
                    const sMandal = stripMandalSuffix(nMandal) || nMandal;
                    const suMandal = superNorm(sMandal);
                    
                    let mMatch = mandalMap?.get(nMandal) || mandalMap?.get(sMandal);
                    
                    // Try superNorm for mandal
                    if (!mMatch && mandalMap) {
                        for (const [key, value] of mandalMap.entries()) {
                            if (superNorm(key) === suMandal) {
                                mMatch = value;
                                break;
                            }
                        }
                    }

                    // Try fuzzy for mandal (high confidence threshold)
                    if (!mMatch && mandalMap) {
                        const candidates = Array.from(mandalMap.keys());
                        const best = findBestMatch(sMandal, candidates, 0.80);
                        if (best) {
                            mMatch = mandalMap.get(best);
                        }
                    }

                    // SEARCH CROSS-DISTRICT (GLOBAL STATE SEARCH)
                    if (!mMatch) {
                        for (const [distId, mP] of mandalsByDistrictId.entries()) {
                            let potentialMatch = mP.get(nMandal) || mP.get(sMandal);
                            
                            if (potentialMatch) {
                                // Find district name from cache instead of DB query
                                const dName = districtNameById.get(String(potentialMatch.district_id));
                                if (dName) {
                                    mMatch = potentialMatch;
                                    finalDistrict = dName;
                                    finalMandal = mMatch.name;
                                    break;
                                }
                            }
                        }
                    }

                    if (mMatch) {
                        finalMandal = mMatch.name; // Use master data name (correct casing)
                        isMapped = true;
                    }
                }
            }

            // Decide if we should perform an update
            const newStatus = isMapped ? 0 : 2;
            const casingChanged = isMapped && (finalDistrict !== lead.district || finalMandal !== lead.mandal);
            const statusChanged = lead.needs_manual_update !== newStatus;
            
            if (casingChanged || statusChanged) {
                if (!isDryRun) {
                    updatePromises.push(limit(async () => {
                        if (isMapped) {
                            await pool.execute(
                                'UPDATE leads SET district = ?, mandal = ?, needs_manual_update = 0 WHERE id = ?',
                                [finalDistrict, finalMandal, lead.id]
                            );
                        } else {
                            await pool.execute(
                                'UPDATE leads SET needs_manual_update = 2 WHERE id = ?',
                                [lead.id]
                            );
                        }
                    }));
                }
                
                const prefix = isDryRun ? '[DRY RUN] ' : '✅ ';
                const distKey = originalDistrictNormalized || 'Unknown';

                if (newStatus === 2) {
                    if (isDryRun) {
                        // Optional: only log if we are curious, but avoid 184k lines!
                        // console.log(`${prefix}FLAGGED: ${lead.name} | District: ${lead.district} | Mandal: ${lead.mandal} (Status -> 2)`);
                    }
                    flaggedCount++;
                    flaggedByDistrict.set(distKey, (flaggedByDistrict.get(distKey) || 0) + 1);
                } else {
                    const label = casingChanged ? 'SYNCED' : 'CLEARED';
                    console.log(`${prefix}${label}: ${lead.name} | District: ${lead.district}->${finalDistrict} | Mandal: ${lead.mandal}->${finalMandal} (Status -> 0)`);
                    clearedCount++;
                    clearedByDistrict.set(distKey, (clearedByDistrict.get(distKey) || 0) + 1);
                }
            } else {
                skipCount++;
            }
        }

        // Wait for all non-dry-run updates to complete
        if (updatePromises.length > 0) {
            console.log(`Waiting for ${updatePromises.length} database updates to complete...`);
            await Promise.all(updatePromises);
            console.log('All database updates finished.');
        }

        console.log(`\n--- Final Summary ${isDryRun ? '(DRY RUN)' : ''} ---`);
        console.log(`Total Leads Analyzed: ${leads.length}`);
        console.log(`Leads That Can Be Cleared (Status 0): ${clearedCount}`);
        console.log(`Leads That Are Broken (Status 2): ${flaggedCount}`);
        console.log(`Leads Already Correct (Skipped): ${skipCount}`);

        if (clearedCount > 0) {
            console.log('\n--- Breakdown: Cleared (Potential Status 0) per District ---');
            for (const [dist, count] of clearedByDistrict.entries()) {
                console.log(`${dist.padEnd(25)}: ${count}`);
            }
        }

        console.log('\n--- Breakdown: Broken (Potential Status 2) per District (Top 20) ---');
        const sortedFlagged = Array.from(flaggedByDistrict.entries()).sort((a,b) => b[1] - a[1]);
        sortedFlagged.slice(0, 20).forEach(([dist, count]) => {
            console.log(`${dist.padEnd(25)}: ${count}`);
        });

        await closeDB();
    } catch (error) {
        console.error('Error in flagging script:', error);
        if (pool) await closeDB();
    }
};

flagUnmappedMandals();
