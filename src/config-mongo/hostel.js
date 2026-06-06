import mongoose from 'mongoose';
import dns from 'dns';
import dotenv from 'dotenv';

dotenv.config();

let hostelConn = null;

const ensureSrvFriendlyDns = () => {
  try {
    dns.setDefaultResultOrder?.('ipv4first');
    const current = dns.promises.getServers?.() || [];
    if (!current.includes('8.8.8.8')) {
      dns.promises.setServers([...new Set([...current, '8.8.8.8', '1.1.1.1'])]);
    }
  } catch {
    // best-effort
  }
};

const connectHostel = async () => {
  if (hostelConn) return hostelConn;

  const uri = process.env.HOSTEL_MONGO_URI?.trim();
  if (!uri) {
    throw new Error('HOSTEL_MONGO_URI is not configured');
  }

  ensureSrvFriendlyDns();

  try {
    hostelConn = await mongoose
      .createConnection(uri, { serverSelectionTimeoutMS: 20000 })
      .asPromise();
    console.log('Connected to Hostel MongoDB');
    return hostelConn;
  } catch (error) {
    hostelConn = null;
    console.error('Hostel MongoDB Connection Error:', error.message);
    throw error;
  }
};

const getHostelConnection = () => {
  if (!hostelConn) {
    throw new Error('Hostel MongoDB not connected');
  }
  return hostelConn;
};

export const warmupHostelMongo = () => {
  const uri = process.env.HOSTEL_MONGO_URI?.trim();
  if (!uri) return Promise.resolve(null);
  return connectHostel();
};

export { connectHostel, getHostelConnection };
