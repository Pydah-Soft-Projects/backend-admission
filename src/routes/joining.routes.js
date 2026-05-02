import express from 'express';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';
import {
  listJoinings,
  getJoining,
  saveJoiningDraft,
  submitJoiningForApproval,
  approveJoining,
} from '../controllers/joining.controller.js';
import { createJoiningPublicEditLink } from '../controllers/joiningPublic.controller.js';

const router = express.Router();

router.use(protect);

router.get('/', listJoinings);
router.post('/:leadId/public-edit-link', createJoiningPublicEditLink);
router.get('/:leadId', getJoining);
router.post('/:leadId', saveJoiningDraft);
router.post('/:leadId/submit', submitJoiningForApproval);
router.post('/:leadId/approve', isSuperAdmin, approveJoining);

export default router;


