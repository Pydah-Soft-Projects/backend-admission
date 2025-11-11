import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.model.js';

dotenv.config();

const seedSuperAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lead-tracker');
    console.log('MongoDB Connected');

    // Check if Super Admin user exists
    const existingSuperAdmin = await User.findOne({ email: 'admin@leadtracker.com' });

    if (existingSuperAdmin) {
      console.log('Super Admin user already exists');
      console.log('Email: admin@leadtracker.com');
      console.log('Password: (use the one you set)');
      process.exit(0);
    }

    // Create Super Admin user
    const superAdmin = await User.create({
      name: 'Super Admin',
      email: 'admin@leadtracker.com',
      password: 'Admin@123', // Change this password after first login
      roleName: 'Super Admin',
      isActive: true,
    });

    console.log('Super Admin user created successfully!');
    console.log('Email: admin@leadtracker.com');
    console.log('Password: Admin@123');
    console.log('⚠️  Please change the password after first login!');

    process.exit(0);
  } catch (error) {
    console.error('Error seeding Super Admin:', error);
    process.exit(1);
  }
};

seedSuperAdmin();

