import express from 'express';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';
import { getDailyCallReports, getConversionReports } from '../controllers/report.controller.js';

const router = express.Router();

// All routes require authentication and Super Admin access
router.use(protect);
router.use(isSuperAdmin);

// Report routes
router.get('/calls/daily', getDailyCallReports);
router.get('/conversions', getConversionReports);

export default router;

