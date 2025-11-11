import express from 'express';
import {
  getRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
} from '../controllers/role.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

// All routes require authentication and Super Admin role
router.use(protect);
router.use(isSuperAdmin);

router.route('/').get(getRoles).post(createRole);
router.route('/:id').get(getRole).put(updateRole).delete(deleteRole);

export default router;

