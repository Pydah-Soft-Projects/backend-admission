import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  listFeeRequests,
  submitFeeRequest,
  approveFeeRequest,
  rejectFeeRequest,
  getPendingFeeRequestForJoining,
} from '../controllers/feeRequest.controller.js';

const router = express.Router();

router.use(protect);

router.get('/', listFeeRequests);
router.get('/joining/:joiningId/pending', getPendingFeeRequestForJoining);
router.post('/submit', submitFeeRequest);
router.post('/:id/approve', approveFeeRequest);
router.post('/:id/reject', rejectFeeRequest);

export default router;
