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
    
    // 1. Ensure table exists with new column
    console.log('✔ Ensuring temp_excel_leads table exists...');
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS temp_excel_leads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_name VARCHAR(255),
        inter_college VARCHAR(255),
        college_district VARCHAR(255),
        pincode VARCHAR(20),
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
    const data = xlsx.utils.sheet_to_json(worksheet);

    if (data.length === 0) {
      console.log('The Excel file is empty.');
      return;
    }

    console.log(`Found ${data.length} rows in the sheet.`);

    // 4. Map columns correctly regardless of order
    const rowsToInsert = data.map(row => {
      const getVal = (possibleNames) => {
        const key = Object.keys(row).find(k => 
          possibleNames.includes(k.toLowerCase().replace(/[\s_]/g, ''))
        );
        return key ? row[key] : null;
      };

      return [
        // Aliases for STUDENT NAME
        getVal(['studentname', 'name', 'student', 'fullname', 'studentfullname', 'full_name', 'student_name']),
        
        // Aliases for INTER COLLEGE
        getVal(['intercollege', 'college', 'inter_college', 'inter_college_name', 'collegename', 'college_name', 'school_college', 'school_or_college']),
        
        // Aliases for COLLEGE DISTRICT
        getVal(['collegedistrict', 'district', 'college_district', 'districtname', 'district_name', 'location_district']),
        
        // Aliases for PINCODE
        getVal(['pincode', 'pin', 'zip', 'zipcode', 'pincode_no', 'postal_code', 'pin_code'])
      ];
    });

    const validRows = rowsToInsert.filter(r => r[0] || r[1] || r[2] || r[3]);

    if (validRows.length === 0) {
      console.error('Error: Could not find any data matching expected columns.');
      return;
    }

    console.log(`\nReady to upload ${validRows.length} rows.`);
    console.log('Columns mapped: [Student Name], [Inter College], [College District], [Pincode]');

    // 5. Ask for confirmation
    const confirm = await question('\nDo you want to proceed and dump this data into the database? (y/n): ');
    
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      console.log('Upload cancelled by user.');
      return;
    }

    console.log('Uploading data...');
    const insertQuery = 'INSERT INTO temp_excel_leads (student_name, inter_college, college_district, pincode) VALUES ?';
    const [result] = await pool.query(insertQuery, [validRows]);

    console.log(`\nSUCCESS! Uploaded ${result.affectedRows} rows to 'temp_excel_leads'.`);
    
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
