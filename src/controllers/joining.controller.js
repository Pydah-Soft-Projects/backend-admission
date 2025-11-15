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
  if (!joiningDoc.courseInfo) {
    joiningDoc.courseInfo = {};
  }
  if (!joiningDoc.courseInfo.course) {
    joiningDoc.courseInfo.course = lead.courseInterested || '';
  }
  if (!joiningDoc.courseInfo.quota) {
    joiningDoc.courseInfo.quota = lead.quota || '';
  }

  if (!joiningDoc.studentInfo) {
    joiningDoc.studentInfo = {};
  }
  if (!joiningDoc.studentInfo.name) {
    joiningDoc.studentInfo.name = lead.name;
  }
  if (!joiningDoc.studentInfo.phone) {
    joiningDoc.studentInfo.phone = lead.phone;
  }
  if (!joiningDoc.studentInfo.gender) {
    joiningDoc.studentInfo.gender = lead.gender || '';
  }
  if (!joiningDoc.studentInfo.notes) {
    joiningDoc.studentInfo.notes = 'As per SSC for no issues';
  }

  joiningDoc.parents = joiningDoc.parents || {};
  joiningDoc.parents.father = joiningDoc.parents.father || {};
  joiningDoc.parents.mother = joiningDoc.parents.mother || {};

  if (!joiningDoc.parents.father.name) {
    joiningDoc.parents.father.name = lead.fatherName || '';
  }
  if (!joiningDoc.parents.father.phone) {
    joiningDoc.parents.father.phone = lead.fatherPhone || '';
  }
  if (!joiningDoc.parents.mother.name) {
    joiningDoc.parents.mother.name = lead.motherName || '';
  }

  return joiningDoc;
};

const syncLeadWithJoining = (leadDoc, joiningDoc) => {
  if (!leadDoc || !joiningDoc) return false;

  let mutated = false;

  const setStringField = (field, value) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim();
    if (!normalized) return;
    if (leadDoc[field] !== normalized) {
      leadDoc[field] = normalized;
      mutated = true;
    }
  };

  setStringField('name', joiningDoc.studentInfo?.name);
  setStringField('phone', joiningDoc.studentInfo?.phone);

  if (
    typeof joiningDoc.studentInfo?.gender === 'string' &&
    joiningDoc.studentInfo.gender.trim() &&
    leadDoc.gender !== joiningDoc.studentInfo.gender.trim()
  ) {
    leadDoc.gender = joiningDoc.studentInfo.gender.trim();
    mutated = true;
  }

  setStringField('fatherName', joiningDoc.parents?.father?.name);
  setStringField('fatherPhone', joiningDoc.parents?.father?.phone);
  setStringField('motherName', joiningDoc.parents?.mother?.name);

  const communication = joiningDoc.address?.communication || {};
  setStringField('village', communication.villageOrCity);
  setStringField('mandal', communication.mandal);
  setStringField('district', communication.district);

  if (
    typeof joiningDoc.courseInfo?.quota === 'string' &&
    joiningDoc.courseInfo.quota.trim() &&
    leadDoc.quota !== joiningDoc.courseInfo.quota.trim()
  ) {
    leadDoc.quota = joiningDoc.courseInfo.quota.trim();
    mutated = true;
  }

  const courseInterested =
    typeof joiningDoc.courseInfo?.course === 'string' && joiningDoc.courseInfo.course.trim()
      ? joiningDoc.courseInfo.course.trim()
      : typeof joiningDoc.courseInfo?.branch === 'string' && joiningDoc.courseInfo.branch.trim()
      ? joiningDoc.courseInfo.branch.trim()
      : null;

  if (courseInterested && leadDoc.courseInterested !== courseInterested) {
    leadDoc.courseInterested = courseInterested;
    mutated = true;
  }

  const interEducation = Array.isArray(joiningDoc.educationHistory)
    ? joiningDoc.educationHistory.find((entry) => entry.level === 'inter_diploma')
    : null;
  if (interEducation?.institutionName) {
    setStringField('interCollege', interEducation.institutionName);
  }

  return mutated;
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
      {
        $addFields: {
          lead: { 
            $cond: {
              if: { $gt: [{ $size: '$lead' }, 0] },
              then: { $arrayElemAt: ['$lead', 0] },
              else: null
            }
          },
        },
      },
    ];

    if (leadStatus) {
      aggregationPipeline.push({
        $match: {
          $or: [
            { 'lead.leadStatus': leadStatus },
            { 'leadData.leadStatus': leadStatus },
          ],
        },
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
            { 'lead.enquiryNumber': regex },
            { 'leadData.name': regex },
            { 'leadData.phone': regex },
            { 'leadData.hallTicketNumber': regex },
            { 'leadData.enquiryNumber': regex },
            { 'studentInfo.name': regex },
            { 'studentInfo.phone': regex },
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
    const joinings = result?.data || [];

    // Debug logging (remove in production)
    console.log('Joining list query:', {
      statusParam,
      query,
      total,
      joiningsCount: joinings.length,
      sampleJoining: joinings[0] ? {
        _id: joinings[0]._id,
        status: joinings[0].status,
        leadId: joinings[0].leadId,
        hasLead: !!joinings[0].lead,
        hasLeadData: !!joinings[0].leadData,
      } : null,
    });

    return successResponse(
      res,
      {
        joinings,
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

    // Handle new joining form without lead - return empty structure, don't create yet
    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      // Return empty joining structure - will be created on save/submit
      const emptyJoining = {
        _id: null,
        leadId: undefined,
        leadData: {},
        courseInfo: {
          courseId: undefined,
          branchId: undefined,
          course: '',
          branch: '',
          quota: '',
        },
        studentInfo: {
          name: '',
          phone: '',
          gender: '',
          dateOfBirth: '',
          notes: 'As per SSC for no issues',
          aadhaarNumber: '',
        },
        parents: {
          father: {
            name: '',
            phone: '',
            aadhaarNumber: '',
          },
          mother: {
            name: '',
            phone: '',
            aadhaarNumber: '',
          },
        },
        reservation: {
          general: DEFAULT_GENERAL_RESERVATION,
          other: [],
        },
        address: {
          communication: {
            doorOrStreet: '',
            landmark: '',
            villageOrCity: '',
            mandal: '',
            district: '',
            pinCode: '',
          },
          relatives: [],
        },
        qualifications: {
          ssc: false,
          interOrDiploma: false,
          ug: false,
          mediums: [],
          otherMediumLabel: '',
        },
        educationHistory: [],
        siblings: [],
        documents: {},
        status: 'draft',
      };

      return successResponse(
        res,
        {
          joining: emptyJoining,
          lead: null,
        },
        'New joining form template loaded',
        200
      );
    }

    // Check if leadId is actually a joining _id (for joinings without leads)
    let joiningDoc = null;
    let lead = null;

    // First, try to find joining by _id (in case it's a joining without a lead)
    if (mongoose.Types.ObjectId.isValid(leadId)) {
      joiningDoc = await Joining.findById(leadId);
      if (joiningDoc && !joiningDoc.leadId) {
        // This is a joining without a lead, return it
        return successResponse(
          res,
          {
            joining: joiningDoc.toObject({ getters: true }),
            lead: null,
          },
          'Joining draft retrieved successfully',
          200
        );
      }
    }

    // If not found by _id, try to find by leadId
    if (!joiningDoc) {
      try {
        lead = await ensureLeadExists(leadId);
        joiningDoc = await Joining.findOne({ leadId });
      } catch (error) {
        // If lead doesn't exist and it's not a valid ObjectId, return error
        if (!mongoose.Types.ObjectId.isValid(leadId)) {
          return errorResponse(res, 'Invalid joining or lead identifier', 404);
        }
        throw error;
      }
    }

    if (!joiningDoc) {
      // Store complete lead data snapshot
      const leadDataSnapshot = lead.toObject();
      delete leadDataSnapshot._id;
      delete leadDataSnapshot.__v;
      
      const draft = new Joining({
        leadId,
        leadData: leadDataSnapshot,
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

    if (safePayload.studentInfo.dateOfBirth) {
      const dob = safePayload.studentInfo.dateOfBirth;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        const [year, month, day] = dob.split('-');
        safePayload.studentInfo.dateOfBirth = `${day}-${month}-${year}`;
      }
    }
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

    // Handle new joining form without lead
    const isNewJoining = leadId === 'new' || !leadId || leadId === 'undefined';
    let lead = null;
    let joiningId = null;

    if (isNewJoining) {
      // For new joining, get joiningId from payload or create new
      if (payload._id) {
        joiningId = payload._id;
      }
    } else {
      // Check if leadId is actually a joining _id (for joinings without leads)
      if (mongoose.Types.ObjectId.isValid(leadId)) {
        const existingJoining = await Joining.findById(leadId);
        if (existingJoining && !existingJoining.leadId) {
          // This is a joining without a lead, use it directly
          joiningId = leadId;
          lead = null;
        } else if (existingJoining && existingJoining.leadId) {
          // This is a joining with a lead, use the leadId
          lead = await ensureLeadExists(existingJoining.leadId.toString());
        } else {
          // Try to find lead
          try {
            lead = await ensureLeadExists(leadId);
          } catch (error) {
            // If lead not found and it's a valid ObjectId, treat as joining _id
            if (error.statusCode === 404) {
              return errorResponse(res, 'Invalid joining or lead identifier', 404);
            }
            throw error;
          }
        }
      } else {
        // Existing flow: ensure lead exists
        lead = await ensureLeadExists(leadId);
      }
    }

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
    let joining;

    if (isNewJoining || joiningId) {
      // For new joining without lead, find by _id or create new
      // Extract _id from payload if present
      const payloadId = payload._id || joiningId;
      delete payload._id; // Remove _id from payload before setting
      
      if (payloadId && mongoose.Types.ObjectId.isValid(payloadId)) {
        joining = await Joining.findById(payloadId);
        if (!joining) {
          return errorResponse(res, 'Joining form not found', 404);
        }
      } else {
        // Create new joining form - this is the first save
        joining = new Joining({
          leadId: undefined,
          leadData: {},
          status: 'draft',
          reservation: {
            general: DEFAULT_GENERAL_RESERVATION,
            other: [],
          },
          createdBy: req.user._id,
        });
      }
    } else {
      // Existing flow: find by leadId or by joining _id if leadId is actually a joining _id
      if (joiningId) {
        // We already found the joining above, use it
        joining = await Joining.findById(joiningId);
        if (!joining) {
          return errorResponse(res, 'Joining form not found', 404);
        }
      } else {
        // Try to find by leadId
        joining = await Joining.findOne({ leadId });
        if (!joining) {
          // Create new joining for this lead
          joining = new Joining({
            leadId,
            status: 'draft',
            reservation: {
              general: DEFAULT_GENERAL_RESERVATION,
              other: [],
            },
            createdBy: req.user._id,
          });
        }
      }
    }

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

    // Only apply lead defaults and sync if lead exists
    if (lead) {
      applyLeadDefaultsToJoining(joining, lead);

      // Sync changes to lead immediately (not just on submission)
      const leadWasUpdated = syncLeadWithJoining(lead, joining);
      if (leadWasUpdated) {
        await lead.save();
      }

      // Update lead data snapshot with latest lead data
      const leadDataSnapshot = lead.toObject();
      delete leadDataSnapshot._id;
      delete leadDataSnapshot.__v;
      joining.leadData = leadDataSnapshot;
    }

    await joining.save();

    // Only record activity if lead exists
    if (lead) {
      await recordActivity({
        leadId: lead._id,
        userId: req.user._id,
        description: 'Joining form saved as draft',
        statusFrom: previousStatus,
        statusTo: 'draft',
      });
    }

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
  } else {
    const dobValue = joining.studentInfo.dateOfBirth;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dobValue)) {
      const [year, month, day] = dobValue.split('-');
      joining.studentInfo.dateOfBirth = `${day}-${month}-${year}`;
    }
    if (!/^\d{2}-\d{2}-\d{4}$/.test(joining.studentInfo.dateOfBirth)) {
      errors.push('Date of birth must be in DD-MM-YYYY format');
    }
  }

  if (!joining.reservation?.general) {
    errors.push('General reservation category is required');
  }

  return errors;
};

export const submitJoiningForApproval = async (req, res) => {
  try {
    const { leadId } = req.params;

    // Handle joinings without leads - check if leadId is actually a joining _id
    let joining = null;
    
    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    // Check if leadId is actually a joining _id (for joinings without leads)
    if (mongoose.Types.ObjectId.isValid(leadId)) {
      joining = await Joining.findById(leadId);
      if (!joining) {
        // Try to find by leadId
        joining = await Joining.findOne({ leadId });
      }
    } else {
      // Try to find by leadId
      joining = await Joining.findOne({ leadId });
    }

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

    // Only record activity if lead exists
    if (joining.leadId) {
      await recordActivity({
        leadId: joining.leadId,
        userId: req.user._id,
        description: 'Joining form submitted for approval',
        statusFrom: previousStatus,
        statusTo: 'pending_approval',
      });
    }

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

    // Handle joinings without leads - check if leadId is actually a joining _id
    let joining = null;
    
    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    // Check if leadId is actually a joining _id (for joinings without leads)
    if (mongoose.Types.ObjectId.isValid(leadId)) {
      joining = await Joining.findById(leadId);
      if (!joining) {
        // Try to find by leadId
        joining = await Joining.findOne({ leadId });
      }
    } else {
      // Try to find by leadId
      joining = await Joining.findOne({ leadId });
    }

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

    let lead = null;
    if (joining.leadId) {
      lead = await Lead.findById(joining.leadId);
    }
    
    let admissionNumber = lead?.admissionNumber;
    if (!admissionNumber) {
      admissionNumber = await generateAdmissionNumber();
    }

    if (lead) {
      syncLeadWithJoining(lead, joining);
      lead.leadStatus = 'Admitted';
      lead.admissionNumber = admissionNumber;
      await lead.save();
    }

    // Store complete lead data snapshot (not populated)
    const leadDataSnapshot = lead ? lead.toObject() : (joining.leadData || {});
    delete leadDataSnapshot._id;
    delete leadDataSnapshot.__v;

    const admissionPayload = {
      joiningId: joining._id,
      admissionNumber,
      ...(joining.leadId && { leadId: joining.leadId }), // Only include leadId if it exists
      enquiryNumber: lead?.enquiryNumber || joining.leadData?.enquiryNumber || '',
      leadData: leadDataSnapshot,
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


