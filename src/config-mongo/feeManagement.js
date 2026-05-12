import mongoose from 'mongoose';
import dns from 'dns';
import dotenv from 'dotenv';

dotenv.config();

let feeMgmtConn = null;

/**
 * Some Windows dev environments cannot resolve Mongo Atlas SRV records through
 * the system DNS resolver. Falling back to Google/Cloudflare ensures `mongodb+srv://`
 * URIs work the same way in dev as they do on the deployed backend.
 */
const ensureSrvFriendlyDns = () => {
  try {
    dns.setDefaultResultOrder?.('ipv4first');
    const current = dns.promises.getServers?.() || [];
    if (!current.includes('8.8.8.8')) {
      dns.promises.setServers([...new Set([...current, '8.8.8.8', '1.1.1.1'])]);
    }
  } catch {
    // best-effort; if the runtime forbids overriding DNS we just continue
  }
};

const connectFeeManagement = async () => {
  if (feeMgmtConn) return feeMgmtConn;

  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) {
    throw new Error('FEE_MANAGEMENT_MONGO_URI is not configured');
  }

  ensureSrvFriendlyDns();

  try {
    feeMgmtConn = await mongoose
      .createConnection(uri, { serverSelectionTimeoutMS: 20000 })
      .asPromise();
    console.log('Connected to Fee-Management MongoDB');
    return feeMgmtConn;
  } catch (error) {
    feeMgmtConn = null;
    console.error('Fee-Management MongoDB Connection Error:', error.message);
    throw error;
  }
};

const getFeeManagementConnection = () => {
  if (!feeMgmtConn) {
    throw new Error('Fee-Management MongoDB not connected');
  }
  return feeMgmtConn;
};

/**
 * Warm the Fee-Management Mongo connection during boot so the first fee-structure
 * request does not pay the cold-connect latency.
 */
export const warmupFeeManagementMongo = () => {
  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) return Promise.resolve(null);
  return connectFeeManagement();
};

export { connectFeeManagement, getFeeManagementConnection };
