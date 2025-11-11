import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/lead-tracker';

(async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
    });

    const result = await mongoose.connection.db.collection('leads').updateMany(
      {
        $or: [
          { state: { $exists: false } },
          { state: null },
          { state: '' },
          { state: 'Unknown' },
        ],
      },
      {
        $set: { state: 'Andhra Pradesh' },
      },
    );

    console.log(`Matched ${result.matchedCount}, modified ${result.modifiedCount}`);
  } catch (error) {
    console.error('State backfill failed:', error);
  } finally {
    await mongoose.disconnect();
  }
})();