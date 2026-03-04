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

export { connectHRMS, getHRMSConnection };
