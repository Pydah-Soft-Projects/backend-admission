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
    
    // Check if Super Admin user exists
    const [existingUsers] = await pool.execute(
      'SELECT id, email FROM users WHERE email = ?',
      ['admin@leadtracker.com']
    );

    if (existingUsers.length > 0) {
      console.log('Super Admin user already exists');
      console.log('Email: admin@leadtracker.com');
      console.log('Password: (use the one you set)');
      await closeDB();
      process.exit(0);
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
      [userId, 'Super Admin', 'admin@leadtracker.com', hashedPassword, 'Super Admin', true]
    );

    console.log('Super Admin user created successfully!');
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
