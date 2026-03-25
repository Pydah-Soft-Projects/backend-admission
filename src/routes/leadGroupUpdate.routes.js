import express from 'express';
import { bulkUpdateLeadGroups, executeLeadGroupSync, getStagedCount, revertManualUpdateFlag } from '../controllers/leadGroupUpdate.controller.js';
import multer from 'multer';
import os from 'os';
import { extname } from 'path';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = extname(file.originalname || '') || '.dat';
      cb(null, `group-update-${uniqueSuffix}${ext}`);
    },
  }),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB limit
  },
});

// Bulk group update route (Super Admin only)
router.post('/bulk-group-update', protect, isSuperAdmin, upload.single('file'), bulkUpdateLeadGroups);

// Execute final sync route (Super Admin only)
router.post('/execute-group-sync', protect, isSuperAdmin, executeLeadGroupSync);

// Get staged count (Super Admin only)
router.get('/staged-count', protect, isSuperAdmin, getStagedCount);

// Revert sync flag (Super Admin only)
router.post('/revert-group-sync-flag', protect, isSuperAdmin, revertManualUpdateFlag);

export default router;
