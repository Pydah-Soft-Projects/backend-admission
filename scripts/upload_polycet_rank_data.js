import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { getPool } from '../src/config-sql/database.js';
import xlsx from 'xlsx';
import readline from 'readline';
import fs from 'fs';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) =>
  new Promise((resolve) => rl.question(query, resolve));

/**
 * DISTRICT CODE MAPPING
 */
const DISTRICT_CODE_MAP = {
  EG: 'East Godavari',
  WG: 'West Godavari',
  VSP: 'Visakhapatnam',
  SKLM: 'Srikakulam',
  VZM: 'Vizianagaram',
  CTR: 'Chittoor',
  ATP: 'Anantapur',
  KNL: 'Kurnool',
  GTR: 'Guntur',
  KRI: 'Krishna',
  NLR: 'Nellore',
  PKS: 'Prakasam',
  YSR: 'YSR Kadapa',
  AKP: 'Anakapalli',
  ASR: 'Alluri Sitharama Raju',
  KKD: 'Kakinada',
  CSM: 'Konaseema',
  ELR: 'Eluru',
  NTR: 'NTR',
  BPT: 'Bapatla',
  PLN: 'Palnadu',
  PMY: 'Parvathipuram Manyam',
  SSA: 'Sri Sathya Sai',
  TPT: 'Tirupati',
  NDL: 'Nandyal',
  ANM: 'Annamayya',
  MRP: 'Markapuram',
  PLV: 'Polavaram',
  KDP: 'YSR Kadapa',
  BRK: 'Konaseema',
  SKL: 'Srikakulam',
  SSS: 'Sri Sathya Sai',
  MNM: 'Parvathipuram Manyam'
};

/**
 * OPEN WINDOWS FILE PICKER
 */
function openFilePicker() {
  try {
    console.log('Opening file selection dialog...');

    const command = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Excel Files (*.xlsx;*.xls)|*.xlsx;*.xls'; $f.Title = 'Select Excel File'; $res = $f.ShowDialog(); if($res -eq 'OK') { $f.FileName }"`;

    const result = execSync(command).toString().trim();

    return result || null;
  } catch (err) {
    return null;
  }
}

async function uploadPolycetRankData() {
  const pool = getPool();

  try {
    console.log('\n=========================================');
    console.log('     POLYCET RANK DATA UPLOADER');
    console.log('=========================================\n');

    /**
     * INITIALIZE ENQUIRY NUMBER SEQUENTIAL GENERATOR
     * Matches standard bulk upload (ENQ{YY}{6-digit})
     */
    const currentYear = new Date().getFullYear();
    const yearSuffix = String(currentYear).slice(-2);
    const enquiryPrefix = `ENQ${yearSuffix}`;

    console.log('Fetching sequence for enquiry numbers...');
    const [lastLeads] = await pool.execute(
      `SELECT enquiry_number FROM leads 
       WHERE enquiry_number LIKE ? 
       ORDER BY enquiry_number DESC 
       LIMIT 1`,
      [`${enquiryPrefix}%`]
    );

    let currentSequence = 1;
    if (lastLeads.length > 0 && lastLeads[0].enquiry_number) {
      const lastSequence = lastLeads[0].enquiry_number.replace(enquiryPrefix, '');
      const lastNumber = parseInt(lastSequence, 10);
      if (!Number.isNaN(lastNumber)) {
        currentSequence = lastNumber + 1;
      }
    }
    console.log(`Starting sequence: ${enquiryPrefix}${String(currentSequence).padStart(6, '0')}\n`);

    const getNextEnquiryNumber = () => {
      const formattedSequence = String(currentSequence).padStart(6, '0');
      currentSequence += 1;
      return `${enquiryPrefix}${formattedSequence}`;
    };

    /**
     * FILE SELECTION
     */
    let filePath = openFilePicker();

    if (!filePath) {
      console.log('No file selected from dialog.');

      const manualPath = await question(
        'Enter Excel File Path: '
      );

      filePath = manualPath
        .trim()
        .replace(/^& /, '')
        .replace(/^"|"$/g, '');
    }

    if (!fs.existsSync(filePath)) {
      console.error('\nFile not found.');
      return;
    }

    /**
     * READ EXCEL
     */
    console.log('\nReading Excel File...\n');

    const workbook = xlsx.readFile(filePath);

    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      console.log('No sheets found.');
      return;
    }

    let selectedSheet = sheetNames[0];

    if (sheetNames.length > 1) {
      console.log('Available Sheets:\n');

      sheetNames.forEach((sheet, index) => {
        console.log(`${index + 1}. ${sheet}`);
      });

      const selected = await question(
        '\nSelect Sheet Number: '
      );

      const selectedIndex = parseInt(selected) - 1;

      if (
        selectedIndex >= 0 &&
        selectedIndex < sheetNames.length
      ) {
        selectedSheet = sheetNames[selectedIndex];
      }
    }

    console.log(`\nSelected Sheet: ${selectedSheet}`);

    const worksheet = workbook.Sheets[selectedSheet];

    const sheetData = xlsx.utils.sheet_to_json(worksheet, {
      header: 1
    });

    if (sheetData.length <= 1) {
      console.log('Excel sheet is empty.');
      return;
    }

    const headers = sheetData[0];

    console.log('\nDetected Headers:\n');
    console.log(headers.join(', '));

    console.log(`\nTotal Rows Found: ${sheetData.length - 1}`);

    /**
     * FIND COLUMN INDEXES
     */
    const findColumn = (aliases) => {
      return headers.findIndex((header) => {
        if (!header) return false;

        const normalized = header
          .toString()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');

        return aliases.includes(normalized);
      });
    };

    const nameIndex = findColumn([
      'candidatename',
      'studentname',
      'name'
    ]);

    const districtCodeIndex = findColumn([
      'distcode',
      'districtcode',
      'dist'
    ]);

    const phoneIndex = findColumn([
      'phoneno',
      'mobileno',
      'phone',
      'mobile',
      'phonenumber'
    ]);

    const rankIndex = findColumn([
      'rank',
      'polycetrank'
    ]);

    const regionIndex = findColumn([
      'region'
    ]);

    if (
      nameIndex === -1 ||
      districtCodeIndex === -1 ||
      phoneIndex === -1
    ) {
      console.error('\nRequired columns missing.');
      return;
    }

    /**
     * PROCESS ROWS
     */
    console.log('\nProcessing Rows...\n');

    const rowsToInsert = [];

    const unmatchedDistrictCodes = new Set();

    const duplicatePhones = new Set();

    const seenPhones = new Set();

    let skippedRows = 0;

    for (let i = 1; i < sheetData.length; i++) {
      const row = sheetData[i];

      const candidateName = (
        row[nameIndex] || ''
      )
        .toString()
        .trim();

      let districtCode = (
        row[districtCodeIndex] || ''
      )
        .toString()
        .trim();

      if (districtCode.toUpperCase() === 'NULL' || districtCode === '—' || districtCode === '-') {
        districtCode = '';
      } else {
        districtCode = districtCode.toUpperCase();
      }

      const phone = (
        row[phoneIndex] || ''
      )
        .toString()
        .replace(/\D/g, '')
        .slice(-10);

      const rank = parseInt(row[rankIndex]) || null;

      const region = (
        row[regionIndex] || ''
      )
        .toString()
        .trim();

      /**
       * SKIP INVALID ROWS
       */
      if (!candidateName || !phone) {
        skippedRows++;
        continue;
      }

      /**
       * VALIDATE PHONE
       */
      if (phone.length !== 10) {
        skippedRows++;
        continue;
      }

      /**
       * SKIP DUPLICATE PHONES IN SAME FILE
       */
      if (seenPhones.has(phone)) {
        duplicatePhones.add(phone);
        skippedRows++;
        continue;
      }

      seenPhones.add(phone);

      /**
       * MAP DISTRICT CODE
       * If district is null or unmapped, set needsManualUpdate to 1.
       * If mapped successfully, keep needsManualUpdate as 2.
       */
      let districtName = DISTRICT_CODE_MAP[districtCode] || null;
      let needsManualUpdate = 2;

      if (!districtName) {
        needsManualUpdate = 1;
        districtName = districtCode || null;
        if (districtCode) {
          unmatchedDistrictCodes.add(districtCode);
        }
      }

      rowsToInsert.push([
        uuidv4(),
        getNextEnquiryNumber(),
        candidateName,
        phone,
        districtName,
        rank,
        region,
        'Polycet Rank Data',
        'New',
        needsManualUpdate,
        new Date(),
        new Date()
      ]);
    }

    /**
     * SUMMARY
     */
    console.log('\n=========================================');
    console.log('            PROCESS SUMMARY');
    console.log('=========================================');

    console.log(`\nTotal Excel Rows      : ${sheetData.length - 1}`);
    console.log(`Valid Rows            : ${rowsToInsert.length}`);
    console.log(`Skipped Rows          : ${skippedRows}`);
    console.log(`Duplicate Phones      : ${duplicatePhones.size}`);

    if (unmatchedDistrictCodes.size > 0) {
      console.log('\nUnmatched/Missing District Codes (Imported with needs_manual_update = 1):\n');

      console.table(
        Array.from(unmatchedDistrictCodes).map(
          (code) => ({
            district_code: code
          })
        )
      );
    } else {
      console.log('\nAll district codes mapped successfully.');
    }

    /**
     * PREVIEW
     */
    console.log('\nPreview Data:\n');

    console.table(
      rowsToInsert.slice(0, 10).map((row) => ({
        enquiry_number: row[1],
        name: row[2],
        phone: row[3],
        district: row[4],
        rank: row[5],
        source: row[7],
        lead_status: row[8],
        needs_manual_update: row[9]
      }))
    );

    /**
     * CONFIRMATION
     */
    const confirm = await question(
      '\nDo you want to upload these leads? (y/n): '
    );

    if (
      confirm.toLowerCase() !== 'y' &&
      confirm.toLowerCase() !== 'yes'
    ) {
      console.log('\nUpload Cancelled.');
      return;
    }

    /**
     * INSERT IN BATCHES
     */
    console.log('\nStarting Bulk Upload...\n');

    const BATCH_SIZE = 5000;

    const insertQuery = `
      INSERT INTO leads (
        id,
        enquiry_number,
        name,
        phone,
        district,
        \`rank\`,
        dynamic_fields,
        source,
        lead_status,
        needs_manual_update,
        created_at,
        updated_at
      )
      VALUES ?
    `;

    let totalInserted = 0;

    for (
      let i = 0;
      i < rowsToInsert.length;
      i += BATCH_SIZE
    ) {
      const chunk = rowsToInsert.slice(
        i,
        i + BATCH_SIZE
      );

      const values = chunk.map((row) => [
        row[0], // id
        row[1], // enquiry_number
        row[2], // name
        row[3], // phone
        row[4], // district
        row[5], // rank
        JSON.stringify({
          region: row[6]
        }),
        row[7], // source
        row[8], // lead_status
        row[9], // needs_manual_update
        row[10], // created_at
        row[11] // updated_at
      ]);

      const [result] = await pool.query(
        insertQuery,
        [values]
      );

      totalInserted += result.affectedRows;

      console.log(
        `Uploaded ${totalInserted} / ${rowsToInsert.length}`
      );
    }

    console.log('\n=========================================');
    console.log('          UPLOAD SUCCESSFUL');
    console.log('=========================================');

    console.log(`\nTotal Uploaded: ${totalInserted}`);

    /**
     * FINAL PREVIEW
     */
    const [preview] = await pool.execute(`
      SELECT
        enquiry_number,
        name,
        phone,
        district,
        \`rank\`,
        source,
        lead_status,
        needs_manual_update,
        created_at
      FROM leads
      WHERE source = 'Polycet Rank Data'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    console.log('\nRecently Uploaded Leads:\n');

    console.table(preview);

  } catch (error) {
    console.error('\nError Occurred:\n');
    console.error(error.message);
  } finally {
    rl.close();
  }
}

uploadPolycetRankData();