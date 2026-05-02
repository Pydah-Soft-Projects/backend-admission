import 'dotenv/config';
import mysql from 'mysql2/promise';
import readline from 'readline';

/**
 * Optimized Village Sanitization Script (Konaseema District)
 * 
 * Logic:
 * 1. Scans leads for address-to-village matches.
 * 2. Optimized Update: Uses Batch CASE statements (no temp tables).
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Master list of villages for Konaseema (Amalapuram + Ramachandrapuram divisions)
const VILLAGE_MASTER = [
  "Ainavilli", "Chintana Lanka", "K. Jagannadhapuram", "Kondukuduru", "Kotipalli Bhaga", "Krapa", "Madupalle", "Magam", "Nedunuru", "Pothukurru", "Sanapalli Lanka", "Sirasavalli Savaram", "Siripalle", "Totharamudi", "Veeravallipalem", "Veluvalapalle", "Vilasa", "Allavaram", "Bendamurulanka", "Bodasakurru", "Devaguptam", "Godi", "Godilanka", "Gudala", "Komaragiripatnam", "Mogallamuru", "Rellugadda", "Samanthakuru", "Tadikona", "Thurupulanka", "Yentrikona", "A. Vemavaram", "Amalapuram (Municipality)", "Amalapuram (Rural)", "Bandarulanka (Pt)", "Bhatnaville", "Edarapalle", "Gunnapalle Agraharam", "Immidivarappadu", "Indupalle", "Janupalle", "Nadipudi", "Nallamille", "Palagummi", "Peruru", "Sakuru", "Samanasa", "Thandavapalle", "Vanne Chintalapudi", "Chiratapudi", "Gangalakurru", "Irusumanda", "Isukapudi", "K. Pedapudi", "Machavaram(U)", "Mosalipalli", "Mukkamala", "Nandampudi", "Pasupalli", "Pulletikurru", "Thondavaram", "Vakkalanka", "G. Vemavaram", "Guthinadeevi", "I. Polavaram", "Kesanakurru", "Komaragiri", "Muralla", "Pasuvullanka", "Patha Injaram", "T. Kothapalle", "Thillakkuppa", "Yedurulanka", "Bantumilli", "Brahmasamedhyam", "Cheyyeru", "Chirrayanam", "Dontikurru", "Geddanapalle", "Kandikuppa", "Katrenikona", "Kundaleswaram", "Lakshmiwada", "Nadavapalle", "Pallamkurru", "Penuwalla", "Uppudi", "Gudapalle", "Gudimellanka", "Kattimanda", "Kesanapalle", "Lakkavaram", "Malikipuram", "Mattaparru", "Ramarajulanka", "Sankaraguptham", "Visweswarayapuram", "Adurru", "Appanapalle", "Botlakurru Doddavaram", "Edarada", "Geddada", "Gogannamatham", "Komarada", "Lutukurru", "Magatapalle", "Makanapalem", "Mamidikuduru", "Mogalikuduru", "Nagaram", "Pasarlapudi", "Pasarlapudilanka", "Pedapatnam", "Pedapatnam Lanka", "Ainapuram", "Ananthavaram", "Annampalle", "Ch. Gunnepalle", "Gadilanka", "Kamini", "Komanapalle", "Kothalanka", "Krapa Chintalapudi", "Mummidivaram", "Tanelanka", "Bellampudi", "Ganti Pedapudi", "Karupallipadu", "Katharlanka", "Kundalapalle", "Lankalagannavaram", "Manepalle", "Mondepu Lanka", "Munganda", "Mungandapalem", "Munjavaram", "Narendrapuram", "Patha Gannavaram", "Pothavaram", "Udumudi", "Vadrevupalle", "Vainateya Kothapalle", "Yenugupalle", "B. Savaram", "Chintalapalle", "Kadali", "Katrenipadu", "Kunavaram", "Mulikipalle", "Podalada", "Ponnamanda", "Razole (Pt)", "Razole Rural", "Sivakodu", "Sompalle", "Tatipaka", "Antarvedi", "Antarvedipalem", "Appanaramuni Lanka", "Gudimula Kandrika", "Kesavadasupalem", "Mori", "Rameswaram", "Sakinetipalle", "Bheemanapalli", "Chinagadavalli", "Gollavilli", "Gopavaram", "Munipalli", "Nangavaram", "Nimmakayala Kothapalli", "Pedagadavilli", "Sannavilli", "Surasaniyanam", "T. Challapalle", "Uppalaguptam", "Vilasavilli", "Addampalle", "Amjuru", "Balantharam", "Bhatla Palika", "Dangeru", "Gangavaram", "Gudigalla", "Gudigalla Bhaga", "Koolla", "Kota", "Kotipalle", "Kudupuru", "Kunduru", "Masakapalle", "Pamarru", "Paningapalle", "Pekeru", "Satyawada", "Sivala", "Sundarapalle", "Thamarapalle", "Vilasa Gangavaram", "Yendagandi", "Yerra Pothavaram", "Angara", "Kaleru", "Kapileswarapuram", "Korumilli", "Machara", "Nalluru", "Nelaturu", "Nidasanametta", "Padamara Khandrika", "Teki", "Thatapudi", "Vadlamuru", "Vakatippa", "Valluru", "Vedurumudi", "Arthamuru", "Chinadevarapudi", "Dwarapudi", "Ippanapadu", "Kesavaram", "Mandapeta (Municipal Town)", "Maredubaka", "Mernipadu", "Palathodu", "Tapeswaram", "Velagathodu", "Vemulapalle @ Seetayyapeta", "Yeditha", "Z.Medapadu", "Ambikapalle Agraharam", "Bheemakrosupalem", "B.Ramannapalem", "Draksharama", "Hasanbada", "Jagannaikulapalem", "Bhupathipalem", "Kapavaram", "Mutchumilli", "Narasapurapupeta", "Chelakaveedhi", "Ramachndrapuram(U) (Municipal Town)", "Cheruvuru", "Thotapeta", "Unduru", "Utrumilli", "Vegayammapeta", "Velampalem", "Vella", "Venkatayapalem", "Yanamadala", "Yerupalle", "Chelluru", "Kurakallapalle", "Kurmapuram", "Lolla", "Machavaram (PT)", "Nadurubada", "Pasalapudi", "Someswaram", "Vedurupaka", "Venturu", "Alamuru", "Baduguvanilanka", "Chintaluru", "Choppela", "Gummileru", "Jonnada", "Kalavacherla", "Madiki", "Modukuru", "Narsipudi", "Navabpeta", "Pedapalle", "Penikeru", "Pinapalle", "Sandhipudi", "Devarapalle", "Gopalapuram", "Ithakota", "Juthigapadu", "Komaraju Lanka", "Lakshmipolavaram", "Mummidivarappadu", "Podagatlapalle", "Ravulapalem", "Ubalanka", "Vedireswaram", "Avidi", "Billa Kurru", "Ganti", "Khandrika", "Kothapeta", "Mandapalli", "Modekurru", "Palivela", "Vadapalem", "Vanapalli", "Ankampalem", "Atreyapuram", "Kattunga", "Merlapalem", "Narkedimilli", "Peravaram", "Pulidindi", "Rajavaram", "Ryali", "Utchili", "Vadapalle", "Vaddiparru", "Valicheru", "Vasanthawada"
];

async function sanitizeVillages() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    console.log('\n=========================================');
    console.log('   KONASEEMA VILLAGE SANITIZATION');
    console.log('=========================================\n');

    // 1. Fetch leads from Konaseema district or matching mandals
    console.log('Fetching leads from Konaseema area...');
    const [leads] = await pool.execute(`
      SELECT id, name, village 
      FROM leads 
      WHERE (district LIKE '%Konaseema%' OR mandal IN ('Ainavilli', 'Allavaram', 'Amalapuram', 'Ambajipeta', 'I. Polavaram', 'Katrenikona', 'Malkipuram', 'Mamidikuduru', 'Mummidivaram', 'P.Gannavaram', 'Razole', 'Sakhinetipalli', 'Uppalaguptam', 'K Gangavaram', 'Kapileswarapuram', 'Mandapeta', 'Ramachandrapuram', 'Rayavaram', 'Alamuru', 'Ravulapalem', 'Kothapeta', 'Atreyapuram'))
      AND village IS NOT NULL 
      AND village != ''
    `);

    if (leads.length === 0) {
      console.log('No leads found for the specified district/mandals.');
      return;
    }

    console.log(`Analyzing ${leads.length} leads...\n`);

    const updates = [];
    const unmatched = [];
    const villageStats = {};

    const sortedMaster = [...VILLAGE_MASTER].sort((a, b) => b.length - a.length);

    for (const lead of leads) {
      const fullAddress = (lead.village || '').trim();
      const lowerAddress = fullAddress.toLowerCase();
      
      // Normalize address for better matching: remove dots and spaces
      const normalizedAddress = lowerAddress.replace(/[\.\s]/g, '');

      let matchedVillage = null;
      for (const masterVillage of sortedMaster) {
        const mvLower = masterVillage.toLowerCase();
        const normalizedMaster = mvLower.replace(/[\.\s]/g, '');
        
        // Check if normalized master exists in normalized address
        if (normalizedAddress.includes(normalizedMaster) && fullAddress !== masterVillage) {
          matchedVillage = masterVillage;
          break;
        }

        // Special handling for common misspellings/variations
        if (masterVillage === 'Thillakkuppa' && normalizedAddress.includes('tillakuppa')) {
          matchedVillage = masterVillage;
          break;
        }
        if (masterVillage === 'I. Polavaram' && normalizedAddress.includes('ipolavaram')) {
          matchedVillage = masterVillage;
          break;
        }
      }

      if (matchedVillage) {
        updates.push({ id: lead.id, name: lead.name, oldValue: fullAddress, newValue: matchedVillage });
        villageStats[matchedVillage] = (villageStats[matchedVillage] || 0) + 1;
      } else {
        unmatched.push(lead);
      }
    }

    // --- DISPLAY SUMMARY ---
    console.log('--- ANALYSIS SUMMARY ---');
    console.log(`Total Leads Scanned:      ${leads.length}`);
    console.log(`Matches Found (Ready):    ${updates.length}`);
    console.log(`No Match Found:           ${unmatched.length}\n`);

    if (updates.length > 0) {
      console.log('--- VILLAGE BREAKDOWN (Top 20) ---');
      console.table(Object.entries(villageStats).sort((a,b) => b[1]-a[1]).slice(0, 20).map(([v, c]) => ({ Village: v, Count: c })));

      console.log('\n--- SAMPLE OF PROPOSED CHANGES ---');
      console.table(updates.slice(0, 15).map(u => ({
        'Lead Name': u.name,
        'Original Address': u.oldValue.length > 40 ? u.oldValue.substring(0, 37) + '...' : u.oldValue,
        'Clean Village': u.newValue
      })));
    }

    if (unmatched.length > 0) {
      console.log('\n--- EXAMPLES OF UNMATCHED ADDRESSES ---');
      unmatched.slice(0, 10).forEach(u => console.log(` • ${u.village}`));
    }

    // 2. Parameter Handling
    const isDryRun = process.argv.includes('--dry-run');
    const isApply = process.argv.includes('--apply');

    if (isDryRun || updates.length === 0) {
      if (isDryRun) console.log('\n[DRY RUN] Finished.');
      return;
    }

    let shouldApply = false;
    if (isApply) {
      shouldApply = true;
    } else {
      const confirm = await question(`\nDo you want to apply these ${updates.length} village name updates? (y/n): `);
      if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
        shouldApply = true;
      }
    }
    
    if (!shouldApply) return;

    // 3. OPTIMIZED BATCH UPDATE
    console.log('\nStarting optimized batch update...');
    const BATCH_SIZE = 500;
    let totalUpdated = 0;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const ids = batch.map(u => pool.escape(u.id)).join(',');
      const cases = batch.map(u => `WHEN ${pool.escape(u.id)} THEN ${pool.escape(u.newValue)}`).join(' ');
      
      const query = `
        UPDATE leads 
        SET village = CASE id ${cases} END, 
            updated_at = NOW() 
        WHERE id IN (${ids})
      `;

      await pool.execute(query);
      totalUpdated += batch.length;
      process.stdout.write(`\rProgress: ${totalUpdated} / ${updates.length} leads updated...`);
    }

    console.log(`\n\nSUCCESS! All ${totalUpdated} leads updated.`);

  } catch (error) {
    console.error('\nAn error occurred:', error.message);
  } finally {
    await pool.end();
    rl.close();
  }
}

sanitizeVillages();
