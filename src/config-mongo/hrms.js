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
 * HRMS Mongo (HRMS_MONGO_URI): org data in `employees`; login passwords in `users` (then `employees` fallback).
 * Open as soon as the API boots (non-blocking). Safe to call multiple times; connectHRMS is idempotent.
 */
export const warmupHrmsMongo = () => {
  const uri = process.env.HRMS_MONGO_URI?.trim();
  if (!uri) return Promise.resolve(null);
  return connectHRMS();
};

export { connectHRMS, getHRMSConnection };
