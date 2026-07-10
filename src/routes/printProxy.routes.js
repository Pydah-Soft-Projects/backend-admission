import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import { handlePrintProxy } from '../controllers/printProxy.controller.js';

const router = express.Router();

// Verify that the logged-in Admissions user has permission to perform the action
router.use(protect);

router.get('/:service', handlePrintProxy);
router.post('/:service', handlePrintProxy);

export default router;
