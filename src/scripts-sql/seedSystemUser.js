import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

/**
 * Creates a dedicated System User in the database with a fixed UUID.
 * This user is used for automated background tasks (like lead reclamation)
 * to satisfy foreign key constraints in activity logs.
 */
const seedSystemUser = async () => {
  let pool;
  
  const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
  const SYSTEM_USER_EMAIL = 'system@automated.task';
  const SYSTEM_USER_NAME = 'System Automated Task';

  try {
    pool = getPool();
    console.log('📋 Ensuring System User exists for automated tasks...');
    
    // Check if the system user already exists
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE id = ?',
      [SYSTEM_USER_ID]
    );

    if (existing.length > 0) {
      console.log('✅ System User already exists. No action needed.');
    } else {
      console.log('🚀 Creating System User...');
      
      // Use a "Super Admin" role for the system user so it has necessary permissions,
      // but give it a dummy password as no one will ever log in as this user.
      await pool.execute(
        `INSERT INTO users (
          id, name, email, password, role_name, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
            SYSTEM_USER_ID, 
            SYSTEM_USER_NAME, 
            SYSTEM_USER_EMAIL, 
            'SYSTEM_NO_LOGIN_' + Math.random().toString(36), 
            'Super Admin', 
            true
        ]
      );
      
      console.log('✅ System User created successfully with ID:', SYSTEM_USER_ID);
    }

    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding System User:', error);
    if (pool) await closeDB();
    process.exit(1);
  }
};

seedSystemUser();
