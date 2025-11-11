import express from 'express';
import {
  getCashfreeConfig,
  getCourseFees,
  getPaymentSettings,
  updateCashfreeConfig,
  upsertBranchFees,
  deleteFeeConfig,
} from '../controllers/paymentConfig.controller.js';
import {
  createCashfreeOrder,
  listTransactions,
  recordCashPayment,
  verifyCashfreePayment,
} from '../controllers/payment.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect);

// payment settings - super admin only
router.get('/settings', isSuperAdmin, getPaymentSettings);
router.get('/settings/courses/:courseId/fees', isSuperAdmin, getCourseFees);
router.put('/settings/courses/:courseId/fees', isSuperAdmin, upsertBranchFees);
router.delete('/settings/courses/:courseId/fees/:configId', isSuperAdmin, deleteFeeConfig);

router.get('/settings/cashfree', isSuperAdmin, getCashfreeConfig);
router.put('/settings/cashfree', isSuperAdmin, updateCashfreeConfig);

// payment transactions
router.get('/transactions', listTransactions);
router.post('/cash', recordCashPayment);
router.post('/cashfree/order', createCashfreeOrder);
router.post('/cashfree/verify', verifyCashfreePayment);

export default router;



