import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { encryptSensitiveValue } from '../utils/encryption.util.js';
import { v4 as uuidv4 } from 'uuid';

const maskValue = (value = '') => {
  if (!value || value.length < 6) return '******';
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
};

// Helper function to format course data
const formatCourse = (courseData) => {
  if (!courseData) return null;
  return {
    id: courseData.id,
    _id: courseData.id,
    name: courseData.name,
    code: courseData.code,
    description: courseData.description,
    isActive: courseData.is_active === 1 || courseData.is_active === true,
    createdAt: courseData.created_at,
    updatedAt: courseData.updated_at,
  };
};

// Helper function to format branch data
const formatBranch = (branchData) => {
  if (!branchData) return null;
  return {
    id: branchData.id,
    _id: branchData.id,
    courseId: branchData.course_id,
    name: branchData.name,
    code: branchData.code,
    description: branchData.description,
    isActive: branchData.is_active === 1 || branchData.is_active === true,
    createdAt: branchData.created_at,
    updatedAt: branchData.updated_at,
  };
};

// Helper function to format payment config data
const formatPaymentConfig = (configData) => {
  if (!configData) return null;
  return {
    id: configData.id,
    _id: configData.id,
    courseId: configData.course_id,
    branchId: configData.branch_id,
    amount: parseFloat(configData.amount),
    currency: configData.currency,
    isActive: configData.is_active === 1 || configData.is_active === true,
    notes: configData.notes,
    createdBy: configData.created_by,
    updatedBy: configData.updated_by,
    createdAt: configData.created_at,
    updatedAt: configData.updated_at,
  };
};

export const getPaymentSettings = async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const pool = getPool();

    // Get courses
    let courseQuery = 'SELECT id, name, code, description, is_active, created_at, updated_at FROM courses';
    const courseParams = [];
    if (!showInactive) {
      courseQuery += ' WHERE is_active = ?';
      courseParams.push(true);
    }
    courseQuery += ' ORDER BY name ASC';

    const [courses] = await pool.execute(courseQuery, courseParams);
    const formattedCourses = courses.map(formatCourse);
    const courseIds = formattedCourses.map(c => c.id);

    if (courseIds.length === 0) {
      return successResponse(res, []);
    }

    // Get branches
    let branchQuery = 'SELECT id, course_id, name, code, description, is_active, created_at, updated_at FROM branches WHERE course_id IN (';
    branchQuery += courseIds.map(() => '?').join(',');
    branchQuery += ')';
    const branchParams = [...courseIds];
    if (!showInactive) {
      branchQuery += ' AND is_active = ?';
      branchParams.push(true);
    }
    branchQuery += ' ORDER BY name ASC';

    const [branches] = await pool.execute(branchQuery, branchParams);
    const formattedBranches = branches.map(formatBranch);

    // Get payment configs
    let configQuery = 'SELECT id, course_id, branch_id, amount, currency, is_active, notes, created_by, updated_by, created_at, updated_at FROM payment_configs WHERE course_id IN (';
    configQuery += courseIds.map(() => '?').join(',');
    configQuery += ')';
    const configParams = [...courseIds];
    if (!showInactive) {
      configQuery += ' AND is_active = ?';
      configParams.push(true);
    }
    configQuery += ' ORDER BY created_at DESC';

    const [configs] = await pool.execute(configQuery, configParams);
    const formattedConfigs = configs.map(formatPaymentConfig);

    // Group by course_id
    const configMap = formattedConfigs.reduce((acc, config) => {
      const key = config.courseId;
      if (!acc[key]) acc[key] = [];
      acc[key].push(config);
      return acc;
    }, {});

    const branchMap = formattedBranches.reduce((acc, branch) => {
      const key = branch.courseId;
      if (!acc[key]) acc[key] = [];
      acc[key].push(branch);
      return acc;
    }, {});

    const payload = formattedCourses.map((course) => {
      const courseKey = course.id;
      const relatedBranches = branchMap[courseKey] || [];
      const relatedConfigs = configMap[courseKey] || [];

      const defaultFee = relatedConfigs.find((config) => !config.branchId) || null;
      const branchFees = relatedConfigs
        .filter((config) => !!config.branchId)
        .map((config) => ({
          ...config,
          branch: relatedBranches.find((branch) => branch.id === config.branchId) || null,
        }));

      return {
        course,
        branches: relatedBranches,
        payment: {
          defaultFee,
          branchFees,
        },
      };
    });

    return successResponse(res, payload);
  } catch (error) {
    console.error('Get payment settings error:', error);
    return errorResponse(res, error.message || 'Failed to load payment settings', 500);
  }
};

export const getCourseFees = async (req, res) => {
  try {
    const { courseId } = req.params;
    const pool = getPool();

    // Get course
    const [courses] = await pool.execute(
      'SELECT id, name, code, description, is_active, created_at, updated_at FROM courses WHERE id = ?',
      [courseId]
    );

    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    const course = formatCourse(courses[0]);

    // Get branches
    const [branches] = await pool.execute(
      'SELECT id, course_id, name, code, description, is_active, created_at, updated_at FROM branches WHERE course_id = ? ORDER BY name ASC',
      [courseId]
    );
    const formattedBranches = branches.map(formatBranch);

    // Get payment configs
    const [configs] = await pool.execute(
      'SELECT id, course_id, branch_id, amount, currency, is_active, notes, created_by, updated_by, created_at, updated_at FROM payment_configs WHERE course_id = ?',
      [courseId]
    );
    const formattedConfigs = configs.map(formatPaymentConfig);

    const defaultFee = formattedConfigs.find((config) => !config.branchId) || null;
    const branchFees = formattedConfigs.filter((config) => !!config.branchId);

    const fees = formattedBranches.map((branch) => {
      const feeConfig = branchFees.find((config) => config.branchId === branch.id);
      return {
        branch,
        feeConfig: feeConfig || null,
      };
    });

    return successResponse(res, {
      course,
      fees,
      defaultFee,
    });
  } catch (error) {
    console.error('Get course fees error:', error);
    return errorResponse(res, error.message || 'Failed to load course fees', 500);
  }
};

export const upsertBranchFees = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { fees = [], defaultFee, currency = 'INR' } = req.body;
    const pool = getPool();
    const actorId = req.user?.id || req.user?._id;
    const normalizedCurrency = currency?.trim()?.toUpperCase() || 'INR';

    // Check if course exists
    const [courses] = await pool.execute(
      'SELECT id FROM courses WHERE id = ?',
      [courseId]
    );
    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    // Validate branches
    const branchIds = fees.map((entry) => entry.branchId).filter(Boolean);
    if (branchIds.length > 0) {
      const placeholders = branchIds.map(() => '?').join(',');
      const [branches] = await pool.execute(
        `SELECT id FROM branches WHERE course_id = ? AND id IN (${placeholders})`,
        [courseId, ...branchIds]
      );
      if (branches.length !== branchIds.length) {
        return errorResponse(res, 'One or more branches are invalid for the selected course', 400);
      }
    }

    // Handle default fee
    if (defaultFee !== undefined) {
      if (defaultFee === null) {
        // Deactivate default fee
        await pool.execute(
          'UPDATE payment_configs SET is_active = ?, updated_by = ?, updated_at = NOW() WHERE course_id = ? AND branch_id IS NULL',
          [false, actorId, courseId]
        );
      } else if (typeof defaultFee === 'number' && defaultFee >= 0) {
        // Check if default fee exists
        const [existing] = await pool.execute(
          'SELECT id FROM payment_configs WHERE course_id = ? AND branch_id IS NULL',
          [courseId]
        );

        if (existing.length > 0) {
          await pool.execute(
            'UPDATE payment_configs SET amount = ?, currency = ?, is_active = ?, updated_by = ?, updated_at = NOW() WHERE course_id = ? AND branch_id IS NULL',
            [defaultFee, normalizedCurrency, true, actorId, courseId]
          );
        } else {
          const configId = uuidv4();
          await pool.execute(
            'INSERT INTO payment_configs (id, course_id, branch_id, amount, currency, is_active, created_by, updated_by, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NOW(), NOW())',
            [configId, courseId, defaultFee, normalizedCurrency, true, actorId, actorId]
          );
        }
      } else {
        return errorResponse(res, 'Default fee must be a non-negative number or null', 422);
      }
    }

    // Handle branch fees
    for (const entry of fees) {
      if (!entry || typeof entry.branchId !== 'string' || entry.branchId.trim() === '') {
        continue;
      }

      if (typeof entry.amount !== 'number' || entry.amount < 0) {
        continue;
      }

      // Check if config exists
      const [existing] = await pool.execute(
        'SELECT id FROM payment_configs WHERE course_id = ? AND branch_id = ?',
        [courseId, entry.branchId]
      );

      if (existing.length > 0) {
        await pool.execute(
          'UPDATE payment_configs SET amount = ?, currency = ?, is_active = ?, updated_by = ?, updated_at = NOW() WHERE course_id = ? AND branch_id = ?',
          [entry.amount, normalizedCurrency, true, actorId, courseId, entry.branchId]
        );
      } else {
        const configId = uuidv4();
        await pool.execute(
          'INSERT INTO payment_configs (id, course_id, branch_id, amount, currency, is_active, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
          [configId, courseId, entry.branchId, entry.amount, normalizedCurrency, true, actorId, actorId]
        );
      }
    }

    // Fetch updated configs
    const [updatedConfigs] = await pool.execute(
      'SELECT id, course_id, branch_id, amount, currency, is_active, notes, created_by, updated_by, created_at, updated_at FROM payment_configs WHERE course_id = ?',
      [courseId]
    );
    const formattedConfigs = updatedConfigs.map(formatPaymentConfig);

    return successResponse(res, formattedConfigs, 'Payment configuration saved successfully');
  } catch (error) {
    console.error('Upsert branch fees error:', error);
    return errorResponse(res, error.message || 'Failed to update payment configuration', 500);
  }
};

export const deleteFeeConfig = async (req, res) => {
  try {
    const { courseId, configId } = req.params;
    const pool = getPool();

    // Check if config exists for this course
    const [configs] = await pool.execute(
      'SELECT id FROM payment_configs WHERE id = ? AND course_id = ?',
      [configId, courseId]
    );

    if (configs.length === 0) {
      return errorResponse(res, 'Fee configuration not found', 404);
    }

    // Delete config
    await pool.execute(
      'DELETE FROM payment_configs WHERE id = ?',
      [configId]
    );

    return successResponse(res, null, 'Fee configuration removed successfully');
  } catch (error) {
    console.error('Delete fee config error:', error);
    return errorResponse(res, error.message || 'Failed to remove fee configuration', 500);
  }
};

export const getCashfreeConfig = async (req, res) => {
  try {
    const pool = getPool();

    const [configs] = await pool.execute(
      'SELECT id, provider, display_name, client_id, client_secret, environment, is_active, updated_at FROM payment_gateway_configs WHERE provider = ?',
      ['cashfree']
    );

    if (configs.length === 0) {
      return successResponse(res, null, 'Cashfree configuration not found', 200);
    }

    const config = configs[0];
    const response = {
      provider: config.provider,
      displayName: config.display_name,
      environment: config.environment,
      isActive: config.is_active === 1 || config.is_active === true,
      updatedAt: config.updated_at,
      clientIdPreview: maskValue(config.client_id),
      clientSecretPreview: maskValue(config.client_secret),
    };

    return successResponse(res, response);
  } catch (error) {
    console.error('Get Cashfree config error:', error);
    return errorResponse(res, error.message || 'Failed to load Cashfree configuration', 500);
  }
};

export const updateCashfreeConfig = async (req, res) => {
  try {
    let { clientId, clientSecret, environment = 'sandbox', confirmChange = false } = req.body;
    const pool = getPool();
    const userId = req.user?.id || req.user?._id;

    if (!clientId || !clientSecret) {
      return errorResponse(res, 'Client ID and Client Secret are required', 422);
    }

    // Clean credentials: trim whitespace and remove newlines
    clientId = (clientId || '').trim().replace(/\r?\n/g, '').replace(/\s+/g, '');
    clientSecret = (clientSecret || '').trim().replace(/\r?\n/g, '').replace(/\s+/g, '');

    if (!clientId || !clientSecret || clientId === '' || clientSecret === '') {
      return errorResponse(res, 'Client ID and Client Secret cannot be empty after cleaning', 422);
    }

    if (!['sandbox', 'production'].includes(environment)) {
      return errorResponse(res, 'Environment must be sandbox or production', 422);
    }

    // Check if config exists
    const [existing] = await pool.execute(
      'SELECT id, client_id, client_secret, environment FROM payment_gateway_configs WHERE provider = ?',
      ['cashfree']
    );

    if (existing.length > 0) {
      const existingConfig = existing[0];
      // Decrypt existing credentials to compare (since we're comparing with plain text input)
      const { decryptSensitiveValue } = await import('../utils/encryption.util.js');
      const existingClientId = decryptSensitiveValue(existingConfig.client_id)?.trim().replace(/\r?\n/g, '').replace(/\s+/g, '') || '';
      const existingClientSecret = decryptSensitiveValue(existingConfig.client_secret)?.trim().replace(/\r?\n/g, '').replace(/\s+/g, '') || '';
      
      const hasChanges =
        existingClientId !== clientId ||
        existingClientSecret !== clientSecret ||
        existingConfig.environment !== environment;

      if (hasChanges && !confirmChange) {
        return res.status(409).json({
          success: false,
          message: 'Updating Cashfree credentials requires confirmation.',
          confirmationRequired: true,
        });
      }

      // Encrypt credentials before storing
      const encryptedClientId = encryptSensitiveValue(clientId);
      const encryptedClientSecret = encryptSensitiveValue(clientSecret);

      // Update existing config
      await pool.execute(
        'UPDATE payment_gateway_configs SET client_id = ?, client_secret = ?, environment = ?, is_active = ?, updated_by = ?, updated_at = NOW() WHERE provider = ?',
        [encryptedClientId, encryptedClientSecret, environment, true, userId, 'cashfree']
      );

      return successResponse(res, { acknowledged: true }, 'Cashfree configuration updated successfully');
    }

    // Encrypt credentials before storing
    const encryptedClientId = encryptSensitiveValue(clientId);
    const encryptedClientSecret = encryptSensitiveValue(clientSecret);

    // Create new config
    const configId = uuidv4();
    await pool.execute(
      'INSERT INTO payment_gateway_configs (id, provider, display_name, client_id, client_secret, environment, is_active, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [configId, 'cashfree', 'Cashfree', encryptedClientId, encryptedClientSecret, environment, true, userId]
    );

    return successResponse(res, { acknowledged: true }, 'Cashfree configuration saved successfully', 201);
  } catch (error) {
    console.error('Update Cashfree config error:', error);
    return errorResponse(res, error.message || 'Failed to update Cashfree configuration', 500);
  }
};



