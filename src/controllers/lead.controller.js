import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { generateEnquiryNumber } from '../utils/generateEnquiryNumber.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { notifyLeadCreated } from '../services/notification.service.js';

const deleteQueue = new PQueue({
  concurrency: Number(process.env.LEAD_DELETE_CONCURRENCY || 1),
});

// Helper function to format lead data from SQL to camelCase
const formatLead = (leadData, assignedToUser = null, uploadedByUser = null) => {
  if (!leadData) return null;
  return {
    id: leadData.id,
    _id: leadData.id, // Keep _id for backward compatibility
    enquiryNumber: leadData.enquiry_number,
    name: leadData.name,
    phone: leadData.phone,
    email: leadData.email,
    fatherName: leadData.father_name,
    motherName: leadData.mother_name || '',
    fatherPhone: leadData.father_phone,
    hallTicketNumber: leadData.hall_ticket_number || '',
    village: leadData.village,
    courseInterested: leadData.course_interested,
    district: leadData.district,
    mandal: leadData.mandal,
    state: leadData.state || '',
    isNRI: leadData.is_nri === 1 || leadData.is_nri === true,
    gender: leadData.gender || 'Not Specified',
    rank: leadData.rank,
    interCollege: leadData.inter_college || '',
    quota: leadData.quota || 'Not Applicable',
    applicationStatus: leadData.application_status || 'Not Provided',
    dynamicFields: typeof leadData.dynamic_fields === 'string' 
      ? JSON.parse(leadData.dynamic_fields) 
      : leadData.dynamic_fields || {},
    leadStatus: leadData.lead_status || 'New',
    admissionNumber: leadData.admission_number,
    assignedTo: assignedToUser || leadData.assigned_to,
    assignedAt: leadData.assigned_at,
    assignedBy: leadData.assigned_by,
    source: leadData.source,
    utmSource: leadData.utm_source,
    utmMedium: leadData.utm_medium,
    utmCampaign: leadData.utm_campaign,
    utmTerm: leadData.utm_term,
    utmContent: leadData.utm_content,
    lastFollowUp: leadData.last_follow_up,
    nextScheduledCall: leadData.next_scheduled_call,
    academicYear: leadData.academic_year != null ? leadData.academic_year : undefined,
    studentGroup: leadData.student_group || undefined,
    needsManualUpdate: leadData.needs_manual_update === 1 || leadData.needs_manual_update === true,
    notes: leadData.notes,
    uploadedBy: uploadedByUser || leadData.uploaded_by,
    uploadBatchId: leadData.upload_batch_id,
    createdAt: leadData.created_at,
    updatedAt: leadData.updated_at,
  };
};

// Helper function to format user data (for populated fields)
const formatUser = (userData) => {
  if (!userData) return null;
  return {
    id: userData.id,
    _id: userData.id,
    name: userData.name,
    email: userData.email,
  };
};

// @desc    Get all leads with pagination
// @route   GET /api/leads
// @access  Private
export const getLeads = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;
    const pool = getPool();

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Use table alias l. for all columns so WHERE is unambiguous when query joins leads l with users
    if (req.query.mandal) {
      conditions.push('l.mandal = ?');
      params.push(req.query.mandal);
    }
    if (req.query.state) {
      conditions.push('l.state = ?');
      params.push(req.query.state);
    }
    if (req.query.district) {
      conditions.push('l.district = ?');
      params.push(req.query.district);
    }
    if (req.query.quota) {
      conditions.push('l.quota = ?');
      params.push(req.query.quota);
    }
    if (req.query.leadStatus) {
      conditions.push('l.lead_status = ?');
      params.push(req.query.leadStatus);
    }
    if (req.query.applicationStatus) {
      conditions.push('l.application_status = ?');
      params.push(req.query.applicationStatus);
    }
    if (req.query.assignedTo) {
      conditions.push('l.assigned_to = ?');
      params.push(req.query.assignedTo);
    }
    if (req.query.courseInterested) {
      conditions.push('l.course_interested = ?');
      params.push(req.query.courseInterested);
    }
    if (req.query.source) {
      conditions.push('l.source = ?');
      params.push(req.query.source);
    }

    // Date filtering
    if (req.query.startDate) {
      conditions.push('l.created_at >= ?');
      const start = new Date(req.query.startDate);
      start.setHours(0, 0, 0, 0);
      params.push(start.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.endDate) {
      conditions.push('l.created_at <= ?');
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      params.push(end.toISOString().slice(0, 19).replace('T', ' '));
    }
    if (req.query.scheduledOn) {
      conditions.push('DATE(l.next_scheduled_call) = ?');
      params.push(req.query.scheduledOn);
    }
    if (req.query.academicYear != null && req.query.academicYear !== '') {
      conditions.push('l.academic_year = ?');
      params.push(Number(req.query.academicYear));
    }
    if (req.query.studentGroup) {
      if (req.query.studentGroup === 'Inter') {
        conditions.push("(l.student_group = 'Inter' OR l.student_group LIKE 'Inter-%')");
      } else {
        conditions.push('l.student_group = ?');
        params.push(req.query.studentGroup);
      }
    }

    // Enquiry number search
    if (req.query.enquiryNumber) {
      const searchTerm = req.query.enquiryNumber.trim();
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        conditions.push('l.enquiry_number LIKE ?');
        params.push(`${searchTerm}%`);
      } else {
        conditions.push('l.enquiry_number LIKE ?');
        params.push(`%${searchTerm}%`);
      }
    }

    // Full-text search
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      conditions.push(`(
        MATCH(l.enquiry_number, l.name, l.phone, l.email, l.father_name, l.mother_name, l.course_interested, l.district, l.mandal, l.state, l.application_status, l.hall_ticket_number, l.inter_college) 
        AGAINST(? IN NATURAL LANGUAGE MODE)
        OR l.name LIKE ?
        OR l.phone LIKE ?
        OR l.email LIKE ?
        OR l.district LIKE ?
      )`);
      params.push(searchTerm, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
    }

    // Access control - if user is not Super Admin, only show assigned leads
    if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
      const userId = req.user.id || req.user._id;
      conditions.push('l.assigned_to = ?');
      params.push(userId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for pagination (use alias l so same whereClause works)
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads l ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get count of leads that need manual update (same filters)
    const needsUpdateConditions = [...conditions, 'l.needs_manual_update = 1'];
    const needsUpdateWhereClause = `WHERE ${needsUpdateConditions.join(' AND ')}`;
    const [needsUpdateResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM leads l ${needsUpdateWhereClause}`,
      params
    );
    const needsUpdateCount = needsUpdateResult[0]?.total ?? 0;

    // Get leads with pagination and user info
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const query = `
      SELECT 
        l.*,
        u1.id as assigned_to_id, u1.name as assigned_to_name, u1.email as assigned_to_email,
        u2.id as uploaded_by_id, u2.name as uploaded_by_name
      FROM leads l
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;

    const [leads] = await pool.execute(query, params);

    // Format leads
    const formattedLeads = leads.map(lead => {
      const assignedToUser = lead.assigned_to_id ? {
        id: lead.assigned_to_id,
        _id: lead.assigned_to_id,
        name: lead.assigned_to_name,
        email: lead.assigned_to_email,
      } : null;
      
      const uploadedByUser = lead.uploaded_by_id ? {
        id: lead.uploaded_by_id,
        _id: lead.uploaded_by_id,
        name: lead.uploaded_by_name,
      } : null;

      return formatLead(lead, assignedToUser, uploadedByUser);
    });

    return successResponse(res, {
      leads: formattedLeads,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      needsUpdateCount,
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
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Get lead with user info
    const [leads] = await pool.execute(
      `SELECT 
        l.*,
        u1.id as assigned_to_id, u1.name as assigned_to_name, u1.email as assigned_to_email,
        u2.id as uploaded_by_id, u2.name as uploaded_by_name
      FROM leads l
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      WHERE l.id = ?`,
      [req.params.id]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const leadData = leads[0];

    // Check if user has access
    let hasAccess = false;

    // Super Admin always has access
    if (hasElevatedAdminPrivileges(req.user.roleName)) {
      hasAccess = true;
    }
    // If lead is assigned to the user, they have access
    else if (leadData.assigned_to === userId) {
      hasAccess = true;
    }
    // If user is a Manager, check if lead is assigned to one of their team members
    else if (req.user.isManager) {
      const [teamMembers] = await pool.execute(
        'SELECT id FROM users WHERE managed_by = ?',
        [userId]
      );
      const teamMemberIds = teamMembers.map(m => m.id);
      
      // Check if lead is assigned to manager or any team member
      if (leadData.assigned_to && (leadData.assigned_to === userId || teamMemberIds.includes(leadData.assigned_to))) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return errorResponse(res, 'Access denied', 403);
    }

    const assignedToUser = leadData.assigned_to_id ? {
      id: leadData.assigned_to_id,
      _id: leadData.assigned_to_id,
      name: leadData.assigned_to_name,
      email: leadData.assigned_to_email,
    } : null;

    const uploadedByUser = leadData.uploaded_by_id ? {
      id: leadData.uploaded_by_id,
      _id: leadData.uploaded_by_id,
      name: leadData.uploaded_by_name,
    } : null;

    const lead = formatLead(leadData, assignedToUser, uploadedByUser);

    return successResponse(res, lead, 'Lead retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting lead:', error);
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

    // Helper function to extract value from dynamicFields if direct field is missing
    const getFieldValue = (directValue, fieldVariations, dynamicFieldsObj) => {
      if (directValue && String(directValue).trim()) {
        return String(directValue).trim();
      }
      
      if (dynamicFieldsObj && typeof dynamicFieldsObj === 'object') {
        for (const variation of fieldVariations) {
          const key = Object.keys(dynamicFieldsObj).find(
            k => k.toLowerCase() === variation.toLowerCase()
          );
          if (key && dynamicFieldsObj[key] && String(dynamicFieldsObj[key]).trim()) {
            return String(dynamicFieldsObj[key]).trim();
          }
        }
      }
      
      return null;
    };

    // Extract required fields from direct values or dynamicFields
    const finalName = getFieldValue(name, ['name', 'fullname', 'full_name', 'studentname', 'student_name'], dynamicFields);
    const finalPhone = getFieldValue(phone, ['phone', 'phonenumber', 'phone_number', 'student_phone', 'studentphone', 'mobile', 'mobilenumber', 'mobile_number', 'contactnumber', 'contact_number', 'primaryphone', 'primary_phone'], dynamicFields);
    const finalFatherName = getFieldValue(fatherName, ['fathername', 'father_name', 'fathersname', 'fathers_name'], dynamicFields) || 'Not Provided';
    const finalFatherPhone = getFieldValue(fatherPhone, ['fatherphone', 'father_phone', 'fathersphone', 'fathers_phone', 'fatherphonenumber', 'father_phone_number'], dynamicFields) || 'Not Provided';
    const finalVillage = getFieldValue(village, ['village', 'city', 'town', 'address_village_city', 'address_village'], dynamicFields) || 'Not Provided';
    const finalDistrict = getFieldValue(district, ['district'], dynamicFields) || 'Not Provided';
    const finalMandal = getFieldValue(mandal, ['mandal', 'tehsil'], dynamicFields) || 'Not Provided';

    // Validate only name and phone as truly required
    if (!finalName || !finalPhone) {
      const missingFields = [];
      if (!finalName) missingFields.push('name');
      if (!finalPhone) missingFields.push('phone');
      
      return errorResponse(
        res, 
        `Please provide required fields: ${missingFields.join(', ')}. Make sure your form includes a student name field and a primary phone number field.`, 
        400
      );
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();

    // If UTM source exists, use it as the lead source
    const leadSource = utmSource ? String(utmSource).trim() : (source || 'Public Form');

    const pool = getPool();
    const leadId = uuidv4();

    // Insert lead
    await pool.execute(
      `INSERT INTO leads (
        id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
        hall_ticket_number, village, course_interested, district, mandal, state,
        is_nri, gender, \`rank\`, inter_college, quota, application_status,
        dynamic_fields, lead_status, source, utm_source, utm_medium, utm_campaign,
        utm_term, utm_content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        leadId,
        enquiryNumber,
        finalName,
        finalPhone,
        email || getFieldValue(email, ['email', 'emailaddress', 'email_address'], dynamicFields) || null,
        finalFatherName,
        motherName ? String(motherName).trim() : (getFieldValue(motherName, ['mothername', 'mother_name', 'mothersname', 'mothers_name'], dynamicFields) || ''),
        finalFatherPhone,
        hallTicketNumber ? String(hallTicketNumber).trim() : (getFieldValue(hallTicketNumber, ['hallticketnumber', 'hall_ticket_number', 'ticketnumber', 'ticket_number'], dynamicFields) || ''),
        finalVillage,
        courseInterested || getFieldValue(courseInterested, ['courseinterested', 'course_interested', 'course', 'coursename', 'course_name'], dynamicFields) || null,
        finalDistrict,
        finalMandal,
        state?.trim() || getFieldValue(state, ['state'], dynamicFields) || 'Andhra Pradesh',
        (() => {
          if (isNRI === true || isNRI === 'true') return true;
          const nriValue = getFieldValue(isNRI, ['isnri', 'is_nri', 'nri'], dynamicFields);
          return nriValue === true || nriValue === 'true';
        })(),
        gender ? String(gender).trim() : (getFieldValue(gender, ['gender'], dynamicFields) || 'Not Specified'),
        rank !== undefined && rank !== null && !Number.isNaN(Number(rank)) ? Number(rank) : (() => {
          const rankValue = getFieldValue(rank, ['rank'], dynamicFields);
          return rankValue && !Number.isNaN(Number(rankValue)) ? Number(rankValue) : null;
        })(),
        interCollege ? String(interCollege).trim() : (getFieldValue(interCollege, ['intercollege', 'inter_college', 'college', 'collegename', 'college_name'], dynamicFields) || ''),
        quota || 'Not Applicable',
        applicationStatus || 'Not Provided',
        JSON.stringify(dynamicFields || {}),
        'New',
        leadSource,
        utmSource ? String(utmSource).trim() : null,
        utmMedium ? String(utmMedium).trim() : null,
        utmCampaign ? String(utmCampaign).trim() : null,
        utmTerm ? String(utmTerm).trim() : null,
        utmContent ? String(utmContent).trim() : null,
      ]
    );

    // Fetch created lead
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );

    const lead = formatLead(leads[0]);

    // Send notification to lead (async, don't wait for it)
    notifyLeadCreated(lead).catch((error) => {
      console.error('[Lead] Error sending notification to lead:', error);
    });

    return successResponse(res, lead, 'Lead submitted successfully', 201);
  } catch (error) {
    console.error('Error creating public lead:', error);
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

    // Helper function to extract a value from direct fields or dynamicFields
    const getFieldValue = (directValue, fieldVariations, dynamicFieldsObj) => {
      if (directValue && String(directValue).trim()) {
        return String(directValue).trim();
      }

      if (dynamicFieldsObj && typeof dynamicFieldsObj === 'object') {
        for (const variation of fieldVariations) {
          const key = Object.keys(dynamicFieldsObj).find(
            (k) => k.toLowerCase() === variation.toLowerCase()
          );
          if (key && dynamicFieldsObj[key] && String(dynamicFieldsObj[key]).trim()) {
            return String(dynamicFieldsObj[key]).trim();
          }
        }
      }

      return null;
    };

    // Resolve key fields from either direct body values or dynamicFields
    const finalName = getFieldValue(
      name,
      ['name', 'fullname', 'full_name', 'studentname', 'student_name'],
      dynamicFields
    );
    const finalPhone = getFieldValue(
      phone,
      [
        'phone',
        'phonenumber',
        'phone_number',
        'student_phone',
        'studentphone',
        'mobile',
        'mobilenumber',
        'mobile_number',
        'contactnumber',
        'contact_number',
        'primaryphone',
        'primary_phone',
      ],
      dynamicFields
    );

    const finalFatherName =
      getFieldValue(
        fatherName,
        ['fathername', 'father_name', 'fathersname', 'fathers_name'],
        dynamicFields
      ) || 'Not Provided';
    const finalFatherPhone =
      getFieldValue(
        fatherPhone,
        [
          'fatherphone',
          'father_phone',
          'fathersphone',
          'fathers_phone',
          'fatherphonenumber',
          'father_phone_number',
        ],
        dynamicFields
      ) || 'Not Provided';
    const finalVillage =
      getFieldValue(village, ['village', 'city', 'town', 'address_village_city', 'address_village'], dynamicFields) || 'Not Provided';
    const finalDistrict =
      getFieldValue(district, ['district'], dynamicFields) || 'Not Provided';
    const finalMandal =
      getFieldValue(mandal, ['mandal', 'tehsil'], dynamicFields) || 'Not Provided';

    // For internal lead creation, only name and phone are truly required.
    if (!finalName || !finalPhone) {
      return errorResponse(res, 'Please provide name and phone', 400);
    }

    // Generate enquiry number
    const enquiryNumber = await generateEnquiryNumber();

    const pool = getPool();
    const leadId = uuidv4();
    const userId = req.user.id || req.user._id;

    // Insert lead
    await pool.execute(
      `INSERT INTO leads (
        id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
        hall_ticket_number, village, course_interested, district, mandal, state,
        gender, \`rank\`, inter_college, quota, application_status,
        dynamic_fields, lead_status, source, uploaded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        leadId,
        enquiryNumber,
        finalName,
        finalPhone,
        email || null,
        finalFatherName,
        motherName ? String(motherName).trim() : '',
        finalFatherPhone,
        hallTicketNumber ? String(hallTicketNumber).trim() : '',
        finalVillage,
        courseInterested || null,
        finalDistrict,
        finalMandal,
        state?.trim() || 'Andhra Pradesh',
        gender ? String(gender).trim() : 'Not Specified',
        rank !== undefined && rank !== null && !Number.isNaN(Number(rank)) ? Number(rank) : null,
        interCollege ? String(interCollege).trim() : '',
        quota || 'Not Applicable',
        applicationStatus || 'Not Provided',
        JSON.stringify(dynamicFields || {}),
        'New',
        source || 'Manual Entry',
        userId,
      ]
    );

    // Fetch created lead
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [leadId]
    );

    const lead = formatLead(leads[0]);

    // Send notification to lead (async, don't wait for it)
    notifyLeadCreated(lead).catch((error) => {
      console.error('[Lead] Error sending notification to lead:', error);
    });

    return successResponse(res, lead, 'Lead created successfully', 201);
  } catch (error) {
    console.error('Error creating lead:', error);
    return errorResponse(res, error.message || 'Failed to create lead', 500);
  }
};

// @desc    Update lead
// @route   PUT /api/leads/:id
// @access  Private
export const updateLead = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Get current lead
    const [leads] = await pool.execute(
      'SELECT * FROM leads WHERE id = ?',
      [req.params.id]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    const currentLead = leads[0];

    // Check if user has access
    if (!hasElevatedAdminPrivileges(req.user.roleName) && currentLead.assigned_to !== userId) {
      return errorResponse(res, 'Access denied', 403);
    }

    // Regular users can only update status and notes; Super Admin can update everything.
    // Assigned counsellor (user assigned to this lead) can also update profile fields: name, phone, father, village, state, district, mandal.
    const isSuperAdmin = hasElevatedAdminPrivileges(req.user.roleName);
    const isAssignedCounsellor = !isSuperAdmin && currentLead.assigned_to === userId;

    // Store original values for comparison
    const originalLead = {
      name: currentLead.name,
      phone: currentLead.phone,
      email: currentLead.email,
      fatherName: currentLead.father_name,
      fatherPhone: currentLead.father_phone,
      motherName: currentLead.mother_name,
      courseInterested: currentLead.course_interested,
      village: currentLead.village,
      district: currentLead.district,
      mandal: currentLead.mandal,
      state: currentLead.state,
      quota: currentLead.quota,
      gender: currentLead.gender,
      rank: currentLead.rank,
      interCollege: currentLead.inter_college,
      hallTicketNumber: currentLead.hall_ticket_number,
      applicationStatus: currentLead.application_status,
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
      nextScheduledCall,
      academicYear,
      studentGroup,
    } = req.body;

    const newLeadStatus = leadStatus ?? legacyStatus;
    const updateFields = [];
    const updateValues = [];
    let oldStatus = currentLead.lead_status || 'New';
    let oldAssignedTo = currentLead.assigned_to;
    let assignmentChanged = false;

    // Only Super Admin can update these fields
    if (isSuperAdmin) {
      if (hallTicketNumber !== undefined) {
        updateFields.push('hall_ticket_number = ?');
        updateValues.push(hallTicketNumber ? String(hallTicketNumber).trim() : '');
      }
      if (name) {
        updateFields.push('name = ?');
        updateValues.push(name.trim());
      }
      if (phone) {
        updateFields.push('phone = ?');
        updateValues.push(phone.trim());
      }
      if (email !== undefined) {
        updateFields.push('email = ?');
        updateValues.push(email || null);
      }
      if (fatherName) {
        updateFields.push('father_name = ?');
        updateValues.push(fatherName.trim());
      }
      if (fatherPhone) {
        updateFields.push('father_phone = ?');
        updateValues.push(fatherPhone.trim());
      }
      if (motherName !== undefined) {
        updateFields.push('mother_name = ?');
        updateValues.push(motherName ? String(motherName).trim() : '');
      }
      if (courseInterested !== undefined) {
        updateFields.push('course_interested = ?');
        updateValues.push(courseInterested || null);
      }
      if (village) {
        updateFields.push('village = ?');
        updateValues.push(village.trim());
      }
      if (district) {
        updateFields.push('district = ?');
        updateValues.push(district.trim());
      }
      if (mandal) {
        updateFields.push('mandal = ?');
        updateValues.push(mandal.trim());
      }
      if (state !== undefined) {
        const trimmedState = typeof state === 'string' ? state.trim() : state;
        updateFields.push('state = ?');
        updateValues.push(trimmedState ? trimmedState : 'Andhra Pradesh');
      }
      if (quota) {
        updateFields.push('quota = ?');
        updateValues.push(quota);
      }
      if (gender !== undefined) {
        updateFields.push('gender = ?');
        updateValues.push(gender ? String(gender).trim() : 'Not Specified');
      }
      if (rank !== undefined && rank !== null && !Number.isNaN(Number(rank))) {
        updateFields.push('`rank` = ?');
        updateValues.push(Number(rank));
      }
      if (interCollege !== undefined) {
        updateFields.push('inter_college = ?');
        updateValues.push(interCollege ? String(interCollege).trim() : '');
      }
      if (applicationStatus !== undefined) {
        updateFields.push('application_status = ?');
        updateValues.push(applicationStatus);
      }
      if (dynamicFields) {
        const currentDynamicFields = typeof currentLead.dynamic_fields === 'string' 
          ? JSON.parse(currentLead.dynamic_fields) 
          : currentLead.dynamic_fields || {};
        const mergedFields = { ...currentDynamicFields, ...dynamicFields };
        updateFields.push('dynamic_fields = ?');
        updateValues.push(JSON.stringify(mergedFields));
      }
      if (assignedTo) {
        const newAssignedTo = assignedTo.toString();
        
        // Only update if assignment is actually changing
        if (oldAssignedTo !== newAssignedTo) {
          assignmentChanged = true;
          updateFields.push('assigned_to = ?');
          updateValues.push(newAssignedTo);
          updateFields.push('assigned_at = NOW()');
          updateFields.push('assigned_by = ?');
          updateValues.push(userId);
          
          // If status is "New", automatically change to "Assigned"
          if (oldStatus === 'New' || !oldStatus) {
            oldStatus = oldStatus || 'New';
            updateFields.push('lead_status = ?');
            updateValues.push('Assigned');
          }
        }
      }
      if (source) {
        updateFields.push('source = ?');
        updateValues.push(source);
      }
      if (lastFollowUp) {
        updateFields.push('last_follow_up = ?');
        updateValues.push(new Date(lastFollowUp).toISOString().slice(0, 19).replace('T', ' '));
      }
    }

    // Assigned counsellor can update profile fields (same as edit form on user lead detail page)
    if (isAssignedCounsellor) {
      if (name) {
        updateFields.push('name = ?');
        updateValues.push(name.trim());
      }
      if (phone) {
        updateFields.push('phone = ?');
        updateValues.push(phone.trim());
      }
      if (fatherName !== undefined) {
        updateFields.push('father_name = ?');
        updateValues.push(fatherName ? String(fatherName).trim() : '');
      }
      if (fatherPhone !== undefined) {
        updateFields.push('father_phone = ?');
        updateValues.push(fatherPhone ? String(fatherPhone).trim() : '');
      }
      if (village !== undefined) {
        updateFields.push('village = ?');
        updateValues.push(village ? String(village).trim() : '');
      }
      if (state !== undefined) {
        const trimmedState = typeof state === 'string' ? state.trim() : state;
        updateFields.push('state = ?');
        updateValues.push(trimmedState ? trimmedState : 'Andhra Pradesh');
      }
      if (district !== undefined) {
        updateFields.push('district = ?');
        updateValues.push(district ? String(district).trim() : '');
      }
      if (mandal !== undefined) {
        updateFields.push('mandal = ?');
        updateValues.push(mandal ? String(mandal).trim() : '');
      }
    }

    // Both Super Admin and regular users can update status and notes
    if (newLeadStatus && newLeadStatus !== currentLead.lead_status) {
      updateFields.push('lead_status = ?');
      updateValues.push(newLeadStatus);
    }
    if (notes !== undefined) {
      updateFields.push('notes = ?');
      updateValues.push(notes || null);
    }
    if (nextScheduledCall !== undefined) {
      updateFields.push('next_scheduled_call = ?');
      updateValues.push(
        nextScheduledCall
          ? new Date(nextScheduledCall).toISOString().slice(0, 19).replace('T', ' ')
          : null
      );
    }
    if (academicYear !== undefined) {
      updateFields.push('academic_year = ?');
      updateValues.push(academicYear != null && academicYear !== '' ? Number(academicYear) : null);
    }
    if (studentGroup !== undefined) {
      updateFields.push('student_group = ?');
      updateValues.push(studentGroup ? String(studentGroup).trim() || null : null);
    }
    // Clear needs_manual_update when lead is updated (Super Admin or assigned counsellor has reviewed/corrected)
    if ((isSuperAdmin || isAssignedCounsellor) && updateFields.length > 0) {
      updateFields.push('needs_manual_update = ?');
      updateValues.push(0);
    }

    // Execute update
    if (updateFields.length > 0) {
      updateFields.push('updated_at = NOW()');
      updateValues.push(req.params.id);
      await pool.execute(
        `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // Create activity logs
    const finalStatus = newLeadStatus || currentLead.lead_status;
    
    // Log assignment change
    if (assignmentChanged && assignedTo) {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          req.params.id,
          'status_change',
          oldStatus,
          finalStatus,
          'Assigned to counsellor',
          userId,
          JSON.stringify({
            assignment: {
              assignedTo: assignedTo.toString(),
              assignedBy: userId,
            },
          }),
        ]
      );
    }

    // Log status change (if status changed and not due to assignment)
    if (newLeadStatus && newLeadStatus !== currentLead.lead_status && !assignmentChanged) {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (id, lead_id, type, old_status, new_status, performed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          req.params.id,
          'status_change',
          currentLead.lead_status,
          newLeadStatus,
          userId,
        ]
      );
    }

    // Log field updates (Super Admin or assigned counsellor)
    const updatedFields = [];
    if (name && name !== originalLead.name) updatedFields.push('name');
    if (phone && phone !== originalLead.phone) updatedFields.push('phone');
    if (email !== undefined && email !== originalLead.email) updatedFields.push('email');
    if (fatherName !== undefined && String(fatherName || '').trim() !== (originalLead.fatherName || '')) updatedFields.push('fatherName');
    if (fatherPhone !== undefined && String(fatherPhone || '').trim() !== (originalLead.fatherPhone || '')) updatedFields.push('fatherPhone');
    if (motherName !== undefined && motherName !== originalLead.motherName) updatedFields.push('motherName');
    if (courseInterested !== undefined && courseInterested !== originalLead.courseInterested) updatedFields.push('courseInterested');
    if (village !== undefined && (village || '').trim() !== (originalLead.village || '')) updatedFields.push('village');
    if (district !== undefined && (district || '').trim() !== (originalLead.district || '')) updatedFields.push('district');
    if (mandal !== undefined && (mandal || '').trim() !== (originalLead.mandal || '')) updatedFields.push('mandal');
    if (state !== undefined && state !== originalLead.state) updatedFields.push('state');
    if (quota && quota !== originalLead.quota) updatedFields.push('quota');
    if (gender !== undefined && gender !== originalLead.gender) updatedFields.push('gender');
    if (rank !== undefined && rank !== originalLead.rank) updatedFields.push('rank');
    if (interCollege !== undefined && interCollege !== originalLead.interCollege) updatedFields.push('interCollege');
    if (hallTicketNumber !== undefined && hallTicketNumber !== originalLead.hallTicketNumber) updatedFields.push('hallTicketNumber');
    if (applicationStatus !== undefined && applicationStatus !== originalLead.applicationStatus) updatedFields.push('applicationStatus');

    if ((isSuperAdmin || isAssignedCounsellor) && updatedFields.length > 0 && !assignedTo) {
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (id, lead_id, type, comment, performed_by, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          req.params.id,
          'field_update',
          `Student details updated: ${updatedFields.join(', ')}`,
          userId,
          JSON.stringify({
            fieldUpdate: {
              updatedFields,
            },
          }),
        ]
      );
    }

    // Fetch updated lead
    const [updatedLeads] = await pool.execute(
      `SELECT 
        l.*,
        u1.id as assigned_to_id, u1.name as assigned_to_name, u1.email as assigned_to_email,
        u2.id as uploaded_by_id, u2.name as uploaded_by_name
      FROM leads l
      LEFT JOIN users u1 ON l.assigned_to = u1.id
      LEFT JOIN users u2 ON l.uploaded_by = u2.id
      WHERE l.id = ?`,
      [req.params.id]
    );

    const assignedToUser = updatedLeads[0].assigned_to_id ? {
      id: updatedLeads[0].assigned_to_id,
      _id: updatedLeads[0].assigned_to_id,
      name: updatedLeads[0].assigned_to_name,
      email: updatedLeads[0].assigned_to_email,
    } : null;

    const uploadedByUser = updatedLeads[0].uploaded_by_id ? {
      id: updatedLeads[0].uploaded_by_id,
      _id: updatedLeads[0].uploaded_by_id,
      name: updatedLeads[0].uploaded_by_name,
    } : null;

    const lead = formatLead(updatedLeads[0], assignedToUser, uploadedByUser);

    return successResponse(res, lead, 'Lead updated successfully', 200);
  } catch (error) {
    console.error('Error updating lead:', error);
    return errorResponse(res, error.message || 'Failed to update lead', 500);
  }
};

// @desc    Delete lead
// @route   DELETE /api/leads/:id
// @access  Private (Super Admin only)
export const deleteLead = async (req, res) => {
  try {
    const pool = getPool();

    // Check if lead exists
    const [leads] = await pool.execute(
      'SELECT id FROM leads WHERE id = ?',
      [req.params.id]
    );

    if (leads.length === 0) {
      return errorResponse(res, 'Lead not found', 404);
    }

    // Only Super Admin can delete
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only', 403);
    }

    // Delete all activity logs for this lead first (CASCADE will handle this, but explicit for clarity)
    await pool.execute(
      'DELETE FROM activity_logs WHERE lead_id = ?',
      [req.params.id]
    );

    // Then delete the lead (CASCADE will also delete related records)
    await pool.execute(
      'DELETE FROM leads WHERE id = ?',
      [req.params.id]
    );

    return successResponse(res, null, 'Lead and associated activity logs deleted successfully', 200);
  } catch (error) {
    console.error('Error deleting lead:', error);
    return errorResponse(res, error.message || 'Failed to delete lead', 500);
  }
};

// Process delete job in background
const processDeleteJob = async (jobId) => {
  const pool = getPool();

  // Get job
  const [jobs] = await pool.execute(
    'SELECT * FROM delete_jobs WHERE job_id = ?',
    [jobId]
  );

  if (jobs.length === 0) {
    console.error(`Delete job ${jobId} not found`);
    return;
  }

  const job = jobs[0];

  if (job.status !== 'queued') {
    console.warn(`Delete job ${jobId} is not in queued status: ${job.status}`);
    return;
  }

  const startTime = Date.now();
  
  // Update job status to processing
  await pool.execute(
    'UPDATE delete_jobs SET status = ?, started_at = NOW(), updated_at = NOW() WHERE job_id = ?',
    ['processing', jobId]
  );

  try {
    // Get all lead IDs for this job
    const [leadIdsRows] = await pool.execute(
      'SELECT lead_id FROM delete_job_lead_ids WHERE delete_job_id = ?',
      [job.id]
    );

    const validIds = leadIdsRows
      .map(row => row.lead_id)
      .filter(id => id && typeof id === 'string' && id.length === 36); // UUID validation

    if (validIds.length === 0) {
      await pool.execute(
        `UPDATE delete_jobs SET 
          status = ?, completed_at = NOW(), updated_at = NOW(),
          stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
          stats_deleted_log_count = ?, stats_duration_ms = ?, message = ?
         WHERE job_id = ?`,
        ['completed', job.stats_requested_count || 0, 0, 0, 0, Date.now() - startTime, 'No valid lead IDs to delete', jobId]
      );
      return;
    }

    const uniqueValidIds = Array.from(new Set(validIds));
    const chunkSize = uniqueValidIds.length > 20000 ? 10000 : uniqueValidIds.length > 5000 ? 5000 : 1000;

    let totalLeadDeleted = 0;
    let totalLogDeleted = 0;
    const errorDetails = [];

    // Process in chunks
    for (let index = 0; index < uniqueValidIds.length; index += chunkSize) {
      const chunk = uniqueValidIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');

      try {
        // Delete activity logs first
        const [logResult] = await pool.execute(
          `DELETE FROM activity_logs WHERE lead_id IN (${placeholders})`,
          chunk
        );
        totalLogDeleted += logResult.affectedRows || 0;

        // Delete leads (CASCADE will handle related records)
        const [leadResult] = await pool.execute(
          `DELETE FROM leads WHERE id IN (${placeholders})`,
          chunk
        );
        totalLeadDeleted += leadResult.affectedRows || 0;

        // Update job progress periodically
        if ((index + chunkSize) % (chunkSize * 5) === 0 || index + chunkSize >= uniqueValidIds.length) {
          await pool.execute(
            `UPDATE delete_jobs SET 
              stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
              stats_deleted_log_count = ?, stats_duration_ms = ?, updated_at = NOW()
             WHERE job_id = ?`,
            [job.stats_requested_count || 0, uniqueValidIds.length, totalLeadDeleted, totalLogDeleted, Date.now() - startTime, jobId]
          );
        }

        // Yield the event loop
        await new Promise((resolve) => setImmediate(resolve));
      } catch (chunkError) {
        console.error(`Error deleting chunk ${index}-${index + chunkSize}:`, chunkError);
        chunk.forEach((id) => {
          errorDetails.push({
            leadId: id,
            error: chunkError.message || 'Unknown error',
          });
        });
      }
    }

    const durationMs = Date.now() - startTime;

    // Insert error details (limit to 200)
    const limitedErrors = errorDetails.slice(0, 200);
    for (const errorDetail of limitedErrors) {
      const errorId = uuidv4();
      await pool.execute(
        'INSERT INTO delete_job_error_details (id, delete_job_id, lead_id, error, created_at) VALUES (?, ?, ?, ?, NOW())',
        [errorId, job.id, errorDetail.leadId, errorDetail.error]
      );
    }

    // Update job to completed
    await pool.execute(
      `UPDATE delete_jobs SET 
        status = ?, completed_at = NOW(), updated_at = NOW(),
        stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
        stats_deleted_log_count = ?, stats_duration_ms = ?, message = ?
       WHERE job_id = ?`,
      [
        'completed',
        job.stats_requested_count || 0,
        uniqueValidIds.length,
        totalLeadDeleted,
        totalLogDeleted,
        durationMs,
        `Deleted ${totalLeadDeleted} lead(s) and ${totalLogDeleted} activity log(s) in ${durationMs} ms`,
        jobId
      ]
    );

    console.log(`Delete job ${jobId} completed: ${totalLeadDeleted} leads deleted`);
  } catch (error) {
    console.error(`Delete job ${jobId} failed:`, error);
    await pool.execute(
      `UPDATE delete_jobs SET 
        status = ?, completed_at = NOW(), updated_at = NOW(),
        stats_requested_count = ?, stats_valid_count = ?, stats_deleted_lead_count = ?,
        stats_deleted_log_count = ?, stats_duration_ms = ?, message = ?
       WHERE job_id = ?`,
      [
        'failed',
        job.stats_requested_count || 0,
        0,
        0,
        0,
        Date.now() - startTime,
        error.message || 'Failed to process delete job',
        jobId
      ]
    );
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

    // Validate UUIDs (36 characters)
    const validIds = leadIds.filter((id) => {
      return id && typeof id === 'string' && id.length === 36;
    });

    if (validIds.length === 0) {
      return errorResponse(res, 'No valid lead IDs provided', 400);
    }

    const uniqueValidIds = Array.from(new Set(validIds));
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Create delete job
    const jobId = uuidv4();
    const deleteJobId = uuidv4();

    await pool.execute(
      `INSERT INTO delete_jobs (
        id, job_id, status, deleted_by, stats_requested_count, stats_valid_count,
        stats_deleted_lead_count, stats_deleted_log_count, stats_duration_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        deleteJobId,
        jobId,
        'queued',
        userId,
        leadIds.length,
        uniqueValidIds.length,
        0,
        0,
        0,
      ]
    );

    // Insert lead IDs
    for (const leadId of uniqueValidIds) {
      const leadIdRecordId = uuidv4();
      await pool.execute(
        'INSERT INTO delete_job_lead_ids (id, delete_job_id, lead_id, created_at) VALUES (?, ?, ?, NOW())',
        [leadIdRecordId, deleteJobId, leadId]
      );
    }

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

    const pool = getPool();

    const [jobs] = await pool.execute(
      'SELECT * FROM delete_jobs WHERE job_id = ?',
      [jobId]
    );

    if (jobs.length === 0) {
      return errorResponse(res, 'Delete job not found', 404);
    }

    const job = jobs[0];

    // Get error details
    const [errorDetails] = await pool.execute(
      'SELECT lead_id, error FROM delete_job_error_details WHERE delete_job_id = ? LIMIT 200',
      [job.id]
    );

    return successResponse(
      res,
      {
        jobId: job.job_id,
        status: job.status,
        stats: {
          requestedCount: job.stats_requested_count,
          validCount: job.stats_valid_count,
          deletedLeadCount: job.stats_deleted_lead_count,
          deletedLogCount: job.stats_deleted_log_count,
          durationMs: job.stats_duration_ms,
        },
        errorDetails: errorDetails.map(e => ({ leadId: e.lead_id, error: e.error })),
        message: job.message,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        createdAt: job.created_at,
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
    const pool = getPool();

    // Build WHERE conditions (same as getLeads)
    const conditions = [];
    const params = [];

    if (req.query.mandal) {
      conditions.push('mandal = ?');
      params.push(req.query.mandal);
    }
    if (req.query.state) {
      conditions.push('state = ?');
      params.push(req.query.state);
    }
    if (req.query.district) {
      conditions.push('district = ?');
      params.push(req.query.district);
    }
    if (req.query.quota) {
      conditions.push('quota = ?');
      params.push(req.query.quota);
    }
    if (req.query.leadStatus) {
      conditions.push('lead_status = ?');
      params.push(req.query.leadStatus);
    }
    if (req.query.applicationStatus) {
      conditions.push('application_status = ?');
      params.push(req.query.applicationStatus);
    }
    if (req.query.assignedTo) {
      conditions.push('assigned_to = ?');
      params.push(req.query.assignedTo);
    }
    if (req.query.enquiryNumber) {
      const searchTerm = req.query.enquiryNumber.trim();
      if (searchTerm.toUpperCase().startsWith('ENQ')) {
        conditions.push('enquiry_number LIKE ?');
        params.push(`${searchTerm}%`);
      } else {
        conditions.push('enquiry_number LIKE ?');
        params.push(`%${searchTerm}%`);
      }
    }
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      conditions.push(`(
        MATCH(enquiry_number, name, phone, email, father_name, mother_name, course_interested, district, mandal, state, application_status, hall_ticket_number, inter_college) 
        AGAINST(? IN NATURAL LANGUAGE MODE)
        OR name LIKE ?
        OR phone LIKE ?
        OR email LIKE ?
        OR district LIKE ?
      )`);
      params.push(searchTerm, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`);
    }

    // Access control
    const userId = req.user.id || req.user._id;
    if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
      conditions.push('assigned_to = ?');
      params.push(userId);
    }

    // Optionally exclude leads that were "touched today" by the current user (call, SMS, or activity log)
    const excludeTouchedToday = req.query.excludeTouchedToday === 'true' || req.query.excludeTouchedToday === '1';
    if (excludeTouchedToday) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM communications c
        WHERE c.lead_id = leads.id AND c.sent_by = ? AND DATE(c.sent_at) = CURDATE()
      )`);
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM activity_logs a
        WHERE a.lead_id = leads.id AND a.performed_by = ? AND DATE(a.created_at) = CURDATE()
      )`);
      params.push(userId, userId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get IDs ordered by assignment time: latest assigned first (assigned_at DESC), then by id for stability
    const [leadIds] = await pool.execute(
      `SELECT id FROM leads ${whereClause} ORDER BY assigned_at DESC, id ASC`,
      params
    );

    const ids = leadIds.map(row => row.id);

    return successResponse(res, {
      ids,
      count: ids.length,
    }, 'Lead IDs retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting lead IDs:', error);
    return errorResponse(res, error.message || 'Failed to get lead IDs', 500);
  }
};

// @desc    Get filter options (public - for form dropdowns)
// @route   GET /api/leads/filters/options/public
// @access  Public
export const getPublicFilterOptions = async (req, res) => {
  try {
    const pool = getPool();

    // Get distinct values for each field
    const [mandals] = await pool.execute('SELECT DISTINCT mandal FROM leads WHERE mandal IS NOT NULL AND mandal != "" ORDER BY mandal ASC');
    const [districts] = await pool.execute('SELECT DISTINCT district FROM leads WHERE district IS NOT NULL AND district != "" ORDER BY district ASC');
    const [states] = await pool.execute('SELECT DISTINCT state FROM leads WHERE state IS NOT NULL AND state != "" ORDER BY state ASC');
    const [quotas] = await pool.execute('SELECT DISTINCT quota FROM leads WHERE quota IS NOT NULL AND quota != "" ORDER BY quota ASC');
    const [applicationStatuses] = await pool.execute('SELECT DISTINCT application_status FROM leads WHERE application_status IS NOT NULL AND application_status != "" ORDER BY application_status ASC');

    return successResponse(res, {
      mandals: mandals.map(r => r.mandal),
      districts: districts.map(r => r.district),
      states: states.map(r => r.state),
      quotas: quotas.map(r => r.quota),
      applicationStatuses: applicationStatuses.map(r => r.application_status),
    }, 'Filter options retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting public filter options:', error);
    return errorResponse(res, error.message || 'Failed to get filter options', 500);
  }
};

// @desc    Get filter options (for dropdowns)
// @route   GET /api/leads/filters/options
// @access  Private
export const getFilterOptions = async (req, res) => {
  try {
    const pool = getPool();

    // Build WHERE clause for access control
    const conditions = [];

    if (!hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin') {
      const userId = req.user.id || req.user._id;
      conditions.push('assigned_to = ?');
    }

    // Add field-specific conditions
    const mandalCondition = [...conditions, 'mandal IS NOT NULL AND mandal != ""'];
    const districtCondition = [...conditions, 'district IS NOT NULL AND district != ""'];
    const stateCondition = [...conditions, 'state IS NOT NULL AND state != ""'];
    const quotaCondition = [...conditions, 'quota IS NOT NULL AND quota != ""'];
    const leadStatusCondition = [...conditions, 'lead_status IS NOT NULL AND lead_status != ""'];
    const appStatusCondition = [...conditions, 'application_status IS NOT NULL AND application_status != ""'];

    const whereClause = (conditions) => conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const params = !hasElevatedAdminPrivileges(req.user.roleName) && req.user.roleName !== 'Admin' 
      ? [req.user.id || req.user._id] 
      : [];

    // Get distinct values for each field
    const [mandals] = await pool.execute(
      `SELECT DISTINCT mandal FROM leads ${whereClause(mandalCondition)} ORDER BY mandal ASC`,
      params
    );
    const [districts] = await pool.execute(
      `SELECT DISTINCT district FROM leads ${whereClause(districtCondition)} ORDER BY district ASC`,
      params
    );
    const [states] = await pool.execute(
      `SELECT DISTINCT state FROM leads ${whereClause(stateCondition)} ORDER BY state ASC`,
      params
    );
    const [quotas] = await pool.execute(
      `SELECT DISTINCT quota FROM leads ${whereClause(quotaCondition)} ORDER BY quota ASC`,
      params
    );
    const [leadStatuses] = await pool.execute(
      `SELECT DISTINCT lead_status FROM leads ${whereClause(leadStatusCondition)} ORDER BY lead_status ASC`,
      params
    );
    const [applicationStatuses] = await pool.execute(
      `SELECT DISTINCT application_status FROM leads ${whereClause(appStatusCondition)} ORDER BY application_status ASC`,
      params
    );

    const academicYearCondition = [...conditions, 'academic_year IS NOT NULL'];
    const studentGroupCondition = [...conditions, 'student_group IS NOT NULL AND student_group != ""'];
    const [academicYearsRows] = await pool.execute(
      `SELECT DISTINCT academic_year FROM leads ${whereClause(academicYearCondition)} ORDER BY academic_year DESC`,
      params
    );
    const [studentGroupsRows] = await pool.execute(
      `SELECT DISTINCT student_group FROM leads ${whereClause(studentGroupCondition)} ORDER BY student_group ASC`,
      params
    );
    const academicYears = academicYearsRows.map(r => r.academic_year).filter(Boolean);
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= currentYear - 3; y -= 1) {
      if (!academicYears.includes(y)) academicYears.unshift(y);
    }
    academicYears.sort((a, b) => b - a);

    const studentGroupOptions = ['10th', 'Inter', 'Inter-MPC', 'Inter-BIPC', 'Degree', 'Diploma'];
    const studentGroupsFromDb = studentGroupsRows.map(r => r.student_group).filter(Boolean);
    const studentGroups = [...new Set([...studentGroupOptions, ...studentGroupsFromDb])].sort();

    return successResponse(res, {
      mandals: mandals.map(r => r.mandal),
      districts: districts.map(r => r.district),
      states: states.map(r => r.state),
      quotas: quotas.map(r => r.quota),
      leadStatuses: leadStatuses.map(r => r.lead_status),
      applicationStatuses: applicationStatuses.map(r => r.application_status),
      academicYears,
      studentGroups,
    }, 'Filter options retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting filter options:', error);
    return errorResponse(res, error.message || 'Failed to get filter options', 500);
  }
};

