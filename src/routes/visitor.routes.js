import express from 'express';
import { 
  generateVisitorCode, 
  verifyVisitorCode, 
  consumeVisitorCode,
  getRecentVisitors
} from '../controllers/visitorCode.controller.js';
import { protect, authorize } from '../middleware/auth.middleware.js';

const router = express.Router();

// Generate code - accessible by all staff roles (e.g., Student Counsellor)
router.post('/generate', protect, generateVisitorCode);

// Verify code - accessible by Admins/Super Admins
router.get('/verify/:code', protect, authorize('Super Admin', 'Sub Super Admin'), verifyVisitorCode);

// Consume code - accessible by Admins/Super Admins
router.post('/consume', protect, authorize('Super Admin', 'Sub Super Admin'), consumeVisitorCode);

// Get recent visitors - accessible by Admins/Super Admins
router.get('/recent', protect, authorize('Super Admin', 'Sub Super Admin'), getRecentVisitors);

export default router;
