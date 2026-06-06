import mongoose from 'mongoose';
import {
  connectHostel,
  getHostelConnection,
} from '../config-mongo/hostel.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const { Types: { ObjectId } } = mongoose;

const getActiveConnection = async () => {
  try {
    return getHostelConnection();
  } catch {
    return connectHostel();
  }
};

const toObjectId = (value) => {
  if (value instanceof ObjectId) return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
};

const toObjectIdOrString = (value) => {
  const oid = toObjectId(value);
  return oid || String(value || '').trim();
};

/** Match Mongo refs stored as ObjectId or plain string. */
const refMatch = (value) => {
  const raw = String(value || '').trim();
  const oid = toObjectId(raw);
  const keys = new Set([raw]);
  if (oid) keys.add(oid);
  return { $in: [...keys] };
};

const normalizeAcademicYear = (value) => String(value || '').trim();

const compareAcademicYearsDesc = (a, b) => normalizeAcademicYear(b).localeCompare(normalizeAcademicYear(a));

const formatFeeDoc = (doc) => ({
  _id: String(doc._id),
  amount: doc.amount ?? null,
  course: doc.course || '',
  academicYear: doc.academicYear || '',
  studentYear:
    doc.studentYear !== undefined && doc.studentYear !== null
      ? Number(doc.studentYear)
      : null,
  description: doc.description || '',
});

const findHostelFeeDocs = async (db, { hostelId, categoryId, academicYear, course }) => {
  const baseQuery = {
    hostel: refMatch(hostelId),
    category: refMatch(categoryId),
  };

  const courseName = String(course || '').trim();
  const normalizedYear = normalizeAcademicYear(academicYear);

  const queryWithFilters = (yearFilter, courseFilter) => {
    const query = { ...baseQuery };
    if (yearFilter) query.academicYear = yearFilter;
    if (courseFilter) query.course = courseFilter;
    return query;
  };

  const courseRegex = courseName
    ? new RegExp(`^${escapeRegex(courseName)}$`, 'i')
    : null;

  const attempts = [];

  if (normalizedYear && courseRegex) {
    attempts.push(queryWithFilters(normalizedYear, courseRegex));
  }
  if (normalizedYear) {
    attempts.push(queryWithFilters(normalizedYear, null));
  }
  if (courseRegex) {
    attempts.push(queryWithFilters(null, courseRegex));
  }
  attempts.push(baseQuery);

  for (const query of attempts) {
    const docs = await db.collection('hostelfeestructures').find(query).toArray();
    if (docs.length > 0) {
      const resolved = normalizeAcademicYear(
        docs.find((doc) => normalizeAcademicYear(doc.academicYear))?.academicYear ||
          docs[0]?.academicYear ||
          normalizedYear ||
          ''
      );
      return {
        docs,
        resolvedAcademicYear: resolved,
        matchedBy:
          normalizedYear && resolved && resolved !== normalizedYear ? 'fallback' : 'exact',
      };
    }
  }

  return { docs: [], resolvedAcademicYear: normalizedYear, matchedBy: 'none' };
};

const deriveHostelType = (name) => {
  const normalized = String(name || '').trim().toLowerCase();
  if (normalized.includes('girl')) return 'girls';
  if (normalized.includes('boy')) return 'boys';
  return 'other';
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GET /api/hostel/academic-years */
export const listHostelAcademicYears = async (_req, res) => {
  try {
    const db = (await getActiveConnection()).db;
    const [fromFees, fromCalendar] = await Promise.all([
      db.collection('hostelfeestructures').distinct('academicYear'),
      db.collection('academiccalendars').distinct('academicYear'),
    ]);
    const feeYears = [...new Set(fromFees.filter(Boolean))]
      .map((year) => String(year).trim())
      .filter(Boolean)
      .sort(compareAcademicYearsDesc);
    const calendarYears = [...new Set(fromCalendar.filter(Boolean))]
      .map((year) => String(year).trim())
      .filter(Boolean)
      .sort(compareAcademicYearsDesc);

    // Prefer years that actually have fee structures configured.
    const years = [...new Set([...feeYears, ...calendarYears])].sort(compareAcademicYearsDesc);

    return successResponse(res, { data: years, total: years.length });
  } catch (error) {
    console.error('listHostelAcademicYears error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel academic years', 500);
  }
};

/** GET /api/hostel/hostels */
export const listHostels = async (_req, res) => {
  try {
    const db = (await getActiveConnection()).db;
    const hostels = await db
      .collection('hostels')
      .find({ isActive: { $ne: false } })
      .sort({ name: 1 })
      .toArray();

    return successResponse(res, {
      data: hostels.map((hostel) => ({
        _id: String(hostel._id),
        name: hostel.name || '',
        type: deriveHostelType(hostel.name),
        description: hostel.description || '',
      })),
      total: hostels.length,
    });
  } catch (error) {
    console.error('listHostels error:', error);
    return errorResponse(res, error.message || 'Failed to load hostels', 500);
  }
};

/** GET /api/hostel/categories?hostelId= */
export const listHostelCategories = async (req, res) => {
  try {
    const hostelId = String(req.query.hostelId || '').trim();
    if (!hostelId) {
      return errorResponse(res, 'hostelId is required', 400);
    }

    const db = (await getActiveConnection()).db;
    const hostelKey = toObjectIdOrString(hostelId);
    const categories = await db
      .collection('hostelcategories')
      .find({
        hostel: hostelKey,
        isActive: { $ne: false },
      })
      .sort({ name: 1 })
      .toArray();

    return successResponse(res, {
      data: categories.map((category) => ({
        _id: String(category._id),
        name: category.name || '',
        description: category.description || '',
        hostelId: String(category.hostel),
      })),
      total: categories.length,
    });
  } catch (error) {
    console.error('listHostelCategories error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel categories', 500);
  }
};

const loadRoomOccupancyMap = async (db, roomIds) => {
  if (!roomIds.length) return new Map();
  const objectIds = roomIds.map((id) => toObjectId(id)).filter(Boolean);
  const idStrings = roomIds.map((id) => String(id));
  const rows = await db
    .collection('users')
    .aggregate([
      {
        $match: {
          role: 'student',
          hostelStatus: { $in: ['Active', 'active', 'ACTIVE'] },
          room: { $in: [...objectIds, ...idStrings] },
        },
      },
      { $group: { _id: '$room', occupiedBeds: { $sum: 1 } } },
    ])
    .toArray();

  const map = new Map();
  for (const row of rows) {
    map.set(String(row._id), Number(row.occupiedBeds) || 0);
  }
  return map;
};

const resolveHostelFeesByYear = async (
  db,
  { hostelId, categoryId, academicYear, course, totalYears = 4 }
) => {
  const { docs, resolvedAcademicYear, matchedBy } = await findHostelFeeDocs(db, {
    hostelId,
    categoryId,
    academicYear,
    course,
  });

  if (docs.length === 0) {
    return { yearlyFees: [], flatFee: null, resolvedAcademicYear: '', matchedBy: 'none' };
  }

  const byYear = new Map();
  let flatDoc = null;
  let defaultAmountDoc = null;

  for (const doc of docs) {
    const formatted = formatFeeDoc(doc);
    const studentYear = formatted.studentYear;

    if (studentYear != null && Number.isFinite(studentYear) && studentYear > 0) {
      byYear.set(studentYear, formatted);
      if (!defaultAmountDoc) defaultAmountDoc = formatted;
      continue;
    }

    if (!flatDoc) flatDoc = formatted;
    if (!defaultAmountDoc) defaultAmountDoc = formatted;
  }

  const years = Math.max(1, Math.trunc(Number(totalYears)) || 4);
  const yearlyFees = [];

  for (let studentYear = 1; studentYear <= years; studentYear += 1) {
    const specific = byYear.get(studentYear);
    if (specific) {
      yearlyFees.push({ ...specific, studentYear });
      continue;
    }

    if (flatDoc) {
      yearlyFees.push({ ...flatDoc, studentYear });
      continue;
    }

    const configuredYears = [...byYear.keys()].sort((a, b) => a - b);
    if (configuredYears.length > 0) {
      const nearestYear =
        configuredYears.find((year) => year >= studentYear) ??
        configuredYears[configuredYears.length - 1];
      const nearest = byYear.get(nearestYear);
      if (nearest) {
        yearlyFees.push({ ...nearest, studentYear });
      }
    }
  }

  return {
    yearlyFees,
    flatFee: flatDoc || defaultAmountDoc,
    resolvedAcademicYear,
    matchedBy,
  };
};

/** @deprecated single-fee helper — prefer resolveHostelFeesByYear */
const resolveHostelFee = async (db, params) => {
  const { yearlyFees, flatFee } = await resolveHostelFeesByYear(db, params);
  if (yearlyFees.length > 0) {
    return yearlyFees[0];
  }
  return flatFee;
};

/** GET /api/hostel/rooms?hostelId=&categoryId=&academicYear=&course=&totalYears= */
export const listHostelRooms = async (req, res) => {
  try {
    const hostelId = String(req.query.hostelId || '').trim();
    const categoryId = String(req.query.categoryId || '').trim();
    const academicYear = String(req.query.academicYear || '').trim();
    const course = String(req.query.course || '').trim();
    const totalYears = Math.min(
      8,
      Math.max(1, parseInt(String(req.query.totalYears || '4'), 10) || 4)
    );

    if (!hostelId || !categoryId) {
      return errorResponse(res, 'hostelId and categoryId are required', 400);
    }

    const db = (await getActiveConnection()).db;
    const rooms = await db
      .collection('rooms')
      .find({
        hostel: refMatch(hostelId),
        category: refMatch(categoryId),
        isActive: { $ne: false },
      })
      .sort({ roomNumber: 1 })
      .toArray();

    const occupancyMap = await loadRoomOccupancyMap(
      db,
      rooms.map((room) => String(room._id))
    );

    const feeResult = academicYear
      ? await resolveHostelFeesByYear(db, {
          hostelId,
          categoryId,
          academicYear,
          course,
          totalYears,
        })
      : { yearlyFees: [], flatFee: null, resolvedAcademicYear: '', matchedBy: 'none' };

    const formattedRooms = rooms.map((room) => {
      const bedCount = Number(room.bedCount) || 0;
      const occupiedBeds = occupancyMap.get(String(room._id)) || 0;
      const availableBeds = Math.max(bedCount - occupiedBeds, 0);
      return {
        _id: String(room._id),
        roomNumber: room.roomNumber || '',
        bedCount,
        occupiedBeds,
        availableBeds,
        isAvailable: availableBeds > 0,
        hostelId: String(room.hostel),
        categoryId: String(room.category),
      };
    });

    return successResponse(res, {
      data: {
        rooms: formattedRooms,
        yearlyFees: feeResult.yearlyFees,
        fee: feeResult.yearlyFees[0] || feeResult.flatFee,
        resolvedAcademicYear: feeResult.resolvedAcademicYear || academicYear,
        feeMatchedBy: feeResult.matchedBy || 'none',
        total: formattedRooms.length,
        availableCount: formattedRooms.filter((room) => room.isAvailable).length,
      },
    });
  } catch (error) {
    console.error('listHostelRooms error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel rooms', 500);
  }
};

/** GET /api/hostel/fee?hostelId=&categoryId=&academicYear=&course= */
export const getHostelFee = async (req, res) => {
  try {
    const hostelId = String(req.query.hostelId || '').trim();
    const categoryId = String(req.query.categoryId || '').trim();
    const academicYear = String(req.query.academicYear || '').trim();
    const course = String(req.query.course || '').trim();
    const totalYears = Math.min(
      8,
      Math.max(1, parseInt(String(req.query.totalYears || '4'), 10) || 4)
    );

    if (!hostelId || !categoryId || !academicYear) {
      return errorResponse(res, 'hostelId, categoryId, and academicYear are required', 400);
    }

    const db = (await getActiveConnection()).db;
    const feeResult = await resolveHostelFeesByYear(db, {
      hostelId,
      categoryId,
      academicYear,
      course,
      totalYears,
    });

    if (feeResult.yearlyFees.length === 0) {
      return errorResponse(res, 'Hostel fee not configured for this selection', 404);
    }

    return successResponse(res, {
      data: {
        yearlyFees: feeResult.yearlyFees,
        fee: feeResult.yearlyFees[0] || feeResult.flatFee,
        resolvedAcademicYear: feeResult.resolvedAcademicYear || academicYear,
        feeMatchedBy: feeResult.matchedBy || 'none',
      },
    });
  } catch (error) {
    console.error('getHostelFee error:', error);
    return errorResponse(res, error.message || 'Failed to load hostel fee', 500);
  }
};
