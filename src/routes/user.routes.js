import express from 'express';
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
} from '../controllers/user.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Routes that require Super Admin only
router.route('/').get(isSuperAdmin, getUsers).post(isSuperAdmin, createUser);

// Get user route - accessible to Super Admin and Managers (for their team members)
// Must be defined before PUT/DELETE to avoid route conflicts
router.get('/:id', getUser);

// Update and delete routes - Super Admin only
router.put('/:id', isSuperAdmin, updateUser);
router.delete('/:id', isSuperAdmin, deleteUser);

export default router;

