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

/** Helper to find the maximum sequential ID serial already assigned to HostelRequests in this academic year. */
export async function getMaxHostelSequenceSerialFromRequests(db, { prefix, academicYear }) {
  try {
    const query = {
      academicYear,
      hostelSequenceId: new RegExp(`^${prefix}\\d+`, 'i'),
    };

    const requests = await db.collection('hostelrequests')
      .find(query, { projection: { hostelSequenceId: 1 } })
      .toArray();

    let maxSerial = 0;
    for (const req of requests) {
      const seqId = String(req.hostelSequenceId || '').trim();
      const numPart = seqId.slice(prefix.length);
      const num = parseInt(numPart, 10);
      if (Number.isFinite(num) && num > maxSerial) {
        maxSerial = num;
      }
    }
    return maxSerial;
  } catch (err) {
    console.warn('[hostelStudentId] Failed to query max serial from requests:', err);
    return 0;
  }
}

/**
 * Assign the next hostel student id.
 * Supports new canonical format (e.g. PCEBTECHBH001) if collegeCode + courseCode are passed.
 */
export async function assignHostelStudentId(db, {
  hostelObjectId,
  academicYear,
  gender = '',
  existingHostelId = null,
  collegeCode = '',
  courseCode = '',
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

  let finalPrefix = prefix;
  let finalYearSuffix = yearSuffix;
  let finalFormat = 'legacy';

  if (collegeCode && courseCode) {
    const cleanCollege = String(collegeCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanCourse = String(courseCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    finalPrefix = `${cleanCollege}${cleanCourse}${prefix}`;
    finalYearSuffix = '';
    finalFormat = 'new';
  }

  const normalizedExisting = String(existingHostelId || '').trim();
  const isExistingValid = finalFormat === 'new'
    ? new RegExp(`^${finalPrefix}\\d{3}$`, 'i').test(normalizedExisting)
    : isValidHostelStudentId(normalizedExisting) && hostelStudentIdScopeMatches(normalizedExisting, finalPrefix, finalYearSuffix);

  if (isExistingValid) {
    const numPart = normalizedExisting.slice(finalPrefix.length);
    const sequence = parseInt(numPart, 10) || 0;
    return {
      hostelId: normalizedExisting.toUpperCase(),
      assigned: false,
      reusedExisting: true,
      prefix: finalPrefix,
      yearSuffix: finalYearSuffix,
      sequence,
    };
  }

  const searchPrefix = finalPrefix + finalYearSuffix;
  const requestsMaxSerial = await getMaxHostelSequenceSerialFromRequests(db, {
    prefix: searchPrefix,
    academicYear,
  });

  const nextSerial = requestsMaxSerial + 1;

  const generatedId = finalFormat === 'new'
    ? `${finalPrefix}${String(nextSerial).padStart(3, '0')}`
    : formatHostelStudentId(finalPrefix, finalYearSuffix, nextSerial);

  return {
    hostelId: generatedId,
    assigned: true,
    reusedExisting: false,
    prefix: finalPrefix,
    yearSuffix: finalYearSuffix,
    sequence: nextSerial,
  };
}

/** Read-only preview of the next hostel student id. Supports collegeCode and courseCode parameters. */
export async function peekNextHostelStudentId(db, {
  hostelObjectId,
  academicYear,
  gender = '',
  collegeCode = '',
  courseCode = '',
}) {
  const yearSuffix = academicYearToHostelIdYearSuffix(academicYear);
  if (!yearSuffix || !hostelObjectId) {
    throw new Error('Hostel and academic year are required to preview a hostel student id.');
  }

  const hostelDoc = await db.collection('hostels').findOne({
    _id: toObjectIdOrString(hostelObjectId),
  });
  const prefix = resolveHostelTypePrefix(hostelDoc?.name, gender);

  let finalPrefix = prefix;
  let finalYearSuffix = yearSuffix;
  let finalFormat = 'legacy';

  if (collegeCode && courseCode) {
    const cleanCollege = String(collegeCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanCourse = String(courseCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    finalPrefix = `${cleanCollege}${cleanCourse}${prefix}`;
    finalYearSuffix = '';
    finalFormat = 'new';
  }

  const searchPrefix = finalPrefix + finalYearSuffix;
  const requestsMaxSerial = await getMaxHostelSequenceSerialFromRequests(db, {
    prefix: searchPrefix,
    academicYear,
  });

  const nextSerial = requestsMaxSerial + 1;

  const generatedId = finalFormat === 'new'
    ? `${finalPrefix}${String(nextSerial).padStart(3, '0')}`
    : formatHostelStudentId(finalPrefix, finalYearSuffix, nextSerial);

  return {
    hostelId: generatedId,
    prefix: finalPrefix,
    yearSuffix: finalYearSuffix,
    sequence: nextSerial,
  };
}
