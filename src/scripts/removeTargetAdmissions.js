/**
 * Remove admission(s) from admissions_db and clean synced transport + fee portal records.
 *
 * Cleans:
 * - admissions_db.admissions
 * - admissions_db.leads.admission_number + joinings.lead_data.admissionNumber
 * - student_database.transport_requests + student_database.students (fee portal student list)
 * - Fee Management Mongo: crm_joining_student_fee_details, studentfees, transactions
 * - Transport Mongo: studentfees
 *
 * Usage:
 *   node src/scripts/removeTargetAdmissions.js
 *   node src/scripts/removeTargetAdmissions.js --dry-run
 *   node src/scripts/removeTargetAdmissions.js 20260272
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import mongoose from 'mongoose';
import {
  resolveAdmissionRemovalTargets,
  previewAdmissionExternalCleanup,
  executeAdmissionExternalCleanup,
  clearAdmissionReferencesInPrimarySql,
} from '../services/admissionRemovalCleanup.service.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const DEFAULT_TARGETS = ['20260272'];
const dryRun = process.argv.includes('--dry-run');
const cliTargets = process.argv
  .slice(2)
  .filter((arg) => arg !== '--dry-run')
  .map((s) => String(s).trim())
  .filter(Boolean);
const TARGET_ADMISSION_NUMBERS = cliTargets.length > 0 ? cliTargets : DEFAULT_TARGETS;

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    const { targets } = await resolveAdmissionRemovalTargets(conn, TARGET_ADMISSION_NUMBERS);
    const externalBefore = await previewAdmissionExternalCleanup(targets);

    const report = {
      dryRun,
      targetAdmissionNumbers: TARGET_ADMISSION_NUMBERS,
      targets,
      externalBefore,
    };

    if (dryRun) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    await conn.beginTransaction();

    const placeholders = TARGET_ADMISSION_NUMBERS.map(() => '?').join(',');
    const [deleted] = await conn.execute(
      `DELETE FROM admissions WHERE admission_number IN (${placeholders})`,
      TARGET_ADMISSION_NUMBERS
    );
    const referenceCleanup = await clearAdmissionReferencesInPrimarySql(conn, targets);

    await conn.commit();

    const externalDeleted = await executeAdmissionExternalCleanup(targets);
    const externalAfter = await previewAdmissionExternalCleanup(targets);

    console.log(
      JSON.stringify(
        {
          ...report,
          deletedAdmissionRows: Number(deleted.affectedRows || 0),
          referenceCleanup,
          externalDeleted,
          externalAfter,
        },
        null,
        2
      )
    );
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
