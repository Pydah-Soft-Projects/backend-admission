import express from 'express';
import {
  logCallCommunication,
  sendSmsCommunication,
  sendTestTemplateSms,
  getLeadCommunications,
  getLeadCommunicationStats,
} from '../controllers/communication.controller.js';
import {
  getTemplates,
  getActiveTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  hardDeleteTemplate,
} from '../controllers/template.controller.js';
import {
  createBulkSmsJob,
  getBulkSmsJob,
  listBulkSmsJobs,
  resumeBulkSmsJob,
} from '../controllers/smsBulkJob.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect);

// Template management
router.get('/templates/active', getActiveTemplates);
router.get('/templates', isSuperAdmin, getTemplates);
router.post('/templates', isSuperAdmin, createTemplate);
router.put('/templates/:id', isSuperAdmin, updateTemplate);
router.delete('/templates/:id', isSuperAdmin, deleteTemplate);
router.delete('/templates/:id/hard', isSuperAdmin, hardDeleteTemplate);
router.post('/templates/:id/test-sms', isSuperAdmin, sendTestTemplateSms);

// Lead communications
router.post('/lead/:leadId/call', logCallCommunication);
router.post('/lead/:leadId/sms', sendSmsCommunication);
router.get('/lead/:leadId/history', getLeadCommunications);
router.get('/lead/:leadId/stats', getLeadCommunicationStats);

// Super Admin: large bulk SMS (background + reports)
router.post('/sms-bulk/jobs', isSuperAdmin, createBulkSmsJob);
router.get('/sms-bulk/jobs', isSuperAdmin, listBulkSmsJobs);
router.get('/sms-bulk/jobs/:id', isSuperAdmin, getBulkSmsJob);
router.post('/sms-bulk/jobs/:id/resume', resumeBulkSmsJob);

export default router;

