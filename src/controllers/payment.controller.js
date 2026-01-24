import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { createOrder as cashfreeCreateOrder, getOrder as cashfreeGetOrder } from '../services/cashfree.service.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';

const resolveConfiguredFee = async (courseId, branchId) => {
  if (!courseId) return 0;

  const pool = getPool(); // Primary DB for payment configs

  // Note: courseId and branchId are expected to be strings (from secondary DB int IDs converted to strings)
  // Try to find branch-specific fee first
  if (branchId) {
    const [branchFees] = await pool.execute(
      `SELECT amount FROM payment_configs 
       WHERE course_id = ? AND branch_id = ? AND is_active = 1 
       ORDER BY updated_at DESC LIMIT 1`,
      [courseId, branchId] // Both are strings
    );
    if (branchFees.length > 0) {
      return Number(branchFees[0].amount) || 0;
    }
  }

  // Fallback to course-level fee
  const [courseFees] = await pool.execute(
    `SELECT amount FROM payment_configs 
     WHERE course_id = ? AND branch_id IS NULL AND is_active = 1 
     ORDER BY updated_at DESC LIMIT 1`,
    [courseId] // courseId is string
  );

  return courseFees.length > 0 ? Number(courseFees[0].amount) || 0 : 0;
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
  const pool = getPool();
  const updates = [];

  if (joiningId) {
    updates.push(
      (async () => {
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [joiningId]
        );
        if (joinings.length === 0) return;

        const joining = joinings[0];
        let totalFee = Number(joining.payment_total_fee) || 0;
        let totalPaid = Number(joining.payment_total_paid) || 0;
        let balance = Number(joining.payment_balance) || 0;
        const currentCurrency = joining.payment_currency || currency || 'INR';

        const resolvedCourseId = courseId || joining.course_id;
        const resolvedBranchId = branchId || joining.branch_id;

        // Resolve fee if not set
        if (!totalFee || totalFee <= 0) {
          const configuredFee = await resolveConfiguredFee(resolvedCourseId, resolvedBranchId);
          if (configuredFee > 0) {
            totalFee = configuredFee;
          }
        }

        // Update payment summary
        totalPaid = totalPaid + amount;
        if (totalFee && totalFee > 0) {
          balance = Math.max(totalFee - totalPaid, 0);
        } else {
          balance = 0;
        }

        const status = computeSummaryStatus({
          totalPaid,
          balance,
        });

        await pool.execute(
          `UPDATE joinings SET
            payment_total_fee = ?,
            payment_total_paid = ?,
            payment_balance = ?,
            payment_currency = ?,
            payment_status = ?,
            payment_last_payment_at = NOW(),
            updated_at = NOW()
          WHERE id = ?`,
          [totalFee, totalPaid, balance, currentCurrency, status, joiningId]
        );
      })()
    );
  }

  if (admissionId) {
    updates.push(
      (async () => {
        const [admissions] = await pool.execute(
          'SELECT * FROM admissions WHERE id = ?',
          [admissionId]
        );
        if (admissions.length === 0) return;

        const admission = admissions[0];
        let totalFee = Number(admission.payment_total_fee) || 0;
        let totalPaid = Number(admission.payment_total_paid) || 0;
        let balance = Number(admission.payment_balance) || 0;
        const currentCurrency = admission.payment_currency || currency || 'INR';

        const resolvedCourseId = courseId || admission.course_id;
        const resolvedBranchId = branchId || admission.branch_id;

        // Resolve fee if not set
        if (!totalFee || totalFee <= 0) {
          const configuredFee = await resolveConfiguredFee(resolvedCourseId, resolvedBranchId);
          if (configuredFee > 0) {
            totalFee = configuredFee;
          }
        }

        // Update payment summary
        totalPaid = totalPaid + amount;
        if (totalFee && totalFee > 0) {
          balance = Math.max(totalFee - totalPaid, 0);
        } else {
          balance = 0;
        }

        const status = computeSummaryStatus({
          totalPaid,
          balance,
        });

        await pool.execute(
          `UPDATE admissions SET
            payment_total_fee = ?,
            payment_total_paid = ?,
            payment_balance = ?,
            payment_currency = ?,
            payment_status = ?,
            payment_last_payment_at = NOW(),
            updated_at = NOW()
          WHERE id = ?`,
          [totalFee, totalPaid, balance, currentCurrency, status, admissionId]
        );
      })()
    );
  }

  await Promise.all(updates);
};

// Helper function to format payment transaction
const formatPaymentTransaction = (transaction, collectedByUser = null, course = null, branch = null, joining = null, admission = null) => {
  if (!transaction) return null;
  return {
    _id: transaction.id,
    id: transaction.id,
    admissionId: transaction.admission_id,
    joiningId: transaction.joining_id,
    leadId: transaction.lead_id,
    courseId: transaction.course_id,
    branchId: transaction.branch_id,
    amount: Number(transaction.amount),
    currency: transaction.currency || 'INR',
    mode: transaction.mode,
    status: transaction.status,
    collectedBy: collectedByUser || transaction.collected_by,
    cashfreeOrderId: transaction.cashfree_order_id,
    cashfreePaymentSessionId: transaction.cashfree_payment_session_id,
    referenceId: transaction.reference_id,
    notes: transaction.notes,
    isAdditionalFee: transaction.is_additional_fee === 1 || transaction.is_additional_fee === true,
    meta: typeof transaction.meta === 'string' ? JSON.parse(transaction.meta) : transaction.meta || {},
    processedAt: transaction.processed_at,
    verifiedAt: transaction.verified_at,
    createdAt: transaction.created_at,
    updatedAt: transaction.updated_at,
    // Populated fields
    ...(collectedByUser && {
      collectedBy: {
        _id: collectedByUser.id,
        id: collectedByUser.id,
        name: collectedByUser.name,
        email: collectedByUser.email,
        roleName: collectedByUser.role_name,
      },
    }),
    ...(course && {
      courseId: {
        _id: course.id,
        id: course.id,
        name: course.name,
        code: course.code,
      },
    }),
    ...(branch && {
      branchId: {
        _id: branch.id,
        id: branch.id,
        name: branch.name,
        code: branch.code,
      },
    }),
    ...(joining && {
      joiningId: {
        _id: joining.id,
        id: joining.id,
        leadData: typeof joining.lead_data === 'string' ? JSON.parse(joining.lead_data) : joining.lead_data || {},
        courseInfo: {
          courseId: joining.course_id,
          branchId: joining.branch_id,
          course: joining.course || '',
          branch: joining.branch || '',
        },
        status: joining.status,
      },
    }),
    ...(admission && {
      admissionId: {
        _id: admission.id,
        id: admission.id,
        admissionNumber: admission.admission_number,
        leadData: typeof admission.lead_data === 'string' ? JSON.parse(admission.lead_data) : admission.lead_data || {},
        enquiryNumber: admission.enquiry_number,
        courseInfo: {
          courseId: admission.course_id,
          branchId: admission.branch_id,
          course: admission.course || '',
          branch: admission.branch || '',
        },
      },
    }),
  };
};

export const listTransactions = async (req, res) => {
  try {
    const { leadId, admissionId, joiningId } = req.query;
    const pool = getPool();

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    if (leadId) {
      conditions.push('pt.lead_id = ?');
      params.push(leadId);
    }
    if (admissionId) {
      conditions.push('pt.admission_id = ?');
      params.push(admissionId);
    }
    if (joiningId) {
      conditions.push('pt.joining_id = ?');
      params.push(joiningId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Fetch transactions with joins
    const [transactions] = await pool.execute(
      `SELECT 
        pt.*,
        u.id as collected_by_id, u.name as collected_by_name, u.email as collected_by_email, u.role_name as collected_by_role_name,
        c.id as course_id_full, c.name as course_name, c.code as course_code,
        b.id as branch_id_full, b.name as branch_name, b.code as branch_code,
        j.id as joining_id_full, j.lead_data as joining_lead_data, j.course_id as joining_course_id, 
        j.branch_id as joining_branch_id, j.course as joining_course, j.branch as joining_branch, j.status as joining_status,
        a.id as admission_id_full, a.admission_number, a.lead_data as admission_lead_data, a.enquiry_number,
        a.course_id as admission_course_id, a.branch_id as admission_branch_id, a.course as admission_course, a.branch as admission_branch
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.collected_by = u.id
      LEFT JOIN courses c ON pt.course_id = c.id
      LEFT JOIN branches b ON pt.branch_id = b.id
      LEFT JOIN joinings j ON pt.joining_id = j.id
      LEFT JOIN admissions a ON pt.admission_id = a.id
      ${whereClause}
      ORDER BY pt.created_at DESC`,
      params
    );

    // Format transactions
    const formattedTransactions = transactions.map((t) => {
      const collectedByUser = t.collected_by_id ? {
        id: t.collected_by_id,
        name: t.collected_by_name,
        email: t.collected_by_email,
        role_name: t.collected_by_role_name,
      } : null;

      const course = t.course_id_full ? {
        id: t.course_id_full,
        name: t.course_name,
        code: t.course_code,
      } : null;

      const branch = t.branch_id_full ? {
        id: t.branch_id_full,
        name: t.branch_name,
        code: t.branch_code,
      } : null;

      const joining = t.joining_id_full ? {
        id: t.joining_id_full,
        lead_data: t.joining_lead_data,
        course_id: t.joining_course_id,
        branch_id: t.joining_branch_id,
        course: t.joining_course,
        branch: t.joining_branch,
        status: t.joining_status,
      } : null;

      const admission = t.admission_id_full ? {
        id: t.admission_id_full,
        admission_number: t.admission_number,
        lead_data: t.admission_lead_data,
        enquiry_number: t.enquiry_number,
        course_id: t.admission_course_id,
        branch_id: t.admission_branch_id,
        course: t.admission_course,
        branch: t.admission_branch,
      } : null;

      return formatPaymentTransaction(t, collectedByUser, course, branch, joining, admission);
    });

    return successResponse(res, formattedTransactions);
  } catch (error) {
    console.error('Error listing transactions:', error);
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
      isAdditionalFee = false,
    } = req.body;

    const pool = getPool();

    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 422);
    }
    
    // Get leadId from joining if not provided
    let finalLeadId = leadId;
    if (!finalLeadId && joiningId) {
      const [joinings] = await pool.execute(
        'SELECT lead_id FROM joinings WHERE id = ?',
        [joiningId]
      );
      if (joinings.length > 0 && joinings[0].lead_id) {
        finalLeadId = joinings[0].lead_id;
      }
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    // Validate course
    if (courseId) {
      const [courses] = await pool.execute(
        'SELECT id FROM courses WHERE id = ?',
        [courseId]
      );
      if (courses.length === 0) {
        return errorResponse(res, 'Invalid course specified', 400);
      }
    }

    // Validate branch
    if (branchId) {
      const [branches] = await pool.execute(
        'SELECT id FROM branches WHERE id = ?',
        [branchId]
      );
      if (branches.length === 0) {
        return errorResponse(res, 'Invalid branch specified', 400);
      }
    }

    // Create transaction
    const transactionId = uuidv4();
    await pool.execute(
      `INSERT INTO payment_transactions (
        id, lead_id, joining_id, admission_id, course_id, branch_id,
        amount, currency, mode, status, collected_by, notes,
        is_additional_fee, meta, processed_at, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW(), NOW())`,
      [
        transactionId,
        finalLeadId || null,
        joiningId,
        admissionId || null,
        courseId || null,
        branchId || null,
        amount,
        currency.toUpperCase(),
        'cash',
        'success',
        req.user?.id || null,
        notes || null,
        isAdditionalFee === true ? 1 : 0,
        JSON.stringify({
          recordedBy: req.user?.id || null,
          isAdditionalFee,
        }),
      ]
    );

    // Update payment summary
    await updatePaymentSummary({
      joiningId,
      admissionId,
      leadId: finalLeadId,
      courseId,
      branchId,
      amount,
      currency,
    });

    // Fetch created transaction
    const [transactions] = await pool.execute(
      `SELECT pt.*,
        u.id as collected_by_id, u.name as collected_by_name, u.email as collected_by_email, u.role_name as collected_by_role_name
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.collected_by = u.id
      WHERE pt.id = ?`,
      [transactionId]
    );

    const transaction = formatPaymentTransaction(
      transactions[0],
      transactions[0].collected_by_id ? {
        id: transactions[0].collected_by_id,
        name: transactions[0].collected_by_name,
        email: transactions[0].collected_by_email,
        role_name: transactions[0].collected_by_role_name,
      } : null
    );

    return successResponse(res, transaction, 'Cash payment recorded successfully', 201);
  } catch (error) {
    console.error('Error recording cash payment:', error);
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
      isAdditionalFee = false,
    } = req.body;

    const pool = getPool();

    if (!joiningId) {
      return errorResponse(res, 'joiningId is required', 422);
    }
    
    // Get leadId from joining if not provided
    let finalLeadId = leadId;
    if (!finalLeadId && joiningId) {
      const [joinings] = await pool.execute(
        'SELECT lead_id FROM joinings WHERE id = ?',
        [joiningId]
      );
      if (joinings.length > 0 && joinings[0].lead_id) {
        finalLeadId = joinings[0].lead_id;
      }
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return errorResponse(res, 'Amount must be a positive number', 422);
    }

    // Get Cashfree config
    const [configs] = await pool.execute(
      `SELECT * FROM payment_gateway_configs WHERE provider = 'cashfree' AND is_active = 1 LIMIT 1`
    );
    if (configs.length === 0) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const config = configs[0];
    let clientId = decryptSensitiveValue(config.client_id);
    let clientSecret = decryptSensitiveValue(config.client_secret);

    // Trim whitespace and newlines from credentials
    if (clientId) {
      clientId = clientId.trim().replace(/\r?\n/g, '').replace(/\s+/g, '');
    }
    if (clientSecret) {
      clientSecret = clientSecret.trim().replace(/\r?\n/g, '').replace(/\s+/g, '');
    }

    if (!clientId || !clientSecret || clientId === '' || clientSecret === '') {
      console.error('Cashfree credentials missing or invalid:', {
        hasClientId: !!config.client_id,
        hasClientSecret: !!config.client_secret,
        clientIdLength: clientId?.length || 0,
        clientSecretLength: clientSecret?.length || 0,
        environment: config.environment,
        clientIdIsEmpty: !clientId || clientId === '',
        clientSecretIsEmpty: !clientSecret || clientSecret === '',
        rawClientIdLength: config.client_id?.length || 0,
        rawClientSecretLength: config.client_secret?.length || 0,
      });
      return errorResponse(
        res,
        'Cashfree credentials are misconfigured. Please update them in Payment Settings.',
        503
      );
    }

    // Validate credential format (basic checks)
    // Cashfree client IDs are typically numeric or alphanumeric
    // Cashfree client secrets typically start with 'cfsk_' for sandbox or 'cfsk_ma_' for production
    if (clientSecret.length < 20) {
      console.warn('Cashfree client secret seems too short. Expected length: 20+ characters');
    }
    if (clientId.length < 5) {
      console.warn('Cashfree client ID seems too short. Expected length: 5+ characters');
    }

    // Log credential info (without exposing secrets) - for debugging
    console.log('Using Cashfree config:', {
      environment: config.environment,
      clientIdLength: clientId.length,
      clientIdPrefix: clientId.length > 8 ? clientId.substring(0, 8) + '...' : '***',
      clientIdSuffix: clientId.length > 8 ? '...' + clientId.substring(clientId.length - 4) : '***',
      clientSecretLength: clientSecret.length,
      clientSecretPrefix: clientSecret.length > 8 ? clientSecret.substring(0, 8) + '...' : '***',
      clientSecretSuffix: clientSecret.length > 8 ? '...' + clientSecret.substring(clientSecret.length - 4) : '***',
      // Check for common issues
      clientIdHasWhitespace: clientId !== clientId.trim(),
      clientSecretHasWhitespace: clientSecret !== clientSecret.trim(),
      clientIdStartsWithSpace: clientId.startsWith(' ') || clientId.startsWith('\n') || clientId.startsWith('\t'),
      clientSecretStartsWithSpace: clientSecret.startsWith(' ') || clientSecret.startsWith('\n') || clientSecret.startsWith('\t'),
    });

    const orderId = `ADM-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    const payload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: customer.customerId || finalLeadId,
        customer_name: customer.name || 'Prospective Student',
        customer_email: customer.email || 'placeholder@example.com',
        customer_phone: customer.phone || '9999999999',
      },
      order_meta: {
        notify_url: customer.notifyUrl || undefined,
      },
      notes: {
        ...notes,
        leadId: finalLeadId,
        joiningId,
        admissionId,
      },
    };

    const environment = config.environment || 'production';

    let orderResponse;
    try {
      orderResponse = await cashfreeCreateOrder({
        environment,
        clientId,
        clientSecret,
        payload,
      });
    } catch (cashfreeError) {
      console.error('Cashfree API error details:', {
        message: cashfreeError.message,
        environment,
        orderId: payload.order_id,
        amount: payload.order_amount,
        currency: payload.order_currency,
        clientIdLength: clientId.length,
        clientIdPrefix: clientId.substring(0, 8) + '...',
        clientSecretLength: clientSecret.length,
        clientSecretPrefix: clientSecret.substring(0, 8) + '...',
        // Don't log full credentials
      });
      
      // Provide more helpful error message
      if (cashfreeError.message && cashfreeError.message.toLowerCase().includes('authentication')) {
        return errorResponse(
          res,
          'Cashfree authentication failed. Please verify your Client ID and Client Secret are correct and match the selected environment (sandbox/production).',
          401
        );
      }
      
      throw cashfreeError;
    }

    if (!orderResponse || !orderResponse.order_id || !orderResponse.payment_session_id) {
      return errorResponse(res, 'Failed to create Cashfree order', 502);
    }

    // Create transaction
    const transactionId = uuidv4();
    await pool.execute(
      `INSERT INTO payment_transactions (
        id, lead_id, joining_id, admission_id, course_id, branch_id,
        amount, currency, mode, status, cashfree_order_id, cashfree_payment_session_id,
        notes, is_additional_fee, meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        transactionId,
        finalLeadId || null,
        joiningId,
        admissionId || null,
        courseId || null,
        branchId || null,
        amount,
        currency.toUpperCase(),
        'online',
        'pending',
        orderResponse.order_id,
        orderResponse.payment_session_id,
        notes || null,
        isAdditionalFee === true ? 1 : 0,
        JSON.stringify({
          cashfree: orderResponse,
          isAdditionalFee,
        }),
      ]
    );

    return successResponse(
      res,
      {
        orderId: orderResponse.order_id,
        paymentSessionId: orderResponse.payment_session_id,
        order: orderResponse,
        transactionId,
      },
      'Cashfree order created successfully',
      201
    );
  } catch (error) {
    console.error('Error creating Cashfree order:', error);
    return errorResponse(res, error.message || 'Failed to initiate online payment', 500);
  }
};

export const verifyCashfreePayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    const pool = getPool();

    if (!orderId) {
      return errorResponse(res, 'orderId is required', 422);
    }

    // Find transaction
    const [transactions] = await pool.execute(
      'SELECT * FROM payment_transactions WHERE cashfree_order_id = ?',
      [orderId]
    );
    if (transactions.length === 0) {
      return errorResponse(res, 'Transaction not found for the provided orderId', 404);
    }

    const transaction = transactions[0];

    // Get Cashfree config
    const [configs] = await pool.execute(
      `SELECT * FROM payment_gateway_configs WHERE provider = 'cashfree' AND is_active = 1 LIMIT 1`
    );
    if (configs.length === 0) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const config = configs[0];
    const clientId = decryptSensitiveValue(config.client_id);
    const clientSecret = decryptSensitiveValue(config.client_secret);

    if (!clientId || !clientSecret) {
      return errorResponse(
        res,
        'Cashfree credentials are misconfigured. Please update them in Payment Settings.',
        503
      );
    }

    const environment = config.environment || 'production';

    const order = await cashfreeGetOrder({
      environment,
      clientId,
      clientSecret,
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

    // Parse existing meta
    const existingMeta = typeof transaction.meta === 'string' 
      ? JSON.parse(transaction.meta) 
      : transaction.meta || {};

    // Update transaction
    await pool.execute(
      `UPDATE payment_transactions SET
        status = ?,
        reference_id = ?,
        meta = ?,
        processed_at = ?,
        verified_at = NOW(),
        updated_at = NOW()
      WHERE id = ?`,
      [
        transactionStatus,
        order.cf_payment_id || transaction.reference_id || null,
        JSON.stringify({
          ...existingMeta,
          cashfreeVerification: order,
        }),
        order?.order_completed_time ? new Date(order.order_completed_time) : transaction.processed_at,
        transaction.id,
      ]
    );

    // Update payment summary if successful
    if (transactionStatus === 'success') {
      await updatePaymentSummary({
        joiningId: transaction.joining_id,
        admissionId: transaction.admission_id,
        leadId: transaction.lead_id,
        courseId: transaction.course_id,
        branchId: transaction.branch_id,
        amount: Number(transaction.amount),
        currency: transaction.currency,
      });
    }

    // Fetch updated transaction
    const [updated] = await pool.execute(
      'SELECT * FROM payment_transactions WHERE id = ?',
      [transaction.id]
    );

    const formattedTransaction = formatPaymentTransaction(updated[0]);

    return successResponse(
      res,
      {
        status: transactionStatus,
        order,
        transaction: formattedTransaction,
      },
      'Payment status updated successfully'
    );
  } catch (error) {
    console.error('Error verifying Cashfree payment:', error);
    return errorResponse(res, error.message || 'Failed to verify payment status', 500);
  }
};

export const reconcilePendingTransactions = async (req, res) => {
  try {
    const pool = getPool();

    // Get Cashfree config
    const [configs] = await pool.execute(
      `SELECT * FROM payment_gateway_configs WHERE provider = 'cashfree' AND is_active = 1 LIMIT 1`
    );
    if (configs.length === 0) {
      return errorResponse(res, 'Cashfree configuration is not set', 503);
    }

    const config = configs[0];
    const clientId = decryptSensitiveValue(config.client_id);
    const clientSecret = decryptSensitiveValue(config.client_secret);

    if (!clientId || !clientSecret) {
      return errorResponse(
        res,
        'Cashfree credentials are misconfigured. Please update them in Payment Settings.',
        503
      );
    }

    // Find all pending transactions with cashfreeOrderId
    const [pendingTransactions] = await pool.execute(
      `SELECT * FROM payment_transactions 
       WHERE status = 'pending' 
       AND mode = 'online' 
       AND cashfree_order_id IS NOT NULL 
       AND cashfree_order_id != ''`
    );

    if (pendingTransactions.length === 0) {
      return successResponse(
        res,
        {
          checked: 0,
          updated: 0,
          failed: 0,
          results: [],
        },
        'No pending transactions to reconcile'
      );
    }

    const environment = config.environment || 'production';
    const results = [];
    let updatedCount = 0;
    let failedCount = 0;

    // Process each transaction
    for (const transaction of pendingTransactions) {
      try {
        const order = await cashfreeGetOrder({
          environment,
          clientId,
          clientSecret,
          orderId: transaction.cashfree_order_id,
        });

        if (!order || !order.order_status) {
          results.push({
            transactionId: transaction.id,
            orderId: transaction.cashfree_order_id,
            status: 'error',
            message: 'Unable to verify payment status from Cashfree',
          });
          failedCount++;
          continue;
        }

        const orderStatus = order.order_status.toLowerCase();
        let transactionStatus = 'pending';

        if (orderStatus === 'paid') {
          transactionStatus = 'success';
        } else if (['failed', 'cancelled', 'expired'].includes(orderStatus)) {
          transactionStatus = 'failed';
        }

        // Only update if status changed
        if (transactionStatus !== 'pending') {
          // Parse existing meta
          const existingMeta = typeof transaction.meta === 'string' 
            ? JSON.parse(transaction.meta) 
            : transaction.meta || {};

          await pool.execute(
            `UPDATE payment_transactions SET
              status = ?,
              reference_id = ?,
              meta = ?,
              processed_at = ?,
              verified_at = NOW(),
              updated_at = NOW()
            WHERE id = ?`,
            [
              transactionStatus,
              order.cf_payment_id || transaction.reference_id || null,
              JSON.stringify({
                ...existingMeta,
                cashfreeVerification: order,
              }),
              order?.order_completed_time ? new Date(order.order_completed_time) : transaction.processed_at,
              transaction.id,
            ]
          );

          // Update payment summary if successful
          if (transactionStatus === 'success') {
            await updatePaymentSummary({
              joiningId: transaction.joining_id,
              admissionId: transaction.admission_id,
              leadId: transaction.lead_id,
              courseId: transaction.course_id,
              branchId: transaction.branch_id,
              amount: Number(transaction.amount),
              currency: transaction.currency,
            });
          }

          updatedCount++;
          results.push({
            transactionId: transaction.id,
            orderId: transaction.cashfree_order_id,
            status: transactionStatus,
            message: `Status updated to ${transactionStatus}`,
          });
        } else {
          results.push({
            transactionId: transaction.id,
            orderId: transaction.cashfree_order_id,
            status: 'pending',
            message: 'Still pending at Cashfree',
          });
        }
      } catch (error) {
        console.error(`Error reconciling transaction ${transaction.id}:`, error);
        results.push({
          transactionId: transaction.id,
          orderId: transaction.cashfree_order_id,
          status: 'error',
          message: error.message || 'Failed to reconcile',
        });
        failedCount++;
      }
    }

    return successResponse(
      res,
      {
        checked: pendingTransactions.length,
        updated: updatedCount,
        failed: failedCount,
        results: results.slice(0, 100), // Limit results to first 100
      },
      `Reconciled ${pendingTransactions.length} pending transactions. ${updatedCount} updated, ${failedCount} failed.`
    );
  } catch (error) {
    console.error('Error reconciling pending transactions:', error);
    return errorResponse(res, error.message || 'Failed to reconcile pending transactions', 500);
  }
};



