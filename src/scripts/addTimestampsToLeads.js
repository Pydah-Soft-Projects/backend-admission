import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Lead from '../models/Lead.model.js';

dotenv.config();

/**
 * Migration script to add createdAt and updatedAt timestamps to existing leads
 * that don't have these fields set.
 */
const addTimestampsToLeads = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lead-tracker');
    console.log('MongoDB Connected');

    // Find all leads without createdAt or updatedAt fields
    const leadsWithoutTimestamps = await Lead.find({
      $or: [
        { createdAt: { $exists: false } },
        { updatedAt: { $exists: false } },
        { createdAt: null },
        { updatedAt: null },
      ],
    }).select('_id createdAt updatedAt').lean();

    const totalLeads = leadsWithoutTimestamps.length;
    console.log(`Found ${totalLeads} leads without timestamps`);

    if (totalLeads === 0) {
      console.log('All leads already have timestamps. No migration needed.');
      process.exit(0);
    }

    // Process in chunks for better performance
    const chunkSize = 5000;
    let processed = 0;
    let updated = 0;

    for (let i = 0; i < totalLeads; i += chunkSize) {
      const chunk = leadsWithoutTimestamps.slice(i, i + chunkSize);
      const bulkOps = [];

      for (const lead of chunk) {
        // Use uploadBatchId to determine approximate creation time
        // If no uploadBatchId, use current time
        // If there's an uploadBatchId, we can try to get the batch creation time
        // For now, we'll use a default date (e.g., 1 day ago) or current time
        const defaultDate = new Date();
        
        // Try to get a more accurate date from the lead's _id (MongoDB ObjectId contains timestamp)
        let createdAt = defaultDate;
        if (lead._id) {
          // Extract timestamp from MongoDB ObjectId (first 4 bytes represent seconds since Unix epoch)
          const objectIdTimestamp = lead._id.getTimestamp();
          if (objectIdTimestamp && objectIdTimestamp < new Date()) {
            createdAt = objectIdTimestamp;
          }
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: lead._id },
            update: {
              $set: {
                createdAt: lead.createdAt || createdAt,
                updatedAt: lead.updatedAt || createdAt,
              },
            },
          },
        });
      }

      // Execute bulk update
      if (bulkOps.length > 0) {
        const result = await Lead.collection.bulkWrite(bulkOps, {
          ordered: false, // Continue even if some fail
        });
        updated += result.modifiedCount || 0;
        processed += chunk.length;
        console.log(`Processed ${processed}/${totalLeads} leads (${updated} updated)`);
      }
    }

    console.log('\n✅ Migration completed!');
    console.log(`Total leads processed: ${processed}`);
    console.log(`Total leads updated: ${updated}`);

    process.exit(0);
  } catch (error) {
    console.error('Error adding timestamps to leads:', error);
    process.exit(1);
  }
};

addTimestampsToLeads();

