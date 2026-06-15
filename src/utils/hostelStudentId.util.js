import mongoose from 'mongoose';
import { calendarYearToAcademicYearSession } from './transportApplicationNumber.util.js';

const { Types: { ObjectId } } = mongoose;

const toObjectIdOrString = (value) => {
  const raw = String(value || '').trim();
  if (/^[a-fA-F0-9]{24}$/.test(raw)) {
    try {
      return new ObjectId(raw);
    } catch {
      return raw;
    }
  }
  return raw;
};

/** Hostel CMS format: BH26001 / GH25015 — prefix + 2-digit year + 3-digit serial. */
export function academicYearToHostelIdYearSuffix(academicYear) {
  const session = calendarYearToAcademicYearSession(academicYear);
  const match = String(session || '').match(/^(\d{4})/);
  if (match) return match[1].slice(-2);
  const cal = String(academicYear || '').match(/^(\d{4})/);
  if (cal) return cal[1].slice(-2);
  return String(new Date().getFullYear()).slice(-2);
}

export function resolveHostelTypePrefix(hostelName, gender = '') {
  const name = String(hostelName || '').trim().toLowerCase();
  if (name.includes('girl')) return 'GH';
  if (name.includes('boy')) return 'BH';
  const g = String(gender || '').trim().toLowerCase();
  if (g.startsWith('f')) return 'GH';
  if (g.startsWith('m')) return 'BH';
  return 'OH';
}

export function formatHostelStudentId(prefix, yearSuffix, serial) {
  return `${prefix}${yearSuffix}${String(serial).padStart(3, '0')}`;
}

export function buildHostelCounterKey(prefix, yearSuffix) {
  return `hostel_${prefix}${yearSuffix}`;
}

export function isValidHostelStudentId(value) {
  return /^[A-Z]{2}\d{5}$/i.test(String(value || '').trim());
}

export function hostelStudentIdScopeMatches(existingHostelId, prefix, yearSuffix) {
  const raw = String(existingHostelId || '').trim().toUpperCase();
  if (!isValidHostelStudentId(raw)) return false;
  return raw.startsWith(`${prefix}${yearSuffix}`);
}

/**
 * Assign the next hostel student id from HMS `counters` (hostel_BH26, hostel_GH26, …).
 */
export async function assignHostelStudentId(db, {
  hostelObjectId,
  academicYear,
  gender = '',
  existingHostelId = null,
}) {
  const yearSuffix = academicYearToHostelIdYearSuffix(academicYear);
  if (!yearSuffix) {
    throw new Error('Academic year is required to generate a hostel student id.');
  }
  if (!hostelObjectId) {
    throw new Error('Hostel is required to generate a hostel student id.');
  }

  const hostelDoc = await db.collection('hostels').findOne({
    _id: toObjectIdOrString(hostelObjectId),
  });
  const prefix = resolveHostelTypePrefix(hostelDoc?.name, gender);

  const normalizedExisting = String(existingHostelId || '').trim();
  if (
    isValidHostelStudentId(normalizedExisting) &&
    hostelStudentIdScopeMatches(normalizedExisting, prefix, yearSuffix)
  ) {
    return {
      hostelId: normalizedExisting.toUpperCase(),
      assigned: false,
      reusedExisting: true,
      prefix,
      yearSuffix,
    };
  }

  const counterKey = buildHostelCounterKey(prefix, yearSuffix);
  const counterResult = await db.collection('counters').findOneAndUpdate(
    { _id: counterKey },
    {
      $inc: { sequence: 1 },
      $set: { updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), __v: 0 },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const counterDoc = counterResult?.value ?? counterResult;
  const sequence = Number(counterDoc?.sequence);
  if (!Number.isFinite(sequence) || sequence <= 0) {
    throw new Error(`Failed to increment hostel counter ${counterKey}`);
  }

  return {
    hostelId: formatHostelStudentId(prefix, yearSuffix, sequence),
    assigned: true,
    reusedExisting: false,
    counterKey,
    sequence,
    prefix,
    yearSuffix,
  };
}

/** Read-only preview of the next hostel student id for a hostel + academic year. */
export async function peekNextHostelStudentId(db, {
  hostelObjectId,
  academicYear,
  gender = '',
}) {
  const yearSuffix = academicYearToHostelIdYearSuffix(academicYear);
  if (!yearSuffix || !hostelObjectId) {
    throw new Error('Hostel and academic year are required to preview a hostel student id.');
  }

  const hostelDoc = await db.collection('hostels').findOne({
    _id: toObjectIdOrString(hostelObjectId),
  });
  const prefix = resolveHostelTypePrefix(hostelDoc?.name, gender);
  const counterKey = buildHostelCounterKey(prefix, yearSuffix);
  const counterDoc = await db.collection('counters').findOne({ _id: counterKey });
  const nextSerial = Number(counterDoc?.sequence || 0) + 1;

  return {
    hostelId: formatHostelStudentId(prefix, yearSuffix, nextSerial),
    counterKey,
    sequence: nextSerial,
    prefix,
    yearSuffix,
  };
}
