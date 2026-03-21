import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';

dotenv.config();

const seedSuperAdmin = async () => {
  let pool;
  
  try {
    // Get database connection pool
    pool = getPool();
    
    // Check for primary Super Admin
    const [primaryAdmin] = await pool.execute(
      'SELECT id, email FROM users WHERE email = ?',
      ['admin@leadtracker.com']
    );

    let seedEmail = 'admin@leadtracker.com';
    let seedName = 'Super Admin';

    if (primaryAdmin.length > 0) {
      console.log('Primary Super Admin (admin@leadtracker.com) already exists. Trying alternative...');
      
      // Check for secondary Super Admin
      const [secondaryAdmin] = await pool.execute(
        'SELECT id, email FROM users WHERE email = ?',
        ['admin2@leadtracker.com']
      );

      if (secondaryAdmin.length > 0) {
        console.log('Secondary Super Admin (admin2@leadtracker.com) also already exists.');
        await closeDB();
        process.exit(0);
      }
      
      seedEmail = 'admin2@leadtracker.com';
      seedName = 'Super Admin 2';
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('Admin@123', salt);

    // Generate UUID for user
    const userId = uuidv4();

    // Create Super Admin user
    await pool.execute(
      `INSERT INTO users (id, name, email, password, role_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, seedName, seedEmail, hashedPassword, 'Super Admin', true]
    );

    console.log(`${seedName} created successfully!`);
    console.log(`Email: ${seedEmail}`);
    console.log('Password: Admin@123');
    // console.log('Email: admin@leadtracker.com');
    // console.log('Password: Admin@123');
    console.log('⚠️  Please change the password after first login!');

    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('Error seeding Super Admin:', error);
    if (pool) {
      await closeDB();
    }
    process.exit(1);
  }
};

seedSuperAdmin();
