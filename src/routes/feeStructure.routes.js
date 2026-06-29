import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  listFeeHeads,
  listFeeStructures,
  listFeeStructureOptions,
} from '../controllers/feeStructure.controller.js';

const router = express.Router();

router.use(protect);

router.get('/fee-heads', listFeeHeads);
router.get('/', listFeeStructures);
router.get('/options', listFeeStructureOptions);

export default router;
