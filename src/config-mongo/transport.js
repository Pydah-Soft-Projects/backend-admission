import mongoose from 'mongoose';
import dns from 'dns';
import dotenv from 'dotenv';

dotenv.config();

let transportConn = null;

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

const connectTransport = async () => {
  if (transportConn) return transportConn;

  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) {
    throw new Error('TRANSPORT_MONGO_URI is not configured');
  }

  ensureSrvFriendlyDns();

  try {
    transportConn = await mongoose
      .createConnection(uri, { serverSelectionTimeoutMS: 20000 })
      .asPromise();
    console.log('Connected to Transport MongoDB');
    return transportConn;
  } catch (error) {
    transportConn = null;
    console.error('Transport MongoDB Connection Error:', error.message);
    throw error;
  }
};

const getTransportConnection = () => {
  if (!transportConn) {
    throw new Error('Transport MongoDB not connected');
  }
  return transportConn;
};

export const warmupTransportMongo = () => {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) return Promise.resolve(null);
  return connectTransport();
};

export { connectTransport, getTransportConnection };
