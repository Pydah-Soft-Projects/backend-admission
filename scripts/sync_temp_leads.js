import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { getPool } from '../src/config-sql/database.js';
import PQueue from 'p-queue';
import readline from 'readline';

const question = (query) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
};

/**
 * Optimized Sync Script with Master Data Validation
 */

const DRY_RUN = !process.argv.includes('--commit');
const CONCURRENCY = 20; // Number of parallel DB writes

const queue = new PQueue({ concurrency: CONCURRENCY });

/**
 * Helper: Levenshtein Distance for Fuzzy Matching
 */
function getLevenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
      else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Finds the best match in a map using fuzzy logic
 */
function findBestMatch(input, masterMap, threshold = 4) {
  let bestMatch = null;
  let minDistance = threshold + 1;
  
  // Smart Aliases (e.g., Rajahmundry -> Rajamahendravaram)
  let processedInput = input.toLowerCase().trim();
  if (processedInput.includes('rajahmundry')) {
    processedInput = processedInput.replace('rajahmundry', 'rajamahendravaram');
  }

  const cleanInput = processedInput.replace(/[^a-z0-9]/g, '');

  for (const [key, value] of masterMap.entries()) {
    const cleanKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Exact or substring match after cleaning
    if (cleanKey.includes(cleanInput) || cleanInput.includes(cleanKey)) {
      return value;
    }

    const distance = getLevenshteinDistance(processedInput, key);
    if (distance < minDistance) {
      minDistance = distance;
      bestMatch = value;
    }
  }
  return bestMatch;
}

/**
 * Helper: Convert to Title Case (Proper Casing)
 */
/**
 * Helper: Convert to Title Case (Proper Casing)
 * Handles "B.KOTHAKOTA" -> "B.Kothakota"
 */
function toTitleCase(str) {
  return str.toLowerCase().replace(/(^|\s|-|\.)\S/g, (s) => s.toUpperCase());
}

async function syncLeadsWithMasterData() {
  const pool = getPool();

  try {
    // ... existing initialization code ...
    console.log('\n=========================================');
    console.log(`   SYNC: TEMP -> MAIN LEADS ${DRY_RUN ? '(DRY RUN)' : '(COMMIT MODE)'}`);
    if (DRY_RUN) console.log('[INFO] No database changes will be made.');
    else console.log('[WARNING] Database updates are being applied!');
    console.log('=========================================\n');

    // Step 1: Load Master Data
    console.log('Step 1: Loading Master Data (Districts & Mandals)...');
    const [distRows] = await pool.execute('SELECT id, name FROM districts WHERE is_active = 1');
    const [mandalRows] = await pool.execute('SELECT id, district_id, name FROM mandals WHERE is_active = 1');

    const districtMap = new Map();
    distRows.forEach(d => districtMap.set(d.name.toLowerCase().trim(), { id: d.id, name: d.name }));

    const mandalLookup = new Map();
    mandalRows.forEach(m => {
      if (!mandalLookup.has(m.district_id)) mandalLookup.set(m.district_id, new Map());
      mandalLookup.get(m.district_id).set(m.name.toLowerCase().trim(), m.name);
    });

    console.log(`Loaded ${districtMap.size} districts and ${mandalRows.length} mandals.\n`);

    // Step 2: Selection
    const [[{ total: totalGlobal }]] = await pool.execute('SELECT COUNT(*) as total FROM temp_excel_leads');
    const [tempDistRows] = await pool.execute('SELECT DISTINCT district FROM temp_excel_leads WHERE district IS NOT NULL AND district != ""');
    const availableDistricts = tempDistRows.map(r => r.district);

    console.log(`\nTotal Records in Temp Table: ${totalGlobal}`);
    console.log('Available Districts in Excel:');
    availableDistricts.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
    console.log(`  ${availableDistricts.length + 1}. -- SYNC ALL DISTRICTS --`);

    const selection = await question(`\nSelect a district to sync (1-${availableDistricts.length + 1}): `);
    const selectedIdx = parseInt(selection) - 1;
    
    let districtFilter = '';
    let selectedDistrictId = null;

    if (selectedIdx >= 0 && selectedIdx < availableDistricts.length) {
      const name = availableDistricts[selectedIdx];
      districtFilter = `AND t.district = ${pool.escape(name)}`;
      
      // Try strict match first, then fuzzy match to find the ID
      let masterDist = districtMap.get(name.toLowerCase().trim());
      if (!masterDist) masterDist = findBestMatch(name, districtMap, 2);
      
      if (masterDist) {
        selectedDistrictId = masterDist.id;
        console.log(`\n[FILTER] Mapping to Master District: ${masterDist.name} (ID: ${selectedDistrictId})`);
      }
    }

    const [[{ total: totalInTemp }]] = await pool.execute(`SELECT COUNT(*) as total FROM temp_excel_leads t WHERE 1=1 ${districtFilter}`);
    
    // Step 2.5: Sync Mode Selection
    console.log('\nSync Modes:');
    console.log('  1. FULL SYNC: Update District, Mandal, Village, and Address');
    console.log('  2. ONLY HOUSE NUMBERS: Update only the Address field (Door No + Street)');
    
    const syncModeChoice = await question('\nSelect sync mode (1-2) [Default: 1]: ');
    const syncMode = syncModeChoice === '2' ? 'hno' : 'full';
    console.log(`\n[MODE] ${syncMode === 'hno' ? 'Updating only House Numbers/Address' : 'Performing Full Data Sync'}`);

    const results = [];
    const unmappedLeads = [];
    let updatedCount = 0;
    let actualChanges = 0;

    // Step 3: Fast Path for "Only House Numbers" (Bulk Update with Progress)
    if (syncMode === 'hno' && !DRY_RUN) {
      console.log('\nStep 3: Performing Chunked Bulk Update for House Numbers...');
      
      const [[{ maxId }]] = await pool.execute('SELECT MAX(id) as maxId FROM temp_excel_leads');
      const CHUNK_SIZE = 10000;
      let totalAffected = 0;

      for (let i = 0; i <= maxId; i += CHUNK_SIZE) {
        const bulkUpdateQuery = `
          UPDATE leads l
          INNER JOIN temp_excel_leads t ON 
            l.name = t.student_name AND l.phone = t.phone
          SET l.address = CONCAT_WS(', ', NULLIF(TRIM(t.house_no), ''), NULLIF(TRIM(t.street), '')),
              l.updated_at = NOW()
          WHERE t.id BETWEEN ${i} AND ${i + CHUNK_SIZE - 1} ${districtFilter}
        `;
        
        const [result] = await pool.execute(bulkUpdateQuery);
        totalAffected += result.affectedRows;
        
        const progress = Math.min(100, Math.round((i + CHUNK_SIZE) / maxId * 100));
        process.stdout.write(`   Progress: ${progress}% | Processed IDs up to ${i + CHUNK_SIZE} | Updates: ${totalAffected}\r`);
      }

      console.log(`\n\n✔ BULK UPDATE SUCCESSFUL!`);
      console.log(`- Total Records Updated: ${totalAffected}`);
      console.log('\nSync operation complete.');
      return;
    }

    // Step 4: Processing matches (Loop for Full Sync or Dry Run)
    console.log(`\nStep 3: Processing matches (${syncMode === 'hno' ? 'Dry Run Preview' : 'Mapping Full Data'})...`);
    const [matches] = await pool.execute(`
      SELECT 
        l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone, 
        l.district AS old_district, l.mandal AS old_mandal, l.village AS old_village, l.address AS old_address, l.needs_manual_update, 
        t.district AS excel_district, t.mandal AS excel_mandal, t.village AS excel_village, t.street AS excel_street, t.house_no AS excel_hno
      FROM leads l
      INNER JOIN temp_excel_leads t ON (LOWER(TRIM(l.name)) COLLATE utf8mb4_general_ci) = (LOWER(TRIM(t.student_name)) COLLATE utf8mb4_general_ci) AND (TRIM(l.phone) COLLATE utf8mb4_general_ci) = (TRIM(t.phone) COLLATE utf8mb4_general_ci)
      WHERE 1=1 ${districtFilter}
    `);

    for (const row of matches) {
      const excelDist = (row.excel_district || '').toLowerCase().trim();
      const excelMandal = (row.excel_mandal || '').toLowerCase().trim();
      let finalDistrict = row.excel_district;
      let finalMandal = row.excel_mandal;
      let masterMatched = false;
      let isFuzzy = false;

      let masterDist = districtMap.get(excelDist);
      if (!masterDist && excelDist) masterDist = findBestMatch(excelDist, districtMap, 2);
      if (masterDist) {
        finalDistrict = masterDist.name;
        const districtMandals = mandalLookup.get(masterDist.id);
        if (districtMandals) {
          let masterMandal = districtMandals.get(excelMandal);
          if (!masterMandal && excelMandal) masterMandal = findBestMatch(excelMandal, districtMandals, 3);
          if (masterMandal) { finalMandal = masterMandal; masterMatched = true; }
        }
      }

      let newFlag = masterMatched ? 0 : 2;
      
      let hasChanged = false;
      let finalAddress = row.excel_street || '';

      if (syncMode === 'hno') {
        // Construct address: "Door No, Street" or just Door No or just Street
        const parts = [row.excel_hno, row.excel_street].filter(p => p && p.trim().length > 0);
        finalAddress = parts.join(', ').trim();
        
        hasChanged = row.old_address !== finalAddress;
        // In hno mode, we don't care about district/mandal flags
        newFlag = row.needs_manual_update; 
      } else {
        hasChanged = row.old_district !== finalDistrict || row.old_mandal !== finalMandal || row.old_village !== row.excel_village || row.old_address !== row.excel_street || row.needs_manual_update !== newFlag;
      }
      
      if (hasChanged) actualChanges++;

      const matchType = syncMode === 'hno' ? '✔ NAME+PHONE' : (masterMatched ? (isFuzzy ? '⚠ FUZZY' : '✔ EXACT') : '❌ NONE');
      
      const record = {
        'Student Name': row.lead_name,
        'Old Value': syncMode === 'hno' ? (row.old_address || '(empty)') : `${row.old_district}, ${row.old_mandal}`,
        'New Value': syncMode === 'hno' ? finalAddress : `${finalDistrict}, ${finalMandal}`,
        'Match': matchType,
        'Sync?': hasChanged ? 'UPDATE' : 'SKIP'
      };

      results.push(record);
      if (!masterMatched) unmappedLeads.push(record);

      if (!DRY_RUN && hasChanged) {
        queue.add(async () => {
          if (syncMode === 'hno') {
            await pool.execute(`UPDATE leads SET address=?, updated_at=NOW() WHERE id=?`, [finalAddress, row.lead_id]);
          } else {
            await pool.execute(`UPDATE leads SET district=?, mandal=?, village=?, address=?, needs_manual_update=?, updated_at=NOW() WHERE id=?`, [finalDistrict, finalMandal, row.excel_village, finalAddress, newFlag, row.lead_id]);
          }
          updatedCount++;
          if (updatedCount % 500 === 0) console.log(`   Progress: Updated ${updatedCount} leads...`);
        });
      } else {
        updatedCount++;
      }
    }

    if (!DRY_RUN) await queue.onIdle();

    console.log('\nPreview of Matched Rows:');
    console.table(results.slice(0, 20));

    if (unmappedLeads.length > 0) {
      console.log(`\n❌ ${unmappedLeads.length} LEADS UNMAPPED`);
      const uniqueUnmappedMandals = [...new Set(unmappedLeads.map(l => l['Mandal (New)']))].sort();
      console.log('\n🔍 UNIQUE MISSING MANDALS:');
      uniqueUnmappedMandals.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

      if (selectedDistrictId) {
        const create = await question(`\nDo you want to CREATE these ${uniqueUnmappedMandals.length} mandals in Master Data for the selected district now? (y/n): `);
        if (create.toLowerCase() === 'y') {
          console.log('Creating mandals...');
          const crypto = await import('crypto');
          for (const m of uniqueUnmappedMandals) {
            const properName = toTitleCase(m);
            const id = crypto.randomUUID();
            await pool.execute('INSERT INTO mandals (id, district_id, name, is_active) VALUES (?, ?, ?, 1)', [id, selectedDistrictId, properName]);
            console.log(`   + Created: ${properName} (ID: ${id})`);
          }
          console.log('Master Data updated. You can run the sync again to clear the flags.');
        }
      }
    }

    const notFoundInLeads = totalInTemp - updatedCount;

    console.log('\n' + '='.repeat(60));
    console.log(`   SYNC COMPLETE ${DRY_RUN ? '(SIMULATED)' : ''}`);
    console.log('='.repeat(60));
    console.log(`Total in Excel:      ${totalInTemp}`);
    console.log(`Matched in Leads:    ${updatedCount}`);
    console.log(`Not Found in Leads:  ${notFoundInLeads}`);
    console.log(`Fuzzy/Exact Matches: ${updatedCount - unmappedLeads.length}`);
    console.log(`UNMAPPED (Flag 2):   ${unmappedLeads.length}`);
    console.log(`Rows to be Updated:  ${actualChanges}`);
    console.log('='.repeat(60));
    if (DRY_RUN) console.log('NOTE: Dry Run only. Use --commit to apply.');
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\nError:', error.message);
  }
}

syncLeadsWithMasterData();
