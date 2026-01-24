import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

let pool = null;

/**
 * Create MySQL connection pool for Amazon RDS
 */
const createPool = () => {
  if (pool) {
    return pool;
  }

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_MAX || '10'),
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ssl: process.env.DB_SSL === 'true' ? {
      rejectUnauthorized: false
    } : false,
    charset: process.env.DB_CHARSET || 'utf8mb4',
    timezone: process.env.DB_TIMEZONE || '+00:00',
  });

  return pool;
};

/**
 * Get MySQL connection pool
 */
const getPool = () => {
  if (!pool) {
    return createPool();
  }
  return pool;
};

/**
 * Test database connection
 */
const testConnection = async () => {
  try {
    const connection = await getPool().getConnection();
    await connection.ping();
    connection.release();
    console.log('MySQL Connected to Amazon RDS');
    return true;
  } catch (error) {
    console.error('MySQL Connection Error:', error.message);
    throw error;
  }
};

/**
 * Connect to database (initialize pool)
 */
const connectDB = async () => {
  try {
    await testConnection();
  } catch (error) {
    console.error(`MySQL connection failed: ${error.message}`);
    // Don't exit process - allow server to run with MongoDB only during transition
    throw error;
  }
};

/**
 * Close database connection pool
 */
const closeDB = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('MySQL connection pool closed');
  }
};

export default connectDB;
export { getPool, testConnection, closeDB };
