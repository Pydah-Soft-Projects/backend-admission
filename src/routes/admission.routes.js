import express from 'express';
import {
  protect,
  isSuperAdmin,
  requireJoiningEditAdmission,
  requireJoiningEditReference,
} from '../middleware/auth.middleware.js';
import { searchHrmsEmployees } from '../controllers/user.controller.js';
import {
  listAdmissions,
  getAdmissionById,
  getAdmissionByJoiningId,
  getAdmissionByLead,
  cancelAdmissionById,
  updateAdmissionById,
  updateAdmissionByLead,
  patchAdmissionReferenceById,
  patchAdmissionRemarksById,
  getAdmissionStats,
  getAdmissionStatsByReference,
  getAdmissionStatsByReferenceAdmissions,
  getAdmissionStatsBySource,
  getAdmissionStatsByDate,
  listDistinctReferenceNames,
  getDistinctReferenceNameUsage,
  renameDistinctReferenceName,
  hideDistinctReferenceName,
  upsertAdmissionBranchIntake,
  exportAdmissions,
  listPendingCertificates,
  exportPendingCertificates,
  listPendingFees,
  exportPendingFees,
  sendAdmissionConfirmationSmsById,
} from '../controllers/admission.controller.js';

const router = express.Router();

router.use(protect);

router.get('/hrms-employees/search', searchHrmsEmployees);
router.get('/reference-names', listDistinctReferenceNames);
router.get('/reference-names/usage', getDistinctReferenceNameUsage);
router.patch('/reference-names/rename', requireJoiningEditReference, renameDistinctReferenceName);
router.post('/reference-names/hide', requireJoiningEditReference, hideDistinctReferenceName);
router.get('/stats/by-reference/admissions', getAdmissionStatsByReferenceAdmissions);
router.get('/stats/by-reference', getAdmissionStatsByReference);
router.get('/stats/by-source', getAdmissionStatsBySource);
router.get('/stats/by-date', getAdmissionStatsByDate);
router.get('/stats', getAdmissionStats);
router.put('/branch-intake', isSuperAdmin, upsertAdmissionBranchIntake);
router.get('/export', isSuperAdmin, exportAdmissions);
router.get('/pending-certificates/export', exportPendingCertificates);
router.get('/pending-certificates', listPendingCertificates);
router.get('/pending-fees/export', exportPendingFees);
router.get('/pending-fees', listPendingFees);
router.get('/', listAdmissions);
router.get('/id/:admissionId', getAdmissionById);
router.get('/joining/:joiningId', getAdmissionByJoiningId);
router.get('/:leadId', getAdmissionByLead); // Keep for backward compatibility
router.post('/id/:admissionId/cancel', requireJoiningEditAdmission, cancelAdmissionById);
router.post('/id/:admissionId/send-confirmation-sms', sendAdmissionConfirmationSmsById);
router.patch('/id/:admissionId/reference', requireJoiningEditReference, patchAdmissionReferenceById);
router.patch('/id/:admissionId/remarks', requireJoiningEditAdmission, patchAdmissionRemarksById);
router.put('/id/:admissionId', requireJoiningEditAdmission, updateAdmissionById);
router.put('/:leadId', requireJoiningEditAdmission, updateAdmissionByLead); // Keep for backward compatibility

export default router;


