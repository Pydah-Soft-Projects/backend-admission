import express from 'express';
import {
  logCallCommunication,
  sendSmsCommunication,
  sendTestTemplateSms,
  getLeadCommunications,
  getLeadCommunicationStats,
  getBulkSmsAccountStatus,
} from '../controllers/communication.controller.js';
import { 
  sendWhatsAppCommunication, 
  syncWhatsAppTemplates,
  uploadWhatsAppMedia,
  verifyWhatsAppContact,
  verifyWhatsAppWebhook,
  receiveWhatsAppWebhook,
  getWhatsAppConversations,
  getWhatsAppMessages,
  sendWhatsAppChatReply
} from '../controllers/whatsapp.controller.js';
import multer from 'multer';
import os from 'os';
import { extname } from 'path';

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = extname(file.originalname || '') || '.dat';
      cb(null, `wa-upload-${uniqueSuffix}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB limit for WhatsApp media
});
import {
  getTemplates,
  getActiveTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  hardDeleteTemplate,
  getTemplateGroups,
  createTemplateGroup,
  updateTemplateGroup,
  deleteTemplateGroup,
} from '../controllers/template.controller.js';
import {
  createBulkSmsJob,
  getBulkSmsJob,
  listBulkSmsJobs,
  resumeBulkSmsJob,
} from '../controllers/smsBulkJob.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

// Webhook for WhatsApp (Public)
router.get('/whatsapp/webhook', verifyWhatsAppWebhook);
router.post('/whatsapp/webhook', receiveWhatsAppWebhook);

router.use(protect);

// Template management
router.get('/templates/groups', isSuperAdmin, getTemplateGroups);
router.post('/templates/groups', isSuperAdmin, createTemplateGroup);
router.put('/templates/groups/:id', isSuperAdmin, updateTemplateGroup);
router.delete('/templates/groups/:id', isSuperAdmin, deleteTemplateGroup);
router.get('/templates/active', getActiveTemplates);
router.get('/templates', isSuperAdmin, getTemplates);
router.post('/templates', isSuperAdmin, createTemplate);
router.put('/templates/:id', isSuperAdmin, updateTemplate);
router.delete('/templates/:id', isSuperAdmin, deleteTemplate);
router.delete('/templates/:id/hard', isSuperAdmin, hardDeleteTemplate);
router.post('/templates/:id/test-sms', isSuperAdmin, sendTestTemplateSms);
router.post('/whatsapp/sync-templates', isSuperAdmin, syncWhatsAppTemplates);
router.post('/whatsapp/upload', isSuperAdmin, upload.single('file'), uploadWhatsAppMedia);
router.get('/sms/account', isSuperAdmin, getBulkSmsAccountStatus);

// Lead communications
router.post('/lead/:leadId/call', logCallCommunication);
router.post('/lead/:leadId/sms', sendSmsCommunication);
router.get('/lead/:leadId/history', getLeadCommunications);
router.get('/lead/:leadId/stats', getLeadCommunicationStats);
router.post('/lead/:leadId/whatsapp', sendWhatsAppCommunication);
router.get('/whatsapp/verify', verifyWhatsAppContact);

// Bulk SMS & WhatsApp Jobs
router.post('/sms-bulk/jobs', isSuperAdmin, createBulkSmsJob);
router.post('/whatsapp-bulk/jobs', isSuperAdmin, createBulkSmsJob);
router.get('/sms-bulk/jobs', isSuperAdmin, listBulkSmsJobs);
router.get('/sms-bulk/jobs/:id', isSuperAdmin, getBulkSmsJob);
router.post('/sms-bulk/jobs/:id/resume', resumeBulkSmsJob);

// WhatsApp Chat APIs
router.get('/whatsapp/conversations', getWhatsAppConversations);
router.get('/whatsapp/conversations/:conversationId/messages', getWhatsAppMessages);
router.post('/whatsapp/conversations/:conversationId/reply', sendWhatsAppChatReply);

export default router;
