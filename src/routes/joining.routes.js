import express from 'express';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';
import {
  listJoinings,
  getJoining,
  saveJoiningDraft,
  submitJoiningForApproval,
  approveJoining,
} from '../controllers/joining.controller.js';

const router = express.Router();

router.use(protect);

router.get('/', listJoinings);
router.get('/:leadId', getJoining);
router.post('/:leadId', saveJoiningDraft);
router.post('/:leadId/submit', submitJoiningForApproval);
router.post('/:leadId/approve', isSuperAdmin, approveJoining);

export default router;


