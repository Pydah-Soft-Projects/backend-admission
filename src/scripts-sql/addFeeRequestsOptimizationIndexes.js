/**
 * Migration: Optimization Indexes for fee_requests (admission_number, status).
 *
 * Runs a query to verify whether these indexes already exist before attempting creation,
 * preventing any duplicate index name crashes.
 *
 * Run (from backend-admission):
 *   node src/scripts-sql/addFeeRequestsOptimizationIndexes.js
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const INDEXES = [
  {
    table: 'fee_requests',
    name: 'idx_fee_requests_admission_number_status',
    ddl: 'CREATE INDEX idx_fee_requests_admission_number_status ON fee_requests (admission_number, status)',
  },
];

const run = async () => {
  let connection;

  try {
    const dbConfig = {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : null,
    };

    console.log('Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    console.log('Connected.\n');

    for (const idx of INDEXES) {
      const [rows] = await connection.execute(
        `SELECT 1
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?
         LIMIT 1`,
        [idx.table, idx.name]
      );

      if (rows.length > 0) {
        console.log(`- ${idx.name}: already exists, skipping.`);
        continue;
      }

      console.log(`- ${idx.name}: creating...`);
      await connection.execute(idx.ddl);
      console.log('  created.');
    }

    console.log('\nDone. Optimization index migration completed successfully.');
  } catch (error) {
    console.error('\nMigration failed:', error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
    process.exit(0);
  }
};

run();
