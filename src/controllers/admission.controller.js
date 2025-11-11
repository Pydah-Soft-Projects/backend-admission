import mongoose from 'mongoose';
import Admission from '../models/Admission.model.js';
import Lead from '../models/Lead.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const ensureLeadId = (leadId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) {
    const error = new Error('Invalid lead identifier');
    error.statusCode = 400;
    throw error;
  }
};

const validateAdmissionPayload = (payload = {}) => {
  const errors = [];
  if (!payload.studentInfo?.name) {
    errors.push('Student name is required');
  }
  if (!payload.reservation?.general) {
    errors.push('General reservation category is required');
  }
  return errors;
};

export const listAdmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status,
    } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    }

    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const skip = (Number(page) - 1) * paginationLimit;

    const pipeline = [
      { $match: query },
      {
        $lookup: {
          from: 'leads',
          localField: 'leadId',
          foreignField: '_id',
          as: 'lead',
        },
      },
      { $unwind: '$lead' },
    ];

    if (search) {
      const regex = new RegExp(search, 'i');
      pipeline.push({
        $match: {
          $or: [
            { admissionNumber: regex },
            { 'lead.name': regex },
            { 'lead.phone': regex },
            { 'lead.hallTicketNumber': regex },
          ],
        },
      });
    }

    pipeline.push(
      { $sort: { updatedAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: paginationLimit }],
          totalCount: [{ $count: 'count' }],
        },
      }
    );

    const [result] = await Admission.aggregate(pipeline);
    const total = result?.totalCount?.[0]?.count || 0;

    return successResponse(
      res,
      {
        admissions: result?.data || [],
        pagination: {
          page: Number(page),
          limit: paginationLimit,
          total,
          pages: Math.ceil(total / paginationLimit) || 1,
        },
      },
      'Admissions retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing admissions:', error);
    return errorResponse(
      res,
      error.message || 'Failed to list admissions',
      error.statusCode || 500
    );
  }
};

export const getAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const admission = await Admission.findOne({ leadId }).lean();
    if (!admission) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const lead = await Lead.findById(leadId)
      .select('name phone fatherName fatherPhone leadStatus admissionNumber')
      .lean();

    return successResponse(
      res,
      {
        admission,
        lead,
      },
      'Admission record retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error fetching admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to fetch admission record',
      error.statusCode || 500
    );
  }
};

export const updateAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const admission = await Admission.findOne({ leadId });
    if (!admission) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };
    payload.updatedBy = req.user._id;

    Object.keys(payload).forEach((key) => {
      if (payload[key] !== undefined) {
        admission.set(key, payload[key]);
      }
    });

    await admission.save();

    return successResponse(
      res,
      admission.toObject(),
      'Admission record updated successfully',
      200
    );
  } catch (error) {
    console.error('Error updating admission record:', error);
    return errorResponse(
      res,
      error.message || 'Failed to update admission record',
      error.statusCode || 500
    );
  }
};


