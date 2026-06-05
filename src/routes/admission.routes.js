import express from 'express';
import {
  protect,
  isSuperAdmin,
  requireJoiningEditAdmission,
  requireJoiningEditReference,
} from '../middleware/auth.middleware.js';
import {
  listAdmissions,
  getAdmissionById,
  getAdmissionByJoiningId,
  getAdmissionByLead,
  cancelAdmissionById,
  updateAdmissionById,
  updateAdmissionByLead,
  patchAdmissionReferenceById,
  getAdmissionStats,
  getAdmissionStatsByReference,
  getAdmissionStatsBySource,
  getAdmissionStatsByDate,
  listDistinctReferenceNames,
  upsertAdmissionBranchIntake,
  exportAdmissions,
  sendAdmissionConfirmationSmsById,
} from '../controllers/admission.controller.js';

const router = express.Router();

router.use(protect);

router.get('/reference-names', listDistinctReferenceNames);
router.get('/stats/by-reference', getAdmissionStatsByReference);
router.get('/stats/by-source', getAdmissionStatsBySource);
router.get('/stats/by-date', getAdmissionStatsByDate);
router.get('/stats', getAdmissionStats);
router.put('/branch-intake', isSuperAdmin, upsertAdmissionBranchIntake);
router.get('/export', isSuperAdmin, exportAdmissions);
router.get('/', listAdmissions);
router.get('/id/:admissionId', getAdmissionById);
router.get('/joining/:joiningId', getAdmissionByJoiningId);
router.get('/:leadId', getAdmissionByLead); // Keep for backward compatibility
router.post('/id/:admissionId/cancel', requireJoiningEditAdmission, cancelAdmissionById);
router.post('/id/:admissionId/send-confirmation-sms', sendAdmissionConfirmationSmsById);
router.patch('/id/:admissionId/reference', requireJoiningEditReference, patchAdmissionReferenceById);
router.put('/id/:admissionId', requireJoiningEditAdmission, updateAdmissionById);
router.put('/:leadId', requireJoiningEditAdmission, updateAdmissionByLead); // Keep for backward compatibility

export default router;


