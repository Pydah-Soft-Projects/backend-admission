import 'dotenv/config';
import mysql from 'mysql2/promise';
import readline from 'readline';

/**
 * Optimized Village Sanitization Script (Kakinada District)
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

// Master list of villages (Kakinada + Peddapuram divisions)
const VILLAGE_MASTER = [
  "Kakinada (Municipal Town)", "Chidiga", "Ganganapalle", "Kovvada", "Kovvuru", "Nemam", "Panduru", "Penumarthi", "Ramanayyapeta", "Repuru", "Sarpavaram", "Suryaraopeta (Part) (Municipal Town)", "Thammavaram", "Thimmapuram", "Toorangi(R)", "Vakalapudi", "Agraharam", "B. Kothuru", "Bhogapuram", "Chitrada", "Fakruddinpalem", "Gokivada", "Govindarajupalem", "Illindarada", "Jagapathirajapuram", "Jalluru", "Jamulapalli", "Kandarada", "Kolanka", "Kumarapuram", "Madhavapuram", "Mallam", "Mangiturthi", "Navakandravada", "Pithapuram (Municipal Town)", "Pro. Donthamuru", "Pro. Rayavaram", "Raparthi", "Somavaram", "Veeraraghavapuram", "Veldurthi", "Virava", "Viravada", "Chebrolu", "Chendurthi", "China Jaggampeta", "Durgada", "Gollaprolu", "Kodavali", "Laxmipuram", "Mallavaram", "Seethanagaram", "Tatiparthi", "Vannepudi", "Vijayanagaram", "Amaravilli", "Aminabada", "Gorsa", "Komaragiri", "Kondevaram", "Kothapalle", "Kutukudumilli", "Mulapeta", "Nagulapalle", "P. Isukapalle", "Ponnada", "Ramanakkapeta", "Subbampeta", "Uppada", "Vakatippa", "Yendapalle", "Aratlakatta", "China Mamidada", "G. Bhavaram", "Gorripudi", "Gurajanapalle", "Karapa", "Kongodu", "Koripalle", "Kurada", "Nadakuduru", "Patharlagadda", "Peddapurappadu", "Penuguduru", "Siripuram", "Vakada", "Velangi", "Vemulavada", "Yandamuru", "Z. Bhavaram", "Atchutapuratrayam", "Chintapalle", "Domada", "G. Mamidada", "Gandredu", "Kaikavolu", "Kandregula", "Karakuduru", "Kumarapriyam", "Pedapudi", "Peddada", "Puttakonda", "Pyna", "Rajupalem", "Sahapuram", "Sampara", "Vendra", "Andrangi", "Aryavatam", "Bandanapudi", "Cheduvada", "Duggudurru", "Gollapalem", "Ithapudi", "Jagannathagiri", "Kajuluru", "Kolanka", "Kuyyeru", "Manjeru", "Mathukumilli", "Pallipalem", "Penumalla", "Seela", "Selapaka", "Tanumalla", "Tarlampudi", "Uppumilli", "Chollangi", "Chollangi Peta", "G. Vemavaram", "Injaram", "Koringa", "Latchipalem", "Neelapalle", "P. Mallavaram", "Patavala", "Pillanka", "Polekurru", "Sunkarapalem", "Uppangala", "Borrampalem", "Gandepalle", "Mallepalle", "Murari", "N.T.Rajapuram", "Nayakampalle", "Pro.Ragampeta", "Singarampalem", "Surampalem", "Talluru", "Uppalapadu", "Yellamilli", "Yerrampalem", "Balabhadrapuram", "Gollalagunta", "Govindapuram", "Gurrappalem", "Irripaka", "J. Kothuru", "Jaggampeta", "Kandregula", "Katravulapalle", "Mallisala", "Mamidada", "Manyanvaripalem", "Marripaka", "Narendrapatnam", "Rajapudi", "Ramavaram", "Seethampeta", "Seethanagaram", "Tirupatirajupeta", "Bhupalapatnam", "Burugupudi", "Chillangi", "Geddanapalle", "Goneda", "Jagapathinagaram", "Kirlampudi", "Krishnavaram", "Mukkollu", "Rajupalem", "Ramakrishnapuram", "S. Thimmapuram", "Somavaram", "Sungarayunipalem", "Thamarada", "Veeravaram", "Velanka", "Allipudi", "Arthamuru", "Bhimavarapukota", "Billananduru", "Bodhavaram", "Darakonda", "Indugapalle", "K. E. Chinnayyapalem", "Kakarapalle", "Kamatam Mallavaram", "Koppaka Agraharam", "Kotananduru", "Kottam", "Lakshmidevipeta", "Surapurajupeta", "T.Jagannadha Nagaram", "Anuru", "Chadalada", "Chandramampalle", "Chinabrahmadevam", "Divili", "G. Ragampeta", "Gorinta", "Gudivada", "J. Thimmapuram", "Kandrakota", "Kattamuru", "Marlava", "Peddapuram (Municipal Town)", "Pulimeru", "Rameswaram", "Rayabhupalapatnam", "Sirivada", "Tatiparthi", "Tirupati", "Ulimeswaram", "Vadlamuru", "Valuthimmapuram", "Arilla Dhara", "Bapannadhara", "Bavuruvaka", "Buradakota", "China Sankarlapudi", "Chintaluru", "Dharmavaram", "Doparthi", "Gajjanapudi", "Girijanapuram", "Gokavaram", "K. Kothapalle", "K. Mirthivada", "Kondapalle", "Kothuru", "Lampakalova", "Mettu Chintha", "P. Jagannadhapuram", "Pandavulapalem", "Peda Sankarlapudi", "Peddipalem", "Podurupaka", "Pothuluru", "Prathipadu", "Rachapalle", "Sarabhavaram", "Seemusuru", "Thaduvai", "Thotakurapalem", "Thotapalle", "U. Jagannadhapuram", "Uligogila", "Uttarakanchi", "Vakapalle", "Vanthada", "Vemulapalem", "Venkatanagaram", "Vommangi", "Yeluru", "Yerakampalem", "A. Mallavaram", "Anantharam", "Balarampuram", "Bapabhupalapatnam", "Billawaka", "Chakirevulapalem", "Challeru", "China Mallapuram", "D. Pydipala", "Dabbadi", "Dhara Jagannadhapuram", "Diguva Darapalle", "Diguva Sivada", "Gangavaram", "Gidajam", "Ginnelaram", "Gummaregula", "Jaldam", "Koduru", "Kondapalem", "Kothuru", "Latchireddipalem", "Meraka Chamavaram", "Mulagapudi", "Namagiri Narendrapatnam", "Pallapu Chamavaram", "Parupaka", "Pedduru", "R. Venkatapuram", "Raghavapatnam", "Rajavaram", "Ramakrishnampuram", "Rowthulapudi", "Santha Pydipala", "Sarlanka", "Satyavada", "Srunga Varam", "Srungadhara Agraharam", "Surampeta", "Tirupatammapeta", "Uppampalem", "Venkatanagaram", "Yeguva Darapalle", "Yeguva Sivada", "Achampeta", "Ammirekhala", "Ankampalem", "Annavaram", "Anumarthi", "Arempudi", "Avelthi", "D.Mallapuram(Achampeta)", "Gondhi", "Gondhi Kothapalli", "Gowrampeta", "Jagannadhapuram", "Jaggampeta", "Kathipudi", "Kondempudi", "Konthangi", "Mandapam", "Masampalli", "Nellipudi", "Ondregula", "Pedamallapuram", "Polavaram", "Rajaram", "Ramannapalem", "Sankhavaram", "Seethayampeta", "Siddivaripalem", "Srungadhara", "Vadrevu Venkatapuram", "Vazrakutam", "Velangi", "Yarakapuram", "A. Kothapalle", "A.V.Nagaram", "Anuru", "Bendapudi", "Gopalapatnam", "Kommanapalle", "Kona Forest", "Krishnapuram", "P. Agraharam", "P.E.Chinnayapalem", "Pydikonda", "Ravikampadu", "Srungavruksham", "Thondangi", "Vemavaram", "Atikivanipalem", "Ch. Agraharam", "Chamavaram", "Chepuru", "D. Polavaram", "Dondavaka", "Hamsavaram", "K.O. Mallavaram", "Kavalapadu", "Kolimeru", "Kothakonda", "Kothuru", "Maruvada", "N. Suravaram", "Nandivampu", "Rapaka", "Rekhavanipalem", "S. Annavaram", "Talluru", "Tetagunta", "Tuni (Municipal Town)", "Valluru", "Bhadravaram", "East Lakshmipuram", "J. Annavaram", "Lakkavaram", "Lingamparthi", "Marriveedu", "Peddanapalle", "Peravaram", "Ramanayyapetta Rur", "Siripuram", "Tirumali", "Yeleswaram", "Yerravaram", "Bhimavaram (Municipal Town)", "Boyanapudi", "G. Medapadu", "Jaggammagaripeta (Part Municipal Town)", "Kapavaram", "Koppavaram", "Madhavapatnam", "Mamilladoddi", "Navara", "P. Vemavaram", "Panasapadu", "Pandravada", "Pavara", "Pedabrahmadevam", "Samalkota (Municipal Town)", "Unduru", "Valluru", "Venkata Krishnarayapura", "Vetlapalem"
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
    console.log('   OPTIMIZED VILLAGE SANITIZATION');
    console.log('=========================================\n');

    // 1. Fetch leads
    const [leads] = await pool.execute(`
      SELECT id, name, village 
      FROM leads 
      WHERE (district LIKE '%Kakinada%' OR mandal IN ('Peddapuram', 'Gandepalli', 'Jaggampeta', 'Kirlampudi', 'Kotananduru', 'Prathipadu', 'Rowtulapudi', 'Shankhavaram', 'Thondangi', 'Tuni', 'Yeleswaram', 'Samalkota'))
      AND village IS NOT NULL 
      AND village != ''
    `);

    if (leads.length === 0) {
      console.log('No leads found.');
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

      let matchedVillage = null;
      for (const masterVillage of sortedMaster) {
        const mvLower = masterVillage.toLowerCase();
        if (lowerAddress.includes(mvLower) && fullAddress !== masterVillage) {
          matchedVillage = masterVillage;
          break;
        }
      }

      if (matchedVillage) {
        updates.push({ id: lead.id, newValue: matchedVillage });
        villageStats[matchedVillage] = (villageStats[matchedVillage] || 0) + 1;
      } else {
        unmatched.push(lead);
      }
    }

    // --- DISPLAY SUMMARY ---
    console.log('--- ANALYSIS SUMMARY ---');
    console.log(`Matches Found:    ${updates.length}`);
    console.log(`No Match Found:   ${unmatched.length}\n`);

    if (updates.length > 0) {
      console.log('--- VILLAGE BREAKDOWN (Top 20) ---');
      console.table(Object.entries(villageStats).sort((a,b) => b[1]-a[1]).slice(0, 20).map(([v, c]) => ({ Village: v, Count: c })));
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
      const confirm = await question(`\nDo you want to update ${updates.length} leads? (y/n): `);
      if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
        shouldApply = true;
      }
    }
    
    if (!shouldApply) return;

    // 3. OPTIMIZED BATCH UPDATE (using CASE statements, no temp tables)
    console.log('\nStarting optimized batch update...');
    const BATCH_SIZE = 500;
    let totalUpdated = 0;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const ids = batch.map(u => pool.escape(u.id)).join(',');
      
      // Build a single query for the batch
      // UPDATE leads SET village = CASE id WHEN 1 THEN 'V1' WHEN 2 THEN 'V2' END WHERE id IN (1, 2)
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
