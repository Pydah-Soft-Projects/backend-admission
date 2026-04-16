/**
 * Migration: Add indexes to speed up lead listing + assignment-heavy filters.
 *
 * Why:
 * - Reduce CPU and sort pressure on paginated lead list queries.
 * - Improve filtering on assignment and academic/student group predicates.
 *
 * Run (from backend-admission):
 *   node src/scripts-sql/addLeadListPerformanceIndexes.js
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const INDEXES = [
  {
    table: 'leads',
    name: 'idx_leads_created_id',
    ddl: 'CREATE INDEX idx_leads_created_id ON leads (created_at DESC, id ASC)',
  },
  {
    table: 'leads',
    name: 'idx_leads_assigned_to',
    ddl: 'CREATE INDEX idx_leads_assigned_to ON leads (assigned_to)',
  },
  {
    table: 'leads',
    name: 'idx_leads_assigned_to_pro',
    ddl: 'CREATE INDEX idx_leads_assigned_to_pro ON leads (assigned_to_pro)',
  },
  {
    table: 'leads',
    name: 'idx_leads_uploaded_by',
    ddl: 'CREATE INDEX idx_leads_uploaded_by ON leads (uploaded_by)',
  },
  {
    table: 'leads',
    name: 'idx_leads_academic_student_created',
    ddl: 'CREATE INDEX idx_leads_academic_student_created ON leads (academic_year, student_group, created_at DESC, id ASC)',
  },
  {
    table: 'leads',
    name: 'idx_leads_assign_year_group_created_id',
    ddl: 'CREATE INDEX idx_leads_assign_year_group_created_id ON leads (assigned_to, academic_year, student_group, created_at DESC, id ASC)',
  },
  {
    table: 'leads',
    name: 'idx_leads_assignpro_year_group_created_id',
    ddl: 'CREATE INDEX idx_leads_assignpro_year_group_created_id ON leads (assigned_to_pro, academic_year, student_group, created_at DESC, id ASC)',
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
      console.log(`  created.`);
    }

    console.log('\nDone. Index migration completed successfully.');
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
