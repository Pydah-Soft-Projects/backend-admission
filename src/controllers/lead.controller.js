import mongoose from 'mongoose';
import Lead from '../models/Lead.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { generateEnquiryNumber } from '../utils/generateEnquiryNumber.js';

// @desc    Get all leads with pagination
// @route   GET /api/leads
// @access  Private
export const getLeads = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};
    
    if (req.query.mandal) filter.mandal = req.query.mandal;
    if (req.query.state) filter.state = req.query.state;
    if (req.query.district) filter.district = req.query.district;
    if (req.query.quota) filter.quota = req.query.quota;
    if (req.query.leadStatus) filter.leadStatus = req.query.leadStatus;
    if (req.query.applicationStatus) filter.applicationStatus = req.query.applicationStatus;
    if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
    if (req.query.enquiryNumber) {
      // Fast search by enquiry number - handle multiple formats
      const searchTerm = req.query.enquiryNumber.trim();
      // If it starts with ENQ, search directly
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        filter.enquiryNumber = { $regex: `^${searchTerm}`, $options: 'i' };
      } else {
        // If it's just numbers, search for enquiry numbers containing those digits anywhere
        // Examples: "1" matches ENQ2400001, ENQ24000010, ENQ24000011, ENQ24000111 (all contain "1")
        //          "7456" matches ENQ2407456, ENQ24074560, ENQ24074561 (all contain "7456")
        filter.enquiryNumber = { $regex: searchTerm, $options: 'i' };
      }
    }
    if (req.query.search) {
      // Search only in name, phone, and email fields (not enquiry number)
      const searchTerm = req.query.search.trim();
      // Use $or to search across name, phone, and email fields
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { phone: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } },
        { district: { $regex: searchTerm, $options: 'i' } },
      ];
    }

    // If user is not Super Admin, only show assigned leads
    if (req.user.roleName !== 'Super Admin' && req.user.roleName !== 'Admin') {
      filter.assignedTo = req.user._id;
    }

    // Get total count for pagination
    const total = await Lead.countDocuments(filter);

    // Get leads with pagination
    const leads = await Lead.find(filter)
      .populate('assignedTo', 'name email')
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(); // Use lean() for better performance with large datasets

    return successResponse(res, {
      leads,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    }, 'Leads retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting leads:', error);
    return errorResponse(res, error.message || 'Failed to get leads', 500);
  }
};

// @desc    Get single lead
// @route   GET /api/leads/:id
// @access  Private
export const getLead = async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('assignedTo', 'name email')
      .populate('uploadedBy', 'name');

    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Check if user has access (Super Admin or assigned to this lead)
    if (req.user.roleName !== 'Super Admin' && lead.assignedTo?._id?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    return successResponse(res, lead, 'Lead retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get lead', 500);
  }
};

// @desc    Create single lead (public - for form submissions)
// @route   POST /api/leads/public
// @access  Public
export const createPublicLead = async (req, res) => {
  try {
    const {
      hallTicketNumber,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName,
      village,
      district,
      courseInterested,
      mandal,
      state,
      quota,
      applicationStatus,
      gender,
      rank,
      interCollege,
      dynamicFields,
      source,
    } = req.body;

    // Validate required fields
    if (!name || !phone || !fatherName || !fatherPhone || !village || !district || !mandal) {
      return errorResponse(res, 'Please provide all required fields', 400);
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();

    const lead = await Lead.create({
      enquiryNumber,
      hallTicketNumber: hallTicketNumber ? String(hallTicketNumber).trim() : undefined,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName: motherName ? String(motherName).trim() : undefined,
      village,
      district,
      courseInterested,
      mandal,
      state: state?.trim() || 'Andhra Pradesh',
      quota: quota || 'Not Applicable',
      applicationStatus: applicationStatus || 'Not Provided',
      gender: gender ? String(gender).trim() : 'Not Specified',
      rank: rank !== undefined && rank !== null && !Number.isNaN(Number(rank)) ? Number(rank) : undefined,
      interCollege: interCollege ? String(interCollege).trim() : undefined,
      dynamicFields: dynamicFields || {},
      source: source || 'Public Form',
    });

    return successResponse(res, lead, 'Lead submitted successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to submit lead', 500);
  }
};

// @desc    Create single lead
// @route   POST /api/leads
// @access  Private
export const createLead = async (req, res) => {
  try {
    const {
      hallTicketNumber,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName,
      village,
      district,
      courseInterested,
      mandal,
      state,
      quota,
      applicationStatus,
      gender,
      rank,
      interCollege,
      dynamicFields,
      source,
    } = req.body;

    // Validate required fields
    if (!name || !phone || !fatherName || !fatherPhone || !village || !district || !mandal) {
      return errorResponse(res, 'Please provide all required fields', 400);
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();

    const lead = await Lead.create({
      enquiryNumber,
      hallTicketNumber: hallTicketNumber ? String(hallTicketNumber).trim() : undefined,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName: motherName ? String(motherName).trim() : undefined,
      village,
      district,
      courseInterested,
      mandal,
      state: state?.trim() || 'Andhra Pradesh',
      quota: quota || 'Not Applicable',
      applicationStatus: applicationStatus || 'Not Provided',
      gender: gender ? String(gender).trim() : 'Not Specified',
      rank: rank !== undefined && rank !== null && !Number.isNaN(Number(rank)) ? Number(rank) : undefined,
      interCollege: interCollege ? String(interCollege).trim() : undefined,
      dynamicFields: dynamicFields || {},
      source: source || 'Manual Entry',
      uploadedBy: req.user._id,
    });

    return successResponse(res, lead, 'Lead created successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to create lead', 500);
  }
};

// @desc    Update lead
// @route   PUT /api/leads/:id
// @access  Private
export const updateLead = async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Check if user has access
    if (req.user.roleName !== 'Super Admin' && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Regular users can only update status and notes, Super Admin can update everything
    const isSuperAdmin = req.user.roleName === 'Super Admin';
    
    // Update fields
    const {
      hallTicketNumber,
      name,
      phone,
      email,
      fatherName,
      fatherPhone,
      motherName,
      village,
      district,
      courseInterested,
      mandal,
      state,
      gender,
      rank,
      interCollege,
      quota,
      dynamicFields,
      applicationStatus,
      leadStatus,
      status: legacyStatus,
      assignedTo,
      source,
      notes,
      lastFollowUp,
    } = req.body;

    const newLeadStatus = leadStatus ?? legacyStatus;

    // Only Super Admin can update these fields
    if (isSuperAdmin) {
      if (hallTicketNumber !== undefined) {
        lead.hallTicketNumber = hallTicketNumber ? String(hallTicketNumber).trim() : '';
      }
      if (name) lead.name = name;
      if (phone) lead.phone = phone;
      if (email !== undefined) lead.email = email;
      if (fatherName) lead.fatherName = fatherName;
      if (fatherPhone) lead.fatherPhone = fatherPhone;
      if (motherName !== undefined) {
        lead.motherName = motherName ? String(motherName).trim() : '';
      }
      if (courseInterested !== undefined) lead.courseInterested = courseInterested;
      if (village) lead.village = village;
      if (district) lead.district = district;
      if (mandal) lead.mandal = mandal;
      if (state !== undefined) {
        const trimmedState = typeof state === 'string' ? state.trim() : state;
        lead.state = trimmedState ? trimmedState : 'Andhra Pradesh';
      }
      if (quota) lead.quota = quota;
      if (gender !== undefined) {
        lead.gender = gender ? String(gender).trim() : 'Not Specified';
      }
      if (rank !== undefined && rank !== null && !Number.isNaN(Number(rank))) {
        lead.rank = Number(rank);
      }
      if (interCollege !== undefined) {
        lead.interCollege = interCollege ? String(interCollege).trim() : '';
      }
      if (applicationStatus !== undefined) lead.applicationStatus = applicationStatus;
      if (dynamicFields) lead.dynamicFields = { ...lead.dynamicFields, ...dynamicFields };
      if (assignedTo) lead.assignedTo = assignedTo;
      if (source) lead.source = source;
      if (lastFollowUp) lead.lastFollowUp = lastFollowUp;
    }

    // Both Super Admin and regular users can update status and notes
    if (newLeadStatus) lead.leadStatus = newLeadStatus;
    if (notes !== undefined) lead.notes = notes;

    await lead.save();

    return successResponse(res, lead, 'Lead updated successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to update lead', 500);
  }
};

// @desc    Delete lead
// @route   DELETE /api/leads/:id
// @access  Private (Super Admin only)
export const deleteLead = async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Only Super Admin can delete
    if (req.user.roleName !== 'Super Admin') {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    // Delete all activity logs for this lead first
    await ActivityLog.deleteMany({ leadId: lead._id });

    // Then delete the lead
    await lead.deleteOne();

    return successResponse(res, null, 'Lead and associated activity logs deleted successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to delete lead', 500);
  }
};

// @desc    Bulk delete leads
// @route   DELETE /api/leads/bulk
// @access  Private (Super Admin only)
export const bulkDeleteLeads = async (req, res) => {
  const startTime = Date.now();

  try {
    const { leadIds } = req.body;

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return errorResponse(res, 'Please provide an array of lead IDs to delete', 400);
    }

    if (req.user.roleName !== 'Super Admin') {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    const validIds = leadIds.filter((id) => {
      try {
        return mongoose.Types.ObjectId.isValid(id);
      } catch {
        return false;
      }
    });

    if (validIds.length === 0) {
      return errorResponse(res, 'No valid lead IDs provided', 400);
    }

    const uniqueValidIds = Array.from(new Set(validIds));
    const chunkSize = uniqueValidIds.length > 20000 ? 10000 : uniqueValidIds.length > 5000 ? 5000 : 1000;

    const executeBulkDelete = async (sessionArg = null) => {
      const options = sessionArg ? { session: sessionArg } : {};
      let totalLeadDeleted = 0;
      let totalLogDeleted = 0;

      for (let index = 0; index < uniqueValidIds.length; index += chunkSize) {
        const chunk = uniqueValidIds.slice(index, index + chunkSize);
        const [logsResult, leadsResult] = await Promise.all([
          ActivityLog.deleteMany({ leadId: { $in: chunk } }, options),
          Lead.deleteMany({ _id: { $in: chunk } }, options),
        ]);

        totalLogDeleted += logsResult?.deletedCount || 0;
        totalLeadDeleted += leadsResult?.deletedCount || 0;

        // Yield the event loop to keep the Node.js process responsive during very large deletes
        await new Promise((resolve) => setImmediate(resolve));
      }

      return {
        activityResult: { deletedCount: totalLogDeleted },
        leadResult: { deletedCount: totalLeadDeleted },
      };
    };

    let activityResult;
    let leadResult;
    let session = null;
    let transactionAttempted = false;

    try {
      session = await mongoose.startSession();
      session.startTransaction();
      transactionAttempted = true;

      ({ activityResult, leadResult } = await executeBulkDelete(session));

      await session.commitTransaction();
    } catch (transactionError) {
      if (session) {
        await session.abortTransaction().catch(() => {});
      }

      const illegalTransaction =
        transactionError?.code === 20 ||
        String(transactionError?.message || '').toLowerCase().includes('transaction numbers are only allowed');

      if (!illegalTransaction) {
        throw transactionError;
      }

      console.warn('Bulk delete fallback to non-transaction mode:', transactionError.message);

      ({ activityResult, leadResult } = await executeBulkDelete());
    } finally {
      if (session) {
        session.endSession();
      }
    }

    const durationMs = Date.now() - startTime;

    return successResponse(
      res,
      {
        requestedCount: leadIds.length,
        validCount: uniqueValidIds.length,
        deletedLeadCount: leadResult.deletedCount,
        deletedLogCount: activityResult.deletedCount,
        durationMs,
      },
      `Deleted ${leadResult.deletedCount} lead(s) and ${activityResult.deletedCount} activity log(s) in ${durationMs} ms`,
      200,
    );
  } catch (error) {
    console.error('Bulk delete error:', error);
    return errorResponse(res, error.message || 'Failed to bulk delete leads', 500);
  }
};

// @desc    Get all lead IDs matching filters (for bulk operations)
// @route   GET /api/leads/ids
// @access  Private
export const getAllLeadIds = async (req, res) => {
  try {
    // Build filter object (same as getLeads)
    const filter = {};
    
    if (req.query.mandal) filter.mandal = req.query.mandal;
    if (req.query.state) filter.state = req.query.state;
    if (req.query.district) filter.district = req.query.district;
    if (req.query.quota) filter.quota = req.query.quota;
    if (req.query.leadStatus) filter.leadStatus = req.query.leadStatus;
    if (req.query.applicationStatus) filter.applicationStatus = req.query.applicationStatus;
    if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
    if (req.query.enquiryNumber) {
      const searchTerm = req.query.enquiryNumber.trim();
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        filter.enquiryNumber = { $regex: `^${searchTerm}`, $options: 'i' };
      } else {
        filter.enquiryNumber = { $regex: searchTerm, $options: 'i' };
      }
    }
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { phone: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } },
        { district: { $regex: searchTerm, $options: 'i' } },
      ];
    }

    // If user is not Super Admin, only show assigned leads
    if (req.user.roleName !== 'Super Admin' && req.user.roleName !== 'Admin') {
      filter.assignedTo = req.user._id;
    }

    // Get only IDs (lean query for performance)
    const leadIds = await Lead.find(filter).select('_id').lean();
    const ids = leadIds.map(lead => lead._id.toString());

    return successResponse(res, {
      ids,
      count: ids.length,
    }, 'Lead IDs retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get lead IDs', 500);
  }
};

// @desc    Get filter options (public - for form dropdowns)
// @route   GET /api/leads/filters/options/public
// @access  Public
export const getPublicFilterOptions = async (req, res) => {
  try {
    // Public endpoint - get all options without filtering by user
    const [mandals, districts, states, quotas, applicationStatuses] = await Promise.all([
      Lead.distinct('mandal').sort(),
      Lead.distinct('district').sort(),
      Lead.distinct('state').sort(),
      Lead.distinct('quota').sort(),
      Lead.distinct('applicationStatus').sort(),
    ]);

    return successResponse(res, {
      mandals,
      districts,
      states,
      quotas,
      applicationStatuses,
    }, 'Filter options retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get filter options', 500);
  }
};

// @desc    Get filter options (for dropdowns)
// @route   GET /api/leads/filters/options
// @access  Private
export const getFilterOptions = async (req, res) => {
  try {
    const filter = {};
    
    // If user is not Super Admin, only show assigned leads
    if (req.user.roleName !== 'Super Admin' && req.user.roleName !== 'Admin') {
      filter.assignedTo = req.user._id;
    }

    const [mandals, districts, states, quotas, leadStatuses, applicationStatuses] = await Promise.all([
      Lead.distinct('mandal', filter).sort(),
      Lead.distinct('district', filter).sort(),
      Lead.distinct('state', filter).sort(),
      Lead.distinct('quota', filter).sort(),
      Lead.distinct('leadStatus', filter).sort(),
      Lead.distinct('applicationStatus', filter).sort(),
    ]);

    return successResponse(res, {
      mandals,
      districts,
      states,
      quotas,
      leadStatuses,
      applicationStatuses,
    }, 'Filter options retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get filter options', 500);
  }
};

