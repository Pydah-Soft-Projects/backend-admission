import { createReadStream, promises as fsPromises } from 'fs';
import { extname } from 'path';
import Excel from 'exceljs';
import XLSX from 'xlsx';
import Papa from 'papaparse';
import PQueue from 'p-queue';
import Lead from '../models/Lead.model.js';
import ImportJob from '../models/ImportJob.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

const UPLOAD_SESSION_TTL_MS = 1000 * 60 * 30; // 30 minutes
const PREVIEW_ROW_LIMIT = 10;
const PREVIEW_SIZE_LIMIT = 15 * 1024 * 1024; // 15 MB threshold for generating previews
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
  'dynamicFields',
    ];

    const canonicalFieldSet = new Set(canonicalFields);

const aliasPairs = [
  ['candidate name', 'name'],
  ['candidate', 'name'],
      ['student', 'name'],
  ['student name', 'name'],
  ['studentname', 'name'],
  ['student full name', 'name'],
  ['name of the student', 'name'],
  ['name', 'name'],
  ['contact', 'phone'],
  ['contact number', 'phone'],
  ['contact no', 'phone'],
  ['contact no 1', 'phone'],
  ['contact number 1', 'phone'],
  ['mobile', 'phone'],
  ['mobile number', 'phone'],
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
  ['fathername', 'fatherName'],
  ['fname', 'fatherName'],
  ['guardian name', 'fatherName'],
  ['mother', 'motherName'],
  ['mother name', 'motherName'],
  ['mothername', 'motherName'],
  ['mname', 'motherName'],
      ['contact2', 'fatherPhone'],
      ['contact 2', 'fatherPhone'],
  ['contact no 2', 'fatherPhone'],
  ['contact number 2', 'fatherPhone'],
  ['contact no2', 'fatherPhone'],
  ['contact number2', 'fatherPhone'],
  ['phone2', 'fatherPhone'],
  ['phone 2', 'fatherPhone'],
  ['phone no 2', 'fatherPhone'],
  ['mobile2', 'fatherPhone'],
  ['mobile 2', 'fatherPhone'],
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
  ['preference', 'courseInterested'],
  ['village/town', 'village'],
  ['village name', 'village'],
  ['city', 'village'],
  ['mandal/town', 'mandal'],
  ['mandal name', 'mandal'],
  ['district name', 'district'],
  ['district', 'district'],
  ['state name', 'state'],
  ['gender', 'gender'],
  ['sex', 'gender'],
  ['quota', 'quota'],
  ['category', 'quota'],
  ['notes', 'notes'],
  ['remarks', 'notes'],
  ['comments', 'notes'],
  ['comment', 'notes'],
  ['source', 'source'],
  
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

    const importJob = await ImportJob.create({
      uploadId,
      originalName,
      filePath,
      fileSize,
      extension: fileExtension,
      selectedSheets,
      sourceLabel,
      createdBy: req.user?._id,
      status: 'queued',
      uploadBatchId: batchId,
      uploadToken,
      message: 'Queued for processing',
    });

    importQueue
      .add(() => processImportJob(importJob._id))
      .catch((error) => {
        console.error('Failed to enqueue import job', error);
      });

    return successResponse(
      res,
      {
        jobId: importJob._id,
        uploadId,
        batchId,
        status: importJob.status,
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
  const job = await ImportJob.findById(jobId);
  if (!job) {
    return;
  }

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
    await ImportJob.findByIdAndUpdate(jobId, {
      stats: {
        totalProcessed: stats.totalProcessed,
        totalSuccess: stats.totalSuccess,
        totalErrors: stats.totalErrors,
        durationMs: Date.now() - startedAt,
        sheetsProcessed: Array.from(processedSheets),
      },
      status: 'processing',
      message,
    }).catch(() => {});
  };
  updateJobProgress.lastUpdated = 0;

  await ImportJob.findByIdAndUpdate(jobId, {
    status: 'processing',
    startedAt: new Date(),
    message: 'Processing file',
  }).catch(() => {});

  let currentSequence = 1;
  let enquiryPrefix = '';

  try {
    const currentYear = new Date().getFullYear();
    const yearSuffix = String(currentYear).slice(-2);
    enquiryPrefix = `ENQ${yearSuffix}`;

    const lastLead = await Lead.findOne({
      enquiryNumber: { $regex: `^${enquiryPrefix}` },
    })
      .sort({ enquiryNumber: -1 })
      .select('enquiryNumber')
      .lean();

    if (lastLead?.enquiryNumber) {
      const lastSequence = lastLead.enquiryNumber.replace(enquiryPrefix, '');
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

      const cleanedDynamicFields = {};
      Object.entries(dynamicFieldsFromPayload).forEach(([key, value]) => {
        const cleanedValue = toTrimmedString(value);
        if (cleanedValue !== undefined) {
          cleanedDynamicFields[key] = cleanedValue;
        }
      });

      const requiredFields = ['name', 'phone', 'fatherName', 'fatherPhone', 'mandal', 'village', 'district'];
      const missing = requiredFields.filter((field) => !toTrimmedString(normalizedLead[field]));
      if (missing.length > 0) {
        throw new Error(`Missing required core fields: ${missing.join(', ')}`);
      }

      const now = new Date();
      const enquiryNumber = getNextEnquiryNumber();

      const leadDocument = {
            enquiryNumber,
        hallTicketNumber: toTrimmedString(normalizedLead.hallTicketNumber) || '',
            name: String(normalizedLead.name).trim(),
            phone: String(normalizedLead.phone).trim(),
        email: toTrimmedString(normalizedLead.email)?.toLowerCase(),
            fatherName: String(normalizedLead.fatherName).trim(),
            fatherPhone: String(normalizedLead.fatherPhone).trim(),
        motherName: toTrimmedString(normalizedLead.motherName),
        courseInterested: toTrimmedString(normalizedLead.courseInterested),
        village: toTrimmedString(normalizedLead.village) || 'Unknown',
        district: toTrimmedString(normalizedLead.district) || 'Unknown',
        mandal:
          toTrimmedString(normalizedLead.mandal) ||
          toTrimmedString(normalizedLead.village) ||
          'Unknown',
        state: toTrimmedString(normalizedLead.state) || 'Andhra Pradesh',
        gender: toTrimmedString(normalizedLead.gender) || 'Not Specified',
            rank: normalizedLead.rank !== undefined ? Number(normalizedLead.rank) : undefined,
        interCollege: toTrimmedString(normalizedLead.interCollege),
        quota: toTrimmedString(normalizedLead.quota) || 'Not Applicable',
        applicationStatus: toTrimmedString(normalizedLead.applicationStatus) || 'Not Provided',
        notes: toTrimmedString(normalizedLead.notes),
        dynamicFields: cleanedDynamicFields,
        source: toTrimmedString(normalizedLead.source) || job.sourceLabel || 'Bulk Upload',
        uploadedBy: job.createdBy,
        uploadBatchId: job.uploadBatchId,
        leadStatus: toTrimmedString(normalizedLead.leadStatus) || 'New',
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
        await Lead.collection.insertMany(documents, {
          ordered: false,
          writeConcern: { w: 1 },
        });
        successfulInBatch = documents.length;
        } catch (error) {
        if (error.writeErrors && Array.isArray(error.writeErrors)) {
          const failedIndexes = new Set();
          error.writeErrors.forEach((writeError) => {
            const failedIndex = writeError.index;
            failedIndexes.add(failedIndex);
            const meta = entries[failedIndex]?.meta;
            pushErrorDetail(
              meta,
              entries[failedIndex]?.doc,
              writeError.errmsg || writeError.err?.message || 'Insert failed'
            );
          });
          failedInBatch = failedIndexes.size;
          successfulInBatch = documents.length - failedInBatch;
        } else if (typeof error.insertedCount === 'number') {
          successfulInBatch = error.insertedCount;
          failedInBatch = documents.length - error.insertedCount;
          for (let i = error.insertedCount; i < documents.length; i += 1) {
            const meta = entries[i]?.meta;
            pushErrorDetail(meta, entries[i]?.doc, error.message || 'Insert failed');
          }
        } else {
          failedInBatch = documents.length;
          entries.forEach((entry) => {
            pushErrorDetail(entry.meta, entry.doc, error.message || 'Insert failed');
          });
        }
      }

      stats.totalSuccess += successfulInBatch;
      stats.totalErrors += failedInBatch;

      await updateJobProgress(
        `Processed ${stats.totalProcessed} row(s). Success: ${stats.totalSuccess}, Errors: ${stats.totalErrors}`
      );
    };

    const scheduleFlush = async (entries) => {
      if (!entries || entries.length === 0) return;
      pendingFlush = pendingFlush.then(() => flushEntries(entries));
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
        leadsBuffer.push({ doc: leadDoc, meta });
        if (leadsBuffer.length >= DEFAULT_CHUNK_SIZE) {
          const entries = leadsBuffer.splice(0, leadsBuffer.length);
          await scheduleFlush(entries);
        }
        } catch (error) {
        stats.totalErrors += 1;
        pushErrorDetail(meta, rawLead, error.message || 'Validation failed');
        await updateJobProgress(
          `Processed ${stats.totalProcessed} row(s). Success: ${stats.totalSuccess}, Errors: ${stats.totalErrors}`
        );
      }
    };

    const selectedSheets = Array.isArray(job.selectedSheets) ? job.selectedSheets : [];
    let processedSheetCount = 0;

    const processExcelStream = async () => {
      const workbookReader = new Excel.stream.xlsx.WorkbookReader(job.filePath, {
        entries: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'cache',
        styles: 'cache',
        worksheets: 'emit',
      });

      for await (const worksheetReader of workbookReader) {
        const sheetName = worksheetReader.name || `Sheet${worksheetReader.id}`;
        if (selectedSheets.length > 0 && !selectedSheets.includes(sheetName)) {
          // eslint-disable-next-line no-continue
          continue;
        }

        processedSheets.add(sheetName);
        processedSheetCount += 1;
        let headers = null;

        for await (const row of worksheetReader) {
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

          await processRawLead(rawLead, { sheetName, rowNumber: row.number });
        }
      }

      if (processedSheetCount === 0) {
        throw new Error('Selected worksheets were not found in the uploaded file');
      }
    };

    const processCsvStream = async () => {
      processedSheets.add('CSV');
      let rowNumber = 2;

      await new Promise((resolve, reject) => {
        const stream = createReadStream(job.filePath);
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

    if (['.xlsx', '.xlsm', '.xlsb'].includes(job.extension)) {
      await processExcelStream();
    } else if (job.extension === '.csv') {
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

    await ImportJob.findByIdAndUpdate(jobId, {
      status: 'completed',
      completedAt: new Date(),
      stats: {
        ...stats,
        sheetsProcessed: Array.from(processedSheets),
      },
      errorDetails: errors.slice(0, MAX_ERROR_DETAILS),
      message: `Imported ${stats.totalSuccess} of ${stats.totalProcessed} row(s).`,
    }).catch(() => {});
  } catch (error) {
    console.error('Import job failed:', error);
    stats.durationMs = Date.now() - startedAt;
    if (errors.length < MAX_ERROR_DETAILS) {
      pushErrorDetail({ sheetName: 'N/A', rowNumber: 0 }, null, error.message || 'Import failed');
    }

    await ImportJob.findByIdAndUpdate(jobId, {
      status: 'failed',
      completedAt: new Date(),
      stats: {
        ...stats,
        sheetsProcessed: Array.from(processedSheets),
      },
      errorDetails: errors.slice(0, MAX_ERROR_DETAILS),
      message: error.message || 'Import job failed',
    }).catch(() => {});
  } finally {
    await fsPromises.unlink(job.filePath).catch(() => {});
  }
};

// @desc    Get upload statistics
// @route   GET /api/leads/upload-stats
// @access  Private (Super Admin only)
export const getUploadStats = async (req, res) => {
  try {
    const { batchId } = req.query;

    if (!batchId) {
      return errorResponse(res, 'Batch ID is required', 400);
    }

    const stats = await Lead.aggregate([
      { $match: { uploadBatchId: batchId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          byStatus: { $push: '$applicationStatus' },
          byMandal: { $push: '$mandal' },
          byState: { $push: '$state' },
        },
      },
    ]);

    if (stats.length === 0) {
      return successResponse(res, {
        total: 0,
        byStatus: {},
        byMandal: {},
        byState: {},
      }, 'No leads found for this batch', 200);
    }

    // Count occurrences
    const statusCount = {};
    const mandalCount = {};
    const stateCount = {};

    stats[0].byStatus.forEach((status) => {
      statusCount[status] = (statusCount[status] || 0) + 1;
    });

    stats[0].byMandal.forEach((mandal) => {
      mandalCount[mandal] = (mandalCount[mandal] || 0) + 1;
    });

    stats[0].byState.forEach((state) => {
      stateCount[state] = (stateCount[state] || 0) + 1;
    });

    return successResponse(res, {
      total: stats[0].total,
      byStatus: statusCount,
      byMandal: mandalCount,
      byState: stateCount,
    }, 'Upload statistics retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get upload stats', 500);
  }
};

// @desc    Get bulk import job status
// @route   GET /api/leads/import-jobs/:jobId
// @access  Private (Super Admin only)
export const getImportJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return errorResponse(res, 'Job ID is required', 400);
    }

    const job = await ImportJob.findById(jobId).lean();

    if (!job) {
      return errorResponse(res, 'Import job not found', 404);
    }

    return successResponse(
      res,
      {
        jobId: job._id,
        uploadId: job.uploadId,
        status: job.status,
        stats: job.stats,
        message: job.message,
        errorDetails: job.errorDetails,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      },
      'Import job status retrieved successfully',
      200
    );
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get import job status', 500);
  }
};

