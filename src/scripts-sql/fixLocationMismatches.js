import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { findBestMatch, similarity } from '../utils/fuzzyMatch.util.js';

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

const fixLocationMismatches = async () => {
    let pool;
    try {
        pool = getPool();
        console.log('--- Student Location Auto-Fix Script ---');
        console.log('Target: Student Group "10th", Academic Year 2026, Needs Update = 1\n');

        // 1. Load Master Data
        console.log('Loading master data...');
        const [statesRows] = await pool.execute('SELECT id, name FROM states WHERE is_active = 1');
        const stateIdByName = new Map();
        statesRows.forEach(r => stateIdByName.set(norm(r.name), String(r.id)));

        const [districtsRows] = await pool.execute('SELECT id, state_id, name FROM districts WHERE is_active = 1');
        const districtsByStateId = new Map();
        districtsRows.forEach(r => {
            const sId = String(r.state_id);
            if (!districtsByStateId.has(sId)) districtsByStateId.set(sId, new Map());
            const dMap = districtsByStateId.get(sId);
            const nName = norm(r.name);
            const sName = stripDistrictSuffix(nName) || nName;
            dMap.set(nName, { id: String(r.id), name: r.name });
            if (sName !== nName) dMap.set(sName, { id: String(r.id), name: r.name });
        });

        const [mandalsRows] = await pool.execute('SELECT id, district_id, name FROM mandals WHERE is_active = 1');
        const mandalsByDistrictId = new Map();
        mandalsRows.forEach(r => {
            const dId = String(r.district_id);
            if (!mandalsByDistrictId.has(dId)) mandalsByDistrictId.set(dId, new Map());
            const mMap = mandalsByDistrictId.get(dId);
            const nName = norm(r.name);
            const sName = stripMandalSuffix(nName) || nName;
            mMap.set(nName, { id: String(r.id), name: r.name });
            if (sName !== nName) mMap.set(sName, { id: String(r.id), name: r.name });
        });

        // 2. Query Leads
        console.log('Querying leads needing update...');
        const [leads] = await pool.execute(`
            SELECT id, name, state, district, mandal 
            FROM leads 
            WHERE student_group = '10th' 
              AND academic_year = 2026
              AND needs_manual_update = 1
            ORDER BY created_at DESC
        `);

        console.log(`Analyzing ${leads.length} records logic...\n`);

        let fixCount = 0;
        let skipCount = 0;

        for (const lead of leads) {
            let finalState = lead.state || 'Andhra Pradesh';
            let finalDistrict = lead.district || '';
            let finalMandal = lead.mandal || '';
            let resolved = false;

            const sId = stateIdByName.get(norm(finalState)) 
                      || (norm(finalState) === 'ap' ? stateIdByName.get('andhra pradesh') : null);

            if (sId) {
                const districtMap = districtsByStateId.get(sId);
                const nDist = norm(finalDistrict);
                const sDist = stripDistrictSuffix(nDist) || nDist;
                
                let dMatch = districtMap?.get(nDist) || districtMap?.get(sDist);
                
                // If no exact match, try superNorm
                if (!dMatch && districtMap) {
                    const suDist = superNorm(sDist);
                    for (const [key, value] of districtMap.entries()) {
                        if (superNorm(key) === suDist) {
                            dMatch = value;
                            finalDistrict = dMatch.name;
                            break;
                        }
                    }
                }

                // If still no match, try fuzzy
                if (!dMatch && districtMap) {
                    const candidates = Array.from(districtMap.keys());
                    const best = findBestMatch(sDist, candidates, 0.75);
                    if (best) {
                        dMatch = districtMap.get(best);
                        finalDistrict = dMatch.name;
                    }
                }

                if (dMatch) {
                    const mandalMap = mandalsByDistrictId.get(dMatch.id);
                    const nMandal = norm(finalMandal);
                    const sMandal = stripMandalSuffix(nMandal) || nMandal;
                    const suMandal = superNorm(sMandal);
                    
                    let mMatch = mandalMap?.get(nMandal) || mandalMap?.get(sMandal);
                    
                    // Try superNorm
                    if (!mMatch && mandalMap) {
                        for (const [key, value] of mandalMap.entries()) {
                            if (superNorm(key) === suMandal) {
                                mMatch = value;
                                finalMandal = mMatch.name;
                                break;
                            }
                        }
                    }

                    // Try fuzzy
                    if (!mMatch && mandalMap) {
                        const candidates = Array.from(mandalMap.keys());
                        const best = findBestMatch(sMandal, candidates, 0.75);
                        if (best) {
                            mMatch = mandalMap.get(best);
                            finalMandal = mMatch.name;
                        }
                    }

                    // IF NOT FOUND IN THIS DISTRICT, SEARCH CROSS-DISTRICT (GLOBAL AP SEARCH)
                    if (!mMatch) {
                        for (const [distId, mP] of mandalsByDistrictId.entries()) {
                            if (mP.has(nMandal) || mP.has(sMandal)) {
                                mMatch = mP.get(nMandal) || mP.get(sMandal);
                                break;
                            }
                            for (const [key, value] of mP.entries()) {
                                if (superNorm(key) === suMandal) {
                                    mMatch = value;
                                    break;
                                }
                            }
                            if (mMatch) {
                                // Find district name for this mandal
                                // We need a way to find the district name. We can find it from districtsRows.
                                const [dRows] = await pool.execute('SELECT name FROM districts WHERE id = ?', [mMatch.district_id]);
                                if (dRows.length > 0) {
                                    finalDistrict = dRows[0].name;
                                    finalMandal = mMatch.name;
                                }
                                break;
                            }
                        }
                    }

                    if (mMatch) {
                        resolved = true;
                    }
                }
            }

            if (resolved) {
                // Check if anything actually changed or if it just needed the flag cleared
                const changed = finalDistrict !== lead.district || finalMandal !== lead.mandal;
                
                await pool.execute(
                    'UPDATE leads SET district = ?, mandal = ?, needs_manual_update = 0 WHERE id = ?',
                    [finalDistrict, finalMandal, lead.id]
                );
                
                if (changed) {
                    console.log(`✅ Fixed: ${lead.name} | ${lead.district}->${finalDistrict} | ${lead.mandal}->${finalMandal}`);
                } else {
                    console.log(`✅ Validated: ${lead.name} (Flag cleared)`);
                }
                fixCount++;
            } else {
                skipCount++;
            }
        }

        console.log('\n--- Final Summary ---');
        console.log(`Total Leads Processed: ${leads.length}`);
        console.log(`Leads Auto-Fixed/Validated: ${fixCount}`);
        console.log(`Leads Still Needing Attention: ${skipCount}`);

        await closeDB();
    } catch (error) {
        console.error('Error in fix script:', error);
        if (pool) await closeDB();
    }
};

fixLocationMismatches();
