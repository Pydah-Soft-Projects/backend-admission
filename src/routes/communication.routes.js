import express from 'express';
import {
  logCallCommunication,
  sendSmsCommunication,
  getLeadCommunications,
  getLeadCommunicationStats,
} from '../controllers/communication.controller.js';
import {
  getTemplates,
  getActiveTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '../controllers/template.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect);

// Template management
router.get('/templates/active', getActiveTemplates);
router.get('/templates', isSuperAdmin, getTemplates);
router.post('/templates', isSuperAdmin, createTemplate);
router.put('/templates/:id', isSuperAdmin, updateTemplate);
router.delete('/templates/:id', isSuperAdmin, deleteTemplate);

// Lead communications
router.post('/lead/:leadId/call', logCallCommunication);
router.post('/lead/:leadId/sms', sendSmsCommunication);
router.get('/lead/:leadId/history', getLeadCommunications);
router.get('/lead/:leadId/stats', getLeadCommunicationStats);

export default router;

