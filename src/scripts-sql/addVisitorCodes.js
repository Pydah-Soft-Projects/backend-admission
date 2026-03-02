import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || '3306', 10),
};

async function migrate() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('📋 Creating visitor_codes table...');

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS visitor_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lead_id VARCHAR(50) NOT NULL,
        created_by VARCHAR(50) NOT NULL,
        code VARCHAR(10) NOT NULL,
        status ENUM('active', 'used', 'expired') DEFAULT 'active',
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_visitor_code (code),
        INDEX idx_lead_id (lead_id),
        INDEX idx_status_active (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    await connection.execute(createTableQuery);
    console.log('✅ Table visitor_codes created or already exists.');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    if (connection) {
      await connection.end();
      console.log('MySQL connection closed');
    }
  }
}

migrate();
