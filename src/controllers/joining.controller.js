import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_GENERAL_RESERVATION = 'oc';

const sanitizeString = (value) =>
  typeof value === 'string' ? value.trim() : value ?? '';

const ensureLeadExists = async (leadId) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    throw new Error('Invalid lead identifier provided');
  }

  const pool = getPool();
  const [leads] = await pool.execute(
    'SELECT * FROM leads WHERE id = ?',
    [leadId]
  );

  if (leads.length === 0) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  // Format lead data
  const lead = formatLead(leads[0]);
  return lead;
};

// Helper function to format lead data from SQL
const formatLead = (leadData) => {
  if (!leadData) return null;
  return {
    _id: leadData.id,
    id: leadData.id,
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
    gender: leadData.gender || 'Not Specified',
    quota: leadData.quota || 'Not Applicable',
    leadStatus: leadData.lead_status || 'New',
    admissionNumber: leadData.admission_number,
    dynamicFields: typeof leadData.dynamic_fields === 'string'
      ? JSON.parse(leadData.dynamic_fields)
      : leadData.dynamic_fields || {},
    createdAt: leadData.created_at,
    updatedAt: leadData.updated_at,
  };
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
    if (!leadId || !userId) return;
    
    const pool = getPool();
    const activityId = uuidv4();
    await pool.execute(
      `INSERT INTO activity_logs (id, lead_id, type, performed_by, comment, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        activityId,
        leadId,
        'joining_update',
        userId,
        description,
        JSON.stringify({
          statusFrom: statusFrom || null,
          statusTo: statusTo || null,
        }),
      ]
    );
  } catch (error) {
    console.error('Failed to append joining activity log:', error);
  }
};

const generateAdmissionNumber = async () => {
  const pool = getPool();
  const currentYear = new Date().getFullYear();

  // Try to get existing sequence
  const [sequences] = await pool.execute(
    'SELECT * FROM admission_sequences WHERE year = ?',
    [currentYear]
  );

  let sequenceNumber = 1;

  if (sequences.length > 0) {
    // Update existing sequence
    sequenceNumber = sequences[0].last_sequence + 1;
    await pool.execute(
      'UPDATE admission_sequences SET last_sequence = ?, updated_at = NOW() WHERE year = ?',
      [sequenceNumber, currentYear]
    );
  } else {
    // Create new sequence
    const sequenceId = uuidv4();
    await pool.execute(
      'INSERT INTO admission_sequences (id, year, last_sequence, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [sequenceId, currentYear, sequenceNumber]
    );
  }

  return `${currentYear}${String(sequenceNumber).padStart(5, '0')}`;
};

// Helper function to format joining data from SQL to camelCase
const formatJoining = async (joiningData, pool) => {
  if (!joiningData) return null;

  const joiningId = joiningData.id;

  // Fetch related data
  const [relatives] = await pool.execute(
    'SELECT * FROM joining_relatives WHERE joining_id = ?',
    [joiningId]
  );

  const [educationHistory] = await pool.execute(
    'SELECT * FROM joining_education_history WHERE joining_id = ? ORDER BY created_at ASC',
    [joiningId]
  );

  const [siblings] = await pool.execute(
    'SELECT * FROM joining_siblings WHERE joining_id = ? ORDER BY created_at ASC',
    [joiningId]
  );

  // Parse JSON fields
  const leadData = typeof joiningData.lead_data === 'string'
    ? JSON.parse(joiningData.lead_data)
    : joiningData.lead_data || {};

  const reservationOther = typeof joiningData.reservation_other === 'string'
    ? JSON.parse(joiningData.reservation_other)
    : joiningData.reservation_other || [];

  const qualificationMediums = typeof joiningData.qualification_mediums === 'string'
    ? JSON.parse(joiningData.qualification_mediums)
    : joiningData.qualification_mediums || [];

  return {
    _id: joiningData.id,
    id: joiningData.id,
    leadId: joiningData.lead_id,
    leadData,
    status: joiningData.status,
    courseInfo: {
      courseId: joiningData.course_id,
      branchId: joiningData.branch_id,
      course: joiningData.course || '',
      branch: joiningData.branch || '',
      quota: joiningData.quota || '',
    },
    paymentSummary: {
      totalFee: Number(joiningData.payment_total_fee) || 0,
      totalPaid: Number(joiningData.payment_total_paid) || 0,
      balance: Number(joiningData.payment_balance) || 0,
      currency: joiningData.payment_currency || 'INR',
      status: joiningData.payment_status || 'not_started',
      lastPaymentAt: joiningData.payment_last_payment_at,
    },
    studentInfo: {
      name: joiningData.student_name || '',
      phone: joiningData.student_phone || '',
      gender: joiningData.student_gender || '',
      dateOfBirth: joiningData.student_date_of_birth || '',
      notes: joiningData.student_notes || '',
      aadhaarNumber: joiningData.student_aadhaar_number || '',
    },
    parents: {
      father: {
        name: joiningData.father_name || '',
        phone: joiningData.father_phone || '',
        aadhaarNumber: joiningData.father_aadhaar_number || '',
      },
      mother: {
        name: joiningData.mother_name || '',
        phone: joiningData.mother_phone || '',
        aadhaarNumber: joiningData.mother_aadhaar_number || '',
      },
    },
    reservation: {
      general: joiningData.reservation_general || 'oc',
      other: reservationOther,
    },
    address: {
      communication: {
        doorOrStreet: joiningData.address_door_street || '',
        landmark: joiningData.address_landmark || '',
        villageOrCity: joiningData.address_village_city || '',
        mandal: joiningData.address_mandal || '',
        district: joiningData.address_district || '',
        pinCode: joiningData.address_pin_code || '',
      },
      relatives: relatives.map((rel) => ({
        name: rel.name || '',
        relationship: rel.relationship || '',
        doorOrStreet: rel.door_street || '',
        landmark: rel.landmark || '',
        villageOrCity: rel.village_city || '',
        mandal: rel.mandal || '',
        district: rel.district || '',
        pinCode: rel.pin_code || '',
      })),
    },
    qualifications: {
      ssc: joiningData.qualification_ssc === 1 || joiningData.qualification_ssc === true,
      interOrDiploma: joiningData.qualification_inter_diploma === 1 || joiningData.qualification_inter_diploma === true,
      ug: joiningData.qualification_ug === 1 || joiningData.qualification_ug === true,
      mediums: qualificationMediums,
      otherMediumLabel: joiningData.qualification_other_medium_label || '',
    },
    educationHistory: educationHistory.map((edu) => ({
      level: edu.level,
      otherLevelLabel: edu.other_level_label || '',
      courseOrBranch: edu.course_or_branch || '',
      yearOfPassing: edu.year_of_passing || '',
      institutionName: edu.institution_name || '',
      institutionAddress: edu.institution_address || '',
      hallTicketNumber: edu.hall_ticket_number || '',
      totalMarksOrGrade: edu.total_marks_or_grade || '',
      cetRank: edu.cet_rank || '',
    })),
    siblings: siblings.map((sib) => ({
      name: sib.name || '',
      relation: sib.relation || '',
      studyingStandard: sib.studying_standard || '',
      institutionName: sib.institution_name || '',
    })),
    documents: {
      ssc: joiningData.document_ssc || 'pending',
      inter: joiningData.document_inter || 'pending',
      ugPgCmm: joiningData.document_ug_pg_cmm || 'pending',
      transferCertificate: joiningData.document_transfer_certificate || 'pending',
      studyCertificate: joiningData.document_study_certificate || 'pending',
      aadhaarCard: joiningData.document_aadhaar_card || 'pending',
      photos: joiningData.document_photos || 'pending',
      incomeCertificate: joiningData.document_income_certificate || 'pending',
      casteCertificate: joiningData.document_caste_certificate || 'pending',
      cetRankCard: joiningData.document_cet_rank_card || 'pending',
      cetHallTicket: joiningData.document_cet_hall_ticket || 'pending',
      allotmentLetter: joiningData.document_allotment_letter || 'pending',
      joiningReport: joiningData.document_joining_report || 'pending',
      bankPassbook: joiningData.document_bank_passbook || 'pending',
      rationCard: joiningData.document_ration_card || 'pending',
    },
    draftUpdatedAt: joiningData.draft_updated_at,
    submittedAt: joiningData.submitted_at,
    submittedBy: joiningData.submitted_by,
    approvedAt: joiningData.approved_at,
    approvedBy: joiningData.approved_by,
    createdBy: joiningData.created_by,
    updatedBy: joiningData.updated_by,
    createdAt: joiningData.created_at,
    updatedAt: joiningData.updated_at,
  };
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

    const pool = getPool();
    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Number(page) - 1) * paginationLimit;

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Status filtering
    if (statusParam) {
      const statusesRaw = Array.isArray(statusParam) ? statusParam : String(statusParam).split(',');
      const statuses = statusesRaw
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);

      if (statuses.length === 1) {
        conditions.push('j.status = ?');
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        conditions.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }

    // Lead status filtering
    if (leadStatus) {
      conditions.push('(l.lead_status = ? OR JSON_EXTRACT(j.lead_data, "$.leadStatus") = ?)');
      params.push(leadStatus, leadStatus);
    }

    // Search filtering
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(`(
        l.name LIKE ? OR l.phone LIKE ? OR l.hall_ticket_number LIKE ? OR l.enquiry_number LIKE ?
        OR JSON_EXTRACT(j.lead_data, "$.name") LIKE ? OR JSON_EXTRACT(j.lead_data, "$.phone") LIKE ?
        OR JSON_EXTRACT(j.lead_data, "$.hallTicketNumber") LIKE ? OR JSON_EXTRACT(j.lead_data, "$.enquiryNumber") LIKE ?
        OR j.student_name LIKE ? OR j.student_phone LIKE ?
      )`);
      params.push(
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total
       FROM joinings j
       LEFT JOIN leads l ON j.lead_id = l.id
       ${whereClause}`,
      params
    );
    const total = countResult[0]?.total || 0;

    // Get paginated results
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [joinings] = await pool.execute(
      `SELECT j.*, l.name as lead_name, l.phone as lead_phone, l.hall_ticket_number as lead_hall_ticket_number,
              l.enquiry_number as lead_enquiry_number, l.lead_status as lead_lead_status
       FROM joinings j
       LEFT JOIN leads l ON j.lead_id = l.id
       ${whereClause}
       ORDER BY j.updated_at DESC
       LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`,
      params
    );

    // Format joinings
    const formattedJoinings = await Promise.all(
      joinings.map((j) => formatJoining(j, pool))
    );

    return successResponse(
      res,
      {
        joinings: formattedJoinings,
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

    const pool = getPool();
    let joiningDoc = null;
    let lead = null;

    // Check if leadId is actually a joining _id (for joinings without leads)
    // First, try to find joining by id (in case it's a joining without a lead)
    if (leadId && typeof leadId === 'string' && leadId.length === 36) {
      const [joinings] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ?',
        [leadId]
      );

      if (joinings.length > 0) {
        joiningDoc = joinings[0];
        if (!joiningDoc.lead_id) {
          // This is a joining without a lead, return it
          const formattedJoining = await formatJoining(joiningDoc, pool);
          return successResponse(
            res,
            {
              joining: formattedJoining,
              lead: null,
            },
            'Joining draft retrieved successfully',
            200
          );
        }
      }
    }

    // If not found by id, try to find by leadId
    if (!joiningDoc) {
      try {
        lead = await ensureLeadExists(leadId);
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE lead_id = ?',
          [leadId]
        );

        if (joinings.length > 0) {
          joiningDoc = joinings[0];
        }
      } catch (error) {
        // If lead doesn't exist and it's not a valid UUID, return error
        if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
          return errorResponse(res, 'Invalid joining or lead identifier', 404);
        }
        throw error;
      }
    }

    if (!joiningDoc && lead) {
      // Store complete lead data snapshot
      const leadDataSnapshot = { ...lead };
      delete leadDataSnapshot._id;
      delete leadDataSnapshot.id;
      delete leadDataSnapshot.__v;
      
      const joiningId = uuidv4();
      await pool.execute(
        `INSERT INTO joinings (
          id, lead_id, lead_data, status, course, quota,
          student_name, student_phone, student_gender, student_notes,
          father_name, father_phone, mother_name,
          reservation_general, reservation_other,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          joiningId,
          leadId,
          JSON.stringify(leadDataSnapshot),
          'draft',
          lead.courseInterested || '',
          lead.quota || '',
          lead.name,
          lead.phone,
          lead.gender || '',
          'As per SSC for no issues',
          lead.fatherName || '',
          lead.fatherPhone || '',
          lead.motherName || '',
          DEFAULT_GENERAL_RESERVATION,
          JSON.stringify([]),
          req.user.id,
          req.user.id,
        ]
      );

      // Fetch created joining
      const [created] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ?',
        [joiningId]
      );
      joiningDoc = created[0];

      await recordActivity({
        leadId: lead.id,
        userId: req.user.id,
        description: 'Joining draft created automatically',
      });
    }

    const formattedJoining = joiningDoc ? await formatJoining(joiningDoc, pool) : null;

    return successResponse(
      res,
      {
        joining: formattedJoining,
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

// Helper function to save related tables (relatives, education history, siblings)
const saveJoiningRelatedTables = async (pool, joiningId, payload) => {
  // Delete existing related records
  await pool.execute('DELETE FROM joining_relatives WHERE joining_id = ?', [joiningId]);
  await pool.execute('DELETE FROM joining_education_history WHERE joining_id = ?', [joiningId]);
  await pool.execute('DELETE FROM joining_siblings WHERE joining_id = ?', [joiningId]);

  // Insert relatives
  if (Array.isArray(payload.address?.relatives)) {
    for (const relative of payload.address.relatives) {
      const relativeId = uuidv4();
      await pool.execute(
        `INSERT INTO joining_relatives (id, joining_id, name, relationship, door_street, landmark,
         village_city, mandal, district, pin_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          relativeId,
          joiningId,
          relative.name || '',
          relative.relationship || '',
          relative.doorOrStreet || '',
          relative.landmark || '',
          relative.villageOrCity || '',
          relative.mandal || '',
          relative.district || '',
          relative.pinCode || '',
        ]
      );
    }
  }

  // Insert education history
  if (Array.isArray(payload.educationHistory)) {
    for (const edu of payload.educationHistory) {
      const eduId = uuidv4();
      await pool.execute(
        `INSERT INTO joining_education_history (id, joining_id, level, other_level_label,
         course_or_branch, year_of_passing, institution_name, institution_address,
         hall_ticket_number, total_marks_or_grade, cet_rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eduId,
          joiningId,
          edu.level,
          edu.otherLevelLabel || '',
          edu.courseOrBranch || '',
          edu.yearOfPassing || '',
          edu.institutionName || '',
          edu.institutionAddress || '',
          edu.hallTicketNumber || '',
          edu.totalMarksOrGrade || '',
          edu.cetRank || '',
        ]
      );
    }
  }

  // Insert siblings
  if (Array.isArray(payload.siblings)) {
    for (const sibling of payload.siblings) {
      const siblingId = uuidv4();
      await pool.execute(
        `INSERT INTO joining_siblings (id, joining_id, name, relation, studying_standard,
         institution_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          siblingId,
          joiningId,
          sibling.name || '',
          sibling.relation || '',
          sibling.studyingStandard || '',
          sibling.institutionName || '',
        ]
      );
    }
  }
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
      if (leadId && typeof leadId === 'string' && leadId.length === 36) {
        const [existingJoinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [leadId]
        );

        if (existingJoinings.length > 0) {
          const existingJoining = existingJoinings[0];
          if (!existingJoining.lead_id) {
            // This is a joining without a lead, use it directly
            joiningId = leadId;
            lead = null;
          } else if (existingJoining.lead_id) {
            // This is a joining with a lead, use the leadId
            lead = await ensureLeadExists(existingJoining.lead_id);
          } else {
            // Try to find lead
            try {
              lead = await ensureLeadExists(leadId);
            } catch (error) {
              // If lead not found, treat as invalid
              if (error.statusCode === 404) {
                return errorResponse(res, 'Invalid joining or lead identifier', 404);
              }
              throw error;
            }
          }
        } else {
          // Try to find lead
          try {
            lead = await ensureLeadExists(leadId);
          } catch (error) {
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

    const pool = getPool();
    let courseDoc = null;
    let branchDoc = null;

    if (payload.courseInfo?.branchId && !payload.courseInfo?.courseId) {
      const [branches] = await pool.execute(
        'SELECT * FROM branches WHERE id = ?',
        [payload.courseInfo.branchId]
      );
      if (branches.length === 0) {
        return errorResponse(res, 'Selected branch could not be found', 404);
      }
      branchDoc = branches[0];
      payload.courseInfo.courseId = branchDoc.course_id;
    }

    if (payload.courseInfo?.courseId) {
      const [courses] = await pool.execute(
        'SELECT * FROM courses WHERE id = ?',
        [payload.courseInfo.courseId]
      );
      if (courses.length === 0) {
        return errorResponse(res, 'Selected course could not be found', 404);
      }
      courseDoc = courses[0];
      payload.courseInfo.courseId = courseDoc.id;
    }

    if (payload.courseInfo?.branchId) {
      if (!branchDoc) {
        const [branches] = await pool.execute(
          'SELECT * FROM branches WHERE id = ? AND course_id = ?',
          [payload.courseInfo.branchId, payload.courseInfo.courseId || courseDoc?.id]
        );
        if (branches.length === 0) {
          return errorResponse(res, 'Selected branch is invalid for the chosen course', 400);
        }
        branchDoc = branches[0];
      }

      payload.courseInfo.branchId = branchDoc.id;
      if (!payload.courseInfo.branch) {
        payload.courseInfo.branch = branchDoc.name;
      }

      if (!payload.courseInfo.courseId) {
        payload.courseInfo.courseId = branchDoc.course_id;
      }
    }

    if (courseDoc && !payload.courseInfo?.course) {
      payload.courseInfo.course = courseDoc.name;
    }

    let joiningIdToUse = null;
    let previousStatus = 'draft';
    let isNewRecord = false;

    // Find or create joining
    if (isNewJoining || joiningId) {
      const payloadId = payload._id || joiningId;
      delete payload._id;

      if (payloadId && typeof payloadId === 'string' && payloadId.length === 36) {
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [payloadId]
        );
        if (joinings.length > 0) {
          joiningIdToUse = payloadId;
          previousStatus = joinings[0].status;
        } else {
          return errorResponse(res, 'Joining form not found', 404);
        }
      } else {
        // Create new joining form
        joiningIdToUse = uuidv4();
        isNewRecord = true;
        await pool.execute(
          `INSERT INTO joinings (id, lead_id, lead_data, status, reservation_general, reservation_other,
           created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            joiningIdToUse,
            null,
            JSON.stringify({}),
            'draft',
            DEFAULT_GENERAL_RESERVATION,
            JSON.stringify([]),
            req.user.id,
            req.user.id,
          ]
        );
      }
    } else {
      if (joiningId) {
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE id = ?',
          [joiningId]
        );
        if (joinings.length > 0) {
          joiningIdToUse = joiningId;
          previousStatus = joinings[0].status;
        } else {
          return errorResponse(res, 'Joining form not found', 404);
        }
      } else {
        // Try to find by leadId
        const [joinings] = await pool.execute(
          'SELECT * FROM joinings WHERE lead_id = ?',
          [leadId]
        );
        if (joinings.length > 0) {
          joiningIdToUse = joinings[0].id;
          previousStatus = joinings[0].status;
        } else {
          // Create new joining for this lead
          joiningIdToUse = uuidv4();
          isNewRecord = true;
          const leadDataSnapshot = lead ? { ...lead } : {};
          delete leadDataSnapshot._id;
          delete leadDataSnapshot.id;
          delete leadDataSnapshot.__v;

          await pool.execute(
            `INSERT INTO joinings (id, lead_id, lead_data, status, reservation_general, reservation_other,
             course, quota, student_name, student_phone, student_gender, student_notes,
             father_name, father_phone, mother_name, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              joiningIdToUse,
              leadId,
              JSON.stringify(leadDataSnapshot),
              'draft',
              DEFAULT_GENERAL_RESERVATION,
              JSON.stringify([]),
              lead?.courseInterested || '',
              lead?.quota || '',
              lead?.name || '',
              lead?.phone || '',
              lead?.gender || '',
              'As per SSC for no issues',
              lead?.fatherName || '',
              lead?.fatherPhone || '',
              lead?.motherName || '',
              req.user.id,
              req.user.id,
            ]
          );
        }
      }
    }

    // Prepare joining data for update
    const studentInfo = payload.studentInfo || {};
    const parents = payload.parents || {};
    const courseInfo = payload.courseInfo || {};
    const reservation = payload.reservation || { general: DEFAULT_GENERAL_RESERVATION, other: [] };
    const address = payload.address || {};
    const qualifications = payload.qualifications || {};
    const documents = payload.documents || {};

    // Apply lead defaults if lead exists
    let finalPayload = { ...payload };
    if (lead) {
      const tempJoining = { ...finalPayload };
      applyLeadDefaultsToJoining(tempJoining, lead);
      finalPayload = tempJoining;

      // Sync changes to lead
      const leadWasUpdated = syncLeadWithJoining(lead, finalPayload);
      if (leadWasUpdated) {
        // Update lead in SQL
        const updateFields = [];
        const updateParams = [];
        if (lead.name) { updateFields.push('name = ?'); updateParams.push(lead.name); }
        if (lead.phone) { updateFields.push('phone = ?'); updateParams.push(lead.phone); }
        if (lead.gender) { updateFields.push('gender = ?'); updateParams.push(lead.gender); }
        if (lead.fatherName) { updateFields.push('father_name = ?'); updateParams.push(lead.fatherName); }
        if (lead.fatherPhone) { updateFields.push('father_phone = ?'); updateParams.push(lead.fatherPhone); }
        if (lead.motherName) { updateFields.push('mother_name = ?'); updateParams.push(lead.motherName); }
        if (lead.village) { updateFields.push('village = ?'); updateParams.push(lead.village); }
        if (lead.mandal) { updateFields.push('mandal = ?'); updateParams.push(lead.mandal); }
        if (lead.district) { updateFields.push('district = ?'); updateParams.push(lead.district); }
        if (lead.quota) { updateFields.push('quota = ?'); updateParams.push(lead.quota); }
        if (lead.courseInterested) { updateFields.push('course_interested = ?'); updateParams.push(lead.courseInterested); }
        if (lead.interCollege) { updateFields.push('inter_college = ?'); updateParams.push(lead.interCollege); }

        if (updateFields.length > 0) {
          updateFields.push('updated_at = NOW()');
          updateParams.push(leadId);
          await pool.execute(
            `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
            updateParams
          );
        }
      }

      // Update lead data snapshot
      const leadDataSnapshot = { ...lead };
      delete leadDataSnapshot._id;
      delete leadDataSnapshot.id;
      delete leadDataSnapshot.__v;
      finalPayload.leadData = leadDataSnapshot;
    }

    // Update main joining record
    await pool.execute(
      `UPDATE joinings SET
        lead_id = ?,
        lead_data = ?,
        status = ?,
        course_id = ?,
        branch_id = ?,
        course = ?,
        branch = ?,
        quota = ?,
        student_name = ?,
        student_phone = ?,
        student_gender = ?,
        student_date_of_birth = ?,
        student_notes = ?,
        student_aadhaar_number = ?,
        father_name = ?,
        father_phone = ?,
        father_aadhaar_number = ?,
        mother_name = ?,
        mother_phone = ?,
        mother_aadhaar_number = ?,
        reservation_general = ?,
        reservation_other = ?,
        address_door_street = ?,
        address_landmark = ?,
        address_village_city = ?,
        address_mandal = ?,
        address_district = ?,
        address_pin_code = ?,
        qualification_ssc = ?,
        qualification_inter_diploma = ?,
        qualification_ug = ?,
        qualification_mediums = ?,
        qualification_other_medium_label = ?,
        document_ssc = ?,
        document_inter = ?,
        document_ug_pg_cmm = ?,
        document_transfer_certificate = ?,
        document_study_certificate = ?,
        document_aadhaar_card = ?,
        document_photos = ?,
        document_income_certificate = ?,
        document_caste_certificate = ?,
        document_cet_rank_card = ?,
        document_cet_hall_ticket = ?,
        document_allotment_letter = ?,
        document_joining_report = ?,
        document_bank_passbook = ?,
        document_ration_card = ?,
        draft_updated_at = NOW(),
        submitted_at = NULL,
        submitted_by = NULL,
        approved_at = NULL,
        approved_by = NULL,
        updated_by = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        finalPayload.leadId || lead?.id || null,
        JSON.stringify(finalPayload.leadData || {}),
        'draft',
        courseInfo.courseId || null,
        courseInfo.branchId || null,
        courseInfo.course || '',
        courseInfo.branch || '',
        courseInfo.quota || '',
        studentInfo.name || '',
        studentInfo.phone || '',
        studentInfo.gender || '',
        studentInfo.dateOfBirth || '',
        studentInfo.notes || '',
        studentInfo.aadhaarNumber || null,
        parents.father?.name || '',
        parents.father?.phone || '',
        parents.father?.aadhaarNumber || null,
        parents.mother?.name || '',
        parents.mother?.phone || '',
        parents.mother?.aadhaarNumber || null,
        reservation.general || DEFAULT_GENERAL_RESERVATION,
        JSON.stringify(reservation.other || []),
        address.communication?.doorOrStreet || '',
        address.communication?.landmark || '',
        address.communication?.villageOrCity || '',
        address.communication?.mandal || '',
        address.communication?.district || '',
        address.communication?.pinCode || '',
        qualifications.ssc === true ? 1 : 0,
        qualifications.interOrDiploma === true ? 1 : 0,
        qualifications.ug === true ? 1 : 0,
        JSON.stringify(qualifications.mediums || []),
        qualifications.otherMediumLabel || '',
        documents.ssc || 'pending',
        documents.inter || 'pending',
        documents.ugPgCmm || 'pending',
        documents.transferCertificate || 'pending',
        documents.studyCertificate || 'pending',
        documents.aadhaarCard || 'pending',
        documents.photos || 'pending',
        documents.incomeCertificate || 'pending',
        documents.casteCertificate || 'pending',
        documents.cetRankCard || 'pending',
        documents.cetHallTicket || 'pending',
        documents.allotmentLetter || 'pending',
        documents.joiningReport || 'pending',
        documents.bankPassbook || 'pending',
        documents.rationCard || 'pending',
        req.user.id,
        joiningIdToUse,
      ]
    );

    // Save related tables
    await saveJoiningRelatedTables(pool, joiningIdToUse, finalPayload);

    // Record activity if lead exists
    if (lead) {
      await recordActivity({
        leadId: lead.id,
        userId: req.user.id,
        description: 'Joining form saved as draft',
        statusFrom: previousStatus,
        statusTo: 'draft',
      });
    }

    // Fetch and return formatted joining
    const [updated] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joiningIdToUse]
    );
    const formattedJoining = await formatJoining(updated[0], pool);

    return successResponse(
      res,
      formattedJoining,
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
  if (!joining.student_name) {
    errors.push('Student name is required');
  }

  if (!joining.student_phone || joining.student_phone.length !== 10) {
    errors.push('Student phone number must be 10 digits');
  }

  if (!joining.student_date_of_birth) {
    errors.push('Date of birth is required');
  } else {
    const dobValue = joining.student_date_of_birth;
    let formattedDob = dobValue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dobValue)) {
      const [year, month, day] = dobValue.split('-');
      formattedDob = `${day}-${month}-${year}`;
    }
    if (!/^\d{2}-\d{2}-\d{4}$/.test(formattedDob)) {
      errors.push('Date of birth must be in DD-MM-YYYY format');
    }
  }

  if (!joining.reservation_general) {
    errors.push('General reservation category is required');
  }

  return errors;
};

export const submitJoiningForApproval = async (req, res) => {
  try {
    const { leadId } = req.params;
    const pool = getPool();

    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    // Find joining by id or leadId
    let joining = null;
    if (leadId && typeof leadId === 'string' && leadId.length === 36) {
      const [joinings] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ? OR lead_id = ?',
        [leadId, leadId]
      );
      if (joinings.length > 0) {
        joining = joinings[0];
      }
    }

    if (!joining) {
      return errorResponse(res, 'Joining draft not found', 404);
    }

    const validationErrors = validateBeforeSubmit(joining);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const previousStatus = joining.status;

    // Update joining status
    await pool.execute(
      `UPDATE joinings SET
        status = ?,
        submitted_at = NOW(),
        submitted_by = ?,
        updated_at = NOW()
      WHERE id = ?`,
      ['pending_approval', req.user.id, joining.id]
    );

    // Record activity if lead exists
    if (joining.lead_id) {
      await recordActivity({
        leadId: joining.lead_id,
        userId: req.user.id,
        description: 'Joining form submitted for approval',
        statusFrom: previousStatus,
        statusTo: 'pending_approval',
      });
    }

    // Fetch and return formatted joining
    const [updated] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joining.id]
    );
    const formattedJoining = await formatJoining(updated[0], pool);

    return successResponse(
      res,
      formattedJoining,
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
    const pool = getPool();

    if (leadId === 'new' || !leadId || leadId === 'undefined') {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    // Find joining by id or leadId
    let joining = null;
    if (leadId && typeof leadId === 'string' && leadId.length === 36) {
      const [joinings] = await pool.execute(
        'SELECT * FROM joinings WHERE id = ? OR lead_id = ?',
        [leadId, leadId]
      );
      if (joinings.length > 0) {
        joining = joinings[0];
      }
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

    // Update joining status
    await pool.execute(
      `UPDATE joinings SET
        status = ?,
        approved_at = NOW(),
        approved_by = ?,
        updated_at = NOW()
      WHERE id = ?`,
      ['approved', req.user.id, joining.id]
    );

    // Format joining for use
    const formattedJoining = await formatJoining(joining, pool);

    // Get lead if exists
    let lead = null;
    if (joining.lead_id) {
      lead = await ensureLeadExists(joining.lead_id);
    }

    // Generate admission number
    let admissionNumber = lead?.admissionNumber;
    if (!admissionNumber) {
      admissionNumber = await generateAdmissionNumber();
    }

    // Update lead if exists
    if (lead) {
      // Sync joining data to lead
      const leadUpdates = {};
      if (formattedJoining.studentInfo?.name) leadUpdates.name = formattedJoining.studentInfo.name;
      if (formattedJoining.studentInfo?.phone) leadUpdates.phone = formattedJoining.studentInfo.phone;
      if (formattedJoining.studentInfo?.gender) leadUpdates.gender = formattedJoining.studentInfo.gender;
      if (formattedJoining.parents?.father?.name) leadUpdates.fatherName = formattedJoining.parents.father.name;
      if (formattedJoining.parents?.father?.phone) leadUpdates.fatherPhone = formattedJoining.parents.father.phone;
      if (formattedJoining.parents?.mother?.name) leadUpdates.motherName = formattedJoining.parents.mother.name;
      if (formattedJoining.address?.communication?.villageOrCity) leadUpdates.village = formattedJoining.address.communication.villageOrCity;
      if (formattedJoining.address?.communication?.mandal) leadUpdates.mandal = formattedJoining.address.communication.mandal;
      if (formattedJoining.address?.communication?.district) leadUpdates.district = formattedJoining.address.communication.district;
      if (formattedJoining.courseInfo?.quota) leadUpdates.quota = formattedJoining.courseInfo.quota;
      if (formattedJoining.courseInfo?.course) leadUpdates.courseInterested = formattedJoining.courseInfo.course;

      const interEducation = formattedJoining.educationHistory?.find((e) => e.level === 'inter_diploma');
      if (interEducation?.institutionName) leadUpdates.interCollege = interEducation.institutionName;

      // Update lead
      const updateFields = [];
      const updateParams = [];
      Object.entries(leadUpdates).forEach(([key, value]) => {
        const sqlKey = key === 'fatherName' ? 'father_name' : key === 'fatherPhone' ? 'father_phone' : key === 'motherName' ? 'mother_name' : key === 'courseInterested' ? 'course_interested' : key === 'interCollege' ? 'inter_college' : key;
        updateFields.push(`${sqlKey} = ?`);
        updateParams.push(value);
      });

      updateFields.push('lead_status = ?');
      updateFields.push('admission_number = ?');
      updateFields.push('updated_at = NOW()');
      updateParams.push('Admitted', admissionNumber, joining.lead_id);

      await pool.execute(
        `UPDATE leads SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Prepare lead data snapshot
    const leadDataSnapshot = lead ? { ...lead } : (typeof joining.lead_data === 'string' ? JSON.parse(joining.lead_data) : joining.lead_data || {});
    delete leadDataSnapshot._id;
    delete leadDataSnapshot.id;
    delete leadDataSnapshot.__v;

    // Check if admission already exists
    const [existingAdmissions] = await pool.execute(
      'SELECT * FROM admissions WHERE joining_id = ?',
      [joining.id]
    );

    const admissionId = existingAdmissions.length > 0 ? existingAdmissions[0].id : uuidv4();

    // Upsert admission
    if (existingAdmissions.length > 0) {
      // Update existing admission
      await pool.execute(
        `UPDATE admissions SET
          lead_id = ?,
          enquiry_number = ?,
          lead_data = ?,
          admission_number = ?,
          course_id = ?,
          branch_id = ?,
          course = ?,
          branch = ?,
          quota = ?,
          student_name = ?,
          student_phone = ?,
          student_gender = ?,
          student_date_of_birth = ?,
          student_notes = ?,
          student_aadhaar_number = ?,
          father_name = ?,
          father_phone = ?,
          father_aadhaar_number = ?,
          mother_name = ?,
          mother_phone = ?,
          mother_aadhaar_number = ?,
          reservation_general = ?,
          reservation_other = ?,
          address_door_street = ?,
          address_landmark = ?,
          address_village_city = ?,
          address_mandal = ?,
          address_district = ?,
          address_pin_code = ?,
          qualification_ssc = ?,
          qualification_inter_diploma = ?,
          qualification_ug = ?,
          qualification_mediums = ?,
          qualification_other_medium_label = ?,
          document_ssc = ?,
          document_inter = ?,
          document_ug_pg_cmm = ?,
          document_transfer_certificate = ?,
          document_study_certificate = ?,
          document_aadhaar_card = ?,
          document_photos = ?,
          document_income_certificate = ?,
          document_caste_certificate = ?,
          document_cet_rank_card = ?,
          document_cet_hall_ticket = ?,
          document_allotment_letter = ?,
          document_joining_report = ?,
          document_bank_passbook = ?,
          document_ration_card = ?,
          status = ?,
          updated_by = ?,
          updated_at = NOW()
        WHERE id = ?`,
        [
          joining.lead_id || null,
          lead?.enquiryNumber || leadDataSnapshot.enquiryNumber || '',
          JSON.stringify(leadDataSnapshot),
          admissionNumber,
          formattedJoining.courseInfo?.courseId || null,
          formattedJoining.courseInfo?.branchId || null,
          formattedJoining.courseInfo?.course || '',
          formattedJoining.courseInfo?.branch || '',
          formattedJoining.courseInfo?.quota || '',
          formattedJoining.studentInfo?.name || '',
          formattedJoining.studentInfo?.phone || '',
          formattedJoining.studentInfo?.gender || '',
          formattedJoining.studentInfo?.dateOfBirth || '',
          formattedJoining.studentInfo?.notes || '',
          formattedJoining.studentInfo?.aadhaarNumber || null,
          formattedJoining.parents?.father?.name || '',
          formattedJoining.parents?.father?.phone || '',
          formattedJoining.parents?.father?.aadhaarNumber || null,
          formattedJoining.parents?.mother?.name || '',
          formattedJoining.parents?.mother?.phone || '',
          formattedJoining.parents?.mother?.aadhaarNumber || null,
          formattedJoining.reservation?.general || 'oc',
          JSON.stringify(formattedJoining.reservation?.other || []),
          formattedJoining.address?.communication?.doorOrStreet || '',
          formattedJoining.address?.communication?.landmark || '',
          formattedJoining.address?.communication?.villageOrCity || '',
          formattedJoining.address?.communication?.mandal || '',
          formattedJoining.address?.communication?.district || '',
          formattedJoining.address?.communication?.pinCode || '',
          formattedJoining.qualifications?.ssc === true ? 1 : 0,
          formattedJoining.qualifications?.interOrDiploma === true ? 1 : 0,
          formattedJoining.qualifications?.ug === true ? 1 : 0,
          JSON.stringify(formattedJoining.qualifications?.mediums || []),
          formattedJoining.qualifications?.otherMediumLabel || '',
          formattedJoining.documents?.ssc || 'pending',
          formattedJoining.documents?.inter || 'pending',
          formattedJoining.documents?.ugPgCmm || 'pending',
          formattedJoining.documents?.transferCertificate || 'pending',
          formattedJoining.documents?.studyCertificate || 'pending',
          formattedJoining.documents?.aadhaarCard || 'pending',
          formattedJoining.documents?.photos || 'pending',
          formattedJoining.documents?.incomeCertificate || 'pending',
          formattedJoining.documents?.casteCertificate || 'pending',
          formattedJoining.documents?.cetRankCard || 'pending',
          formattedJoining.documents?.cetHallTicket || 'pending',
          formattedJoining.documents?.allotmentLetter || 'pending',
          formattedJoining.documents?.joiningReport || 'pending',
          formattedJoining.documents?.bankPassbook || 'pending',
          formattedJoining.documents?.rationCard || 'pending',
          'active',
          req.user.id,
          admissionId,
        ]
      );
    } else {
      // Insert new admission
      await pool.execute(
        `INSERT INTO admissions (
          id, lead_id, enquiry_number, lead_data, joining_id, admission_number, status,
          course_id, branch_id, course, branch, quota,
          student_name, student_phone, student_gender, student_date_of_birth, student_notes, student_aadhaar_number,
          father_name, father_phone, father_aadhaar_number,
          mother_name, mother_phone, mother_aadhaar_number,
          reservation_general, reservation_other,
          address_door_street, address_landmark, address_village_city, address_mandal, address_district, address_pin_code,
          qualification_ssc, qualification_inter_diploma, qualification_ug, qualification_mediums, qualification_other_medium_label,
          document_ssc, document_inter, document_ug_pg_cmm, document_transfer_certificate, document_study_certificate,
          document_aadhaar_card, document_photos, document_income_certificate, document_caste_certificate,
          document_cet_rank_card, document_cet_hall_ticket, document_allotment_letter, document_joining_report,
          document_bank_passbook, document_ration_card,
          admission_date, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW())`,
        [
          admissionId,
          joining.lead_id || null,
          lead?.enquiryNumber || leadDataSnapshot.enquiryNumber || '',
          JSON.stringify(leadDataSnapshot),
          joining.id,
          admissionNumber,
          'active',
          formattedJoining.courseInfo?.courseId || null,
          formattedJoining.courseInfo?.branchId || null,
          formattedJoining.courseInfo?.course || '',
          formattedJoining.courseInfo?.branch || '',
          formattedJoining.courseInfo?.quota || '',
          formattedJoining.studentInfo?.name || '',
          formattedJoining.studentInfo?.phone || '',
          formattedJoining.studentInfo?.gender || '',
          formattedJoining.studentInfo?.dateOfBirth || '',
          formattedJoining.studentInfo?.notes || '',
          formattedJoining.studentInfo?.aadhaarNumber || null,
          formattedJoining.parents?.father?.name || '',
          formattedJoining.parents?.father?.phone || '',
          formattedJoining.parents?.father?.aadhaarNumber || null,
          formattedJoining.parents?.mother?.name || '',
          formattedJoining.parents?.mother?.phone || '',
          formattedJoining.parents?.mother?.aadhaarNumber || null,
          formattedJoining.reservation?.general || 'oc',
          JSON.stringify(formattedJoining.reservation?.other || []),
          formattedJoining.address?.communication?.doorOrStreet || '',
          formattedJoining.address?.communication?.landmark || '',
          formattedJoining.address?.communication?.villageOrCity || '',
          formattedJoining.address?.communication?.mandal || '',
          formattedJoining.address?.communication?.district || '',
          formattedJoining.address?.communication?.pinCode || '',
          formattedJoining.qualifications?.ssc === true ? 1 : 0,
          formattedJoining.qualifications?.interOrDiploma === true ? 1 : 0,
          formattedJoining.qualifications?.ug === true ? 1 : 0,
          JSON.stringify(formattedJoining.qualifications?.mediums || []),
          formattedJoining.qualifications?.otherMediumLabel || '',
          formattedJoining.documents?.ssc || 'pending',
          formattedJoining.documents?.inter || 'pending',
          formattedJoining.documents?.ugPgCmm || 'pending',
          formattedJoining.documents?.transferCertificate || 'pending',
          formattedJoining.documents?.studyCertificate || 'pending',
          formattedJoining.documents?.aadhaarCard || 'pending',
          formattedJoining.documents?.photos || 'pending',
          formattedJoining.documents?.incomeCertificate || 'pending',
          formattedJoining.documents?.casteCertificate || 'pending',
          formattedJoining.documents?.cetRankCard || 'pending',
          formattedJoining.documents?.cetHallTicket || 'pending',
          formattedJoining.documents?.allotmentLetter || 'pending',
          formattedJoining.documents?.joiningReport || 'pending',
          formattedJoining.documents?.bankPassbook || 'pending',
          formattedJoining.documents?.rationCard || 'pending',
          req.user.id,
          req.user.id,
        ]
      );

      // Insert admission related tables (relatives, education history, siblings)
      // Note: These would need to be copied from joining related tables
      // For now, we'll handle this in a separate step if needed
    }

    // Record activity if lead exists
    if (joining.lead_id) {
      await recordActivity({
        leadId: joining.lead_id,
        userId: req.user.id,
        description: 'Joining form approved',
        statusFrom: previousStatus,
        statusTo: 'approved',
      });
    }

    // Fetch updated joining
    const [updated] = await pool.execute(
      'SELECT * FROM joinings WHERE id = ?',
      [joining.id]
    );
    const finalJoining = await formatJoining(updated[0], pool);

    return successResponse(
      res,
      {
        joining: finalJoining,
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


