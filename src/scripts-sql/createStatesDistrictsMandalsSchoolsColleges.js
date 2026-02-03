/**
 * Migration: Create states, districts, mandals, schools, colleges tables.
 * Run: node src/scripts-sql/createStatesDistrictsMandalsSchoolsColleges.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Creating states, districts, mandals, schools, colleges tables...\n');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS states (
        id CHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        display_order INT UNSIGNED DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_states_name (name),
        INDEX idx_states_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Table states ready.');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS districts (
        id CHAR(36) PRIMARY KEY,
        state_id CHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        display_order INT UNSIGNED DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (state_id) REFERENCES states(id) ON DELETE CASCADE,
        UNIQUE KEY uk_districts_state_name (state_id, name),
        INDEX idx_districts_state_id (state_id),
        INDEX idx_districts_name (name),
        INDEX idx_districts_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Table districts ready.');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS mandals (
        id CHAR(36) PRIMARY KEY,
        district_id CHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        display_order INT UNSIGNED DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (district_id) REFERENCES districts(id) ON DELETE CASCADE,
        UNIQUE KEY uk_mandals_district_name (district_id, name),
        INDEX idx_mandals_district_id (district_id),
        INDEX idx_mandals_name (name),
        INDEX idx_mandals_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Table mandals ready.');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS schools (
        id CHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_schools_name (name),
        INDEX idx_schools_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Table schools ready.');

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS colleges (
        id CHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_colleges_name (name),
        INDEX idx_colleges_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Table colleges ready.');

    console.log('\nDone.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
