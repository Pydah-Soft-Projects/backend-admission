import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { decryptSensitiveValue } from '../utils/encryption.util.js';

const ensureLeadId = (leadId) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    const error = new Error('Invalid lead identifier');
    error.statusCode = 400;
    throw error;
  }
};

const ensureAdmissionId = (admissionId) => {
  if (!admissionId || typeof admissionId !== 'string' || admissionId.length !== 36) {
    const error = new Error('Invalid admission identifier');
    error.statusCode = 400;
    throw error;
  }
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
    fatherName: leadData.father_name,
    fatherPhone: leadData.father_phone,
    leadStatus: leadData.lead_status,
    admissionNumber: leadData.admission_number,
  };
};

// Helper function to format admission data from SQL
const formatAdmission = async (admissionData, pool) => {
  if (!admissionData) return null;

  const admissionId = admissionData.id;

  // Fetch related data
  const [relatives] = await pool.execute(
    'SELECT * FROM admission_relatives WHERE admission_id = ?',
    [admissionId]
  );

  const [educationHistory] = await pool.execute(
    'SELECT * FROM admission_education_history WHERE admission_id = ? ORDER BY created_at ASC',
    [admissionId]
  );

  const [siblings] = await pool.execute(
    'SELECT * FROM admission_siblings WHERE admission_id = ? ORDER BY created_at ASC',
    [admissionId]
  );

  // Parse JSON fields
  const leadData = typeof admissionData.lead_data === 'string'
    ? JSON.parse(admissionData.lead_data)
    : admissionData.lead_data || {};

  const reservationOther = typeof admissionData.reservation_other === 'string'
    ? JSON.parse(admissionData.reservation_other)
    : admissionData.reservation_other || [];

  const qualificationMediums = typeof admissionData.qualification_mediums === 'string'
    ? JSON.parse(admissionData.qualification_mediums)
    : admissionData.qualification_mediums || [];

  return {
    _id: admissionData.id,
    id: admissionData.id,
    leadId: admissionData.lead_id,
    enquiryNumber: admissionData.enquiry_number,
    leadData,
    joiningId: admissionData.joining_id,
    admissionNumber: admissionData.admission_number,
    status: admissionData.status,
    admissionDate: admissionData.admission_date,
    courseInfo: {
      courseId: admissionData.course_id,
      branchId: admissionData.branch_id,
      course: admissionData.course || '',
      branch: admissionData.branch || '',
      quota: admissionData.quota || '',
    },
    paymentSummary: {
      totalFee: Number(admissionData.payment_total_fee) || 0,
      totalPaid: Number(admissionData.payment_total_paid) || 0,
      balance: Number(admissionData.payment_balance) || 0,
      currency: admissionData.payment_currency || 'INR',
      status: admissionData.payment_status || 'not_started',
      lastPaymentAt: admissionData.payment_last_payment_at,
    },
    studentInfo: {
      name: admissionData.student_name || '',
      phone: admissionData.student_phone || '',
      gender: admissionData.student_gender || '',
      dateOfBirth: admissionData.student_date_of_birth || '',
      notes: admissionData.student_notes || '',
      aadhaarNumber: admissionData.student_aadhaar_number || '',
    },
    parents: {
      father: {
        name: admissionData.father_name || '',
        phone: admissionData.father_phone || '',
        aadhaarNumber: admissionData.father_aadhaar_number || '',
      },
      mother: {
        name: admissionData.mother_name || '',
        phone: admissionData.mother_phone || '',
        aadhaarNumber: admissionData.mother_aadhaar_number || '',
      },
    },
    reservation: {
      general: admissionData.reservation_general || 'oc',
      other: reservationOther,
    },
    address: {
      communication: {
        doorOrStreet: admissionData.address_door_street || '',
        landmark: admissionData.address_landmark || '',
        villageOrCity: admissionData.address_village_city || '',
        mandal: admissionData.address_mandal || '',
        district: admissionData.address_district || '',
        pinCode: admissionData.address_pin_code || '',
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
      ssc: admissionData.qualification_ssc === 1 || admissionData.qualification_ssc === true,
      interOrDiploma: admissionData.qualification_inter_diploma === 1 || admissionData.qualification_inter_diploma === true,
      ug: admissionData.qualification_ug === 1 || admissionData.qualification_ug === true,
      mediums: qualificationMediums,
      otherMediumLabel: admissionData.qualification_other_medium_label || '',
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
      ssc: admissionData.document_ssc || 'pending',
      inter: admissionData.document_inter || 'pending',
      ugPgCmm: admissionData.document_ug_pg_cmm || 'pending',
      transferCertificate: admissionData.document_transfer_certificate || 'pending',
      studyCertificate: admissionData.document_study_certificate || 'pending',
      aadhaarCard: admissionData.document_aadhaar_card || 'pending',
      photos: admissionData.document_photos || 'pending',
      incomeCertificate: admissionData.document_income_certificate || 'pending',
      casteCertificate: admissionData.document_caste_certificate || 'pending',
      cetRankCard: admissionData.document_cet_rank_card || 'pending',
      cetHallTicket: admissionData.document_cet_hall_ticket || 'pending',
      allotmentLetter: admissionData.document_allotment_letter || 'pending',
      joiningReport: admissionData.document_joining_report || 'pending',
      bankPassbook: admissionData.document_bank_passbook || 'pending',
      rationCard: admissionData.document_ration_card || 'pending',
    },
    createdBy: admissionData.created_by,
    updatedBy: admissionData.updated_by,
    createdAt: admissionData.created_at,
    updatedAt: admissionData.updated_at,
  };
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

// Helper function to save admission related tables
const saveAdmissionRelatedTables = async (pool, admissionId, payload) => {

  // Delete existing related records
  await pool.execute('DELETE FROM admission_relatives WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_education_history WHERE admission_id = ?', [admissionId]);
  await pool.execute('DELETE FROM admission_siblings WHERE admission_id = ?', [admissionId]);

  // Insert relatives
  if (Array.isArray(payload.address?.relatives)) {
    for (const relative of payload.address.relatives) {
      const relativeId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_relatives (id, admission_id, name, relationship, door_street, landmark,
         village_city, mandal, district, pin_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          relativeId,
          admissionId,
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
        `INSERT INTO admission_education_history (id, admission_id, level, other_level_label,
         course_or_branch, year_of_passing, institution_name, institution_address,
         hall_ticket_number, total_marks_or_grade, cet_rank, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          eduId,
          admissionId,
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
    for (const sib of payload.siblings) {
      const sibId = uuidv4();
      await pool.execute(
        `INSERT INTO admission_siblings (id, admission_id, name, relation, studying_standard,
         institution_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          sibId,
          admissionId,
          sib.name || '',
          sib.relation || '',
          sib.studyingStandard || '',
          sib.institutionName || '',
        ]
      );
    }
  }
};

export const listAdmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status,
    } = req.query;

    const pool = getPool();
    const paginationLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Number(page) - 1) * paginationLimit;

    // Build WHERE conditions
    const conditions = [];
    const params = [];

    // Status filtering
    if (status) {
      conditions.push('a.status = ?');
      params.push(status);
    }

    // Search filtering
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(`(
        a.admission_number LIKE ? OR
        l.name LIKE ? OR l.phone LIKE ? OR l.hall_ticket_number LIKE ? OR l.enquiry_number LIKE ?
        OR JSON_EXTRACT(a.lead_data, "$.name") LIKE ? OR JSON_EXTRACT(a.lead_data, "$.phone") LIKE ?
        OR JSON_EXTRACT(a.lead_data, "$.hallTicketNumber") LIKE ? OR JSON_EXTRACT(a.lead_data, "$.enquiryNumber") LIKE ?
        OR a.student_name LIKE ? OR a.student_phone LIKE ?
      )`);
      params.push(
        searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern, searchPattern, searchPattern,
        searchPattern, searchPattern
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total
       FROM admissions a
       LEFT JOIN leads l ON a.lead_id = l.id
       ${whereClause}`,
      params
    );
    const total = countResult[0]?.total || 0;

    // Get paginated results
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [admissions] = await pool.execute(
      `SELECT a.*, l.name as lead_name, l.phone as lead_phone, l.hall_ticket_number as lead_hall_ticket_number,
              l.enquiry_number as lead_enquiry_number, l.lead_status as lead_lead_status
       FROM admissions a
       LEFT JOIN leads l ON a.lead_id = l.id
       ${whereClause}
       ORDER BY a.updated_at DESC
       LIMIT ${Number(paginationLimit)} OFFSET ${Number(offset)}`,
      params
    );

    // Format admissions
    const formattedAdmissions = await Promise.all(
      admissions.map((a) => formatAdmission(a, pool))
    );

    return successResponse(
      res,
      {
        admissions: formattedAdmissions,
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

export const getAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
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

export const getAdmissionByJoiningId = async (req, res) => {
  try {
    const { joiningId } = req.params;
    if (!joiningId || typeof joiningId !== 'string' || joiningId.length !== 36) {
      return errorResponse(res, 'Invalid joining identifier', 400);
    }

    const pool = getPool();

    // Fetch admission by joining_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE joining_id = ?',
      [joiningId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this joining', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead if exists
    let lead = null;
    if (admissionData.lead_id) {
      const [leads] = await pool.execute(
        `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number
         FROM leads WHERE id = ?`,
        [admissionData.lead_id]
      );
      if (leads.length > 0) {
        lead = formatLead(leads[0]);
      }
    }

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
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

export const getAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    // Fetch admission by lead_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ?',
      [leadId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const admissionData = admissions[0];
    const formattedAdmission = await formatAdmission(admissionData, pool);

    // Fetch lead
    const [leads] = await pool.execute(
      `SELECT id, name, phone, father_name, father_phone, lead_status, admission_number, enquiry_number
       FROM leads WHERE id = ?`,
      [leadId]
    );

    const lead = leads.length > 0 ? formatLead(leads[0]) : null;

    return successResponse(
      res,
      {
        admission: formattedAdmission,
        lead: lead || (formattedAdmission.leadData || {}),
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

export const updateAdmissionById = async (req, res) => {
  try {
    const { admissionId } = req.params;
    ensureAdmissionId(admissionId);

    const pool = getPool();

    // Fetch admission
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found', 404);
    }

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };

    // Build dynamic UPDATE query
    const updateFields = [];
    const updateParams = [];

    // Main admission fields
    if (payload.courseInfo !== undefined) {
      if (payload.courseInfo.courseId !== undefined) {
        updateFields.push('course_id = ?');
        updateParams.push(payload.courseInfo.courseId || null);
      }
      if (payload.courseInfo.branchId !== undefined) {
        updateFields.push('branch_id = ?');
        updateParams.push(payload.courseInfo.branchId || null);
      }
      if (payload.courseInfo.course !== undefined) {
        updateFields.push('course = ?');
        updateParams.push(payload.courseInfo.course || '');
      }
      if (payload.courseInfo.branch !== undefined) {
        updateFields.push('branch = ?');
        updateParams.push(payload.courseInfo.branch || '');
      }
      if (payload.courseInfo.quota !== undefined) {
        updateFields.push('quota = ?');
        updateParams.push(payload.courseInfo.quota || '');
      }
    }

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(payload.studentInfo.dateOfBirth || '');
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || 'oc');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
    }

    if (payload.address?.communication !== undefined) {
      const comm = payload.address.communication;
      if (comm.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (comm.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (comm.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (comm.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (comm.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (comm.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    return successResponse(
      res,
      formattedAdmission,
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

export const updateAdmissionByLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    ensureLeadId(leadId);

    const pool = getPool();

    // Fetch admission by lead_id
    const [admissions] = await pool.execute(
      'SELECT * FROM admissions WHERE lead_id = ?',
      [leadId]
    );

    if (admissions.length === 0) {
      return errorResponse(res, 'Admission record not found for this lead', 404);
    }

    const admissionId = admissions[0].id;

    const validationErrors = validateAdmissionPayload(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, validationErrors.join(', '), 400);
    }

    const payload = { ...req.body };

    // Build dynamic UPDATE query (same as updateAdmissionById)
    const updateFields = [];
    const updateParams = [];

    // Main admission fields (same logic as updateAdmissionById)
    if (payload.courseInfo !== undefined) {
      if (payload.courseInfo.courseId !== undefined) {
        updateFields.push('course_id = ?');
        updateParams.push(payload.courseInfo.courseId || null);
      }
      if (payload.courseInfo.branchId !== undefined) {
        updateFields.push('branch_id = ?');
        updateParams.push(payload.courseInfo.branchId || null);
      }
      if (payload.courseInfo.course !== undefined) {
        updateFields.push('course = ?');
        updateParams.push(payload.courseInfo.course || '');
      }
      if (payload.courseInfo.branch !== undefined) {
        updateFields.push('branch = ?');
        updateParams.push(payload.courseInfo.branch || '');
      }
      if (payload.courseInfo.quota !== undefined) {
        updateFields.push('quota = ?');
        updateParams.push(payload.courseInfo.quota || '');
      }
    }

    if (payload.studentInfo !== undefined) {
      if (payload.studentInfo.name !== undefined) {
        updateFields.push('student_name = ?');
        updateParams.push(payload.studentInfo.name || '');
      }
      if (payload.studentInfo.phone !== undefined) {
        updateFields.push('student_phone = ?');
        updateParams.push(payload.studentInfo.phone || '');
      }
      if (payload.studentInfo.gender !== undefined) {
        updateFields.push('student_gender = ?');
        updateParams.push(payload.studentInfo.gender || '');
      }
      if (payload.studentInfo.dateOfBirth !== undefined) {
        updateFields.push('student_date_of_birth = ?');
        updateParams.push(payload.studentInfo.dateOfBirth || '');
      }
      if (payload.studentInfo.notes !== undefined) {
        updateFields.push('student_notes = ?');
        updateParams.push(payload.studentInfo.notes || '');
      }
      if (payload.studentInfo.aadhaarNumber !== undefined) {
        updateFields.push('student_aadhaar_number = ?');
        updateParams.push(payload.studentInfo.aadhaarNumber || null);
      }
    }

    if (payload.parents !== undefined) {
      if (payload.parents.father !== undefined) {
        if (payload.parents.father.name !== undefined) {
          updateFields.push('father_name = ?');
          updateParams.push(payload.parents.father.name || '');
        }
        if (payload.parents.father.phone !== undefined) {
          updateFields.push('father_phone = ?');
          updateParams.push(payload.parents.father.phone || '');
        }
        if (payload.parents.father.aadhaarNumber !== undefined) {
          updateFields.push('father_aadhaar_number = ?');
          updateParams.push(payload.parents.father.aadhaarNumber || null);
        }
      }
      if (payload.parents.mother !== undefined) {
        if (payload.parents.mother.name !== undefined) {
          updateFields.push('mother_name = ?');
          updateParams.push(payload.parents.mother.name || '');
        }
        if (payload.parents.mother.phone !== undefined) {
          updateFields.push('mother_phone = ?');
          updateParams.push(payload.parents.mother.phone || '');
        }
        if (payload.parents.mother.aadhaarNumber !== undefined) {
          updateFields.push('mother_aadhaar_number = ?');
          updateParams.push(payload.parents.mother.aadhaarNumber || null);
        }
      }
    }

    if (payload.reservation !== undefined) {
      if (payload.reservation.general !== undefined) {
        updateFields.push('reservation_general = ?');
        updateParams.push(payload.reservation.general || 'oc');
      }
      if (payload.reservation.other !== undefined) {
        updateFields.push('reservation_other = ?');
        updateParams.push(JSON.stringify(payload.reservation.other || []));
      }
    }

    if (payload.address?.communication !== undefined) {
      const comm = payload.address.communication;
      if (comm.doorOrStreet !== undefined) {
        updateFields.push('address_door_street = ?');
        updateParams.push(comm.doorOrStreet || '');
      }
      if (comm.landmark !== undefined) {
        updateFields.push('address_landmark = ?');
        updateParams.push(comm.landmark || '');
      }
      if (comm.villageOrCity !== undefined) {
        updateFields.push('address_village_city = ?');
        updateParams.push(comm.villageOrCity || '');
      }
      if (comm.mandal !== undefined) {
        updateFields.push('address_mandal = ?');
        updateParams.push(comm.mandal || '');
      }
      if (comm.district !== undefined) {
        updateFields.push('address_district = ?');
        updateParams.push(comm.district || '');
      }
      if (comm.pinCode !== undefined) {
        updateFields.push('address_pin_code = ?');
        updateParams.push(comm.pinCode || '');
      }
    }

    if (payload.qualifications !== undefined) {
      if (payload.qualifications.ssc !== undefined) {
        updateFields.push('qualification_ssc = ?');
        updateParams.push(payload.qualifications.ssc === true ? 1 : 0);
      }
      if (payload.qualifications.interOrDiploma !== undefined) {
        updateFields.push('qualification_inter_diploma = ?');
        updateParams.push(payload.qualifications.interOrDiploma === true ? 1 : 0);
      }
      if (payload.qualifications.ug !== undefined) {
        updateFields.push('qualification_ug = ?');
        updateParams.push(payload.qualifications.ug === true ? 1 : 0);
      }
      if (payload.qualifications.mediums !== undefined) {
        updateFields.push('qualification_mediums = ?');
        updateParams.push(JSON.stringify(payload.qualifications.mediums || []));
      }
      if (payload.qualifications.otherMediumLabel !== undefined) {
        updateFields.push('qualification_other_medium_label = ?');
        updateParams.push(payload.qualifications.otherMediumLabel || '');
      }
    }

    if (payload.documents !== undefined) {
      const docs = payload.documents;
      const docFields = [
        'ssc', 'inter', 'ugPgCmm', 'transferCertificate', 'studyCertificate',
        'aadhaarCard', 'photos', 'incomeCertificate', 'casteCertificate',
        'cetRankCard', 'cetHallTicket', 'allotmentLetter', 'joiningReport',
        'bankPassbook', 'rationCard',
      ];
      const sqlDocFields = [
        'document_ssc', 'document_inter', 'document_ug_pg_cmm', 'document_transfer_certificate',
        'document_study_certificate', 'document_aadhaar_card', 'document_photos',
        'document_income_certificate', 'document_caste_certificate', 'document_cet_rank_card',
        'document_cet_hall_ticket', 'document_allotment_letter', 'document_joining_report',
        'document_bank_passbook', 'document_ration_card',
      ];
      docFields.forEach((field, idx) => {
        if (docs[field] !== undefined) {
          updateFields.push(`${sqlDocFields[idx]} = ?`);
          updateParams.push(docs[field] || 'pending');
        }
      });
    }

    if (payload.status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(payload.status);
    }

    // Always update updated_by and updated_at
    updateFields.push('updated_by = ?');
    updateFields.push('updated_at = NOW()');
    updateParams.push(req.user.id);

    // Add admissionId to params
    updateParams.push(admissionId);

    // Execute update
    if (updateFields.length > 2) { // More than just updated_by and updated_at
      await pool.execute(
        `UPDATE admissions SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
    }

    // Update related tables if provided
    if (payload.address?.relatives !== undefined || payload.educationHistory !== undefined || payload.siblings !== undefined) {
      await saveAdmissionRelatedTables(pool, admissionId, payload);
    }

    // Fetch and return updated admission
    const [updated] = await pool.execute(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );
    const formattedAdmission = await formatAdmission(updated[0], pool);

    return successResponse(
      res,
      formattedAdmission,
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


