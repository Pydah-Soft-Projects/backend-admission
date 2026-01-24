import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { encryptSensitiveValue } from '../utils/encryption.util.js';
import { v4 as uuidv4 } from 'uuid';

const maskValue = (value = '') => {
  if (!value || value.length < 6) return '******';
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
};

// Helper function to format course data from secondary database
const formatCourse = (courseData) => {
  if (!courseData) return null;
  const courseId = String(courseData.id); // Convert int to string for payment configs
  return {
    id: courseId,
    _id: courseId, // Keep _id for backward compatibility
    name: courseData.name,
    code: courseData.code || null,
    description: courseData.metadata?.description || null, // Extract from metadata if available
    isActive: courseData.is_active === 1 || courseData.is_active === true,
    // Additional fields from secondary DB
    collegeId: courseData.college_id ? String(courseData.college_id) : null,
    totalYears: courseData.total_years || null,
    semestersPerYear: courseData.semesters_per_year || null,
    yearSemesterConfig: courseData.year_semester_config || null,
    metadata: courseData.metadata || null,
    createdAt: courseData.created_at,
    updatedAt: courseData.updated_at,
  };
};

// Helper function to format branch data from secondary database
const formatBranch = (branchData) => {
  if (!branchData) return null;
  const branchId = String(branchData.id); // Convert int to string
  const courseId = String(branchData.course_id); // Convert int to string
  return {
    id: branchId,
    _id: branchId, // Keep _id for backward compatibility
    courseId: courseId,
    name: branchData.name,
    code: branchData.code || null,
    description: branchData.metadata?.description || null, // Extract from metadata if available
    isActive: branchData.is_active === 1 || branchData.is_active === true,
    // Additional fields from secondary DB
    totalYears: branchData.total_years || null,
    semestersPerYear: branchData.semesters_per_year || null,
    yearSemesterConfig: branchData.year_semester_config || null,
    metadata: branchData.metadata || null,
    academicYearId: branchData.academic_year_id ? String(branchData.academic_year_id) : null,
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
    const secondaryPool = getSecondaryPool(); // Secondary DB for courses/branches
    const primaryPool = getPool(); // Primary DB for payment configs

    // Get courses from secondary database
    let courseQuery = 'SELECT id, college_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, created_at, updated_at FROM courses';
    const courseParams = [];
    if (!showInactive) {
      courseQuery += ' WHERE is_active = ?';
      courseParams.push(1); // tinyint(1) uses 1 for true
    }
    courseQuery += ' ORDER BY name ASC';

    const [courses] = await secondaryPool.execute(courseQuery, courseParams);
    const formattedCourses = courses.map(formatCourse);
    const courseIds = formattedCourses.map(c => c.id); // These are now strings

    if (courseIds.length === 0) {
      return successResponse(res, []);
    }

    // Get branches from secondary database
    const courseIdsInt = formattedCourses.map(c => parseInt(c.id)); // Convert back to int for query
    let branchQuery = 'SELECT DISTINCT id, course_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, academic_year_id, created_at, updated_at FROM course_branches WHERE course_id IN (';
    branchQuery += courseIdsInt.map(() => '?').join(',');
    branchQuery += ')';
    const branchParams = [...courseIdsInt];
    if (!showInactive) {
      branchQuery += ' AND is_active = ?';
      branchParams.push(1); // tinyint(1) uses 1 for true
    }
    branchQuery += ' ORDER BY name ASC';

    const [branches] = await secondaryPool.execute(branchQuery, branchParams);
    const formattedBranches = branches.map(formatBranch);

    // Deduplicate branches by ID (in case of any duplicates from secondary DB)
    const uniqueBranchesMap = new Map();
    formattedBranches.forEach((branch) => {
      const branchId = branch.id || branch._id;
      if (branchId && !uniqueBranchesMap.has(branchId)) {
        uniqueBranchesMap.set(branchId, branch);
      }
    });
    const deduplicatedBranches = Array.from(uniqueBranchesMap.values());

    // Get payment configs from primary database (using string IDs)
    let configQuery = 'SELECT id, course_id, branch_id, amount, currency, is_active, notes, created_by, updated_by, created_at, updated_at FROM payment_configs WHERE course_id IN (';
    configQuery += courseIds.map(() => '?').join(',');
    configQuery += ')';
    const configParams = [...courseIds];
    if (!showInactive) {
      configQuery += ' AND is_active = ?';
      configParams.push(true);
    }
    configQuery += ' ORDER BY created_at DESC';

    const [configs] = await primaryPool.execute(configQuery, configParams);
    const formattedConfigs = configs.map(formatPaymentConfig);

    // Group by course_id
    const configMap = formattedConfigs.reduce((acc, config) => {
      const key = config.courseId;
      if (!acc[key]) acc[key] = [];
      acc[key].push(config);
      return acc;
    }, {});

    // Group deduplicated branches by course_id
    const branchMap = deduplicatedBranches.reduce((acc, branch) => {
      const key = branch.courseId;
      if (!acc[key]) acc[key] = [];
      // Additional check to prevent duplicates within the same course
      const existingBranch = acc[key].find((b) => (b.id || b._id) === (branch.id || branch._id));
      if (!existingBranch) {
        acc[key].push(branch);
      }
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
    const secondaryPool = getSecondaryPool(); // Secondary DB for courses/branches
    const primaryPool = getPool(); // Primary DB for payment configs

    // Convert courseId to int for secondary database query
    const courseIdInt = parseInt(courseId);
    if (isNaN(courseIdInt)) {
      return errorResponse(res, 'Invalid course ID', 400);
    }

    // Get course from secondary database
    const [courses] = await secondaryPool.execute(
      'SELECT id, college_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, created_at, updated_at FROM courses WHERE id = ?',
      [courseIdInt]
    );

    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    const course = formatCourse(courses[0]);

    // Get branches from secondary database
    const [branches] = await secondaryPool.execute(
      'SELECT DISTINCT id, course_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, academic_year_id, created_at, updated_at FROM course_branches WHERE course_id = ? ORDER BY name ASC',
      [courseIdInt]
    );
    const formattedBranches = branches.map(formatBranch);

    // Deduplicate branches by ID (in case of any duplicates from secondary DB)
    const uniqueBranchesMap = new Map();
    formattedBranches.forEach((branch) => {
      const branchId = branch.id || branch._id;
      if (branchId && !uniqueBranchesMap.has(branchId)) {
        uniqueBranchesMap.set(branchId, branch);
      }
    });
    const deduplicatedBranches = Array.from(uniqueBranchesMap.values());

    // Get payment configs from primary database (using string courseId)
    const [configs] = await primaryPool.execute(
      'SELECT id, course_id, branch_id, amount, currency, is_active, notes, created_by, updated_by, created_at, updated_at FROM payment_configs WHERE course_id = ?',
      [courseId] // courseId is already a string from formatCourse
    );
    const formattedConfigs = configs.map(formatPaymentConfig);

    const defaultFee = formattedConfigs.find((config) => !config.branchId) || null;
    const branchFees = formattedConfigs.filter((config) => !!config.branchId);

    const fees = deduplicatedBranches.map((branch) => {
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
    const secondaryPool = getSecondaryPool(); // Secondary DB for validation
    const primaryPool = getPool(); // Primary DB for payment configs
    const actorId = req.user?.id || req.user?._id;
    const normalizedCurrency = currency?.trim()?.toUpperCase() || 'INR';

    // Convert courseId to int for secondary database query
    const courseIdInt = parseInt(courseId);
    if (isNaN(courseIdInt)) {
      return errorResponse(res, 'Invalid course ID', 400);
    }

    // Check if course exists in secondary database
    const [courses] = await secondaryPool.execute(
      'SELECT id FROM courses WHERE id = ?',
      [courseIdInt]
    );
    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    // Validate branches in secondary database
    const branchIds = fees.map((entry) => entry.branchId).filter(Boolean);
    if (branchIds.length > 0) {
      // Convert branch IDs to int for query
      const branchIdsInt = branchIds.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (branchIdsInt.length > 0) {
        const placeholders = branchIdsInt.map(() => '?').join(',');
        const [branches] = await secondaryPool.execute(
          `SELECT id FROM course_branches WHERE course_id = ? AND id IN (${placeholders})`,
          [courseIdInt, ...branchIdsInt]
        );
        if (branches.length !== branchIdsInt.length) {
          return errorResponse(res, 'One or more branches are invalid for the selected course', 400);
        }
      }
    }

    // Handle default fee (using string courseId for primary DB)
    if (defaultFee !== undefined) {
      if (defaultFee === null) {
        // Deactivate default fee
        await primaryPool.execute(
          'UPDATE payment_configs SET is_active = ?, updated_by = ?, updated_at = NOW() WHERE course_id = ? AND branch_id IS NULL',
          [false, actorId, courseId] // courseId is string
        );
      } else if (typeof defaultFee === 'number' && defaultFee >= 0) {
        // Check if default fee exists
        const [existing] = await primaryPool.execute(
          'SELECT id FROM payment_configs WHERE course_id = ? AND branch_id IS NULL',
          [courseId] // courseId is string
        );

        if (existing.length > 0) {
          await primaryPool.execute(
            'UPDATE payment_configs SET amount = ?, currency = ?, is_active = ?, updated_by = ?, updated_at = NOW() WHERE course_id = ? AND branch_id IS NULL',
            [defaultFee, normalizedCurrency, true, actorId, courseId] // courseId is string
          );
        } else {
          const configId = uuidv4();
          await primaryPool.execute(
            'INSERT INTO payment_configs (id, course_id, branch_id, amount, currency, is_active, created_by, updated_by, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NOW(), NOW())',
            [configId, courseId, defaultFee, normalizedCurrency, true, actorId, actorId] // courseId is string
          );
        }
      } else {
        return errorResponse(res, 'Default fee must be a non-negative number or null', 422);
      }
    }

    // Handle branch fees (using string IDs for primary DB)
    for (const entry of fees) {
      if (!entry || typeof entry.branchId !== 'string' || entry.branchId.trim() === '') {
        continue;
      }

      if (typeof entry.amount !== 'number' || entry.amount < 0) {
        continue;
      }

      // Check if config exists (using string IDs)
      const [existing] = await primaryPool.execute(
        'SELECT id FROM payment_configs WHERE course_id = ? AND branch_id = ?',
        [courseId, entry.branchId] // Both are strings
      );

      if (existing.length > 0) {
        await primaryPool.execute(
          'UPDATE payment_configs SET amount = ?, currency = ?, is_active = ?, updated_by = ?, updated_at = NOW() WHERE course_id = ? AND branch_id = ?',
          [entry.amount, normalizedCurrency, true, actorId, courseId, entry.branchId] // Both are strings
        );
      } else {
        const configId = uuidv4();
        await primaryPool.execute(
          'INSERT INTO payment_configs (id, course_id, branch_id, amount, currency, is_active, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
          [configId, courseId, entry.branchId, entry.amount, normalizedCurrency, true, actorId, actorId] // Both are strings
        );
      }
    }

    // Fetch updated configs (using string courseId)
    const [updatedConfigs] = await primaryPool.execute(
      'SELECT id, course_id, branch_id, amount, currency, is_active, notes, created_by, updated_by, created_at, updated_at FROM payment_configs WHERE course_id = ?',
      [courseId] // courseId is string
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
    const primaryPool = getPool(); // Primary DB for payment configs

    // Check if config exists for this course (using string courseId)
    const [configs] = await primaryPool.execute(
      'SELECT id FROM payment_configs WHERE id = ? AND course_id = ?',
      [configId, courseId] // courseId is string
    );

    if (configs.length === 0) {
      return errorResponse(res, 'Fee configuration not found', 404);
    }

    // Delete config
    await primaryPool.execute(
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



