import express from 'express';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';
import {
  listAdmissions,
  getAdmissionById,
  getAdmissionByJoiningId,
  getAdmissionByLead,
  updateAdmissionById,
  updateAdmissionByLead,
} from '../controllers/admission.controller.js';

const router = express.Router();

router.use(protect);

router.get('/', listAdmissions);
router.get('/id/:admissionId', getAdmissionById);
router.get('/joining/:joiningId', getAdmissionByJoiningId);
router.get('/:leadId', getAdmissionByLead); // Keep for backward compatibility
router.put('/id/:admissionId', isSuperAdmin, updateAdmissionById);
router.put('/:leadId', isSuperAdmin, updateAdmissionByLead); // Keep for backward compatibility

export default router;


