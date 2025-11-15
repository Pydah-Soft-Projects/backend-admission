import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Joining from '../models/Joining.model.js';
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

const migrateJoiningsLeadData = async () => {
  try {
    await connectDB();

    console.log('Starting migration: Adding leadData to existing joinings...\n');

    // Find all joinings without leadData or with empty leadData
    const joinings = await Joining.find({
      $or: [
        { leadData: { $exists: false } },
        { leadData: null },
        { leadData: {} },
      ],
    }).lean();

    console.log(`Found ${joinings.length} joinings to migrate.\n`);

    if (joinings.length === 0) {
      console.log('No joinings need migration. All joinings already have leadData.');
      await mongoose.connection.close();
      process.exit(0);
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const joining of joinings) {
      try {
        if (!joining.leadId) {
          console.warn(`Skipping joining ${joining._id}: No leadId found`);
          errorCount++;
          continue;
        }

        // Fetch the lead
        const lead = await Lead.findById(joining.leadId).lean();

        if (!lead) {
          console.warn(`Skipping joining ${joining._id}: Lead not found for leadId ${joining.leadId}`);
          errorCount++;
          errors.push({
            joiningId: joining._id,
            leadId: joining.leadId,
            error: 'Lead not found',
          });
          continue;
        }

        // Create lead data snapshot (exclude MongoDB internal fields)
        const leadDataSnapshot = { ...lead };
        delete leadDataSnapshot._id;
        delete leadDataSnapshot.__v;

        // Update joining with leadData
        await Joining.updateOne(
          { _id: joining._id },
          {
            $set: {
              leadData: leadDataSnapshot,
            },
          }
        );

        successCount++;
        console.log(`✓ Migrated joining ${joining._id} (Lead: ${lead.enquiryNumber || joining.leadId})`);
      } catch (error) {
        errorCount++;
        errors.push({
          joiningId: joining._id,
          leadId: joining.leadId,
          error: error.message,
        });
        console.error(`✗ Error migrating joining ${joining._id}:`, error.message);
      }
    }

    console.log('\n=== Migration Summary ===');
    console.log(`Total joinings processed: ${joinings.length}`);
    console.log(`Successfully migrated: ${successCount}`);
    console.log(`Errors: ${errorCount}`);

    if (errors.length > 0) {
      console.log('\n=== Errors ===');
      errors.forEach((err, index) => {
        console.log(`${index + 1}. Joining ${err.joiningId} (LeadId: ${err.leadId}): ${err.error}`);
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
migrateJoiningsLeadData();

