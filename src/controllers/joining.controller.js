import mongoose from 'mongoose';
import Joining from '../models/Joining.model.js';
import Lead from '../models/Lead.model.js';
import ActivityLog from '../models/ActivityLog.model.js';
import Admission from '../models/Admission.model.js';
import AdmissionSequence from '../models/AdmissionSequence.model.js';
import Course from '../models/Course.model.js';
import Branch from '../models/Branch.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const DEFAULT_GENERAL_RESERVATION = 'oc';

const sanitizeString = (value) =>
  typeof value === 'string' ? value.trim() : value ?? '';

const ensureLeadExists = async (leadId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) {
    throw new Error('Invalid lead identifier provided');
  }

  const lead = await Lead.findById(leadId);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }
  return lead;
};

const applyLeadDefaultsToJoining = (joiningDoc, lead) => {
  if (!joiningDoc.courseInfo || !joiningDoc.courseInfo.course) {
    joiningDoc.courseInfo.course = lead.courseInterested || '';
  }
  if (!joiningDoc.courseInfo || !joiningDoc.courseInfo.quota) {
    joiningDoc.courseInfo.quota = lead.quota || '';
  }

  joiningDoc.studentInfo = {
    ...joiningDoc.studentInfo,
    name: lead.name,
    phone: lead.phone,
    gender: lead.gender || '',
    notes: joiningDoc.studentInfo?.notes || 'As per SSC for no issues',
  };

  joiningDoc.parents = {
    father: {
      ...(joiningDoc.parents?.father || {}),
      name: lead.fatherName || '',
      phone: lead.fatherPhone || '',
    },
    mother: {
      ...(joiningDoc.parents?.mother || {}),
      name: lead.motherName || '',
    },
  };

  return joiningDoc;
};

const recordActivity = async ({ leadId, userId, description, statusFrom, statusTo }) => {
  try {
    await ActivityLog.create({
      leadId,
      type: 'joining_update',
      performedBy: userId,
      comment: description,
      metadata: {
        statusFrom: statusFrom || null,
        statusTo: statusTo || null,
      },
    });
  } catch (error) {
    console.error('Failed to append joining activity log:', error);
  }
};

const generateAdmissionNumber = async () => {
  const currentYear = new Date().getFullYear();
  const sequenceDoc = await AdmissionSequence.findOneAndUpdate(
    { year: currentYear },
    {
      $inc: { lastSequence: 1 },
      $setOnInsert: { year: currentYear },
    },
    {
      upsert: true,
      new: true,
    }
  );

  const sequenceNumber = sequenceDoc.lastSequence || 1;
  return `${currentYear}${String(sequenceNumber).padStart(5, '0')}`;
};

export const listJoinings = async (req, res) => {
  try {
    const {
      status: statusParam,
      page = 1,
      limit = 20,
      search = '',
      leadStatus,
    } = req.query;

    const query = {};
    if (statusParam) {
      const statusesRaw = Array.isArray(statusParam) ? statusParam : String(statusParam).split(',');
      const statuses = statusesRaw
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);

      if (statuses.length === 1) {
        query.status = statuses[0];
      } else if (statuses.length > 1) {
        query.status = { $in: statuses };
      }
    }

    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const skip = (Number(page) - 1) * paginationLimit;

    const aggregationPipeline = [
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

    if (leadStatus) {
      aggregationPipeline.push({
        $match: { 'lead.leadStatus': leadStatus },
      });
    }

    if (search) {
      const regex = new RegExp(search, 'i');
      aggregationPipeline.push({
        $match: {
          $or: [
            { 'lead.name': regex },
            { 'lead.phone': regex },
            { 'lead.hallTicketNumber': regex },
          ],
        },
      });
    }

    aggregationPipeline.push(
      {
        $sort: { updatedAt: -1 },
      },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: paginationLimit }],
          totalCount: [{ $count: 'count' }],
        },
      }
    );

    const [result] = await Joining.aggregate(aggregationPipeline);
    const total = result?.totalCount?.[0]?.count || 0;

    return successResponse(
      res,
      {
        joinings: result?.data || [],
        pagination: {
          page: Number(page),
          limit: paginationLimit,
          total,
          pages: Math.ceil(total / paginationLimit) || 1,
        },
      },
      'Joining records retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error listing joining records:', error);
    return errorResponse(
      res,
      error.message || 'Failed to retrieve joining records',
      error.statusCode || 500
    );
  }
};

export const getJoining = async (req, res) => {
  try {
    const { leadId } = req.params;

    const lead = await ensureLeadExists(leadId);

    let joiningDoc = await Joining.findOne({ leadId });
    if (!joiningDoc) {
      const draft = new Joining({
        leadId,
        courseInfo: {
          course: lead.courseInterested || '',
          branch: '',
          quota: lead.quota || '',
        },
        studentInfo: {
          name: lead.name,
          phone: lead.phone,
          gender: lead.gender || '',
          notes: 'As per SSC for no issues',
        },
        parents: {
          father: {
            name: lead.fatherName || '',
            phone: lead.fatherPhone || '',
          },
          mother: {
            name: lead.motherName || '',
          },
        },
        reservation: {
          general: DEFAULT_GENERAL_RESERVATION,
          other: [],
        },
        createdBy: req.user._id,
        updatedBy: req.user._id,
      });
      joiningDoc = await draft.save();
      await recordActivity({
        leadId: lead._id,
        userId: req.user._id,
        description: 'Joining draft created automatically',
      });
    }

    return successResponse(
      res,
      {
        joining: joiningDoc.toObject({ getters: true }),
        lead,
      },
      'Joining draft retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error retrieving joining draft:', error);
    return errorResponse(
      res,
      error.message || 'Failed to load joining draft',
      error.statusCode || 500
    );
  }
};

const normalizeJoiningPayload = (payload) => {
  const safePayload = { ...payload };
  if (safePayload.studentInfo) {
    safePayload.studentInfo.name = sanitizeString(safePayload.studentInfo.name);
    safePayload.studentInfo.phone = sanitizeString(safePayload.studentInfo.phone);
    safePayload.studentInfo.gender = sanitizeString(safePayload.studentInfo.gender);
    safePayload.studentInfo.dateOfBirth = sanitizeString(
      safePayload.studentInfo.dateOfBirth
    );
  }

  if (safePayload.parents?.father) {
    safePayload.parents.father.name = sanitizeString(safePayload.parents.father.name);
    safePayload.parents.father.phone = sanitizeString(
      safePayload.parents.father.phone
    );
  }

  if (safePayload.parents?.mother) {
    safePayload.parents.mother.name = sanitizeString(safePayload.parents.mother.name);
    safePayload.parents.mother.phone = sanitizeString(
      safePayload.parents.mother.phone
    );
  }

  if (safePayload.reservation) {
    safePayload.reservation.general =
      safePayload.reservation.general || DEFAULT_GENERAL_RESERVATION;
    safePayload.reservation.other =
      safePayload.reservation.other?.map((entry) => sanitizeString(entry)) || [];
  }

  if (safePayload.courseInfo) {
    safePayload.courseInfo = {
      ...safePayload.courseInfo,
      course: sanitizeString(safePayload.courseInfo.course),
      branch: sanitizeString(safePayload.courseInfo.branch),
      quota: sanitizeString(safePayload.courseInfo.quota),
    };

    if (safePayload.courseInfo.courseId === '') {
      safePayload.courseInfo.courseId = undefined;
    }

    if (safePayload.courseInfo.branchId === '') {
      safePayload.courseInfo.branchId = undefined;
    }
  }

  return safePayload;
};

export const saveJoiningDraft = async (req, res) => {
  try {
    const { leadId } = req.params;
    const payload = normalizeJoiningPayload(req.body || {});

    const lead = await ensureLeadExists(leadId);

     let courseDoc = null;
     let branchDoc = null;

     if (payload.courseInfo?.branchId && !payload.courseInfo?.courseId) {
       branchDoc = await Branch.findById(payload.courseInfo.branchId);
       if (!branchDoc) {
         return errorResponse(res, 'Selected branch could not be found', 404);
       }
       payload.courseInfo.courseId = branchDoc.courseId.toString();
     }

     if (payload.courseInfo?.courseId) {
       courseDoc = await Course.findById(payload.courseInfo.courseId);
       if (!courseDoc) {
         return errorResponse(res, 'Selected course could not be found', 404);
       }
       payload.courseInfo.courseId = courseDoc._id;
     }

     if (payload.courseInfo?.branchId) {
       branchDoc =
         branchDoc ||
         (await Branch.findOne({
           _id: payload.courseInfo.branchId,
           courseId: payload.courseInfo.courseId || courseDoc?._id,
         }));

       if (!branchDoc) {
         return errorResponse(res, 'Selected branch is invalid for the chosen course', 400);
       }

       payload.courseInfo.branchId = branchDoc._id;
       if (!payload.courseInfo.branch) {
         payload.courseInfo.branch = branchDoc.name;
       }

       if (!payload.courseInfo.courseId) {
         payload.courseInfo.courseId = branchDoc.courseId;
       }
     }

     if (courseDoc && !payload.courseInfo?.course) {
       payload.courseInfo.course = courseDoc.name;
     }

    const now = new Date();
    const joining =
      (await Joining.findOne({ leadId })) ||
      new Joining({
        leadId,
        status: 'draft',
        reservation: {
          general: DEFAULT_GENERAL_RESERVATION,
          other: [],
        },
        createdBy: req.user._id,
      });

    const previousStatus = joining.status;

    joining.set({
      ...payload,
      status: 'draft',
      draftUpdatedAt: now,
      submittedAt: null,
      submittedBy: null,
      approvedAt: null,
      approvedBy: null,
      updatedBy: req.user._id,
    });

    applyLeadDefaultsToJoining(joining, lead);

    await joining.save();

    await recordActivity({
      leadId: lead._id,
      userId: req.user._id,
      description: 'Joining form saved as draft',
      statusFrom: previousStatus,
      statusTo: 'draft',
    });

    return successResponse(
      res,
      joining.toObject(),
      'Joining form saved as draft',
      200
    );
  } catch (error) {
    console.error('Error saving joining draft:', error);
    return errorResponse(
      res,
      error.message || 'Failed to save joining draft',
      error.statusCode || 500
    );
  }
};

const validateBeforeSubmit = (joining) => {
  const errors = [];
  if (!joining.studentInfo?.name) {
    errors.push('Student name is required');
  }

  if (!joining.studentInfo?.phone || joining.studentInfo.phone.length !== 10) {
    errors.push('Student phone number must be 10 digits');
  }

  if (!joining.studentInfo?.dateOfBirth) {
    errors.push('Date of birth is required');
  } else if (!/^\d{2}-\d{2}-\d{4}$/.test(joining.studentInfo.dateOfBirth)) {
    errors.push('Date of birth must be in DD-MM-YYYY format');
  }

  if (!joining.reservation?.general) {
    errors.push('General reservation category is required');
  }

  return errors;
};

export const submitJoiningForApproval = async (req, res) => {
  try {
    const { leadId } = req.params;

    const joining = await Joining.findOne({ leadId });
    if (!joining) {
      return errorResponse(res, 'Joining draft not found', 404);
    }

    const validationErrors = validateBeforeSubmit(joining);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const previousStatus = joining.status;
    joining.status = 'pending_approval';
    joining.submittedAt = new Date();
    joining.submittedBy = req.user._id;

    await joining.save();

    await recordActivity({
      leadId: joining.leadId,
      userId: req.user._id,
      description: 'Joining form submitted for approval',
      statusFrom: previousStatus,
      statusTo: 'pending_approval',
    });

    return successResponse(
      res,
      joining.toObject(),
      'Joining form submitted for approval',
      200
    );
  } catch (error) {
    console.error('Error submitting joining form:', error);
    return errorResponse(
      res,
      error.message || 'Failed to submit joining form',
      error.statusCode || 500
    );
  }
};

export const approveJoining = async (req, res) => {
  try {
    const { leadId } = req.params;

    const joining = await Joining.findOne({ leadId });
    if (!joining) {
      return errorResponse(res, 'Joining draft not found', 404);
    }

    if (joining.status !== 'pending_approval') {
      return errorResponse(
        res,
        'Only submissions awaiting approval can be approved',
        400
      );
    }

    const previousStatus = joining.status;
    joining.status = 'approved';
    joining.approvedAt = new Date();
    joining.approvedBy = req.user._id;

    await joining.save();

    const joiningObject = joining.toObject({ getters: true });

    const lead = await Lead.findById(joining.leadId);
    let admissionNumber = lead?.admissionNumber;
    if (!admissionNumber) {
      admissionNumber = await generateAdmissionNumber();
    }

    if (lead) {
      lead.leadStatus = 'Admitted';
      lead.admissionNumber = admissionNumber;
      await lead.save();
    }

    const admissionPayload = {
      joiningId: joining._id,
      admissionNumber,
      courseInfo: joiningObject.courseInfo || {},
      studentInfo: joiningObject.studentInfo || {},
      parents: joiningObject.parents || {},
      reservation: joiningObject.reservation || { general: 'oc', other: [] },
      address: joiningObject.address || { communication: {}, relatives: [] },
      qualifications: joiningObject.qualifications || {},
      educationHistory: joiningObject.educationHistory || [],
      siblings: joiningObject.siblings || [],
      documents: joiningObject.documents || {},
      status: 'active',
      updatedBy: req.user._id,
      paymentSummary: joiningObject.paymentSummary || undefined,
    };

    await Admission.findOneAndUpdate(
      { leadId: joining.leadId },
      {
        $set: admissionPayload,
        $setOnInsert: {
          leadId: joining.leadId,
          admissionDate: new Date(),
          createdBy: req.user._id,
        },
      },
      { upsert: true, new: true }
    );

    await recordActivity({
      leadId: joining.leadId,
      userId: req.user._id,
      description: 'Joining form approved',
      statusFrom: previousStatus,
      statusTo: 'approved',
    });

    return successResponse(
      res,
      {
        joining: joiningObject,
        admissionNumber,
      },
      'Joining form approved',
      200
    );
  } catch (error) {
    console.error('Error approving joining form:', error);
    return errorResponse(
      res,
      error.message || 'Failed to approve joining form',
      error.statusCode || 500
    );
  }
};


