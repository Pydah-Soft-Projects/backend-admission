import mongoose from 'mongoose';
import PaymentConfig from '../models/PaymentConfig.model.js';
import PaymentGatewayConfig from '../models/PaymentGatewayConfig.model.js';
import Course from '../models/Course.model.js';
import Branch from '../models/Branch.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const toObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
};

const maskValue = (value = '') => {
  if (!value || value.length < 6) return '******';
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
};

export const getPaymentSettings = async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';

    const courseFilter = showInactive ? {} : { isActive: true };
    const courses = await Course.find(courseFilter).sort({ name: 1 }).lean();
    const courseIds = courses.map((course) => course._id);

    const branchFilter = { courseId: { $in: courseIds } };
    if (!showInactive) {
      branchFilter.isActive = true;
    }

    const branches = await Branch.find(branchFilter).sort({ name: 1 }).lean();
    const configs = await PaymentConfig.find({
      courseId: { $in: courseIds },
      ...(showInactive ? {} : { isActive: true }),
    })
      .sort({ createdAt: -1 })
      .lean();

    const configMap = configs.reduce((acc, config) => {
      const key = config.courseId.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(config);
      return acc;
    }, {});

    const branchMap = branches.reduce((acc, branch) => {
      const key = branch.courseId.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(branch);
      return acc;
    }, {});

    const payload = courses.map((course) => {
      const courseKey = course._id.toString();
      const relatedBranches = branchMap[courseKey] || [];
      const relatedConfigs = configMap[courseKey] || [];

      const defaultFee = relatedConfigs.find((config) => !config.branchId);
      const branchFees = relatedConfigs
        .filter((config) => !!config.branchId)
        .map((config) => ({
          ...config,
          branch: relatedBranches.find((branch) => branch._id.equals(config.branchId)) || null,
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
    return errorResponse(res, error.message || 'Failed to load payment settings', 500);
  }
};

export const getCourseFees = async (req, res) => {
  try {
    const { courseId } = req.params;
    const course = await Course.findById(courseId).lean();

    if (!course) {
      return errorResponse(res, 'Course not found', 404);
    }

    const branches = await Branch.find({ courseId }).sort({ name: 1 }).lean();
    const configs = await PaymentConfig.find({ courseId }).lean();

    const defaultFee = configs.find((config) => !config.branchId) || null;
    const branchFees = configs.filter((config) => !!config.branchId);

    const fees = branches.map((branch) => {
      const feeConfig = branchFees.find((config) => config.branchId.toString() === branch._id.toString());
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
    return errorResponse(res, error.message || 'Failed to load course fees', 500);
  }
};

export const upsertBranchFees = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { fees = [], defaultFee, currency = 'INR' } = req.body;

    const course = await Course.findById(courseId);
    if (!course) {
      return errorResponse(res, 'Course not found', 404);
    }

    const branchIds = fees.map((entry) => entry.branchId).filter(Boolean);
    if (branchIds.length > 0) {
      const branches = await Branch.find({ courseId, _id: { $in: branchIds } }).lean();
      if (branches.length !== branchIds.length) {
        return errorResponse(res, 'One or more branches are invalid for the selected course', 400);
      }
    }

    const bulkOperations = [];
    const actorId = req.user?._id;
    const normalizedCurrency = currency?.trim()?.toUpperCase() || 'INR';

    if (defaultFee !== undefined) {
      if (defaultFee === null) {
        bulkOperations.push({
          updateOne: {
            filter: { courseId, branchId: null },
            update: {
              $set: {
                isActive: false,
                updatedBy: actorId,
                updatedAt: new Date(),
              },
            },
            upsert: false,
          },
        });
      } else if (typeof defaultFee === 'number' && defaultFee >= 0) {
        bulkOperations.push({
          updateOne: {
            filter: { courseId, branchId: null },
            update: {
              $set: {
                amount: defaultFee,
                currency: normalizedCurrency,
                isActive: true,
                updatedBy: actorId,
              },
              $setOnInsert: {
                createdBy: actorId,
                branchId: null,
              },
            },
            upsert: true,
          },
        });
      } else {
        return errorResponse(res, 'Default fee must be a non-negative number or null', 422);
      }
    }

    fees.forEach((entry) => {
      if (!entry || typeof entry.branchId !== 'string' || entry.branchId.trim() === '') {
        return;
      }

      if (typeof entry.amount !== 'number' || entry.amount < 0) {
        return;
      }

      bulkOperations.push({
        updateOne: {
          filter: { courseId, branchId: entry.branchId },
          update: {
            $set: {
              amount: entry.amount,
              currency: normalizedCurrency,
              isActive: true,
              updatedBy: actorId,
            },
            $setOnInsert: {
              createdBy: actorId,
            },
          },
          upsert: true,
        },
      });
    });

    if (bulkOperations.length === 0) {
      return successResponse(res, { message: 'No changes applied' }, 'Nothing to update');
    }

    await PaymentConfig.bulkWrite(bulkOperations);

    const updatedConfigs = await PaymentConfig.find({ courseId }).lean();

    return successResponse(res, updatedConfigs, 'Payment configuration saved successfully');
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to update payment configuration', 500);
  }
};

export const deleteFeeConfig = async (req, res) => {
  try {
    const { courseId, configId } = req.params;

    const config = await PaymentConfig.findOne({ _id: configId, courseId });
    if (!config) {
      return errorResponse(res, 'Fee configuration not found', 404);
    }

    await PaymentConfig.deleteOne({ _id: configId });
    return successResponse(res, null, 'Fee configuration removed successfully');
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to remove fee configuration', 500);
  }
};

export const getCashfreeConfig = async (req, res) => {
  try {
    const config = await PaymentGatewayConfig.findOne({ provider: 'cashfree' });

    if (!config) {
      return successResponse(res, null, 'Cashfree configuration not found', 200);
    }

    const configObj = config.toObject({ getters: true });
    const response = {
      provider: configObj.provider,
      displayName: configObj.displayName,
      environment: configObj.environment,
      isActive: configObj.isActive,
      updatedAt: configObj.updatedAt,
      clientIdPreview: maskValue(configObj.clientId),
      clientSecretPreview: maskValue(configObj.clientSecret),
    };

    return successResponse(res, response);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to load Cashfree configuration', 500);
  }
};

export const updateCashfreeConfig = async (req, res) => {
  try {
    const { clientId, clientSecret, environment = 'sandbox', confirmChange = false } = req.body;

    if (!clientId || !clientSecret) {
      return errorResponse(res, 'Client ID and Client Secret are required', 422);
    }

    if (!['sandbox', 'production'].includes(environment)) {
      return errorResponse(res, 'Environment must be sandbox or production', 422);
    }

    const existing = await PaymentGatewayConfig.findOne({ provider: 'cashfree' });

    if (existing) {
      const hasChanges =
        existing.clientId !== clientId ||
        existing.clientSecret !== clientSecret ||
        existing.environment !== environment;

      if (hasChanges && !confirmChange) {
        return res.status(409).json({
          success: false,
          message: 'Updating Cashfree credentials requires confirmation.',
          confirmationRequired: true,
        });
      }

      existing.clientId = clientId;
      existing.clientSecret = clientSecret;
      existing.environment = environment;
      existing.updatedBy = req.user?._id;
      existing.isActive = true;
      await existing.save();

      return successResponse(res, { acknowledged: true }, 'Cashfree configuration updated successfully');
    }

    await PaymentGatewayConfig.create({
      provider: 'cashfree',
      clientId,
      clientSecret,
      environment,
      displayName: 'Cashfree',
      isActive: true,
      updatedBy: req.user?._id,
    });

    return successResponse(res, { acknowledged: true }, 'Cashfree configuration saved successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to update Cashfree configuration', 500);
  }
};



