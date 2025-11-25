import mongoose from 'mongoose';
import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import Lead from '../models/Lead.model.js';
import User from '../models/User.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import DeleteJob from '../models/DeleteJob.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { generateEnquiryNumber } from '../utils/generateEnquiryNumber.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadCreated } from '../services/notification.service.js';

const deleteQueue = new PQueue({
  concurrency: Number(process.env.LEAD_DELETE_CONCURRENCY || 1),
});

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
    if (req.query.courseInterested) filter.courseInterested = req.query.courseInterested;
    if (req.query.source) filter.source = req.query.source;
    
    // Add date filtering for analytics
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        const start = new Date(req.query.startDate);
        start.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = start;
      }
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }
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
    if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
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

    // Check if user has access
    let hasAccess = false;

    // Super Admin always has access
    if (hasElevatedAdminPrivileges(req.user.roleName)) {
      hasAccess = true;
    }
    // If lead is assigned to the user, they have access
    else if (lead.assignedTo?._id?.toString() === req.user._id.toString()) {
      hasAccess = true;
    }
    // If user is a Manager, check if lead is assigned to one of their team members
    else if (req.user.isManager) {
      const teamMembers = await User.find({ managedBy: req.user._id }).select('_id');
      const teamMemberIds = teamMembers.map((member) => member._id.toString());
      
      // Check if lead is assigned to manager or any team member
      const assignedToId = lead.assignedTo?._id?.toString();
      if (assignedToId && (assignedToId === req.user._id.toString() || teamMemberIds.includes(assignedToId))) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
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
      isNRI,
      // UTM Parameters (can come from body or query params)
      utm_source,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
    } = req.body;

    // Also check query parameters for UTM (in case they're passed via URL)
    const utmSource = utm_source || req.query.utm_source;
    const utmMedium = utm_medium || req.query.utm_medium;
    const utmCampaign = utm_campaign || req.query.utm_campaign;
    const utmTerm = utm_term || req.query.utm_term;
    const utmContent = utm_content || req.query.utm_content;

    // Validate required fields
    if (!name || !phone || !fatherName || !fatherPhone || !village || !district || !mandal) {
      return errorResponse(res, 'Please provide all required fields', 400);
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();

    // If UTM source exists, use it as the lead source
    const leadSource = utmSource ? String(utmSource).trim() : (source || 'Public Form');

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
      source: leadSource,
      isNRI: isNRI === true || isNRI === 'true',
      // UTM Tracking Parameters
      utmSource: utmSource ? String(utmSource).trim() : undefined,
      utmMedium: utmMedium ? String(utmMedium).trim() : undefined,
      utmCampaign: utmCampaign ? String(utmCampaign).trim() : undefined,
      utmTerm: utmTerm ? String(utmTerm).trim() : undefined,
      utmContent: utmContent ? String(utmContent).trim() : undefined,
    });

    // Send notification to lead (async, don't wait for it)
    notifyLeadCreated(lead).catch((error) => {
      console.error('[Lead] Error sending notification to lead:', error);
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

    // Send notification to lead (async, don't wait for it)
    notifyLeadCreated(lead).catch((error) => {
      console.error('[Lead] Error sending notification to lead:', error);
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
    if (!hasElevatedAdminPrivileges(req.user.roleName) && lead.assignedTo?.toString() !== req.user._id.toString()) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Regular users can only update status and notes, Super Admin can update everything
    const isSuperAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    
    // Store original values for comparison
    const originalLead = {
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      fatherName: lead.fatherName,
      fatherPhone: lead.fatherPhone,
      motherName: lead.motherName,
      courseInterested: lead.courseInterested,
      village: lead.village,
      district: lead.district,
      mandal: lead.mandal,
      state: lead.state,
      quota: lead.quota,
      gender: lead.gender,
      rank: lead.rank,
      interCollege: lead.interCollege,
      hallTicketNumber: lead.hallTicketNumber,
      applicationStatus: lead.applicationStatus,
    };
    
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
      if (assignedTo) {
        const oldAssignedTo = lead.assignedTo?.toString();
        const newAssignedTo = assignedTo.toString();
        
        // Only log if assignment is actually changing
        if (oldAssignedTo !== newAssignedTo) {
          const oldStatus = lead.leadStatus || 'New';
          lead.assignedTo = assignedTo;
          lead.assignedAt = new Date();
          lead.assignedBy = req.user._id;
          
          // If status is "New", automatically change to "Assigned"
          if (oldStatus === 'New' || !oldStatus) {
            lead.leadStatus = 'Assigned';
          }
          
          // Create activity log for assignment
          await ActivityLog.create({
            leadId: lead._id,
            type: 'status_change',
            oldStatus: oldStatus,
            newStatus: lead.leadStatus,
            comment: `Assigned to counsellor`,
            performedBy: req.user._id,
            metadata: {
              assignment: {
                assignedTo: newAssignedTo,
                assignedBy: req.user._id.toString(),
              },
            },
          });
        }
      }
      if (source) lead.source = source;
      if (lastFollowUp) lead.lastFollowUp = lastFollowUp;
    }

    // Both Super Admin and regular users can update status and notes
    if (newLeadStatus) lead.leadStatus = newLeadStatus;
    if (notes !== undefined) lead.notes = notes;

    await lead.save();

    // Log field updates (if any fields were changed by Super Admin)
    if (isSuperAdmin) {
      const updatedFields = [];
      if (name && name !== originalLead.name) updatedFields.push('name');
      if (phone && phone !== originalLead.phone) updatedFields.push('phone');
      if (email !== undefined && email !== originalLead.email) updatedFields.push('email');
      if (fatherName && fatherName !== originalLead.fatherName) updatedFields.push('fatherName');
      if (fatherPhone && fatherPhone !== originalLead.fatherPhone) updatedFields.push('fatherPhone');
      if (motherName !== undefined && motherName !== originalLead.motherName) updatedFields.push('motherName');
      if (courseInterested !== undefined && courseInterested !== originalLead.courseInterested) updatedFields.push('courseInterested');
      if (village && village !== originalLead.village) updatedFields.push('village');
      if (district && district !== originalLead.district) updatedFields.push('district');
      if (mandal && mandal !== originalLead.mandal) updatedFields.push('mandal');
      if (state !== undefined && state !== originalLead.state) updatedFields.push('state');
      if (quota && quota !== originalLead.quota) updatedFields.push('quota');
      if (gender !== undefined && gender !== originalLead.gender) updatedFields.push('gender');
      if (rank !== undefined && rank !== originalLead.rank) updatedFields.push('rank');
      if (interCollege !== undefined && interCollege !== originalLead.interCollege) updatedFields.push('interCollege');
      if (hallTicketNumber !== undefined && hallTicketNumber !== originalLead.hallTicketNumber) updatedFields.push('hallTicketNumber');
      if (applicationStatus !== undefined && applicationStatus !== originalLead.applicationStatus) updatedFields.push('applicationStatus');
      
      // Only create activity log if fields were actually changed (excluding assignment which is already logged)
      if (updatedFields.length > 0 && !assignedTo) {
        await ActivityLog.create({
          leadId: lead._id,
          type: 'comment',
          comment: `Student details updated: ${updatedFields.join(', ')}`,
          performedBy: req.user._id,
          metadata: {
            fieldUpdate: {
              updatedFields,
            },
          },
        });
      }
    }

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
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
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

// Process delete job in background
const processDeleteJob = async (jobId) => {
  const job = await DeleteJob.findOne({ jobId });
  if (!job) {
    console.error(`Delete job ${jobId} not found`);
    return;
  }

  if (job.status !== 'queued') {
    console.warn(`Delete job ${jobId} is not in queued status: ${job.status}`);
    return;
  }

  const startTime = Date.now();
  job.status = 'processing';
  job.startedAt = new Date();
  await job.save();

  try {
    const validIds = job.leadIds.filter((id) => {
      try {
        return mongoose.Types.ObjectId.isValid(id);
      } catch {
        return false;
      }
    });

    if (validIds.length === 0) {
      job.status = 'completed';
      job.completedAt = new Date();
      job.stats = {
        requestedCount: job.leadIds.length,
        validCount: 0,
        deletedLeadCount: 0,
        deletedLogCount: 0,
        durationMs: Date.now() - startTime,
      };
      job.message = 'No valid lead IDs to delete';
      await job.save();
      return;
    }

    const uniqueValidIds = Array.from(new Set(validIds.map((id) => id.toString())));
    const chunkSize = uniqueValidIds.length > 20000 ? 10000 : uniqueValidIds.length > 5000 ? 5000 : 1000;
    const objectIds = uniqueValidIds.map((id) => new mongoose.Types.ObjectId(id));

    let totalLeadDeleted = 0;
    let totalLogDeleted = 0;
    const errorDetails = [];

    // Process in chunks without transactions to avoid timeout
    for (let index = 0; index < objectIds.length; index += chunkSize) {
      const chunk = objectIds.slice(index, index + chunkSize);

      try {
        const [logsResult, leadsResult] = await Promise.all([
          ActivityLog.deleteMany({ leadId: { $in: chunk } }),
          Lead.deleteMany({ _id: { $in: chunk } }),
        ]);

        totalLogDeleted += logsResult?.deletedCount || 0;
        totalLeadDeleted += leadsResult?.deletedCount || 0;

        // Update job progress periodically
        if ((index + chunkSize) % (chunkSize * 5) === 0 || index + chunkSize >= objectIds.length) {
          job.stats = {
            requestedCount: job.leadIds.length,
            validCount: uniqueValidIds.length,
            deletedLeadCount: totalLeadDeleted,
            deletedLogCount: totalLogDeleted,
            durationMs: Date.now() - startTime,
          };
          await job.save();
        }

        // Yield the event loop to keep the Node.js process responsive
        await new Promise((resolve) => setImmediate(resolve));
      } catch (chunkError) {
        console.error(`Error deleting chunk ${index}-${index + chunkSize}:`, chunkError);
        // Continue with next chunk even if one fails
        chunk.forEach((id) => {
          errorDetails.push({
            leadId: id,
            error: chunkError.message || 'Unknown error',
          });
        });
      }
    }

    const durationMs = Date.now() - startTime;

    job.status = 'completed';
    job.completedAt = new Date();
    job.stats = {
      requestedCount: job.leadIds.length,
      validCount: uniqueValidIds.length,
      deletedLeadCount: totalLeadDeleted,
      deletedLogCount: totalLogDeleted,
      durationMs,
    };
    job.errorDetails = errorDetails.slice(0, 200); // Limit error details
    job.message = `Deleted ${totalLeadDeleted} lead(s) and ${totalLogDeleted} activity log(s) in ${durationMs} ms`;
    await job.save();

    console.log(`Delete job ${jobId} completed: ${totalLeadDeleted} leads deleted`);
  } catch (error) {
    console.error(`Delete job ${jobId} failed:`, error);
    job.status = 'failed';
    job.completedAt = new Date();
    job.stats = {
      requestedCount: job.leadIds.length,
      validCount: 0,
      deletedLeadCount: 0,
      deletedLogCount: 0,
      durationMs: Date.now() - startTime,
    };
    job.message = error.message || 'Failed to process delete job';
    await job.save();
  }
};

// @desc    Bulk delete leads (queued)
// @route   DELETE /api/leads/bulk
// @access  Private (Super Admin only)
export const bulkDeleteLeads = async (req, res) => {
  try {
    const { leadIds } = req.body;

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return errorResponse(res, 'Please provide an array of lead IDs to delete', 400);
    }

    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
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
    const objectIds = uniqueValidIds.map((id) => new mongoose.Types.ObjectId(id));

    // Create delete job
    const jobId = uuidv4();
    const job = await DeleteJob.create({
      jobId,
      leadIds: objectIds,
      status: 'queued',
      deletedBy: req.user._id,
      stats: {
        requestedCount: leadIds.length,
        validCount: uniqueValidIds.length,
        deletedLeadCount: 0,
        deletedLogCount: 0,
        durationMs: 0,
      },
    });

    // Queue the job for processing
    deleteQueue.add(() => processDeleteJob(jobId)).catch((error) => {
      console.error(`Error queuing delete job ${jobId}:`, error);
    });

    return successResponse(
      res,
      {
        jobId,
        status: 'queued',
        requestedCount: leadIds.length,
        validCount: uniqueValidIds.length,
        message: 'Delete job queued successfully',
      },
      'Bulk delete job queued. Use the job ID to check status.',
      202,
    );
  } catch (error) {
    console.error('Bulk delete error:', error);
    return errorResponse(res, error.message || 'Failed to queue bulk delete', 500);
  }
};

// @desc    Get delete job status
// @route   GET /api/leads/delete-jobs/:jobId
// @access  Private (Super Admin only)
export const getDeleteJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    const job = await DeleteJob.findOne({ jobId });

    if (!job) {
      return errorResponse(res, 'Delete job not found', 404);
    }

    return successResponse(
      res,
      {
        jobId: job.jobId,
        status: job.status,
        stats: job.stats,
        errorDetails: job.errorDetails || [],
        message: job.message,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
      },
      'Delete job status retrieved successfully',
      200,
    );
  } catch (error) {
    console.error('Error getting delete job status:', error);
    return errorResponse(res, error.message || 'Failed to get delete job status', 500);
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
    if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
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
    if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
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

