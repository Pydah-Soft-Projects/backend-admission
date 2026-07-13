import mongoose from 'mongoose';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { getTableColumnSet } from '../utils/secondarySchema.util.js';
import { resolveTransportApplicationCodes } from '../utils/transportApplicationNumber.util.js';

const { Types: { ObjectId } } = mongoose;

const RECEIPT_SEQUENCES_COLLECTION = 'receiptsequences';
const SETTINGS_COLLECTION = 'settings';
const FEE_GROUPS_COLLECTION = 'feegroups';

const DEFAULT_CODE = 'GEN';
const SETTINGS_CACHE_TTL_MS = 60_000;

let settingsCache = { at: 0, value: null };

/**
 * Financial year label (e.g. "2026-27") using reset boundary (default April 1).
 */
export const calculateFinancialYear = (date, resetMonth = 4, resetDay = 1) => {
  const d = date instanceof Date ? date : new Date(date);
  const currentYear = d.getFullYear();
  const resetDateThisYear = new Date(currentYear, resetMonth - 1, resetDay);
  if (d >= resetDateThisYear) {
    const nextYearLastTwoDigits = String(currentYear + 1).slice(-2);
    return `${currentYear}-${nextYearLastTwoDigits}`;
  }
  const currentYearLastTwoDigits = String(currentYear).slice(-2);
  return `${currentYear - 1}-${currentYearLastTwoDigits}`;
};

const normalizeCode = (value) => {
  const code = String(value ?? '').trim().toUpperCase();
  return code || DEFAULT_CODE;
};

/** Fallback when custom receipt sequences are disabled. */
export const generateFallbackReceiptNumber = () => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(100 + Math.random() * 900).toString();
  return `REC${timestamp}${random}`;
};

const defaultReceiptSettings = () => ({
  enableCustomReceiptSequence: false,
  receiptSequenceSeparator: '/',
  receiptSequencePadding: 5,
  receiptSequenceResetMonth: 4,
  receiptSequenceResetDay: 1,
});

const loadReceiptSettings = async (feeMgmtDb) => {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.at < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.value;
  }

  const defaults = defaultReceiptSettings();
  try {
    const doc =
      (await feeMgmtDb.collection(SETTINGS_COLLECTION).findOne({
        enableCustomReceiptSequence: { $exists: true },
      })) ||
      (await feeMgmtDb.collection(SETTINGS_COLLECTION).findOne({}));

    const merged = {
      ...defaults,
      ...(doc && typeof doc === 'object' ? doc : {}),
    };
    settingsCache = { at: now, value: merged };
    return merged;
  } catch (err) {
    console.warn('[receiptSequence] Could not load Fee Management settings:', err?.message || err);
    return defaults;
  }
};

const feeHeadMatchValues = (feeHeadId) => {
  const raw = String(feeHeadId ?? '').trim();
  if (!raw) return [];
  const values = [raw];
  try {
    values.push(new ObjectId(raw));
  } catch {
    // non-ObjectId fee head ids are matched as-is
  }
  return values;
};

const resolveGroupCode = async (feeMgmtDb, feeHeadId) => {
  const matchValues = feeHeadMatchValues(feeHeadId);
  if (matchValues.length === 0) return DEFAULT_CODE;

  try {
    const feeGroup = await feeMgmtDb.collection(FEE_GROUPS_COLLECTION).findOne({
      feeHeads: { $in: matchValues },
    });
    if (feeGroup?.code) return normalizeCode(feeGroup.code);
  } catch (err) {
    console.warn('[receiptSequence] feegroups lookup failed:', err?.message || err);
  }
  return DEFAULT_CODE;
};

const resolveCollegeCodeByName = async (secondaryPool, collegeName) => {
  const name = String(collegeName ?? '').trim();
  if (!name) return null;

  const collegeCols = await getTableColumnSet(secondaryPool, 'colleges');
  const hasCode = collegeCols.has('code');
  const [rows] = await secondaryPool.execute(
    hasCode
      ? 'SELECT code, name FROM colleges WHERE name = ? OR code = ? LIMIT 1'
      : 'SELECT name FROM colleges WHERE name = ? LIMIT 1',
    hasCode ? [name, name] : [name]
  );
  if (!rows.length) return null;
  return normalizeCode(rows[0].code || rows[0].name);
};

const resolveCourseCodeByName = async (secondaryPool, courseName, collegeName = null) => {
  const name = String(courseName ?? '').trim();
  if (!name) return null;

  const courseCols = await getTableColumnSet(secondaryPool, 'courses');
  const hasCode = courseCols.has('code');
  const params = [name];
  let sql = hasCode
    ? 'SELECT code, name FROM courses WHERE name = ?'
    : 'SELECT name FROM courses WHERE name = ?';

  if (collegeName) {
    const collegeCols = await getTableColumnSet(secondaryPool, 'colleges');
    if (collegeCols.has('name')) {
      sql += ' AND college_id = (SELECT id FROM colleges WHERE name = ? LIMIT 1)';
      params.push(String(collegeName).trim());
    }
  }
  sql += ' LIMIT 1';

  const [rows] = await secondaryPool.execute(sql, params);
  if (!rows.length) return normalizeCode(name.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || DEFAULT_CODE);
  return normalizeCode(rows[0].code || rows[0].name || name);
};

/**
 * Resolve collegeCode / courseCode from secondary students (+ fallbacks).
 */
export const resolveReceiptMetadataCodes = async ({
  admissionNumber,
  admission = null,
  joining = null,
  secondaryPool = null,
} = {}) => {
  const pool = secondaryPool || getSecondaryPool();
  let collegeName = null;
  let courseName = null;
  let collegeCode = null;
  let courseCode = null;

  const admNo = String(admissionNumber ?? '').trim();
  if (admNo) {
    try {
      const [studentRows] = await pool.execute(
        'SELECT college, course FROM students WHERE admission_number = ? OR admission_no = ? LIMIT 1',
        [admNo, admNo]
      );
      if (studentRows.length > 0) {
        collegeName = studentRows[0].college || null;
        courseName = studentRows[0].course || null;
      }
    } catch (err) {
      console.warn('[receiptSequence] students lookup failed:', err?.message || err);
    }
  }

  collegeName =
    collegeName ||
    admission?.college ||
    joining?.college ||
    null;
  courseName =
    courseName ||
    admission?.course ||
    joining?.course ||
    null;

  if (collegeName) {
    collegeCode = await resolveCollegeCodeByName(pool, collegeName);
  }
  if (courseName) {
    courseCode = await resolveCourseCodeByName(pool, courseName, collegeName);
  }

  if ((!collegeCode || !courseCode) && (joining?.managed_course_id || admission?.managed_course_id)) {
    try {
      const fromManaged = await resolveTransportApplicationCodes(pool, {
        managedCourseId: joining?.managed_course_id ?? admission?.managed_course_id,
        courseName: courseName || undefined,
        collegeName: collegeName || undefined,
      });
      if (!collegeCode || collegeCode === DEFAULT_CODE) {
        collegeCode = fromManaged.collegeCode || collegeCode;
      }
      if (!courseCode || courseCode === DEFAULT_CODE) {
        courseCode = fromManaged.courseCode || courseCode;
      }
    } catch (err) {
      console.warn('[receiptSequence] managed course code resolve failed:', err?.message || err);
    }
  }

  return {
    collegeCode: normalizeCode(collegeCode),
    courseCode: normalizeCode(courseCode),
  };
};

const atomicNextSequenceNumber = async (feeMgmtDb, key) => {
  const coll = feeMgmtDb.collection(RECEIPT_SEQUENCES_COLLECTION);
  const filter = {
    collegeCode: key.collegeCode,
    courseCode: key.courseCode,
    groupCode: key.groupCode,
    financialYear: key.financialYear,
  };

  const runIncrement = (upsert) =>
    coll.findOneAndUpdate(
      filter,
      {
        $inc: { nextNumber: 1 },
        $setOnInsert: {
          collegeCode: key.collegeCode,
          courseCode: key.courseCode,
          groupCode: key.groupCode,
          financialYear: key.financialYear,
        },
      },
      { returnDocument: 'after', upsert }
    );

  try {
    const result = await runIncrement(true);
    const nextNumber = result?.value?.nextNumber ?? result?.nextNumber;
    if (Number.isFinite(Number(nextNumber)) && Number(nextNumber) > 0) {
      return Number(nextNumber);
    }
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const result = await runIncrement(false);
    const nextNumber = result?.value?.nextNumber ?? result?.nextNumber;
    if (Number.isFinite(Number(nextNumber)) && Number(nextNumber) > 0) {
      return Number(nextNumber);
    }
  }

  throw new Error('Failed to allocate receipt sequence number');
};

const formatCustomReceiptNumber = (settings, codes, nextNumber) => {
  const separator = String(settings.receiptSequenceSeparator ?? '/');
  const padding = Math.max(1, Number(settings.receiptSequencePadding) || 5);
  const paddedNum = String(nextNumber).padStart(padding, '0');
  return `${codes.collegeCode}${separator}${codes.courseCode}${separator}${codes.groupCode}${separator}${paddedNum}`;
};

/**
 * Generate a receipt number using Fee Management shared sequence rules.
 * @param {object} params
 * @param {string} params.admissionNumber
 * @param {string|import('mongoose').Types.ObjectId} params.feeHeadId
 * @param {Date} [params.transactionDate]
 * @param {object} [params.admission]
 * @param {object} [params.joining]
 * @param {import('mongodb').Db} [params.feeMgmtDb]
 */
export const generateTransactionReceiptNumber = async ({
  admissionNumber,
  feeHeadId,
  transactionDate = new Date(),
  admission = null,
  joining = null,
  feeMgmtDb = null,
} = {}) => {
  const conn = feeMgmtDb ? null : await connectFeeManagement();
  const db = feeMgmtDb || conn.db;
  const settings = await loadReceiptSettings(db);

  if (!settings.enableCustomReceiptSequence) {
    return generateFallbackReceiptNumber();
  }

  const resetMonth = Number(settings.receiptSequenceResetMonth) || 4;
  const resetDay = Number(settings.receiptSequenceResetDay) || 1;
  const financialYear = calculateFinancialYear(transactionDate, resetMonth, resetDay);

  const { collegeCode, courseCode } = await resolveReceiptMetadataCodes({
    admissionNumber,
    admission,
    joining,
  });
  const groupCode = await resolveGroupCode(db, feeHeadId);

  const nextNumber = await atomicNextSequenceNumber(db, {
    collegeCode,
    courseCode,
    groupCode,
    financialYear,
  });

  return formatCustomReceiptNumber(
    settings,
    { collegeCode, courseCode, groupCode },
    nextNumber
  );
};
