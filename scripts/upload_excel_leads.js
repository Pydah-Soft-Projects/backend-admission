import 'dotenv/config';
import mysql from 'mysql2/promise';
import xlsx from 'xlsx';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Script to upload an Excel file to a temporary table
 * Columns: "student name", "intercollege", "college district", "pincode"
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

/**
 * Opens a Windows File Picker dialog using PowerShell
 */
function openFilePicker() {
  try {
    console.log('Opening file selection dialog...');
    const command = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Excel Files (*.xlsx;*.xls)|*.xlsx;*.xls'; $f.Title = 'Select Excel File to Upload'; $res = $f.ShowDialog(); if($res -eq 'OK') { $f.FileName }"`;
    const result = execSync(command).toString().trim();
    return result || null;
  } catch (err) {
    return null;
  }
}

async function uploadExcel() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    console.log('\n=========================================');
    console.log('   EXCEL UPLOAD TO TEMPORARY TABLE');
    console.log('=========================================\n');
    
    // 1. Ensure table exists with new columns
    console.log('✔ Ensuring temp_excel_leads table exists...');
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS temp_excel_leads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_name VARCHAR(255),
        phone VARCHAR(20),
        district VARCHAR(255),
        mandal VARCHAR(255),
        village VARCHAR(255),
        street VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. File selection
    let filePath = openFilePicker();

    if (!filePath) {
      console.log('No file selected via dialog. Entering manual mode...');
      const filePathRaw = await question('Please enter the path to the Excel file manually: ');
      filePath = filePathRaw.trim().replace(/^& /, '').replace(/^"|"$/g, '');
    }

    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found at path: ${filePath}`);
      return;
    }

    // 3. Parse Excel
    console.log('\nReading Excel file...');
    const workbook = xlsx.readFile(filePath);
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      console.error('Error: The Excel file has no sheets.');
      return;
    }

    let selectedSheetName = sheetNames[0];

    if (sheetNames.length > 1) {
      console.log('\nFound multiple sheets in this file:');
      sheetNames.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));
      const choice = await question(`Select a sheet to upload (1-${sheetNames.length}) [Default: 1]: `);
      const index = parseInt(choice) - 1;
      if (index >= 0 && index < sheetNames.length) {
        selectedSheetName = sheetNames[index];
      }
    }

    console.log(`\nSelected Sheet: "${selectedSheetName}"`);
    const worksheet = workbook.Sheets[selectedSheetName];
    const sheetData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    const headers = sheetData[0];

    if (sheetData.length <= 1) {
      console.log('The Excel file is empty.');
      return;
    }

    console.log(`Found ${sheetData.length - 1} rows in the sheet.`);

    // 4. Process rows and map columns
    const seen = new Set();
    let duplicateCount = 0;

    const rowsToInsert = sheetData.slice(1).map((row) => {
      const getVal = (aliases) => {
        const index = headers.findIndex(h => h && aliases.includes(h.toLowerCase().replace(/[^a-z0-9]/g, '')));
        return index !== -1 ? row[index] : null;
      };

      const name = (getVal(['stuname', 'studentname', 'name', 'student', 'fullname', 'studentfullname', 'full_name', 'student_name']) || '').toString().trim();
      const phone = (getVal(['stumobileno', 'mobileno', 'phone', 'phonenumber', 'studentphone', 'mobile', 'contact_no']) || '').toString().trim();

      // Duplicate detection: Name + Phone
      const duplicateKey = `${name.toLowerCase()}|${phone}`;
      if (seen.has(duplicateKey)) {
        duplicateCount++;
        return null;
      }
      if (name && phone) seen.add(duplicateKey);

      return [
        name,
        phone,
        getVal(['stddistrictname', 'district', 'dist', 'districtname', 'district_name', 'student_district']),
        getVal(['stdmandalname', 'mandal', 'tehsil', 'block', 'mandalname', 'mandal_name']),
        getVal(['villagename', 'village', 'city', 'town', 'vill', 'village_name', 'habitation']),
        getVal(['street', 'address', 'fulladdress', 'full_address', 'streetname', 'street_name', 'location'])
      ];
    });

    const validRows = rowsToInsert.filter(r => r !== null && r[0] && r[1]);
    
    console.log(`\nExcel processing complete.`);
    console.log(`- Rows found: ${sheetData.length - 1}`);
    console.log(`- Duplicates skipped: ${duplicateCount}`);
    console.log(`- Valid unique rows to upload: ${validRows.length}`);
    console.log('Columns mapped: [Student Name], [Phone], [District], [Mandal], [Village], [Street]');

    if (validRows.length === 0) {
      console.error('Error: Could not find any valid data matching expected columns.');
      return;
    }

    // 5. Ask for confirmation and truncation
    const cleanOld = await question('\nDo you want to CLEAR (TRUNCATE) old data in the temp table first? (y/n): ');
    if (cleanOld.toLowerCase() === 'y' || cleanOld.toLowerCase() === 'yes') {
      console.log('Clearing old data...');
      await pool.execute('TRUNCATE TABLE temp_excel_leads');
    }

    const confirm = await question('\nDo you want to proceed and upload this new data? (y/n): ');
    
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      console.log('Upload cancelled by user.');
      return;
    }

    console.log(`Uploading ${validRows.length} unique rows...`);
    const BATCH_SIZE = 5000;
    const insertQuery = 'INSERT INTO temp_excel_leads (student_name, phone, district, mandal, village, street) VALUES ?';
    
    let totalInserted = 0;
    for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
      const chunk = validRows.slice(i, i + BATCH_SIZE);
      const [result] = await pool.query(insertQuery, [chunk]);
      totalInserted += result.affectedRows;
      console.log(`   Progress: Uploaded ${totalInserted} / ${validRows.length} rows...`);
    }

    console.log(`\nSUCCESS! Uploaded ${totalInserted} rows to 'temp_excel_leads'.`);
    
    // Preview
    const [preview] = await pool.execute('SELECT * FROM temp_excel_leads ORDER BY id DESC LIMIT 5');
    console.log('\nPreview of recently uploaded data:');
    console.table(preview);

  } catch (error) {
    console.error('\nAn error occurred:', error.message);
  } finally {
    await pool.end();
    rl.close();
  }
}

uploadExcel();
