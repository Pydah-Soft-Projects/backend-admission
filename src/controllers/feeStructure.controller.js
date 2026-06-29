import mongoose from 'mongoose';
import {
  connectFeeManagement,
  getFeeManagementConnection,
} from '../config-mongo/feeManagement.js';
import { mapCourseLabel } from '../data/admissionsCourseBranchMap2026.js';
import { resolveFeePortalBranchLabel } from '../utils/feePortalBranchLabel.util.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const { Types: { ObjectId } } = mongoose;

/** Convert a value that might be a hex string or already-ObjectId into an ObjectId; returns null if invalid. */
const toObjectId = (value) => {
  if (value instanceof ObjectId) return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (!/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
};

const QUOTA_TO_CATEGORY = {
  convenor: 'CONV',
  convener: 'CONV',
  conv: 'CONV',
  management: 'MANG',
  mang: 'MANG',
  spot: 'SPOT',
  'spot admission': 'SPOT',
  'lateral entry': 'CONV',
  'lateral spot': 'SPOT',
};

const normalize = (value) =>
  typeof value === 'string' ? value.trim() : value === undefined ? '' : String(value);

/** Best-effort mapping from CRM `quota` to feestructures.category bucket. */
const mapQuotaToCategory = (quota) => {
  const key = normalize(quota).toLowerCase();
  if (!key) return '';
  if (QUOTA_TO_CATEGORY[key]) return QUOTA_TO_CATEGORY[key];
  for (const [needle, bucket] of Object.entries(QUOTA_TO_CATEGORY)) {
    if (key.includes(needle)) return bucket;
  }
  return key.toUpperCase();
};

/** Build a case-insensitive exact match regex for short attribute values like course/branch. */
const exactIRegex = (value) => {
  const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
};

const getActiveConnection = async () => {
  try {
    return getFeeManagementConnection();
  } catch {
    return connectFeeManagement();
  }
};

const enrichWithFeeHead = async (db, structures) => {
  const headIdStrings = [
    ...new Set(
      structures
        .map((doc) => doc.feeHead)
        .filter((id) => id !== undefined && id !== null && String(id).trim() !== '')
        .map((id) => String(id))
    ),
  ];
  if (headIdStrings.length === 0) {
    return structures.map((doc) => ({ ...doc, feeHeadDetails: null }));
  }

  // feestructures.feeHead is stored as a hex string, but feeheads._id is an ObjectId.
  // Build $in arrays of both shapes so we transparently match either schema.
  const objectIds = headIdStrings
    .map((id) => toObjectId(id))
    .filter((id) => id !== null);
  const heads = await db
    .collection('feeheads')
    .find({ _id: { $in: [...objectIds, ...headIdStrings] } })
    .toArray();
  const byId = new Map(heads.map((head) => [String(head._id), head]));

  return structures.map((doc) => {
    const head = doc.feeHead ? byId.get(String(doc.feeHead)) : null;
    return {
      ...doc,
      feeHeadDetails: head
        ? {
            _id: String(head._id),
            name: head.name || '',
            code: head.code || '',
            description: head.description || '',
          }
        : null,
    };
  });
};

const formatStructure = (doc) => ({
  _id: String(doc._id),
  id: String(doc._id),
  category: doc.category || '',
  course: doc.course || '',
  branch: doc.branch || '',
  college: doc.college || '',
  studentYear: doc.studentYear ?? null,
  semester: doc.semester ?? null,
  batch: doc.batch || '',
  amount: typeof doc.amount === 'number' ? doc.amount : Number(doc.amount) || 0,
  isScholarshipApplicable: Boolean(doc.isScholarshipApplicable),
  feeHead: doc.feeHead ? String(doc.feeHead) : null,
  feeHeadName: doc.feeHeadDetails?.name || '',
  feeHeadCode: doc.feeHeadDetails?.code || '',
  feeHeadDescription: doc.feeHeadDetails?.description || '',
  terms: Array.isArray(doc.terms)
    ? doc.terms.map((term) => ({
        termNumber: term.termNumber ?? null,
        percentage: term.percentage ?? null,
        amount: typeof term.amount === 'number' ? term.amount : Number(term.amount) || 0,
        lateFeeAmount:
          typeof term.lateFeeAmount === 'number'
            ? term.lateFeeAmount
            : Number(term.lateFeeAmount) || 0,
        dueOffsetDays: term.dueOffsetDays ?? null,
        dueDescription: term.dueDescription || '',
      }))
    : [],
  createdAt: doc.createdAt || null,
  updatedAt: doc.updatedAt || null,
});

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) return normalized;
  }
  return '';
};

const formatFeeHead = (doc) => ({
  _id: String(doc._id),
  id: String(doc._id),
  name: firstNonEmpty(doc.name, doc.feeHeadName, doc.headName, doc.title, doc.label),
  code: firstNonEmpty(doc.code, doc.feeHeadCode, doc.headCode, doc.shortCode),
  description: firstNonEmpty(doc.description, doc.feeHeadDescription, doc.headDescription),
  createdAt: doc.createdAt || null,
  updatedAt: doc.updatedAt || null,
});

/**
 * GET /api/fee-structures
 * Filters: course, branch, category (or quota), batch, studentYear, college
 * Returns: list of fee structures with the matching feeHead joined.
 */
export const listFeeStructures = async (req, res) => {
  try {
    const conn = await getActiveConnection();
    const db = conn.db;
    const query = {};

    const courseRaw = normalize(req.query.course);
    const branchRawInput = normalize(req.query.branch);
    const branchRaw = branchRawInput
      ? await resolveFeePortalBranchLabel({
          branchLabel: branchRawInput,
          courseLabel: mapCourseLabel(courseRaw || ''),
        })
      : '';
    const collegeRaw = normalize(req.query.college);
    const batchRaw = normalize(req.query.batch);
    const studentYearRaw = normalize(req.query.studentYear);
    let categoryRaw = normalize(req.query.category);
    if (!categoryRaw && req.query.quota) {
      categoryRaw = mapQuotaToCategory(req.query.quota);
    }

    if (courseRaw) query.course = exactIRegex(mapCourseLabel(courseRaw));
    if (branchRaw) query.branch = exactIRegex(branchRaw);
    if (collegeRaw) query.college = exactIRegex(collegeRaw);
    if (batchRaw) query.batch = String(batchRaw);
    if (categoryRaw) query.category = exactIRegex(categoryRaw);
    if (studentYearRaw && !Number.isNaN(Number(studentYearRaw))) {
      query.studentYear = Number(studentYearRaw);
    }

    const docs = await db
      .collection('feestructures')
      .find(query)
      .sort({ studentYear: 1, batch: 1, category: 1 })
      .toArray();

    const enriched = await enrichWithFeeHead(db, docs);
    const payload = enriched.map(formatStructure);

    return successResponse(res, {
      data: payload,
      filters: {
        course: courseRaw || null,
        branch: branchRaw || null,
        branchInput: branchRawInput || null,
        college: collegeRaw || null,
        batch: batchRaw || null,
        category: categoryRaw || null,
        studentYear: studentYearRaw ? Number(studentYearRaw) : null,
      },
      total: payload.length,
    });
  } catch (error) {
    console.error('listFeeStructures error:', error);
    return errorResponse(res, error.message || 'Failed to fetch fee structures', 500);
  }
};

/** GET /api/fee-structures/fee-heads — all fee head master rows from Fee Management. */
export const listFeeHeads = async (_req, res) => {
  try {
    const conn = await getActiveConnection();
    const db = conn.db;
    const docs = await db
      .collection('feeheads')
      .find({})
      .sort({ code: 1, feeHeadCode: 1, name: 1, feeHeadName: 1 })
      .toArray();

    const payload = docs
      .map(formatFeeHead)
      .filter((head) => head.id && (head.name || head.code));
    return successResponse(res, {
      data: payload,
      total: payload.length,
    });
  } catch (error) {
    console.error('listFeeHeads error:', error);
    return errorResponse(res, error.message || 'Failed to fetch fee heads', 500);
  }
};

/** GET /api/fee-structures/options — distinct dropdown values for the admin UI. */
export const listFeeStructureOptions = async (_req, res) => {
  try {
    const conn = await getActiveConnection();
    const db = conn.db;
    const [courses, branches, categories, batches, colleges, years] = await Promise.all([
      db.collection('feestructures').distinct('course'),
      db.collection('feestructures').distinct('branch'),
      db.collection('feestructures').distinct('category'),
      db.collection('feestructures').distinct('batch'),
      db.collection('feestructures').distinct('college'),
      db.collection('feestructures').distinct('studentYear'),
    ]);
    return successResponse(res, {
      courses: courses.filter(Boolean).sort(),
      branches: branches.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      batches: batches.filter(Boolean).sort(),
      colleges: colleges.filter(Boolean).sort(),
      studentYears: years.filter((y) => y != null).sort((a, b) => a - b),
    });
  } catch (error) {
    console.error('listFeeStructureOptions error:', error);
    return errorResponse(res, error.message || 'Failed to fetch fee structure options', 500);
  }
};
