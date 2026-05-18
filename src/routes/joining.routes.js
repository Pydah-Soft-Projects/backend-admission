import express from 'express';
import {
  protect,
  isSuperAdmin,
  requireJoiningEditAdmission,
} from '../middleware/auth.middleware.js';
import {
  listJoinings,
  getJoining,
  saveJoiningDraft,
  patchJoiningStepTwo,
  submitJoiningForApproval,
  approveJoining,
} from '../controllers/joining.controller.js';
import {
  createJoiningPublicEditLink,
  createJoiningDraftAndPublicLink,
} from '../controllers/joiningPublic.controller.js';

const router = express.Router();

router.use(protect);

router.get('/', listJoinings);
router.post('/send-public-link', createJoiningDraftAndPublicLink);
router.post('/:leadId/public-edit-link', createJoiningPublicEditLink);
router.get('/:leadId', getJoining);
router.patch('/:leadId/step-two', requireJoiningEditAdmission, patchJoiningStepTwo);
router.post('/:leadId', saveJoiningDraft);
router.post('/:leadId/submit', submitJoiningForApproval);
router.post('/:leadId/approve', isSuperAdmin, approveJoining);

export default router;


