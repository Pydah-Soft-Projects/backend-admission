import dotenv from 'dotenv';
import path from 'path';
import mysql from 'mysql2/promise';
import mongoose from 'mongoose';

dotenv.config({ path: path.join(process.cwd(), '.env') });

async function inspectStudent() {
  console.log('================================================================');
  console.log('SEARCHING ALL DATABASES FOR: BANNU ROYALS (20260003 / ENQ26949623)');
  console.log('================================================================\n');

  const ADM_NO = '20260003';
  const NAME_PATTERN = '%BANNU%';
  const ENQ = 'ENQ26949623';

  // ----------------------------------------------------------------
  // 1. Primary MySQL DB (joinings, admissions, fee_requests, leads)
  // ----------------------------------------------------------------
  try {
    const pool = await mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'admission_db',
      port: Number(process.env.DB_PORT || 3306),
    });

    console.log('--- 1. Primary MySQL Database ---');

    // Joinings table
    const [joinings] = await pool.execute(
      `SELECT id, student_name, student_gender, course, lead_data 
       FROM joinings 
       WHERE student_name LIKE ? OR lead_data LIKE ? OR lead_data LIKE ?`,
      [NAME_PATTERN, `%${ADM_NO}%`, `%${ENQ}%`]
    );
    console.log(`\n[joinings table] Found ${joinings.length} matching rows:`);
    for (const j of joinings) {
      let ld = {};
      try { ld = typeof j.lead_data === 'string' ? JSON.parse(j.lead_data) : (j.lead_data || {}); } catch {}
      const extras = ld._joiningRegistrationExtras || {};
      console.log(`  Joining ID: ${j.id}`);
      console.log(`  Student Name: ${j.student_name}`);
      console.log(`  Registration Extras Keys:`, Object.keys(extras));
      console.log(`  transport_details:`, JSON.stringify(extras.transport_details || ld.transport_details || null, null, 2));
    }

    // Admissions table
    const [admissions] = await pool.execute(
      `SELECT id, student_name, registration_form_data 
       FROM admissions 
       WHERE student_name LIKE ? OR registration_form_data LIKE ? OR registration_form_data LIKE ?`,
      [NAME_PATTERN, `%${ADM_NO}%`, `%${ENQ}%`]
    );
    console.log(`\n[admissions table] Found ${admissions.length} matching rows:`);
    for (const a of admissions) {
      let rfd = {};
      try { rfd = typeof a.registration_form_data === 'string' ? JSON.parse(a.registration_form_data) : (a.registration_form_data || {}); } catch {}
      console.log(`  Admission ID: ${a.id}`);
      console.log(`  Student Name: ${a.student_name}`);
      console.log(`  transport_details:`, JSON.stringify(rfd.transport_details || null, null, 2));
    }

    // Fee requests table
    const [feeRequests] = await pool.execute(
      `SELECT id, joining_id, student_fee_details, transport_details, status 
       FROM fee_requests 
       WHERE student_fee_details LIKE ? OR transport_details LIKE ? OR joining_id IN (
         SELECT id FROM joinings WHERE student_name LIKE ? OR lead_data LIKE ?
       )`,
      [`%${ADM_NO}%`, `%${ADM_NO}%`, NAME_PATTERN, `%${ADM_NO}%`]
    );
    console.log(`\n[fee_requests table] Found ${feeRequests.length} matching rows:`);
    for (const f of feeRequests) {
      console.log(`  Fee Request ID: ${f.id} (Status: ${f.status}, Joining: ${f.joining_id})`);
      let td = f.transport_details;
      try { if (typeof td === 'string') td = JSON.parse(td); } catch {}
      console.log(`  transport_details:`, JSON.stringify(td || null, null, 2));
    }

    await pool.end();
  } catch (err) {
    console.error('Primary MySQL Error:', err.message);
  }

  // ----------------------------------------------------------------
  // 2. Secondary MySQL DB (transport_requests)
  // ----------------------------------------------------------------
  try {
    const secPool = await mysql.createPool({
      host: process.env.SECONDARY_DB_HOST || process.env.DB_HOST || 'localhost',
      user: process.env.SECONDARY_DB_USER || process.env.DB_USER || 'root',
      password: process.env.SECONDARY_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.SECONDARY_DB_NAME || 'student_database',
      port: Number(process.env.SECONDARY_DB_PORT || process.env.DB_PORT || 3306),
    });

    console.log('\n--- 2. Secondary MySQL Database ---');
    const [trRows] = await secPool.execute(
      `SELECT * FROM transport_requests 
       WHERE admission_number = ? OR student_name LIKE ?`,
      [ADM_NO, NAME_PATTERN]
    );
    console.log(`\n[secondary.transport_requests table] Found ${trRows.length} matching rows:`);
    for (const r of trRows) {
      console.log(`  ID: ${r.id} | AdmNo: ${r.admission_number} | Name: ${r.student_name}`);
      console.log(`  Route: ${r.route_name} (${r.route_id}) | Stage: ${r.stage_name} | Bus: ${r.bus_id}`);
      console.log(`  AppNo: ${r.application_number} (Serial: ${r.application_serial}) | Status: ${r.status}`);
    }

    await secPool.end();
  } catch (err) {
    console.error('Secondary MySQL Error:', err.message);
  }

  // ----------------------------------------------------------------
  // 3. Transport Mongo DB (transport_requests & studentfees)
  // ----------------------------------------------------------------
  const transportUri = process.env.TRANSPORT_MONGO_URI;
  if (transportUri) {
    try {
      console.log('\n--- 3. Transport MongoDB ---');
      const conn = await mongoose.createConnection(transportUri).asPromise();
      const db = conn.db;

      const mongoRequests = await db.collection('transport_requests').find({
        $or: [
          { admission_number: ADM_NO },
          { student_name: new RegExp('BANNU', 'i') }
        ]
      }).toArray();
      console.log(`\n[Transport Mongo -> transport_requests] Found ${mongoRequests.length} docs:`);
      for (const r of mongoRequests) {
        console.log(JSON.stringify(r, null, 2));
      }

      const mongoStudentFees = await db.collection('studentfees').find({
        $or: [
          { admissionNumber: ADM_NO },
          { studentName: new RegExp('BANNU', 'i') }
        ]
      }).toArray();
      console.log(`\n[Transport Mongo -> studentfees] Found ${mongoStudentFees.length} docs:`);
      for (const sf of mongoStudentFees) {
        console.log(JSON.stringify(sf, null, 2));
      }

      await conn.close();
    } catch (err) {
      console.error('Transport Mongo Error:', err.message);
    }
  }

  // ----------------------------------------------------------------
  // 4. Fee Management Mongo DB (studentfees)
  // ----------------------------------------------------------------
  const feeMgmtUri = process.env.FEE_MANAGEMENT_MONGO_URI;
  if (feeMgmtUri) {
    try {
      console.log('\n--- 4. Fee Management MongoDB ---');
      const conn = await mongoose.createConnection(feeMgmtUri).asPromise();
      const db = conn.db;

      const feeDocs = await db.collection('studentfees').find({
        $or: [
          { studentId: ADM_NO },
          { studentName: new RegExp('BANNU', 'i') },
          { remarks: 'Transport' }
        ],
        feeHeadCode: 'TRN01'
      }).limit(5).toArray();
      console.log(`\n[Fee Mgmt Mongo -> studentfees] Found ${feeDocs.length} TRN01 docs:`);
      for (const fd of feeDocs) {
        console.log(`  Student: ${fd.studentId} (${fd.studentName}) | Fee: ${fd.actualAmount}/${fd.revisedAmount} | AY: ${fd.academicYear}`);
      }

      await conn.close();
    } catch (err) {
      console.error('Fee Mgmt Mongo Error:', err.message);
    }
  }

  console.log('\n================================================================');
  console.log('INSPECTION COMPLETE');
  console.log('================================================================');
  process.exit(0);
}

inspectStudent();
