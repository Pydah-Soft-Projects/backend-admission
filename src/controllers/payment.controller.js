import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import PaymentConfig from '../models/PaymentConfig.model.js';
import PaymentGatewayConfig from '../models/PaymentGatewayConfig.model.js';
import PaymentTransaction from '../models/PaymentTransaction.model.js';
import Joining from '../models/Joining.model.js';
import Admission from '../models/Admission.model.js';
import Course from '../models/Course.model.js';
import Branch from '../models/Branch.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { createOrder as cashfreeCreateOrder, getOrder as cashfreeGetOrder } from '../services/cashfree.service.js';

const toObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
};

const resolveConfiguredFee = async (courseId, branchId) => {
  if (!courseId) return 0;

  const branchObjectId = toObjectId(branchId);

  if (branchObjectId) {
    const branchFee = await PaymentConfig.findOne({
      courseId,
      branchId: branchObjectId,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();
    if (branchFee) {
      return branchFee.amount;
    }
  }

  const courseFee = await PaymentConfig.findOne({
    courseId,
    branchId: null,
    isActive: true,
  })
    .sort({ updatedAt: -1 })
    .lean();

  return courseFee ? courseFee.amount : 0;
};

const computeSummaryStatus = (summary) => {
  if (!summary.totalPaid || summary.totalPaid <= 0) {
    return 'not_started';
  }

  if (summary.balance <= 0.5) {
    return 'paid';
  }

  return 'partial';
};

const updatePaymentSummary = async ({
  joiningId,
  admissionId,
  leadId,
  courseId,
  branchId,
  amount,
  currency,
}) => {
  const updates = [];

  if (joiningId) {
    updates.push(
      Joining.findById(joiningId)
        .select('paymentSummary courseInfo')
        .then(async (joining) => {
          if (!joining) return;
          const summary = joining.paymentSummary || {
            totalFee: 0,
            totalPaid: 0,
            balance: 0,
            currency: currency || 'INR',
            status: 'not_started',
          };

          const resolvedCourseId = courseId || joining.courseInfo?.courseId;
          const resolvedBranchId = branchId || joining.courseInfo?.branchId;

          if (!summary.totalFee || summary.totalFee <= 0) {
            const configuredFee = await resolveConfiguredFee(resolvedCourseId, resolvedBranchId);
            if (configuredFee > 0) {
              summary.totalFee = configuredFee;
            }
          }

          summary.totalPaid = (summary.totalPaid || 0) + amount;
          if (summary.totalFee && summary.totalFee > 0) {
            summary.balance = Math.max(summary.totalFee - summary.totalPaid, 0);
          } else {
            summary.balance = 0;
          }
          summary.currency = currency || summary.currency || 'INR';
          summary.lastPaymentAt = new Date();
          summary.status = computeSummaryStatus(summary);

          joining.paymentSummary = summary;
          await joining.save();
        })
    );
  }

  if (admissionId) {
    updates.push(
      Admission.findById(admissionId)
        .select('paymentSummary courseInfo')
        .then(async (admission) => {
          if (!admission) return;
          const summary = admission.paymentSummary || {
            totalFee: 0,
            totalPaid: 0,
            balance: 0,
            currency: currency || 'INR',
            status: 'not_started',
          };

          const resolvedCourseId = courseId || admission.courseInfo?.courseId;
          const resolvedBranchId = branchId || admission.courseInfo?.branchId;

          if (!summary.totalFee || summary.totalFee <= 0) {
            const configuredFee = await resolveConfiguredFee(resolvedCourseId, resolvedBranchId);
            if (configuredFee > 0) {
              summary.totalFee = configuredFee;
            }
          }

          summary.totalPaid = (summary.totalPaid || 0) + amount;
          if (summary.totalFee && summary.totalFee > 0) {
            summary.balance = Math.max(summary.totalFee - summary.totalPaid, 0);
          } else {
            summary.balance = 0;
          }
          summary.currency = currency || summary.currency || 'INR';
          summary.lastPaymentAt = new Date();
          summary.status = computeSummaryStatus(summary);

          admission.paymentSummary = summary;
          await admission.save();
        })
    );
  }

  await Promise.all(updates);
};

export const listTransactions = async (req, res) => {
  try {
    const { leadId, admissionId, joiningId } = req.query;
    const filter = {};

    if (leadId) filter.leadId = leadId;
    if (admissionId) filter.admissionId = admissionId;
    if (joiningId) filter.joiningId = joiningId;

    const transactions = await PaymentTransaction.find(filter)
      .sort({ createdAt: -1 })
      .populate('collectedBy', 'name email roleName')
      .populate('courseId', 'name code')
      .populate('branchId', 'name code')
      .lean();

    return successResponse(res, transactions);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to load payment transactions', 500);
  }
};

export const recordCashPayment = async (req, res) => {
  try {
    const {
      leadId,
      joiningId,
      admissionId,
      courseId,
      branchId,
      amount,
      currency = 'INR',
      notes,
    } = req.body;

    if (!leadId) {
      return errorResponse(res, 'leadId is required', 422);
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    if (courseId) {
      const courseExists = await Course.exists({ _id: courseId });
      if (!courseExists) {
        return errorResponse(res, 'Invalid course specified', 400);
      }
    }

    if (branchId) {
      const branchExists = await Branch.exists({ _id: branchId });
      if (!branchExists) {
        return errorResponse(res, 'Invalid branch specified', 400);
      }
    }

    const transaction = await PaymentTransaction.create({
      leadId,
      joiningId,
      admissionId,
      courseId,
      branchId,
      amount,
      currency,
      mode: 'cash',
      status: 'success',
      collectedBy: req.user?._id,
      notes,
      processedAt: new Date(),
      verifiedAt: new Date(),
      meta: {
        recordedBy: req.user?._id,
      },
    });

    await updatePaymentSummary({
      joiningId,
      admissionId,
      leadId,
      courseId,
      branchId,
      amount,
      currency,
    });

    return successResponse(res, transaction, 'Cash payment recorded successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to record cash payment', 500);
  }
};

export const createCashfreeOrder = async (req, res) => {
  try {
    const {
      leadId,
      joiningId,
      admissionId,
      courseId,
      branchId,
      amount,
      currency = 'INR',
      customer = {},
      notes,
    } = req.body;

    if (!leadId) {
      return errorResponse(res, 'leadId is required', 422);
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    const config = await PaymentGatewayConfig.findOne({ provider: 'cashfree', isActive: true });
    if (!config) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const resolvedCourseId = courseId ? toObjectId(courseId) : null;
    const resolvedBranchId = branchId ? toObjectId(branchId) : null;

    const orderId = `ADM-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const payload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: customer.customerId || leadId,
        customer_name: customer.name || 'Prospective Student',
        customer_email: customer.email || 'placeholder@example.com',
        customer_phone: customer.phone || '9999999999',
      },
      order_meta: {
        notify_url: customer.notifyUrl || undefined,
      },
      notes: {
        ...notes,
        leadId,
        joiningId,
        admissionId,
      },
    };

    const orderResponse = await cashfreeCreateOrder({
      environment: config.environment,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      payload,
    });

    if (!orderResponse || !orderResponse.order_id || !orderResponse.payment_session_id) {
      return errorResponse(res, 'Failed to create Cashfree order', 502);
    }

    const transaction = await PaymentTransaction.create({
      leadId,
      joiningId,
      admissionId,
      courseId: resolvedCourseId,
      branchId: resolvedBranchId,
      amount,
      currency,
      mode: 'online',
      status: 'pending',
      cashfreeOrderId: orderResponse.order_id,
      cashfreePaymentSessionId: orderResponse.payment_session_id,
      notes,
      meta: {
        cashfree: orderResponse,
      },
    });

    return successResponse(
      res,
      {
        orderId: orderResponse.order_id,
        paymentSessionId: orderResponse.payment_session_id,
        order: orderResponse,
        transactionId: transaction._id,
      },
      'Cashfree order created successfully',
      201
    );
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to initiate online payment', 500);
  }
};

export const verifyCashfreePayment = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return errorResponse(res, 'orderId is required', 422);
    }

    const transaction = await PaymentTransaction.findOne({ cashfreeOrderId: orderId });
    if (!transaction) {
      return errorResponse(res, 'Transaction not found for the provided orderId', 404);
    }

    const config = await PaymentGatewayConfig.findOne({ provider: 'cashfree', isActive: true });
    if (!config) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const order = await cashfreeGetOrder({
      environment: config.environment,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      orderId,
    });

    if (!order || !order.order_status) {
      return errorResponse(res, 'Unable to verify payment status', 502);
    }

    const orderStatus = order.order_status.toLowerCase();
    let transactionStatus = 'pending';

    if (orderStatus === 'paid') {
      transactionStatus = 'success';
    } else if (['failed', 'cancelled', 'expired'].includes(orderStatus)) {
      transactionStatus = 'failed';
    }

    transaction.status = transactionStatus;
    transaction.referenceId = order.cf_payment_id || transaction.referenceId;
    transaction.meta = {
      ...transaction.meta,
      cashfreeVerification: order,
    };
    transaction.processedAt = order?.order_completed_time
      ? new Date(order.order_completed_time)
      : transaction.processedAt;
    transaction.verifiedAt = new Date();
    await transaction.save();

    if (transactionStatus === 'success') {
      await updatePaymentSummary({
        joiningId: transaction.joiningId,
        admissionId: transaction.admissionId,
        leadId: transaction.leadId,
        courseId: transaction.courseId,
        branchId: transaction.branchId,
        amount: transaction.amount,
        currency: transaction.currency,
      });
    }

    return successResponse(
      res,
      {
        status: transactionStatus,
        order,
        transaction,
      },
      'Payment status updated successfully'
    );
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to verify payment status', 500);
  }
};



