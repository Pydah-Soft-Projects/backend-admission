import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
// import connectDB from './config/database.js'; // COMMENTED OUT: Migration to SQL complete
import connectSQLDB from './config-sql/database.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import leadRoutes from './routes/lead.routes.js';
import { errorHandler } from './middleware/error.middleware.js';
import communicationRoutes from './routes/communication.routes.js';
import joiningRoutes from './routes/joining.routes.js';
import admissionRoutes from './routes/admission.routes.js';
import courseRoutes from './routes/course.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import reportRoutes from './routes/report.routes.js';
import utmRoutes from './routes/utm.routes.js';
import managerRoutes from './routes/manager.routes.js';

// Load environment variables
dotenv.config();

// Connect to databases
// MongoDB connection (existing) - COMMENTED OUT: Migration to SQL complete
// connectDB();

// MySQL connection (Amazon RDS)
if (process.env.DB_HOST && process.env.DB_NAME) {
  console.log('Attempting to connect to MySQL (Amazon RDS)...');
  connectSQLDB().catch((error) => {
    console.error('⚠️  MySQL connection failed:', error.message);
    console.log('⚠️  Server will start but database operations will fail without MySQL connection.');
    // Don't exit - allow server to start for debugging, but operations will fail
  });
} else {
  console.log('⚠️  MySQL configuration not found - skipping MySQL connection');
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN  || "https://frontend-admission.vercel.app" || 'http://localhost:3000',
  credentials: true
}));
// Increase JSON payload limit for bulk uploads (50MB)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Request logging middleware (optimized - don't log large request bodies)
app.use((req, res, next) => {
  // Only log request method and path, skip body for bulk uploads to avoid performance issues
  if (req.path === '/api/leads/bulk-upload' && req.method === 'POST') {
    console.log(`${req.method} ${req.path} - Bulk upload (${req.body?.leads?.length || 0} leads)`);
  } else {
    // For other routes, log method and path only (not full body)
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/communications', communicationRoutes);
app.use('/api/joinings', joiningRoutes);
app.use('/api/admissions', admissionRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/utm', utmRoutes);
app.use('/api/manager', managerRoutes);
// Role routes removed - using roleName string in User model instead

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Error handling middleware
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

