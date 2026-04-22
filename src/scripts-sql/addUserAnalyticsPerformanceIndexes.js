/**
 * Migration: Indexes for GET /api/leads/analytics/users and related report queries.
 *
 * Covers common filter shapes:
 * - activity_logs: type = 'status_change' + target_user_id IN (...) + created_at range
 * - activity_logs: type + performed_by IN (...) + created_at range
 * - activity_logs: type + source_user_id (reclamation loads)
 * - communications: type + sent_by IN (...) + sent_at range (calls/SMS aggregates)
 *
 * Existing schema already has partial coverage (e.g. idx_communications_sent_by_at);
 * these composites help the planner when type is equality-filtered first.
 *
 * Run (from backend-admission, after .env with DB_* is loaded):
 *   node src/scripts-sql/addUserAnalyticsPerformanceIndexes.js
 *
 * Or:
 *   npm run migrate:user-analytics-indexes
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const INDEXES = [
  {
    table: 'activity_logs',
    name: 'idx_activity_logs_type_target_user_created',
    ddl:
      'CREATE INDEX idx_activity_logs_type_target_user_created ON activity_logs (type, target_user_id, created_at)',
  },
  {
    table: 'activity_logs',
    name: 'idx_activity_logs_type_performed_by_created',
    ddl:
      'CREATE INDEX idx_activity_logs_type_performed_by_created ON activity_logs (type, performed_by, created_at)',
  },
  {
    table: 'activity_logs',
    name: 'idx_activity_logs_type_source_user_created',
    ddl:
      'CREATE INDEX idx_activity_logs_type_source_user_created ON activity_logs (type, source_user_id, created_at)',
  },
  {
    table: 'communications',
    name: 'idx_communications_type_sent_by_sent_at',
    ddl:
      'CREATE INDEX idx_communications_type_sent_by_sent_at ON communications (type, sent_by, sent_at)',
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

    console.log('\nDone. User analytics index migration completed successfully.');
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
