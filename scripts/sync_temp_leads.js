import 'dotenv/config';
import mysql from 'mysql2/promise';

/**
 * Optimized Sync Script
 * 
 * Logic:
 * 1. Uses a JOIN to find all matches in one go (High Performance)
 * 2. Displays [Old Value] -> [New Value]
 * 3. Updates the main leads table
 */

async function syncLeadsOptimized() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    console.log('\n=========================================');
    console.log('   OPTIMIZED SYNC: TEMP -> MAIN LEADS');
    console.log('=========================================\n');

    console.log('Step 1: Finding all matches and preparing data...');

    // The JOIN is much faster than individual SELECTs in a loop
    const [matches] = await pool.execute(`
      SELECT 
        l.id AS lead_id, 
        l.name AS lead_name, 
        l.inter_college AS old_inter_college,
        t.inter_college AS excel_college,
        t.college_district AS excel_district,
        t.pincode AS excel_pincode
      FROM leads l
      INNER JOIN temp_excel_leads t ON LOWER(TRIM(l.name)) = LOWER(TRIM(t.student_name)) COLLATE utf8mb4_unicode_ci
    `);

    if (matches.length === 0) {
      console.log('No matches found between temporary table and main leads table.');
      return;
    }

    console.log(`Found ${matches.length} matching leads. Starting updates...\n`);

    let updatedCount = 0;

    for (const row of matches) {
      // Prepare new string
      const parts = [];
      if (row.excel_college) parts.push(row.excel_college.trim());
      if (row.excel_district) parts.push(row.excel_district.trim());
      if (row.excel_pincode) parts.push(row.excel_pincode.trim());
      const newString = parts.join(' | ');

      const oldVal = row.old_inter_college || '(empty)';

      // Perform update
      await pool.execute(
        'UPDATE leads SET inter_college = ?, updated_at = NOW() WHERE id = ?',
        [newString, row.lead_id]
      );

      console.log(`[UPDATED] ${row.lead_name.padEnd(25)} | Old: ${oldVal.padEnd(20)} -> New: ${newString}`);
      updatedCount++;
    }

    console.log('\n' + '='.repeat(60));
    console.log('                SYNC COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total Matches Found:   ${matches.length}`);
    console.log(`Leads Updated:         ${updatedCount}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\nAn error occurred during sync:', error.message);
  } finally {
    await pool.end();
  }
}

syncLeadsOptimized();
