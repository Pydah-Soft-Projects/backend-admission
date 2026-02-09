import { createReadStream, promises as fsPromises } from 'fs';
import { extname } from 'path';
import Excel from 'exceljs';
import XLSX from 'xlsx';
import Papa from 'papaparse';
import PQueue from 'p-queue';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { findBestMatch } from '../utils/fuzzyMatch.util.js';
import { v4 as uuidv4 } from 'uuid';

const UPLOAD_SESSION_TTL_MS = 1000 * 60 * 30; // 30 minutes
const PREVIEW_ROW_LIMIT = 10;
const PREVIEW_SIZE_LIMIT = 55 * 1024 * 1024; // 15 MB threshold for generating previews
const MAX_ERROR_DETAILS = 200;
const DEFAULT_CHUNK_SIZE = Number(process.env.LEAD_IMPORT_CHUNK_SIZE || 2000);

const importQueue = new PQueue({
  concurrency: Number(process.env.LEAD_IMPORT_CONCURRENCY || 1),
});

const normalizeKey = (value) => {
  if (value === undefined || value === null) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

    const canonicalFields = [
      'hallTicketNumber',
      'name',
      'phone',
      'email',
      'fatherName',
      'fatherPhone',
      'motherName',
      'courseInterested',
      'village',
      'district',
      'mandal',
      'state',
      'gender',
      'rank',
      'interCollege',
      'quota',
      'applicationStatus',
      'leadStatus',
      'source',
      'notes',
      'academicYear',
      'studentGroup',
      'schoolOrCollegeName',
      'dynamicFields',
    ];

    const canonicalFieldSet = new Set(canonicalFields);

const aliasPairs = [
  // name
  ['candidate name', 'name'],
  ['candidate', 'name'],
  ['student', 'name'],
  ['student name', 'name'],
  ['studentname', 'name'],
  ['student full name', 'name'],
  ['name of the student', 'name'],
  ['full name', 'name'],
  ['applicant name', 'name'],
  ['name', 'name'],
  // phone
  ['contact', 'phone'],
  ['contact number', 'phone'],
  ['contact no', 'phone'],
  ['contact no 1', 'phone'],
  ['contact number 1', 'phone'],
  ['phone number 1', 'phone'],
  ['phone number1', 'phone'],
  ['mobile', 'phone'],
  ['mobile number', 'phone'],
  ['mobile no', 'phone'],
  ['mobile no 1', 'phone'],
  ['phone number', 'phone'],
  ['phone no', 'phone'],
  ['phone no 1', 'phone'],
  ['primary phone', 'phone'],
  ['phone1', 'phone'],
  ['phone 1', 'phone'],
      ['contact1', 'phone'],
      ['contact 1', 'phone'],
  ['contact no1', 'phone'],
  ['contact number1', 'phone'],
  ['parent phone', 'fatherPhone'],
  ['parent contact', 'fatherPhone'],
  ['parent phone number', 'fatherPhone'],
  ['parent contact number', 'fatherPhone'],
  ['parent mobile', 'fatherPhone'],
  ['parent mobile number', 'fatherPhone'],
  ['father', 'fatherName'],
  ['father name', 'fatherName'],
  ['fathers name', 'fatherName'],
  ['father s name', 'fatherName'],
  ['father  name', 'fatherName'],
  ['fathername', 'fatherName'],
  ['fname', 'fatherName'],
  ['guardian name', 'fatherName'],
  ['mother', 'motherName'],
  ['mother name', 'motherName'],
  ['mothers name', 'motherName'],
  ['mother s name', 'motherName'],
  ['mothername', 'motherName'],
  ['mname', 'motherName'],
      ['contact2', 'fatherPhone'],
      ['contact 2', 'fatherPhone'],
  ['contact no 2', 'fatherPhone'],
  ['contact number 2', 'fatherPhone'],
  ['phone number 2', 'fatherPhone'],
  ['phone number2', 'fatherPhone'],
  ['contact no2', 'fatherPhone'],
  ['contact number2', 'fatherPhone'],
  ['phone2', 'fatherPhone'],
  ['phone 2', 'fatherPhone'],
  ['phone no 2', 'fatherPhone'],
  ['mobile2', 'fatherPhone'],
  ['mobile 2', 'fatherPhone'],
  ['mobile no 2', 'fatherPhone'],
  ['alternate mobile no', 'fatherPhone'],
  ['alternate mobile number', 'fatherPhone'],
  ['alternate phone', 'fatherPhone'],
  ['secondary phone', 'fatherPhone'],
  ['secondary contact', 'fatherPhone'],
  ['father contact', 'fatherPhone'],
  ['father mobile', 'fatherPhone'],
  ['father mobile number', 'fatherPhone'],
  ['father number', 'fatherPhone'],
  ['father phone', 'fatherPhone'],
  ['hallticket', 'hallTicketNumber'],
  ['hallticket number', 'hallTicketNumber'],
  ['hall ticket', 'hallTicketNumber'],
  ['hall ticket number', 'hallTicketNumber'],
  ['hallticket no', 'hallTicketNumber'],
  ['htno', 'hallTicketNumber'],
  ['ht no', 'hallTicketNumber'],
  ['htno.', 'hallTicketNumber'],
  ['h t no', 'hallTicketNumber'],
  ['h t number', 'hallTicketNumber'],
  ['eamcet hallticket', 'hallTicketNumber'],
  ['eamcet hall ticket', 'hallTicketNumber'],
  ['eamcet rank', 'rank'],
  ['rank obtained', 'rank'],
  ['eamcet rank obtained', 'rank'],
  ['rank', 'rank'],
  ['eamcet qualification', 'applicationStatus'],
  ['eamcet status', 'applicationStatus'],
  ['exam status', 'applicationStatus'],
      ['status', 'applicationStatus'],
  ['lead status', 'leadStatus'],
  ['current status', 'leadStatus'],
  ['present status', 'leadStatus'],
  ['course', 'courseInterested'],
  ['course interested', 'courseInterested'],
  ['course preference', 'courseInterested'],
      ['inter college', 'interCollege'],
  ['college studied', 'interCollege'],
  ['college name', 'interCollege'],
  ['school name', 'interCollege'],
  ['preference', 'courseInterested'],
  ['village/town', 'village'],
  ['village town', 'village'],
  ['village name', 'village'],
  ['city', 'village'],
  ['address', 'village'],
  ['mandal/town', 'mandal'],
  ['mandal town', 'mandal'],
  ['mandal name', 'mandal'],
  ['stu mandal', 'mandal'],
  ['taluk', 'mandal'],
  ['mandal taluk', 'mandal'],
  ['district name', 'district'],
  ['district', 'district'],
  ['state name', 'state'],
  ['state', 'state'],
  ['gender', 'gender'],
  ['sex', 'gender'],
  ['quota', 'quota'],
  ['category', 'quota'],
  ['notes', 'notes'],
  ['remarks', 'notes'],
  ['remarks telecalling', 'notes'],
  ['remarks if any doorstep', 'notes'],
  ['comments', 'notes'],
  ['comment', 'notes'],
  ['source', 'source'],
  // email (add after phone/contact aliases - email often in spreadsheets)
  ['email', 'email'],
  ['email id', 'email'],
  ['email address', 'email'],
  ['e mail', 'email'],
  ['mail', 'email'],
  // academic year
  ['academic year', 'academicYear'],
  ['academicyear', 'academicYear'],
  ['academic_year', 'academicYear'],
  ['year', 'academicYear'],
  // student group
  ['student group', 'studentGroup'],
  ['studentgroup', 'studentGroup'],
  ['student_group', 'studentGroup'],
  ['academic stream', 'studentGroup'],
  ['group', 'studentGroup'],
  // school or college name
  ['school or college name', 'schoolOrCollegeName'],
  ['school or college', 'schoolOrCollegeName'],
  ['school name', 'schoolOrCollegeName'],
  ['schoolname', 'schoolOrCollegeName'],
  ['college name', 'schoolOrCollegeName'],
  ['collegename', 'schoolOrCollegeName'],
  ['school_or_college_name', 'schoolOrCollegeName'],
];

const aliasMap = new Map();
aliasPairs.forEach(([alias, canonical]) => {
  aliasMap.set(normalizeKey(alias), canonical);
});
canonicalFields.forEach((field) => {
  aliasMap.set(normalizeKey(field), field);
});

          const stringFieldsToTrim = [
            'hallTicketNumber',
            'name',
            'phone',
            'email',
            'fatherName',
            'fatherPhone',
            'motherName',
            'courseInterested',
            'village',
            'district',
            'mandal',
            'state',
            'gender',
            'interCollege',
            'quota',
            'applicationStatus',
            'leadStatus',
            'source',
            'notes',
            'studentGroup',
            'schoolOrCollegeName',
          ];

const buildPreviewFromArray = (headers, row) => {
  const preview = {};
  headers.forEach((header, index) => {
    const value = row[index];
    preview[header] = value === undefined || value === null ? '' : String(value).trim();
  });
  return preview;
};

const buildPreviewFromObject = (row) => {
  const preview = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    preview[key] = value === undefined || value === null ? '' : String(value).trim();
  });
  return preview;
};

const uploadSessionStore = new Map();

const cleanupUploadSession = async (token, options = {}) => {
  const { removeFile = true } = options;
  const session = uploadSessionStore.get(token);
  if (!session) return;

  uploadSessionStore.delete(token);
  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  if (removeFile && session.filePath) {
    await fsPromises.unlink(session.filePath).catch(() => {});
  }
};

const consumeUploadSession = (token) => {
  const session = uploadSessionStore.get(token);
  if (!session) return null;
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  uploadSessionStore.delete(token);
  return session;
};

const createUploadSession = (token, payload) => {
  const timeout = setTimeout(() => {
    cleanupUploadSession(token).catch(() => {});
  }, UPLOAD_SESSION_TTL_MS);

  uploadSessionStore.set(token, {
    ...payload,
    timeout,
    createdAt: Date.now(),
    expiresAt: Date.now() + UPLOAD_SESSION_TTL_MS,
  });
};

const getUploadSession = (token) => {
  const session = uploadSessionStore.get(token);
  if (!session) return null;
  return session;
};

const parseSelectedSheets = (input) => {
  if (!input) return [];

  let values = [];

  if (Array.isArray(input)) {
    values = input;
  } else if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        values = parsed;
      } else {
        values = input.split(',');
      }
    } catch (error) {
      values = input.split(',');
    }
  }

  return Array.from(
    new Set(
      values
        .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
        .filter((value) => value.length > 0)
    )
  );
};

// @desc    Analyze an uploaded workbook and return sheet metadata/preview samples
// @route   POST /api/leads/bulk-upload/inspect
// @access  Private (Super Admin only)
export const inspectBulkUpload = async (req, res) => {
  if (!req.file) {
    return errorResponse(res, 'Please upload an Excel or CSV file', 400);
  }

  const originalName = req.file.originalname || req.file.filename;
  const fileSize = req.file.size || 0;
  const filePath = req.file.path;
  const extension = extname(originalName || '').toLowerCase();
  const uploadToken = uuidv4();

  const responsePayload = {
    uploadToken,
    originalName,
    size: fileSize,
    fileType: extension === '.csv' ? 'csv' : 'excel',
    sheetNames: [],
    previews: {},
    previewAvailable: true,
    previewDisabledReason: undefined,
    expiresInMs: UPLOAD_SESSION_TTL_MS,
  };

  try {
    if (extension === '.xlsx' || extension === '.xls') {
      if (fileSize > PREVIEW_SIZE_LIMIT) {
        const workbookMeta = XLSX.readFile(filePath, { bookSheets: true });
        responsePayload.sheetNames = workbookMeta.SheetNames || [];
        responsePayload.previewAvailable = false;
        responsePayload.previewDisabledReason = 'Preview disabled for large workbooks (>15 MB).';
      } else {
        const workbook = XLSX.readFile(filePath, { dense: true, sheetRows: PREVIEW_ROW_LIMIT + 1 });
        responsePayload.sheetNames = workbook.SheetNames || [];
        const previews = {};

        workbook.SheetNames.forEach((sheetName) => {
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) return;

          const sheetRows = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            blankrows: false,
            defval: '',
            raw: false,
          });

          if (!sheetRows.length) {
            previews[sheetName] = [];
            return;
          }

          const headers = (sheetRows[0] || []).map((cell, index) => {
            const trimmed = cell === undefined || cell === null ? '' : String(cell).trim();
            return trimmed || `Column${index + 1}`;
          });

          const previewRows = sheetRows
            .slice(1, PREVIEW_ROW_LIMIT + 1)
            .filter((row) => Array.isArray(row) && row.some((value) => value !== null && value !== undefined && value !== ''))
            .map((row) => buildPreviewFromArray(headers, row));

          previews[sheetName] = previewRows;
        });

        responsePayload.previews = previews;
      }
    } else if (extension === '.csv') {
      responsePayload.fileType = 'csv';
      responsePayload.sheetNames = ['CSV'];

      if (fileSize > PREVIEW_SIZE_LIMIT) {
        responsePayload.previewAvailable = false;
        responsePayload.previewDisabledReason = 'Preview disabled for large CSV files (>15 MB).';
      } else {
        const fileContent = await fsPromises.readFile(filePath, 'utf8');
        const parsed = Papa.parse(fileContent, {
          header: true,
          skipEmptyLines: true,
        });

        const previewRows = (parsed.data || [])
          .filter((row) => row && Object.values(row).some((value) => value !== null && value !== undefined && String(value).trim() !== ''))
          .slice(0, PREVIEW_ROW_LIMIT)
          .map((row) => buildPreviewFromObject(row));

        responsePayload.previews = { CSV: previewRows };
      }
    } else {
      throw new Error('Unsupported file format. Please upload an Excel or CSV file.');
    }

    if (!responsePayload.sheetNames || responsePayload.sheetNames.length === 0) {
      throw new Error('No worksheets found in the uploaded file.');
    }

    createUploadSession(uploadToken, {
      filePath,
      originalName,
      fileSize,
      extension,
      sheetNames: responsePayload.sheetNames,
      uploadedBy: req.user?._id,
    });

    return successResponse(res, responsePayload, 'Workbook analyzed successfully', 200);
  } catch (error) {
    await fsPromises.unlink(filePath).catch(() => {});
    return errorResponse(res, error.message || 'Failed to analyze workbook', 500);
  }
};

// @desc    Persist leads from an analyzed workbook or direct file upload
// @route   POST /api/leads/bulk-upload
// @access  Private (Super Admin only)
export const bulkUploadLeads = async (req, res) => {
  let uploadToken = null;
  let filePath = null;
  let session = null;
  let fileExtension = '';
  let originalName = '';

  try {
    if (req.file) {
      filePath = req.file.path;
      fileExtension = extname(req.file.originalname || req.file.filename || '').toLowerCase();
      originalName = req.file.originalname || req.file.filename || 'upload.xlsx';
    } else if (req.body.uploadToken) {
      uploadToken = String(req.body.uploadToken);
      session = consumeUploadSession(uploadToken);

      if (!session) {
        return errorResponse(res, 'Upload session expired or not found. Please analyze the file again.', 410);
      }

      filePath = session.filePath;
      fileExtension = session.extension || extname(session.originalName || '').toLowerCase();
      originalName = session.originalName || 'upload.xlsx';
    } else {
      return errorResponse(res, 'Please upload an Excel or CSV file', 400);
    }

    if (!filePath) {
      return errorResponse(res, 'Uploaded file not found. Please try again.', 400);
    }

    let selectedSheets = parseSelectedSheets(req.body.selectedSheets);
    if (selectedSheets.length === 0 && session?.sheetNames?.length) {
      selectedSheets = session.sheetNames;
    }

    const sourceLabel =
      req.body.source && typeof req.body.source === 'string' && req.body.source.trim().length > 0
        ? req.body.source.trim()
        : 'Bulk Upload';

    const uploadId = uuidv4();
    const batchId = uuidv4();

    const fileStats = await fsPromises.stat(filePath).catch(() => null);
    const fileSize =
      fileStats?.size ||
      session?.fileSize ||
      req.file?.size ||
      0;

    const pool = getPool();
    const jobId = uuidv4();

    // Create import job in SQL
    await pool.execute(
      `INSERT INTO import_jobs (
        id, upload_id, original_name, file_path, file_size, extension,
        selected_sheets, source_label, status, created_by, upload_batch_id,
        upload_token, message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        jobId,
        uploadId,
        originalName,
        filePath,
        fileSize,
        fileExtension,
        JSON.stringify(selectedSheets),
        sourceLabel,
        'queued',
        req.user?.id || null,
        batchId,
        uploadToken || null,
        'Queued for processing',
      ]
    );

    importQueue
      .add(() => processImportJob(jobId))
      .catch((error) => {
        console.error('Failed to enqueue import job', error);
      });

    return successResponse(
      res,
      {
        jobId,
        uploadId,
        batchId,
        status: 'queued',
      },
      'Bulk upload queued successfully',
      202
    );
  } catch (error) {
    console.error('Failed to queue bulk upload:', error);
    if (filePath) {
      await fsPromises.unlink(filePath).catch(() => {});
    }
    if (uploadToken) {
      await cleanupUploadSession(uploadToken, { removeFile: false }).catch(() => {});
    }
    return errorResponse(res, error.message || 'Failed to queue bulk upload', 500);
  }
};

const processImportJob = async (jobId) => {
  const pool = getPool();
  
  // Fetch import job
  const [jobs] = await pool.execute(
    'SELECT * FROM import_jobs WHERE id = ?',
    [jobId]
  );

  if (jobs.length === 0) {
    return;
  }

  const job = jobs[0];
  // Parse JSON fields
  job.selectedSheets = typeof job.selected_sheets === 'string' 
    ? JSON.parse(job.selected_sheets) 
    : job.selected_sheets || [];
  job.stats = {
    totalProcessed: job.stats_total_processed || 0,
    totalSuccess: job.stats_total_success || 0,
    totalErrors: job.stats_total_errors || 0,
    sheetsProcessed: typeof job.stats_sheets_processed === 'string'
      ? JSON.parse(job.stats_sheets_processed)
      : job.stats_sheets_processed || [],
    durationMs: job.stats_duration_ms || 0,
  };

  const startedAt = Date.now();
  const stats = {
    totalProcessed: 0,
    totalSuccess: 0,
    totalErrors: 0,
    durationMs: 0,
  };
  const processedSheets = new Set();
  const errors = [];

  const toTrimmedString = (value) => {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };

  const normalizeGender = (value) => {
    if (!value) return undefined;
    const genderValue = String(value).trim().toLowerCase();
    if (genderValue.startsWith('m')) return 'Male';
    if (genderValue.startsWith('f')) return 'Female';
    if (genderValue.startsWith('o')) return 'Other';
    return String(value).trim();
  };

  const getCellValue = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      if (value.result !== undefined && value.result !== null) {
        return value.result;
      }
      if (Array.isArray(value.richText)) {
        return value.richText.map((part) => part.text || '').join('');
      }
      if (value.text !== undefined) {
        return value.text;
      }
      if (value.hyperlink) {
        return value.text || value.hyperlink;
      }
      if (value.value !== undefined) {
        return value.value;
      }
    }
    return value;
  };

  const pushErrorDetail = (meta, data, message) => {
    if (errors.length >= MAX_ERROR_DETAILS) return;
    errors.push({
      sheet: meta?.sheetName,
      row: meta?.rowNumber,
      data,
      error: message,
    });
  };

  const updateJobProgress = async (message, force = false) => {
    const now = Date.now();
    if (!force && now - updateJobProgress.lastUpdated < 5000) {
      return;
    }
    updateJobProgress.lastUpdated = now;
    await pool.execute(
      `UPDATE import_jobs SET
        stats_total_processed = ?,
        stats_total_success = ?,
        stats_total_errors = ?,
        stats_duration_ms = ?,
        stats_sheets_processed = ?,
        status = ?,
        message = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        stats.totalProcessed,
        stats.totalSuccess,
        stats.totalErrors,
        Date.now() - startedAt,
        JSON.stringify(Array.from(processedSheets)),
        'processing',
        message,
        jobId,
      ]
    ).catch(() => {});
  };
  updateJobProgress.lastUpdated = 0;

  await pool.execute(
    `UPDATE import_jobs SET
      status = ?,
      started_at = NOW(),
      message = ?,
      updated_at = NOW()
    WHERE id = ?`,
    ['processing', 'Processing file', jobId]
  ).catch(() => {});

  let currentSequence = 1;
  let enquiryPrefix = '';

  try {
    const currentYear = new Date().getFullYear();
    const yearSuffix = String(currentYear).slice(-2);
    enquiryPrefix = `ENQ${yearSuffix}`;

    const [lastLeads] = await pool.execute(
      `SELECT enquiry_number FROM leads 
       WHERE enquiry_number LIKE ? 
       ORDER BY enquiry_number DESC 
       LIMIT 1`,
      [`${enquiryPrefix}%`]
    );

    if (lastLeads.length > 0 && lastLeads[0].enquiry_number) {
      const lastSequence = lastLeads[0].enquiry_number.replace(enquiryPrefix, '');
      const lastNumber = parseInt(lastSequence, 10);
      if (!Number.isNaN(lastNumber)) {
        currentSequence = lastNumber + 1;
      }
    }

    const getNextEnquiryNumber = () => {
      const formattedSequence = String(currentSequence).padStart(6, '0');
      currentSequence += 1;
      return `${enquiryPrefix}${formattedSequence}`;
    };

    // Normalize string for lookup: trim, collapse spaces, lowercase (avoids Excel/DB spacing differences)
    const norm = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+/g, ' ').toLowerCase());

    // Strip common Excel suffixes so "Kakinada Dist" / "East Godavari Dist" match DB "Kakinada" / "East Godavari"
    const stripDistrictSuffix = (normalizedStr) => {
      if (!normalizedStr || typeof normalizedStr !== 'string') return normalizedStr || '';
      return normalizedStr.replace(/\s+(dist(rict)?|dt\.?)\s*$/i, '').trim();
    };
    const stripMandalSuffix = (normalizedStr) => {
      if (!normalizedStr || typeof normalizedStr !== 'string') return normalizedStr || '';
      return normalizedStr.replace(/\s+(mandal|mandalam|mndl\.?)\s*$/i, '').trim();
    };
    // Same suffix stripping for saving clean values (keeps original case)
    const stripDistrictSuffixForStorage = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(dist(rict)?|dt\.?)\s*$/i, '').trim());
    const stripMandalSuffixForStorage = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(mandal|mandalam|mndl\.?)\s*$/i, '').trim());

    // Load master data for district/mandal/school/college matching
    // Use String() for all IDs so Map.get() works (MySQL2 can return CHAR(36) as Buffer)
    const loadMasterLookup = async () => {
      const [statesRows] = await pool.execute('SELECT id, name FROM states WHERE is_active = 1');
      const stateIdByName = new Map();
      statesRows.forEach((r) => stateIdByName.set(norm(r.name), String(r.id)));

      const [districtsRows] = await pool.execute('SELECT id, state_id, name FROM districts WHERE is_active = 1');
      const districtsByStateId = new Map();
      districtsRows.forEach((r) => {
        const stateKey = String(r.state_id);
        if (!districtsByStateId.has(stateKey)) {
          districtsByStateId.set(stateKey, new Map());
        }
        const dMap = districtsByStateId.get(stateKey);
        const keyNorm = norm(r.name);
        const keyStripped = stripDistrictSuffix(keyNorm) || keyNorm;
        dMap.set(keyNorm, String(r.id));
        if (keyStripped !== keyNorm) dMap.set(keyStripped, String(r.id));
      });

      const [mandalsRows] = await pool.execute('SELECT id, district_id, name FROM mandals WHERE is_active = 1');
      const mandalsByDistrictId = new Map();
      mandalsRows.forEach((r) => {
        const distKey = String(r.district_id);
        if (!mandalsByDistrictId.has(distKey)) {
          mandalsByDistrictId.set(distKey, new Set());
        }
        const mSet = mandalsByDistrictId.get(distKey);
        const keyNorm = norm(r.name);
        const keyStripped = stripMandalSuffix(keyNorm) || keyNorm;
        mSet.add(keyNorm);
        if (keyStripped !== keyNorm) mSet.add(keyStripped);
      });

      const [schoolsRows] = await pool.execute('SELECT name FROM schools WHERE is_active = 1');
      const schoolNames = new Set(schoolsRows.map((r) => norm(r.name)));

      const [collegesRows] = await pool.execute('SELECT name FROM colleges WHERE is_active = 1');
      const collegeNames = new Set(collegesRows.map((r) => norm(r.name)));

      return { stateIdByName, districtsByStateId, mandalsByDistrictId, schoolNames, collegeNames };
    };

    /**
     * Normalize raw student group from Excel to canonical form.
     * 10th: "10th", "10", "x", "ssc", "class 10" -> "10th"
     * Inter-MPC / Inter-BIPC: "inter mpc", "mpc", "inter bipc", "bipc" -> "Inter-MPC" / "Inter-BIPC"
     * "Inter" or "Intermediate" (without stream) -> "Inter" (ambiguous; triggers needs_manual_update so user can set MPC/BIPC)
     */
    const normalizeStudentGroup = (raw) => {
      if (raw === undefined || raw === null) return null;
      const s = String(raw).trim();
      if (!s) return null;
      const lower = s.toLowerCase();
      // 10th variants
      if (lower === '10th' || lower === '10' || lower === 'x' || lower === 'ssc' ||
          lower === 'class 10' || lower === 'class 10th' || lower === 's.s.c' || lower === 's.sc') {
        return '10th';
      }
      // Science -> Inter (from Academic Stream column)
      if (lower === 'science') {
        return 'Inter';
      }
      // Inter-MPC variants (must check before generic "Inter")
      if (lower === 'inter-mpc' || lower === 'inter mpc' || lower === 'intermpc' ||
          lower === 'mpc' || lower === 'intermediate mpc' || lower === 'intermediate mpc stream') {
        return 'Inter-MPC';
      }
      // Inter-BIPC variants
      if (lower === 'inter-bipc' || lower === 'inter bipc' || lower === 'interbipc' ||
          lower === 'bipc' || lower === 'intermediate bipc' || lower === 'intermediate bipc stream') {
        return 'Inter-BIPC';
      }
      // Inter / Intermediate without MPC/BIPC -> "Inter" (ambiguous; needs_manual_update so counsellor can set MPC/BIPC)
      if (lower === 'inter' || lower === 'intermediate' || lower === 'inter mediate' ||
          lower === 'inter 1' || lower === 'inter 2' || lower === 'inter i' || lower === 'inter ii' ||
          lower === '1st inter' || lower === '2nd inter' || lower === 'first inter' || lower === 'second inter' ||
          lower === 'intermediate 1' || lower === 'intermediate 2' || lower === 'inter year 1' || lower === 'inter year 2') {
        return 'Inter';
      }
      // Degree, Diploma as-is (case-normalized)
      if (lower === 'degree') return 'Degree';
      if (lower === 'diploma') return 'Diploma';
      return s;
    };

    const checkNeedsManualUpdate = (doc, lookup) => {
      // Only district/mandal mismatch triggers needs_manual_update (Inter ambiguity excluded per request)
      const stateKey = norm(doc.state || '');
      if (!stateKey) return true;
      // Allow "Andhra Pradesh (AP)" or "AP" to match "Andhra Pradesh"
      const stateId = lookup.stateIdByName.get(stateKey)
        || lookup.stateIdByName.get(stateKey.replace(/\s*\(ap\)\s*$/i, '').trim() || stateKey)
        || (stateKey === 'ap' ? lookup.stateIdByName.get('andhra pradesh') : undefined);
      if (!stateId) return true;

      const districtKeyRaw = norm(doc.district || '');
      if (!districtKeyRaw) return true;
      const districtKey = stripDistrictSuffix(districtKeyRaw) || districtKeyRaw;
      const districtMap = lookup.districtsByStateId.get(String(stateId));
      if (!districtMap) return true;
      let districtId = districtMap.get(districtKey) ?? districtMap.get(districtKeyRaw);
      if (!districtId) {
        const candidates = Array.from(districtMap.keys());
        const bestDistrict = findBestMatch(districtKey, candidates, 0.80);
        districtId = bestDistrict ? districtMap.get(bestDistrict) : null;
      }
      if (!districtId) return true;

      const mandalKeyRaw = norm(doc.mandal || '');
      if (!mandalKeyRaw) return true;
      const mandalKey = stripMandalSuffix(mandalKeyRaw) || mandalKeyRaw;
      const mandalSet = lookup.mandalsByDistrictId.get(String(districtId));
      let mandalMatches = mandalSet && (mandalSet.has(mandalKey) || mandalSet.has(mandalKeyRaw));
      if (!mandalMatches && mandalSet && mandalSet.size > 0) {
        const bestMandal = findBestMatch(mandalKey, Array.from(mandalSet), 0.80);
        mandalMatches = !!bestMandal;
      }
      if (!mandalMatches) return true;

      // School/college name mismatch is excluded from needs_manual_update; only district and mandal trigger the tag
      return false;
    };

    let masterLookup = null;
    try {
      masterLookup = await loadMasterLookup();
    } catch (err) {
      console.warn('[Import] Could not load master lookup; all leads will be marked needs_manual_update:', err.message);
    }

    const buildLeadDocument = (rawLead) => {
      const normalizedLead = {};
      const dynamicFieldsFromPayload = {};

      Object.entries(rawLead || {}).forEach(([key, value]) => {
        if (!key || value === undefined || value === null || value === '') return;
        const trimmedKey = String(key).trim();
        if (!trimmedKey) return;
        if (trimmedKey === 'dynamicFields' && typeof value === 'object') {
          Object.assign(dynamicFieldsFromPayload, value);
          return;
        }

        const normalizedHeader = normalizeKey(trimmedKey);
        const canonicalKey = aliasMap.get(normalizedHeader) || trimmedKey;
        if (canonicalFieldSet.has(canonicalKey)) {
          normalizedLead[canonicalKey] = value;
        } else {
          dynamicFieldsFromPayload[trimmedKey] = value;
        }
      });

          stringFieldsToTrim.forEach((field) => {
            if (normalizedLead[field] !== undefined && normalizedLead[field] !== null && normalizedLead[field] !== '') {
              normalizedLead[field] = String(normalizedLead[field]).trim();
            }
          });

      const normalizedVillage = toTrimmedString(normalizedLead.village);
      if (normalizedVillage !== undefined) {
        normalizedLead.village = normalizedVillage;
      }

      const normalizedMandal = toTrimmedString(normalizedLead.mandal);
      if (!normalizedMandal && normalizedVillage) {
        normalizedLead.mandal = normalizedVillage;
      } else if (normalizedMandal) {
        normalizedLead.mandal = normalizedMandal;
      }

          if (normalizedLead.gender) {
        normalizedLead.gender = normalizeGender(normalizedLead.gender);
      }

          if (normalizedLead.rank !== undefined && normalizedLead.rank !== null && normalizedLead.rank !== '') {
            const numericRank = Number(normalizedLead.rank);
            if (!Number.isNaN(numericRank)) {
              normalizedLead.rank = numericRank;
            } else {
              dynamicFieldsFromPayload.Rank = String(normalizedLead.rank).trim();
              delete normalizedLead.rank;
            }
          }

      // academic_year: parse as number (e.g. 2024, 2025); default 2026 if not provided
      const DEFAULT_ACADEMIC_YEAR = 2026;
      if (normalizedLead.academicYear !== undefined && normalizedLead.academicYear !== null && normalizedLead.academicYear !== '') {
        const yearNum = Number(normalizedLead.academicYear);
        if (!Number.isNaN(yearNum) && yearNum >= 2000 && yearNum <= 2100) {
          normalizedLead.academicYear = yearNum;
        } else {
          normalizedLead.academicYear = DEFAULT_ACADEMIC_YEAR;
        }
      } else {
        normalizedLead.academicYear = DEFAULT_ACADEMIC_YEAR;
      }

      // student_group: normalize variants (10, X -> 10th; Inter MPC -> Inter-MPC; Inter only -> Inter for manual update)
      const rawStudentGroup = toTrimmedString(normalizedLead.studentGroup);
      const normalizedStudentGroupVal = normalizeStudentGroup(rawStudentGroup);
      if (normalizedStudentGroupVal) {
        normalizedLead.studentGroup = normalizedStudentGroupVal;
      } else {
        normalizedLead.studentGroup = 'Not Specified';
      }

      // schoolOrCollegeName -> store in dynamicFields for matching
      const schoolOrCollegeVal = toTrimmedString(normalizedLead.schoolOrCollegeName);
      if (schoolOrCollegeVal) {
        dynamicFieldsFromPayload.school_or_college_name = schoolOrCollegeVal;
      }
      delete normalizedLead.schoolOrCollegeName;

      const cleanedDynamicFields = {};
      Object.entries(dynamicFieldsFromPayload).forEach(([key, value]) => {
        const cleanedValue = toTrimmedString(value);
        if (cleanedValue !== undefined) {
          cleanedDynamicFields[key] = cleanedValue;
        }
      });

      // Require only: student name + at least one phone (phone or fatherPhone)
      const nameVal = toTrimmedString(normalizedLead.name);
      const phoneVal = toTrimmedString(normalizedLead.phone);
      const fatherPhoneVal = toTrimmedString(normalizedLead.fatherPhone);
      const hasAnyPhone = phoneVal || fatherPhoneVal;
      if (!nameVal) {
        throw new Error('__SKIP_ROW__');
      }
      if (!hasAnyPhone) {
        throw new Error('Missing required: student name and at least one phone number (Phone 1 or Phone 2)');
      }

      const now = new Date();
      const enquiryNumber = getNextEnquiryNumber();

      // Use whichever phone(s) we have; DB requires both phone and father_phone so fill from the other if missing
      const primaryPhone = phoneVal || fatherPhoneVal;
      const secondaryPhone = fatherPhoneVal || phoneVal || '';

      const leadDocument = {
            enquiryNumber,
        hallTicketNumber: toTrimmedString(normalizedLead.hallTicketNumber) || '',
            name: String(nameVal).trim(),
            phone: String(primaryPhone).trim(),
        email: toTrimmedString(normalizedLead.email)?.toLowerCase(),
            fatherName: toTrimmedString(normalizedLead.fatherName) || '',
            fatherPhone: String(secondaryPhone).trim(),
        motherName: toTrimmedString(normalizedLead.motherName),
        courseInterested: toTrimmedString(normalizedLead.courseInterested),
        village: toTrimmedString(normalizedLead.village) || 'Unknown',
        district: stripDistrictSuffixForStorage(toTrimmedString(normalizedLead.district) || '') || 'Unknown',
        mandal: stripMandalSuffixForStorage(
          toTrimmedString(normalizedLead.mandal) || toTrimmedString(normalizedLead.village) || ''
        ) || 'Unknown',
        state: toTrimmedString(normalizedLead.state) || 'Andhra Pradesh',
        gender: toTrimmedString(normalizedLead.gender) || 'Not Specified',
            rank: normalizedLead.rank !== undefined ? Number(normalizedLead.rank) : undefined,
        interCollege: toTrimmedString(normalizedLead.interCollege),
        quota: toTrimmedString(normalizedLead.quota) || 'Not Applicable',
        applicationStatus: toTrimmedString(normalizedLead.applicationStatus) || 'Not Provided',
        notes: toTrimmedString(normalizedLead.notes),
        dynamicFields: cleanedDynamicFields,
        source: toTrimmedString(normalizedLead.source) || job.source_label || 'Bulk Upload',
        uploadedBy: job.created_by,
        uploadBatchId: job.upload_batch_id,
        leadStatus: toTrimmedString(normalizedLead.leadStatus) || 'New',
        academicYear: normalizedLead.academicYear !== undefined ? normalizedLead.academicYear : null,
        studentGroup: normalizedLead.studentGroup || 'Not Specified',
        createdAt: now,
        updatedAt: now,
      };

      if (!leadDocument.dynamicFields || Object.keys(leadDocument.dynamicFields).length === 0) {
        delete leadDocument.dynamicFields;
      }

      return leadDocument;
    };

    const leadsBuffer = [];
    let pendingFlush = Promise.resolve();

    const flushEntries = async (entries) => {
      if (!entries || !entries.length) return;

      const documents = entries.map((entry) => entry.doc);
      let successfulInBatch = 0;
      let failedInBatch = 0;

      try {
        // Lead INSERT: 31 columns, 29 placeholders + NOW(), NOW().
        // "Column count doesn't match value count" causes: (1) undefined in values array,
        // (2) triggers on leads doing another INSERT with wrong count, (3) wrong DB/schema.
        // Run: SHOW TRIGGERS LIKE 'leads'; and DESCRIBE leads; to verify.
        // Bulk insert leads using prepared statements (check duplicate by phone before insert)
        const insertPromises = documents.map(async (doc) => {
          const leadId = uuidv4();
          try {
            const phoneTrimmed = doc.phone ? String(doc.phone).trim() : '';
            if (phoneTrimmed) {
              const [existing] = await pool.execute(
                'SELECT id FROM leads WHERE phone = ? LIMIT 1',
                [phoneTrimmed]
              );
              if (existing && existing.length > 0) {
                return { success: false, error: new Error('Duplicate phone number') };
              }
            }
            // Bulk insert: 31 columns, 31 placeholders, 31 params (no NOW() to avoid driver/server count mismatch)
            const LEAD_INSERT_COLUMN_COUNT = 31;
            const nil = (v, d) => (v === undefined || v === null ? d : v);
            const now = new Date();
            const insertValues = [
              leadId,
              nil(doc.enquiryNumber, null),
              nil(doc.name, ''),
              nil(doc.phone, ''),
              nil(doc.email, null),
              nil(doc.fatherName, ''),
              nil(doc.motherName, ''),
              nil(doc.fatherPhone, ''),
              nil(doc.hallTicketNumber, ''),
              nil(doc.village, ''),
              nil(doc.courseInterested, null),
              nil(doc.district, ''),
              nil(doc.mandal, ''),
              nil(doc.state, 'Andhra Pradesh'),
              doc.isNRI === true || doc.isNRI === 'true' ? 1 : 0,
              nil(doc.gender, 'Not Specified'),
              doc.rank !== undefined && doc.rank !== null && !Number.isNaN(Number(doc.rank)) ? Number(doc.rank) : null,
              nil(doc.interCollege, ''),
              nil(doc.quota, 'Not Applicable'),
              nil(doc.applicationStatus, 'Not Provided'),
              typeof doc.dynamicFields === 'object' && doc.dynamicFields !== null ? JSON.stringify(doc.dynamicFields) : '{}',
              nil(doc.leadStatus, 'New'),
              (doc.academicYear !== undefined && doc.academicYear !== null && !Number.isNaN(Number(doc.academicYear))) ? Number(doc.academicYear) : null,
              nil(doc.studentGroup, 'Not Specified'),
              doc.needsManualUpdate === true ? 1 : 0,
              nil(doc.source, 'Bulk Upload'),
              nil(job.created_by, null),
              nil(job.upload_batch_id, null),
              nil(doc.notes, null),
              now,
              now,
            ];
            if (insertValues.length !== LEAD_INSERT_COLUMN_COUNT) {
              throw new Error(
                `Lead INSERT value count mismatch: expected ${LEAD_INSERT_COLUMN_COUNT}, got ${insertValues.length}.`
              );
            }
            await pool.execute(
              `INSERT INTO leads (
                id, enquiry_number, name, phone, email, father_name, mother_name, father_phone,
                hall_ticket_number, village, course_interested, district, mandal, state,
                is_nri, gender, \`rank\`, inter_college, quota, application_status,
                dynamic_fields, lead_status, academic_year, student_group, needs_manual_update,
                source, uploaded_by, upload_batch_id, notes, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              insertValues
            );
            return { success: true };
          } catch (insertError) {
            const err = insertError?.message || String(insertError);
            const isColumnCountError = /column count|value count|doesn't match/i.test(err);
            if (isColumnCountError) {
              console.error('[Import] Lead INSERT failed (column/value count):', {
                code: insertError?.code,
                sqlMessage: insertError?.sqlMessage,
                sqlState: insertError?.sqlState,
                hint: 'Check SHOW TRIGGERS and that leads table has no extra/missing columns vs schema.',
              });
            }
            return { success: false, error: insertError };
          }
        });

        const results = await Promise.allSettled(insertPromises);
        results.forEach((result, index) => {
          if (result.status === 'fulfilled' && result.value.success) {
            successfulInBatch += 1;
          } else {
            failedInBatch += 1;
            const meta = entries[index]?.meta;
            const errorMsg = result.status === 'rejected' 
              ? result.reason?.message || 'Insert failed'
              : result.value?.error?.message || 'Insert failed';
            pushErrorDetail(meta, entries[index]?.doc, errorMsg);
          }
        });
      } catch (error) {
        // Fallback: mark all as failed
        failedInBatch = documents.length;
        entries.forEach((entry) => {
          pushErrorDetail(entry.meta, entry.doc, error.message || 'Insert failed');
        });
      }

      stats.totalSuccess += successfulInBatch;
      stats.totalErrors += failedInBatch;

      await updateJobProgress(
        `Processed ${stats.totalProcessed} row(s). Success: ${stats.totalSuccess}, Errors: ${stats.totalErrors}`
      );
    };

    const scheduleFlush = async (entries) => {
      if (!entries || entries.length === 0) return;
      // Chain the flush operation but don't await it immediately to avoid blocking
      pendingFlush = pendingFlush
        .then(() => flushEntries(entries))
        .catch((error) => {
          console.error('[Import] Error in flushEntries:', error);
          // Mark all entries as failed
          entries.forEach((entry) => {
            stats.totalErrors += 1;
            pushErrorDetail(entry.meta, entry.doc, error.message || 'Database insert failed');
          });
        });
      // Wait for the flush to complete before continuing
      await pendingFlush;
    };

    const processRawLead = async (rawLead, meta) => {
      const isEmptyRow = Object.values(rawLead || {}).every(
        (value) => value === undefined || value === null || String(value).trim() === ''
      );
      if (isEmptyRow) {
        return;
      }

      stats.totalProcessed += 1;

      try {
        const leadDoc = buildLeadDocument(rawLead);
        leadDoc.needsManualUpdate = masterLookup
          ? checkNeedsManualUpdate(leadDoc, masterLookup)
          : true;
        leadsBuffer.push({ doc: leadDoc, meta });
        if (leadsBuffer.length >= DEFAULT_CHUNK_SIZE) {
          const entries = leadsBuffer.splice(0, leadsBuffer.length);
          // Schedule flush but handle errors gracefully to not break the stream
          try {
            await scheduleFlush(entries);
          } catch (flushError) {
            console.error('[Import] Error flushing leads buffer:', flushError);
            // Mark entries as failed but continue processing
            entries.forEach((entry) => {
              stats.totalErrors += 1;
              pushErrorDetail(entry.meta, entry.doc, flushError.message || 'Database flush failed');
            });
          }
        }
      } catch (error) {
        if (error.message === '__SKIP_ROW__') {
          stats.totalProcessed -= 1;
          return;
        }
        stats.totalErrors += 1;
        pushErrorDetail(meta, rawLead, error.message || 'Validation failed');
        // Don't await updateJobProgress to avoid blocking
        updateJobProgress(
          `Processed ${stats.totalProcessed} row(s). Success: ${stats.totalSuccess}, Errors: ${stats.totalErrors}`
        ).catch(() => {}); // Ignore update errors
      }
    };

    const selectedSheets = Array.isArray(job.selectedSheets) ? job.selectedSheets : [];
    let processedSheetCount = 0;

    const processExcelStream = async () => {
      // Verify file exists before processing
      try {
        await fsPromises.access(job.file_path);
      } catch (error) {
        throw new Error(`File not found: ${job.file_path}. The file may have been deleted or moved.`);
      }

      // Verify file is readable
      const fileStats = await fsPromises.stat(job.file_path).catch(() => null);
      if (!fileStats || fileStats.size === 0) {
        throw new Error('File is empty or cannot be read');
      }

      let workbookReader;
      try {
        workbookReader = new Excel.stream.xlsx.WorkbookReader(job.file_path, {
          entries: 'emit',
          sharedStrings: 'cache',
          hyperlinks: 'cache',
          styles: 'cache',
          worksheets: 'emit',
        });
      } catch (error) {
        throw new Error(`Failed to initialize Excel reader: ${error.message}. The file may be corrupted or in an unsupported format.`);
      }

      // Verify workbookReader is properly initialized
      if (!workbookReader) {
        throw new Error('WorkbookReader initialization failed');
      }

      try {
        for await (const worksheetReader of workbookReader) {
          if (!worksheetReader) {
            console.warn('[Import] Skipping invalid worksheet reader');
            continue;
          }

          const sheetName = worksheetReader.name || `Sheet${worksheetReader.id || processedSheetCount + 1}`;
          if (selectedSheets.length > 0 && !selectedSheets.includes(sheetName)) {
            // eslint-disable-next-line no-continue
            continue;
          }

          processedSheets.add(sheetName);
          processedSheetCount += 1;
          let headers = null;

          try {
            for await (const row of worksheetReader) {
              if (!row) {
                continue;
              }

              const rowValues = row.values || [];
              if (!headers) {
                headers = rowValues
                  .slice(1)
                  .map((cellValue, index) => {
                    const value = getCellValue(cellValue);
                    const trimmed = value === undefined || value === null ? '' : String(value).trim();
                    return trimmed || `Column${index + 1}`;
                  });
                // eslint-disable-next-line no-continue
                continue;
              }

              const rawLead = {};
              headers.forEach((header, index) => {
                rawLead[header] = getCellValue(rowValues[index + 1]);
              });

              // Process lead - await to ensure proper buffer flushing, but catch errors to prevent stream failure
              try {
                await processRawLead(rawLead, { sheetName, rowNumber: row.number });
              } catch (leadError) {
                // Error already handled in processRawLead, just log for debugging
                console.error(`[Import] Error processing lead in sheet "${sheetName}", row ${row.number}:`, leadError.message);
                // Don't re-throw - continue processing other rows
              }
            }
          } catch (sheetError) {
            console.error(`[Import] Error processing sheet "${sheetName}":`, sheetError);
            // Continue with other sheets instead of failing completely
            stats.totalErrors += 1;
            pushErrorDetail(
              { sheetName, rowNumber: null },
              {},
              `Error processing sheet "${sheetName}": ${sheetError.message}`
            );
          }
        }
      } catch (parseError) {
        // More specific error message for parsing errors
        if (parseError.message && parseError.message.includes('sheets')) {
          throw new Error(`Excel file parsing failed: The file structure may be corrupted or invalid. Please verify the file is a valid .xlsx file. Original error: ${parseError.message}`);
        }
        throw new Error(`Excel file parsing failed: ${parseError.message}`);
      }

      if (processedSheetCount === 0) {
        throw new Error('Selected worksheets were not found in the uploaded file');
      }
    };

    const processCsvStream = async () => {
      processedSheets.add('CSV');
      let rowNumber = 2;

      await new Promise((resolve, reject) => {
        const stream = createReadStream(job.file_path);
        Papa.parse(stream, {
          header: true,
          skipEmptyLines: true,
          step: async (results, parser) => {
            parser.pause();
            try {
              await processRawLead(results.data, { sheetName: 'CSV', rowNumber });
              rowNumber += 1;
              parser.resume();
            } catch (error) {
              parser.abort();
              reject(error);
            }
          },
          complete: () => resolve(),
          error: (error) => reject(error),
        });
      });
    };

    if (['.xlsx', '.xlsm', '.xlsb'].includes(job.extension || '')) {
      try {
        await processExcelStream();
      } catch (excelError) {
        // If streaming reader fails, provide a more helpful error message
        const errorMessage = excelError.message || 'Unknown error';
        if (errorMessage.includes('sheets') || errorMessage.includes('Cannot read properties')) {
          throw new Error(
            `Excel file parsing failed: The file may be corrupted, password-protected, or in an unsupported format. ` +
            `Please ensure the file is a valid .xlsx file and try again. ` +
            `If the problem persists, try opening and re-saving the file in Excel. ` +
            `Original error: ${errorMessage}`
          );
        }
        throw excelError;
      }
    } else if ((job.extension || '') === '.csv') {
      await processCsvStream();
    } else if (job.extension === '.xls') {
      throw new Error('Legacy .xls files are not supported. Please convert the file to .xlsx and try again.');
    } else {
      throw new Error('Unsupported file format. Please upload .xlsx or .csv files.');
    }

    if (leadsBuffer.length > 0) {
      const entries = leadsBuffer.splice(0, leadsBuffer.length);
      await scheduleFlush(entries);
    }

    await pendingFlush;

    stats.durationMs = Date.now() - startedAt;

    // Log stats before saving for debugging
    console.log('[Import] Final stats before saving:', {
      totalProcessed: stats.totalProcessed,
      totalSuccess: stats.totalSuccess,
      totalErrors: stats.totalErrors,
      durationMs: stats.durationMs,
      sheetsProcessed: Array.from(processedSheets),
    });

    // Update job status
    const updateResult = await pool.execute(
      `UPDATE import_jobs SET
        status = ?,
        completed_at = NOW(),
        stats_total_processed = ?,
        stats_total_success = ?,
        stats_total_errors = ?,
        stats_sheets_processed = ?,
        stats_duration_ms = ?,
        message = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        'completed',
        stats.totalProcessed || 0,
        stats.totalSuccess || 0,
        stats.totalErrors || 0,
        JSON.stringify(Array.from(processedSheets)),
        stats.durationMs || 0,
        `Imported ${stats.totalSuccess || 0} of ${stats.totalProcessed || 0} row(s).`,
        jobId,
      ]
    ).catch((error) => {
      console.error('[Import] Error updating job status:', error);
      throw error;
    });

    console.log('[Import] Job status updated. Affected rows:', updateResult[0]?.affectedRows || 0);

    // Insert error details
    const errorDetailsToInsert = errors.slice(0, MAX_ERROR_DETAILS);
    if (errorDetailsToInsert.length > 0) {
      const errorInsertPromises = errorDetailsToInsert.map(async (errorDetail) => {
        const errorId = uuidv4();
        await pool.execute(
          `INSERT INTO import_job_error_details (id, import_job_id, sheet, \`row_number\`, error, created_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [
            errorId,
            jobId,
            errorDetail.sheet || null,
            errorDetail.row || errorDetail.rowNumber || null,
            errorDetail.error || 'Unknown error',
          ]
        );
      });
      await Promise.allSettled(errorInsertPromises);
    }

    // Verify stats were saved correctly
    try {
      const [verifyJobs] = await pool.execute(
        'SELECT stats_total_processed, stats_total_success, stats_total_errors FROM import_jobs WHERE id = ?',
        [jobId]
      );
      if (verifyJobs.length > 0) {
        const savedStats = verifyJobs[0];
        console.log('[Import] Verified saved stats:', {
          totalProcessed: savedStats.stats_total_processed,
          totalSuccess: savedStats.stats_total_success,
          totalErrors: savedStats.stats_total_errors,
        });
      }
    } catch (verifyError) {
      console.error('[Import] Error verifying saved stats:', verifyError);
    }
  } catch (error) {
    console.error('Import job failed:', error);
    stats.durationMs = Date.now() - startedAt;
    if (errors.length < MAX_ERROR_DETAILS) {
      pushErrorDetail({ sheetName: 'N/A', rowNumber: 0 }, null, error.message || 'Import failed');
    }

    // Update job status to failed
    await pool.execute(
      `UPDATE import_jobs SET
        status = ?,
        completed_at = NOW(),
        stats_total_processed = ?,
        stats_total_success = ?,
        stats_total_errors = ?,
        stats_sheets_processed = ?,
        stats_duration_ms = ?,
        message = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        'failed',
        stats.totalProcessed,
        stats.totalSuccess,
        stats.totalErrors,
        JSON.stringify(Array.from(processedSheets)),
        stats.durationMs,
        error.message || 'Import job failed',
        jobId,
      ]
    ).catch(() => {});

    // Insert error details
    const errorDetailsToInsert = errors.slice(0, MAX_ERROR_DETAILS);
    if (errorDetailsToInsert.length > 0) {
      const errorInsertPromises = errorDetailsToInsert.map(async (errorDetail) => {
        const errorId = uuidv4();
        await pool.execute(
          `INSERT INTO import_job_error_details (id, import_job_id, sheet, \`row_number\`, error, created_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [
            errorId,
            jobId,
            errorDetail.sheet || null,
            errorDetail.row || errorDetail.rowNumber || null,
            errorDetail.error || 'Unknown error',
          ]
        );
      });
      await Promise.allSettled(errorInsertPromises);
    }
  } finally {
    await fsPromises.unlink(job.file_path).catch(() => {});
  }
};

// @desc    Get upload statistics
// @route   GET /api/leads/upload-stats
// @access  Private (Super Admin only)
export const getUploadStats = async (req, res) => {
  try {
    const { batchId } = req.query;
    const pool = getPool();

    if (!batchId) {
      return errorResponse(res, 'Batch ID is required', 400);
    }

    // Get total count
    const [totalResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM leads WHERE upload_batch_id = ?',
      [batchId]
    );

    const total = totalResult[0]?.total || 0;

    if (total === 0) {
      return successResponse(res, {
        total: 0,
        byStatus: {},
        byMandal: {},
        byState: {},
      }, 'No leads found for this batch', 200);
    }

    // Get counts by status
    const [statusResults] = await pool.execute(
      `SELECT application_status, COUNT(*) as count 
       FROM leads 
       WHERE upload_batch_id = ? 
       GROUP BY application_status`,
      [batchId]
    );

    const statusCount = {};
    statusResults.forEach((row) => {
      statusCount[row.application_status || 'Not Provided'] = row.count;
    });

    // Get counts by mandal
    const [mandalResults] = await pool.execute(
      `SELECT mandal, COUNT(*) as count 
       FROM leads 
       WHERE upload_batch_id = ? 
       GROUP BY mandal`,
      [batchId]
    );

    const mandalCount = {};
    mandalResults.forEach((row) => {
      mandalCount[row.mandal || 'Unknown'] = row.count;
    });

    // Get counts by state
    const [stateResults] = await pool.execute(
      `SELECT state, COUNT(*) as count 
       FROM leads 
       WHERE upload_batch_id = ? 
       GROUP BY state`,
      [batchId]
    );

    const stateCount = {};
    stateResults.forEach((row) => {
      stateCount[row.state || 'Unknown'] = row.count;
    });

    return successResponse(res, {
      total,
      byStatus: statusCount,
      byMandal: mandalCount,
      byState: stateCount,
    }, 'Upload statistics retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting upload stats:', error);
    return errorResponse(res, error.message || 'Failed to get upload stats', 500);
  }
};

// @desc    Get bulk import job status
// @route   GET /api/leads/import-jobs/:jobId
// @access  Private (Super Admin only)
export const getImportJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const pool = getPool();

    if (!jobId) {
      return errorResponse(res, 'Job ID is required', 400);
    }

    // Fetch import job
    const [jobs] = await pool.execute(
      'SELECT * FROM import_jobs WHERE id = ?',
      [jobId]
    );

    if (jobs.length === 0) {
      return errorResponse(res, 'Import job not found', 404);
    }

    const job = jobs[0];

    // Fetch error details
    const [errorDetails] = await pool.execute(
      'SELECT sheet, `row_number` as rowNumber, error FROM import_job_error_details WHERE import_job_id = ? ORDER BY created_at ASC',
      [jobId]
    );

    // Parse sheets processed safely
    let sheetsProcessed = [];
    try {
      if (job.stats_sheets_processed) {
        if (typeof job.stats_sheets_processed === 'string') {
          sheetsProcessed = JSON.parse(job.stats_sheets_processed);
        } else if (Array.isArray(job.stats_sheets_processed)) {
          sheetsProcessed = job.stats_sheets_processed;
        }
      }
    } catch (parseError) {
      console.error('[Import] Error parsing stats_sheets_processed:', parseError);
      sheetsProcessed = [];
    }

    // Format response with explicit number conversion
    const response = {
      jobId: job.id,
      uploadId: job.upload_id,
      status: job.status,
      stats: {
        totalProcessed: Number(job.stats_total_processed) || 0,
        totalSuccess: Number(job.stats_total_success) || 0,
        totalErrors: Number(job.stats_total_errors) || 0,
        sheetsProcessed: sheetsProcessed,
        durationMs: Number(job.stats_duration_ms) || 0,
      },
      message: job.message || null,
      errorDetails: errorDetails.map((err) => ({
        sheet: err.sheet || null,
        row: err.rowNumber || null,
        error: err.error || 'Unknown error',
      })),
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    };

    // Log response for debugging
    console.log('[Import] Returning job status response:', {
      jobId: response.jobId,
      status: response.status,
      stats: response.stats,
    });

    return successResponse(
      res,
      response,
      'Import job status retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting import job status:', error);
    return errorResponse(res, error.message || 'Failed to get import job status', 500);
  }
};

