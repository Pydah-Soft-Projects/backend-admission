import express from 'express';
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
} from '../controllers/user.controller.js';
import { getMySettings, updateMySettings } from '../controllers/userSettings.controller.js';
import { updateMyProfile } from '../controllers/userProfile.controller.js';
import { getMyLoginLogs, getAllUserLoginLogs } from '../controllers/userLoginLogs.controller.js';
import { protect, isSuperAdmin, requireTimeTrackingEnabled } from '../middleware/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Current user's settings and login logs (no time-tracking restriction - user must access settings to enable)
router.get('/me/settings', getMySettings);
router.put('/me/settings', updateMySettings);
router.put('/me/profile', updateMyProfile);
router.get('/me/login-logs', getMyLoginLogs);

// Routes that require Super Admin only
router.route('/').get(isSuperAdmin, getUsers).post(isSuperAdmin, createUser);
router.get('/all/login-logs', isSuperAdmin, getAllUserLoginLogs);

// Require time tracking for User/Counsellor/Manager dashboard routes below
router.use(requireTimeTrackingEnabled);

// Get user route - accessible to Super Admin and Managers (for their team members)
// Must be defined before PUT/DELETE to avoid route conflicts
router.get('/:id', getUser);

// Update and delete routes - Super Admin only
router.put('/:id', isSuperAdmin, updateUser);
router.delete('/:id', isSuperAdmin, deleteUser);

export default router;

