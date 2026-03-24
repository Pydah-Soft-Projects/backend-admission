import dotenv from 'dotenv';
import pLimit from 'p-limit';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const norm = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+/g, ' ').toLowerCase());
const superNorm = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const stripSuffix = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(dist(rict)?|dt\.?|mandal|mndl\.?|mnd\.?)\s*$/i, '').trim());
const esc = (s) => (s == null ? '' : String(s).replace(/'/g, "''"));

const TARGET_GROUP_PARAM = process.argv[2] || '10th';
const TARGET_YEAR = parseInt(process.argv[3]) || 2026;
const APPLY_CHANGES = process.argv.includes('--apply');
const DRY_RUN = !APPLY_CHANGES;

const BATCH_SIZE = 5000;
const UPDATE_CHUNK = 1000;
const CONCURRENCY = 50;

async function mapLocations() {
  let pool;
  try {
    pool = getPool();

    let groups = [TARGET_GROUP_PARAM];
    if (TARGET_GROUP_PARAM.toLowerCase() === 'inter') {
      groups = ['Inter', 'inter-bipc', 'inter-mpc', 'INTER-BIPC', 'INTER-MPC', 'INTER-MEC'];
    }

    console.log(`--- PRODUCTION LOCATION MAPPING (Dry Run: ${DRY_RUN}) ---`);
    console.log(`Target: ${groups.join(', ')}, Year: ${TARGET_YEAR}`);

    const [states] = await pool.execute('SELECT id FROM states WHERE name = "Andhra Pradesh" LIMIT 1');
    const AP_STATE_ID = states[0].id;

    const [districtsRows] = await pool.execute(
      'SELECT id, name FROM districts WHERE state_id = ? AND is_active = 1',
      [AP_STATE_ID]
    );

    const districtMap = new Map();
    const districtNameToId = new Map();
    const districtIdToName = new Map();

    // Define special aliases for common variations
    const DISTRICT_ALIASES = {
      'drbrambedkarkonaseema': 'Konaseema',
      'ambedkarkonaseema': 'Konaseema',
      'ysr': 'YSR Kadapa',
      'kadapa': 'YSR Kadapa',
      'ysrkadapa': 'YSR Kadapa'
    };

    const MANDAL_ALIASES = {
      'kakinada': {
        'kakinada': 'Kakinada Urban',
        'samalkot': 'Samalkota',
        'samalkota': 'Samalkota',
        'gandepalli': 'Gandepalle',
        'gandepalle': 'Gandepalle',
        'pedapudi': 'Pedapudi',
        'pedadapudi': 'Pedapudi'
      },
      'konaseema': {
        'mandapet': 'Mandapeta',
        'mandapeta': 'Mandapeta',
        'ipolavaram': 'I. Polavaram',
        'polavaram': 'I. Polavaram',
        'alamuru': 'Alumuru',
        'alumuru': 'Alumuru',
        'sakhinetipalli': 'Sakhinetipalle',
        'malkipuram': 'Malikipuram'
      },
      'east godavari': {
        'biccavole': 'Biccavolu',
        'biccavolu': 'Biccavolu'
      },
      'ysr kadapa': {
        'vempalli': 'Vempalle',
        'pulivendula': 'Pulivendla',
        'proddatur': 'Proddutur'
      }
    };

    districtsRows.forEach(r => {
      const id = String(r.id);
      const name = r.name;
      const n = norm(name);
      const sn = superNorm(name);
      const stripped = norm(stripSuffix(n));

      districtMap.set(n, name);
      districtMap.set(sn, name);
      if (stripped.length > 3) districtMap.set(stripped, name);

      // Add District Aliases
      for (const [alias, target] of Object.entries(DISTRICT_ALIASES)) {
          if (superNorm(target) === sn) {
              districtMap.set(alias, name);
              districtNameToId.set(alias, id);
          }
      }

      districtNameToId.set(n, id);
      districtNameToId.set(sn, id);
      districtIdToName.set(id, name);
    });

    const sortedDistrictKeys = Array.from(districtMap.keys()).sort((a, b) => b.length - a.length);

    const districtIds = districtsRows.map(r => String(r.id));
    const [mandalsRows] = await pool.query(
      `SELECT id, district_id, name FROM mandals WHERE district_id IN (${districtIds.map(() => '?').join(',')}) AND is_active = 1`,
      districtIds
    );

    const mandalsByDistrict = new Map();
    const mandalKeysByDistrict = new Map();

    mandalsRows.forEach(r => {
      const dId = String(r.district_id);
      if (!mandalsByDistrict.has(dId)) mandalsByDistrict.set(dId, new Map());

      const mMap = mandalsByDistrict.get(dId);
      const name = r.name;
      const n = norm(name);
      const sn = superNorm(name);
      const stripped = norm(stripSuffix(n));

      mMap.set(n, name);
      mMap.set(sn, name);
      if (stripped.length > 3) mMap.set(stripped, name);

      // Add aliases
      const dName = districtIdToName.get(dId);
      const dNorm = norm(dName);
      if (MANDAL_ALIASES[dNorm]) {
          for (const [alias, target] of Object.entries(MANDAL_ALIASES[dNorm])) {
              if (target === name) {
                  mMap.set(norm(alias), name);
                  mMap.set(superNorm(alias), name);
              }
          }
      }
    });

    for (const [dId, mMap] of mandalsByDistrict.entries()) {
      mandalKeysByDistrict.set(dId, Array.from(mMap.keys()).sort((a, b) => {
          if (a.length !== b.length) return b.length - a.length;
          const aIsKakinada = a.includes('kakinada');
          const bIsKakinada = b.includes('kakinada');
          if (aIsKakinada && !bIsKakinada) return 1;
          if (!aIsKakinada && bIsKakinada) return -1;
          return 0;
      }));
    }

    let lastId = '';
    let processed = 0;
    let totalMatchedDist = 0;
    let totalMatchedMandal = 0;
    let totalResolved = 0;
    let noMatchFound = 0;
    const unresolvedSample = [];

    const limit = pLimit(CONCURRENCY);
    const startTime = Date.now();

    while (true) {
      const [leads] = await pool.query(
        `SELECT id, enquiry_number, name, village, mandal, district
         FROM leads
         WHERE student_group IN (${groups.map(() => '?').join(',')})
           AND academic_year = ?
           AND needs_manual_update = 1
           AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
        [...groups, TARGET_YEAR, lastId, BATCH_SIZE]
      );

      if (leads.length === 0) break;
      lastId = leads[leads.length - 1].id;

      const updatesByChunk = [];

      await Promise.all(
        leads.map(lead => limit(async () => {
          let updatedDistrict = null;
          let updatedMandal = null;

          const villageText = lead.village || '';
          const mandalText = lead.mandal || '';
          const combinedText = `${villageText} ${mandalText}`.trim();
          const sSearchText = superNorm(combinedText);

          // 1. Resolve District
          const currentDistNorm = norm(lead.district);
          const currentDistSN = superNorm(lead.district);
          const isDistCorrect = districtMap.has(currentDistNorm) || districtMap.has(currentDistSN);
          let activeDistrictName = isDistCorrect ? lead.district : null;

          // If current district is an alias, set to canonical name
          if (isDistCorrect) {
              const canonical = districtMap.get(currentDistNorm) || districtMap.get(currentDistSN);
              if (canonical !== lead.district) {
                  updatedDistrict = canonical;
                  activeDistrictName = canonical;
              }
          }

          // Scan text for better/different district
          for (const key of sortedDistrictKeys) {
            if (key.length >= 3 && sSearchText.includes(key)) {
              const found = districtMap.get(key);
              if (!activeDistrictName || found !== activeDistrictName) {
                  updatedDistrict = found;
                  activeDistrictName = found;
              }
              break;
            }
          }

          // 2. Resolve Mandal
          const dId = districtNameToId.get(norm(activeDistrictName)) || districtNameToId.get(superNorm(activeDistrictName));
          let finalMandalName = lead.mandal;

          if (dId && mandalsByDistrict.has(dId)) {
            const mMap = mandalsByDistrict.get(dId);
            const keys = mandalKeysByDistrict.get(dId);
            const isMandalCorrect = mMap.has(norm(lead.mandal)) || mMap.has(superNorm(lead.mandal));

            if (!isMandalCorrect || lead.mandal === 'Not Provided' || lead.mandal === '' || lead.mandal === '—') {
              for (const key of keys) {
                if (key.length > 3 && sSearchText.includes(key)) {
                  const found = mMap.get(key);
                  // Special Rule: Kakinada twice
                  if (found.toLowerCase().includes('kakinada')) {
                      const kakinadaCount = (sSearchText.match(/kakinada/g) || []).length;
                      if (kakinadaCount < 2) continue;
                  }
                  updatedMandal = found;
                  finalMandalName = found;
                  break;
                }
              }
            }
          }

          if (updatedDistrict || updatedMandal) {
            if (updatedDistrict) totalMatchedDist++;
            if (updatedMandal) totalMatchedMandal++;

            // Status Check
            const dNorm = norm(activeDistrictName);
            const mNorm = norm(finalMandalName);
            const checkDistId = districtNameToId.get(dNorm) || districtNameToId.get(superNorm(activeDistrictName));
            const isResolved = checkDistId && mandalsByDistrict.has(checkDistId) && (mandalsByDistrict.get(checkDistId).has(mNorm) || mandalsByDistrict.get(checkDistId).has(superNorm(mNorm)));

            if (isResolved) totalResolved++;

            updatesByChunk.push({
              id: lead.id,
              district: updatedDistrict || lead.district,
              mandal: updatedMandal || lead.mandal,
              isResolved
            });
          } else {
              noMatchFound++;
              // Collect a small sample of unresolved cases
              if (unresolvedSample.length < 50) {
                  unresolvedSample.push({
                      enq: lead.enquiry_number,
                      name: lead.name,
                      text: combinedText,
                      current: `${lead.district} / ${lead.mandal}`
                  });
              }
          }
        }))
      );

      if (!DRY_RUN && updatesByChunk.length > 0) {
        for (let i = 0; i < updatesByChunk.length; i += UPDATE_CHUNK) {
          const chunk = updatesByChunk.slice(i, i + UPDATE_CHUNK);
          const idList = chunk.map(u => `'${u.id}'`).join(',');
          const districtCase = chunk.map(u => `WHEN '${u.id}' THEN '${esc(u.district)}'`).join(' ');
          const mandalCase = chunk.map(u => `WHEN '${u.id}' THEN '${esc(u.mandal)}'`).join(' ');
          const resolveCase = chunk.map(u => `WHEN '${u.id}' THEN ${u.isResolved ? 0 : 1}`).join(' ');

          await pool.query(`
            UPDATE leads
            SET 
              district = CASE id ${districtCase} END,
              mandal = CASE id ${mandalCase} END,
              needs_manual_update = CASE id ${resolveCase} END,
              updated_at = NOW()
            WHERE id IN (${idList})
          `);
        }
      }

      processed += leads.length;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = (processed / elapsed).toFixed(1);
      console.log(`Processed: ${processed} (${speed} leads/sec)`);
    }

    console.log('\n--- LOCATION MAPPING SUMMARY ---');
    console.log(`Total Leads Processed:     ${processed}`);
    console.log(`New Districts Mapped:      ${totalMatchedDist}`);
    console.log(`New Mandals Mapped:        ${totalMatchedMandal}`);
    console.log(`Leads Fully Resolved:      ${totalResolved}`);
    console.log(`Still Unresolved:          ${noMatchFound}`);

    if (unresolvedSample.length > 0) {
        console.log('\n--- SAMPLE OF UNRESOLVED CASES (FIRST 50) ---');
        unresolvedSample.forEach((s, idx) => {
            console.log(`${idx + 1}. [${s.enq}] ${s.name} | Text: "${s.text}" | Current: ${s.current}`);
        });
    }
    console.log('--- COMPLETED ---');

  } catch (err) {
    console.error(err);
  } finally {
    if (pool) await closeDB();
  }
}

mapLocations();