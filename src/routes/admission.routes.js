import express from 'express';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';
import {
  listAdmissions,
  getAdmissionByLead,
  updateAdmissionByLead,
} from '../controllers/admission.controller.js';

const router = express.Router();

router.use(protect);

router.get('/', listAdmissions);
router.get('/:leadId', getAdmissionByLead);
router.put('/:leadId', isSuperAdmin, updateAdmissionByLead);

export default router;


