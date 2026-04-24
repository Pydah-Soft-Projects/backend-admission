import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

let hrmsConn = null;

const connectHRMS = async () => {
  if (hrmsConn) return hrmsConn;

  try {
    const uri = process.env.HRMS_MONGO_URI;
    hrmsConn = await mongoose.createConnection(uri).asPromise();
    console.log('Connected to HRMS MongoDB');
    return hrmsConn;
  } catch (error) {
    console.error('HRMS MongoDB Connection Error:', error.message);
    throw error;
  }
};

const getHRMSConnection = () => {
  if (!hrmsConn) {
    throw new Error('HRMS MongoDB not connected');
  }
  return hrmsConn;
};

/**
 * Open HRMS Mongo as soon as the API boots (non-blocking). First HRMS hydrate avoids cold connect.
 * Safe to call multiple times; connectHRMS is idempotent after first success.
 */
export const warmupHrmsMongo = () => {
  const uri = process.env.HRMS_MONGO_URI?.trim();
  if (!uri) return Promise.resolve(null);
  return connectHRMS();
};

export { connectHRMS, getHRMSConnection };
