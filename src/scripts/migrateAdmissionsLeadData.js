import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Admission from '../models/Admission.model.js';
import Lead from '../models/Lead.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
};

const migrateAdmissionsLeadData = async () => {
  try {
    await connectDB();

    console.log('Starting migration: Adding leadData to existing admissions...\n');

    // Find all admissions without leadData or with empty leadData
    const admissions = await Admission.find({
      $or: [
        { leadData: { $exists: false } },
        { leadData: null },
        { leadData: {} },
      ],
    }).lean();

    console.log(`Found ${admissions.length} admissions to migrate.\n`);

    if (admissions.length === 0) {
      console.log('No admissions need migration. All admissions already have leadData.');
      await mongoose.connection.close();
      process.exit(0);
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const admission of admissions) {
      try {
        if (!admission.leadId) {
          console.warn(`Skipping admission ${admission._id}: No leadId found`);
          errorCount++;
          continue;
        }

        // Fetch the lead
        const lead = await Lead.findById(admission.leadId).lean();

        if (!lead) {
          console.warn(`Skipping admission ${admission._id}: Lead not found for leadId ${admission.leadId}`);
          errorCount++;
          errors.push({
            admissionId: admission._id,
            leadId: admission.leadId,
            error: 'Lead not found',
          });
          continue;
        }

        // Create lead data snapshot (exclude MongoDB internal fields)
        const leadDataSnapshot = { ...lead };
        delete leadDataSnapshot._id;
        delete leadDataSnapshot.__v;

        // Update admission with leadData and enquiryNumber
        await Admission.updateOne(
          { _id: admission._id },
          {
            $set: {
              leadData: leadDataSnapshot,
              enquiryNumber: lead.enquiryNumber || admission.enquiryNumber || '',
            },
          }
        );

        successCount++;
        console.log(`✓ Migrated admission ${admission._id} (Lead: ${lead.enquiryNumber || admission.leadId})`);
      } catch (error) {
        errorCount++;
        errors.push({
          admissionId: admission._id,
          leadId: admission.leadId,
          error: error.message,
        });
        console.error(`✗ Error migrating admission ${admission._id}:`, error.message);
      }
    }

    console.log('\n=== Migration Summary ===');
    console.log(`Total admissions processed: ${admissions.length}`);
    console.log(`Successfully migrated: ${successCount}`);
    console.log(`Errors: ${errorCount}`);

    if (errors.length > 0) {
      console.log('\n=== Errors ===');
      errors.forEach((err, index) => {
        console.log(`${index + 1}. Admission ${err.admissionId} (LeadId: ${err.leadId}): ${err.error}`);
      });
    }

    console.log('\nMigration completed!');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run migration
migrateAdmissionsLeadData();

