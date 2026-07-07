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
  getOverallConcessions,
  listFeeManagementTransactions,
  listTransactions,
  recordFeeManagementTransaction,
  recordCashPayment,
  reconcilePendingTransactions,
  verifyCashfreePayment,
  createRazorpayQR,
  verifyRazorpayQR,
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
router.get('/overall-concessions', getOverallConcessions);
router.get('/fee-management/transactions', listFeeManagementTransactions);
router.post('/fee-management/transactions', recordFeeManagementTransaction);
router.post('/cash', recordCashPayment);
router.post('/cashfree/order', createCashfreeOrder);
router.post('/cashfree/verify', verifyCashfreePayment);
router.post('/cashfree/reconcile', isSuperAdmin, reconcilePendingTransactions);
router.post('/razorpay/qr', createRazorpayQR);
router.post('/razorpay/verify-qr', verifyRazorpayQR);

export default router;



