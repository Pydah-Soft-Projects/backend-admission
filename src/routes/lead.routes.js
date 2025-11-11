import express from 'express';
import {
  getLeads,
  getLead,
  createLead,
  createPublicLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  getAllLeadIds,
  getFilterOptions,
  getPublicFilterOptions,
} from '../controllers/lead.controller.js';
import {
  inspectBulkUpload,
  bulkUploadLeads,
  getUploadStats,
} from '../controllers/leadUpload.controller.js';
import multer from 'multer';
import os from 'os';
import { extname } from 'path';
import {
  addActivity,
  getActivityLogs,
} from '../controllers/activityLog.controller.js';
import {
  assignLeads,
  getUserLeadAnalytics,
} from '../controllers/leadAssignment.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = extname(file.originalname || '') || '.dat';
      cb(null, `bulk-upload-${uniqueSuffix}${ext}`);
    },
  }),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB limit to accommodate large workbooks
  },
});

// Public routes (no authentication required)
router.post('/public', createPublicLead);
router.get('/filters/options/public', getPublicFilterOptions);

// All other routes require authentication
router.use(protect);

// Filter options route (available to all authenticated users)
router.get('/filters/options', getFilterOptions);

// Get all lead IDs route (for bulk operations)
router.get('/ids', getAllLeadIds);

// Bulk upload routes (Super Admin only)
router.post('/bulk-upload/inspect', isSuperAdmin, upload.single('file'), inspectBulkUpload);
router.post('/bulk-upload', isSuperAdmin, upload.single('file'), bulkUploadLeads);
router.get('/upload-stats', isSuperAdmin, getUploadStats);

// Bulk delete route (Super Admin only)
router.delete('/bulk', isSuperAdmin, bulkDeleteLeads);

// Assignment routes (Super Admin only)
router.post('/assign', isSuperAdmin, assignLeads);

// Analytics routes
router.get('/analytics/:userId', getUserLeadAnalytics);

// Activity log routes (must come before /:id routes)
router.post('/:leadId/activity', addActivity);
router.get('/:leadId/activity', getActivityLogs);

// CRUD routes
router.route('/').get(getLeads).post(createLead);
router.route('/:id').get(getLead).put(updateLead).delete(isSuperAdmin, deleteLead);

export default router;

