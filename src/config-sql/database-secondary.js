import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

let pool = null;

/**
 * Create MySQL connection pool for secondary database (Courses & Branches)
 */
const createPool = () => {
  if (pool) {
    return pool;
  }

  pool = mysql.createPool({
    host: process.env.DB_SECONDARY_HOST,
    port: process.env.DB_SECONDARY_PORT || 3306,
    user: process.env.DB_SECONDARY_USER,
    password: process.env.DB_SECONDARY_PASSWORD,
    database: process.env.DB_SECONDARY_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_MAX || '10'),
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ssl: process.env.DB_SECONDARY_SSL === 'true' ? {
      rejectUnauthorized: false
    } : false,
    charset: process.env.DB_CHARSET || 'utf8mb4',
    timezone: process.env.DB_TIMEZONE || '+00:00',
  });

  return pool;
};

/**
 * Get secondary MySQL connection pool
 */
const getPool = () => {
  if (!pool) {
    return createPool();
  }
  return pool;
};

/**
 * Test secondary database connection
 */
const testConnection = async () => {
  try {
    const connection = await getPool().getConnection();
    await connection.ping();
    connection.release();
    console.log('Secondary MySQL Connected (Courses & Branches)');
    return true;
  } catch (error) {
    console.error('Secondary MySQL Connection Error:', error.message);
    throw error;
  }
};

/**
 * Connect to secondary database (initialize pool)
 */
const connectDB = async () => {
  try {
    await testConnection();
  } catch (error) {
    console.error(`Secondary MySQL connection failed: ${error.message}`);
    throw error;
  }
};

/**
 * Close secondary database connection pool
 */
const closeDB = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Secondary MySQL connection pool closed');
  }
};

export default connectDB;
export { getPool, testConnection, closeDB };
