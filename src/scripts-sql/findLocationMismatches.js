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

const stripDistrictSuffix = (s) => {
    if (!s || typeof s !== 'string') return s || '';
    return s.replace(/\s+(dist(rict)?|dt\.?)\s*$/i, '').trim();
};

const stripMandalSuffix = (s) => {
    if (!s || typeof s !== 'string') return s || '';
    return s.replace(/\s+(mandal|mandalam|mndl\.?)\s*$/i, '').trim();
};

const findLocationMismatches = async () => {
    let pool;
    try {
        pool = getPool();
        console.log('--- Student Location Mismatch Analysis ---');
        console.log('Target: Student Group "10th", Academic Year 2026');
        console.log('Limit: First 250 records\n');

        // 1. Load Master Data
        console.log('Loading master data...');
        const [statesRows] = await pool.execute('SELECT id, name FROM states WHERE is_active = 1');
        const stateMap = new Map(); // id -> name
        const stateIdByName = new Map(); // normalized name -> id
        statesRows.forEach(r => {
            stateMap.set(String(r.id), r.name);
            stateIdByName.set(norm(r.name), String(r.id));
        });

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

        // 2. Query Leads (Specifically those flagged for manual update)
        console.log('Querying leads with "Needs Update" tag...');
        const [leads] = await pool.execute(`
            SELECT id, name, state, district, mandal, needs_manual_update 
            FROM leads 
            WHERE student_group = '10th' 
              AND academic_year = 2026
              AND needs_manual_update = 1
            ORDER BY created_at DESC
        `);

        console.log(`Analyzing ${leads.length} records...\n`);

        const mismatches = [];
        let totalChecked = 0;

        for (const lead of leads) {
            totalChecked++;
            let reason = null;
            let suggestion = null;
            let field = null;
            let expectedValue = null;

            const lState = lead.state || 'Andhra Pradesh';
            const sId = stateIdByName.get(norm(lState)) 
                      || (norm(lState) === 'ap' ? stateIdByName.get('andhra pradesh') : null);

            if (!sId) {
                reason = `State "${lState}" not found in master data`;
                field = 'state';
            } else {
                const districtMap = districtsByStateId.get(sId);
                const lDist = lead.district || '';
                const nDist = norm(lDist);
                const sDist = stripDistrictSuffix(nDist) || nDist;
                
                const dMatch = districtMap?.get(nDist) || districtMap?.get(sDist);
                
                if (!dMatch) {
                    field = 'district';
                    const candidates = Array.from(districtMap?.keys() || []);
                    const best = findBestMatch(sDist, candidates, 0.70); // Lowered slightly for discovery
                    if (best) {
                        const match = districtMap.get(best);
                        suggestion = match.name;
                        const score = similarity(sDist, best);
                        reason = `District "${lDist}" mismatch. Best guess: "${suggestion}" (${Math.round(score*100)}% match)`;
                    } else {
                        reason = `District "${lDist}" not found (no close match)`;
                    }
                } else {
                    const mandalMap = mandalsByDistrictId.get(dMatch.id);
                    const lMandal = lead.mandal || '';
                    const nMandal = norm(lMandal);
                    const sMandal = stripMandalSuffix(nMandal) || nMandal;
                    
                    const mMatch = mandalMap?.get(nMandal) || mandalMap?.get(sMandal);
                    
                    if (!mMatch) {
                        field = 'mandal';
                        const candidates = Array.from(mandalMap?.keys() || []);
                        const best = findBestMatch(sMandal, candidates, 0.70);
                        if (best) {
                            const match = mandalMap.get(best);
                            suggestion = match.name;
                            const score = similarity(sMandal, best);
                            
                            // Check for punctuation/spacing issues specifically
                            const sNormInput = superNorm(sMandal);
                            const sNormBest = superNorm(best);
                            if (sNormInput === sNormBest) {
                                reason = `Mandal "${lMandal}" mismatch due to spacing/punctuation. Correct master value: "${suggestion}"`;
                            } else {
                                reason = `Mandal "${lMandal}" mismatch. Best guess: "${suggestion}" (${Math.round(score*100)}% match)`;
                            }
                        } else {
                            reason = `Mandal "${lMandal}" not found (no close match)`;
                        }
                    }
                }
            }

            if (reason) {
                mismatches.push({
                    id: lead.id,
                    name: lead.name,
                    state: lead.state,
                    district: lead.district,
                    mandal: lead.mandal,
                    reason,
                    field
                });
            }
        }

        // 3. Print Results
        if (mismatches.length === 0) {
            console.log('✅ Success: All 250 students are correctly mapped!');
        } else {
            console.log(`❌ Found ${mismatches.length} mismatches out of ${totalChecked} checked.\n`);
            
            console.log('Sample Mismatches (First 50):');
            console.log(''.padEnd(120, '-'));
            console.log(`${'Student Name'.padEnd(25)} | ${'Field'.padEnd(10)} | ${'Current Value'.padEnd(20)} | ${'Reason/Suggestion'}`);
            console.log(''.padEnd(120, '-'));
            
            mismatches.slice(0, 50).forEach(m => {
                const currentVal = m[m.field] || 'N/A';
                console.log(`${m.name.slice(0, 24).padEnd(25)} | ${m.field.padEnd(10)} | ${currentVal.slice(0, 19).padEnd(20)} | ${m.reason}`);
            });
            
            if (mismatches.length > 50) {
                console.log(`\n... and ${mismatches.length - 50} more mismatches.`);
            }

            console.log('\nSummary by Field:');
            const fieldCounts = mismatches.reduce((acc, m) => {
                acc[m.field] = (acc[m.field] || 0) + 1;
                return acc;
            }, {});
            console.table(fieldCounts);
        }

        await closeDB();
    } catch (error) {
        console.error('Error in analysis script:', error);
        if (pool) await closeDB();
    }
};

findLocationMismatches();
