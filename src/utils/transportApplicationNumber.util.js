/**
 * Transport passenger application numbers per academic year, college, and course.
 * Format: {COLLEGE_CODE}-{COURSE_CODE}-0001 (e.g. PCE-BTECH-0001).
 * Mirrors PydahTransport/backend/utils/transportApplicationNumber.js
 */

import { getTableColumnSet } from './secondarySchema.util.js';

const CODE_FALLBACK = 'UNK';

export function normalizeTransportCodePart(value, fallback = CODE_FALLBACK) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return fallback;
  const normalized = raw.replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  return normalized || fallback;
}

export function formatTransportApplicationNumber(collegeCode, courseCode, serial) {
  const college = normalizeTransportCodePart(collegeCode);
  const course = normalizeTransportCodePart(courseCode);
  return `${college}-${course}-${String(serial).padStart(4, '0')}`;
}

export function parseTransportApplicationNumber(applicationNumber) {
  const raw = String(applicationNumber ?? '').trim();
  const match = raw.match(/^([A-Z0-9]+)-([A-Z0-9]+)-(\d{4})$/i);
  if (!match) return null;
  return {
    collegeCode: normalizeTransportCodePart(match[1]),
    courseCode: normalizeTransportCodePart(match[2]),
    serial: Number(match[3]),
  };
}

export function transportApplicationScopeMatches(applicationNumber, collegeCode, courseCode) {
  const parsed = parseTransportApplicationNumber(applicationNumber);
  if (!parsed) return false;
  return (
    parsed.collegeCode === normalizeTransportCodePart(collegeCode) &&
    parsed.courseCode === normalizeTransportCodePart(courseCode)
  );
}

/**
 * Resolve college/course codes from secondary `courses` + `colleges` using managed course id
 * and/or explicit college id from registration extras.
 */
export async function resolveTransportApplicationCodes(mysqlPool, {
  managedCourseId = null,
  collegeId = null,
  courseName = null,
  collegeName = null,
} = {}) {
  let resolvedCollegeId = collegeId != null && String(collegeId).trim() !== ''
    ? Number.parseInt(String(collegeId).trim(), 10)
    : null;
  let courseCode = null;

  const courseId = Number.parseInt(String(managedCourseId ?? '').trim(), 10);
  if (Number.isFinite(courseId)) {
    const [courseRows] = await mysqlPool.execute(
      'SELECT code, college_id, name FROM courses WHERE id = ? LIMIT 1',
      [courseId]
    );
    if (courseRows.length > 0) {
      courseCode = courseRows[0].code || courseRows[0].name;
      if (!Number.isFinite(resolvedCollegeId) && courseRows[0].college_id != null) {
        resolvedCollegeId = Number.parseInt(String(courseRows[0].college_id), 10);
      }
    }
  }

  if (!courseCode && courseName) {
    const params = [String(courseName).trim()];
    let sql = 'SELECT code, college_id FROM courses WHERE name = ?';
    if (Number.isFinite(resolvedCollegeId)) {
      sql += ' AND college_id = ?';
      params.push(resolvedCollegeId);
    }
    sql += ' LIMIT 1';
    const [courseRows] = await mysqlPool.execute(sql, params);
    if (courseRows.length > 0) {
      courseCode = courseRows[0].code || courseName;
      if (!Number.isFinite(resolvedCollegeId) && courseRows[0].college_id != null) {
        resolvedCollegeId = Number.parseInt(String(courseRows[0].college_id), 10);
      }
    }
  }

  let collegeCode = null;
  if (Number.isFinite(resolvedCollegeId)) {
    const collegeCols = await getTableColumnSet(mysqlPool, 'colleges');
    const selectCols = collegeCols.has('code') ? 'code, name' : 'name';
    const [collegeRows] = await mysqlPool.execute(
      `SELECT ${selectCols} FROM colleges WHERE id = ? LIMIT 1`,
      [resolvedCollegeId]
    );
    if (collegeRows.length > 0) {
      collegeCode = collegeRows[0].code || collegeRows[0].name;
    }
  }

  if (!collegeCode && collegeName) {
    const collegeCols = await getTableColumnSet(mysqlPool, 'colleges');
    const hasCode = collegeCols.has('code');
    const [collegeRows] = await mysqlPool.execute(
      hasCode
        ? 'SELECT code, name FROM colleges WHERE name = ? OR code = ? LIMIT 1'
        : 'SELECT name FROM colleges WHERE name = ? LIMIT 1',
      hasCode
        ? [String(collegeName).trim(), String(collegeName).trim()]
        : [String(collegeName).trim()]
    );
    if (collegeRows.length > 0) {
      collegeCode = collegeRows[0].code || collegeRows[0].name;
    }
  }

  return {
    collegeCode: normalizeTransportCodePart(collegeCode),
    courseCode: normalizeTransportCodePart(courseCode || courseName),
  };
}

/**
 * Resolve codes for CRM joining sync — prefers managed course id + registration college id.
 */
export async function resolveTransportApplicationCodesForJoining(mysqlPool, joiningContext = {}) {
  const collegeId =
    joiningContext.collegeId ??
    joiningContext.college_id ??
    joiningContext.school_or_college_id ??
    null;
  const managedCourseId =
    joiningContext.managedCourseId ??
    joiningContext.managed_course_id ??
    null;

  return resolveTransportApplicationCodes(mysqlPool, {
    managedCourseId,
    collegeId,
    courseName: joiningContext.course || null,
    collegeName: joiningContext.collegeName || joiningContext.college || null,
  });
}

async function ensureTransportApplicationCounterRow(connection, academicYear, collegeCode, courseCode) {
  const college = normalizeTransportCodePart(collegeCode);
  const course = normalizeTransportCodePart(courseCode);

  await connection.query(
    `INSERT INTO transport_application_counters (academic_year, college_code, course_code, last_serial)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE academic_year = academic_year`,
    [academicYear, college, course]
  );

  const [counterRows] = await connection.query(
    `SELECT last_serial FROM transport_application_counters
     WHERE academic_year = ? AND college_code = ? AND course_code = ?
     FOR UPDATE`,
    [academicYear, college, course]
  );

  const counterSerial = Number(counterRows[0]?.last_serial || 0);
  const requestsMaxSerial = await getMaxTransportApplicationSerialFromRequests(
    connection,
    academicYear,
    college,
    course
  );
  const lastSerial = Math.max(counterSerial, requestsMaxSerial);

  if (lastSerial > counterSerial) {
    await connection.query(
      `UPDATE transport_application_counters
       SET last_serial = ?
       WHERE academic_year = ? AND college_code = ? AND course_code = ?`,
      [lastSerial, academicYear, college, course]
    );
  }

  return {
    collegeCode: college,
    courseCode: course,
    lastSerial,
  };
}

/** Highest assigned serial already stored on transport_requests for this AY + college + course. */
export async function getMaxTransportApplicationSerialFromRequests(
  mysqlPool,
  academicYear,
  collegeCode,
  courseCode
) {
  const college = normalizeTransportCodePart(collegeCode);
  const course = normalizeTransportCodePart(courseCode);

  const [rows] = await mysqlPool.query(
    `SELECT application_number, application_serial
     FROM transport_requests
     WHERE academic_year = ?
       AND application_number IS NOT NULL
       AND TRIM(application_number) != ''`,
    [academicYear]
  );

  let maxSerial = 0;
  for (const row of rows) {
    if (!transportApplicationScopeMatches(row.application_number, college, course)) continue;
    const parsed = parseTransportApplicationNumber(row.application_number);
    const serial =
      row.application_serial != null && Number.isFinite(Number(row.application_serial))
        ? Number(row.application_serial)
        : parsed?.serial;
    if (Number.isFinite(serial) && serial > maxSerial) {
      maxSerial = serial;
    }
  }
  return maxSerial;
}

export async function assignTransportApplicationNumber(
  mysqlPool,
  academicYear,
  collegeCode,
  courseCode,
  existingApplicationNumber = null,
  existingApplicationSerial = null
) {
  if (!academicYear) {
    throw new Error('Academic year is required to generate a transport application number.');
  }
  if (!collegeCode || !courseCode) {
    throw new Error('College code and course code are required to generate a transport application number.');
  }

  if (
    existingApplicationNumber &&
    transportApplicationScopeMatches(existingApplicationNumber, collegeCode, courseCode)
  ) {
    const parsed = parseTransportApplicationNumber(existingApplicationNumber);
    return {
      application_number: existingApplicationNumber,
      application_serial:
        existingApplicationSerial != null
          ? Number(existingApplicationSerial)
          : parsed?.serial ?? null,
      college_code: normalizeTransportCodePart(collegeCode),
      course_code: normalizeTransportCodePart(courseCode),
    };
  }

  const connection = await mysqlPool.getConnection();
  try {
    await connection.beginTransaction();

    const counter = await ensureTransportApplicationCounterRow(
      connection,
      academicYear,
      collegeCode,
      courseCode
    );
    const nextSerial = counter.lastSerial + 1;

    await connection.query(
      `UPDATE transport_application_counters
       SET last_serial = ?
       WHERE academic_year = ? AND college_code = ? AND course_code = ?`,
      [nextSerial, academicYear, counter.collegeCode, counter.courseCode]
    );

    await connection.commit();

    return {
      application_number: formatTransportApplicationNumber(
        counter.collegeCode,
        counter.courseCode,
        nextSerial
      ),
      application_serial: nextSerial,
      college_code: counter.collegeCode,
      course_code: counter.courseCode,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Read-only preview of the next serial for an academic year + college + course. */
export async function peekNextTransportApplicationNumber(
  mysqlPool,
  academicYear,
  collegeCode,
  courseCode
) {
  if (!academicYear) {
    throw new Error('Academic year is required to preview a transport application number.');
  }
  if (!collegeCode || !courseCode) {
    throw new Error('College code and course code are required to preview a transport application number.');
  }

  const college = normalizeTransportCodePart(collegeCode);
  const course = normalizeTransportCodePart(courseCode);

  const [counterRows] = await mysqlPool.query(
    `SELECT last_serial FROM transport_application_counters
     WHERE academic_year = ? AND college_code = ? AND course_code = ?
     LIMIT 1`,
    [academicYear, college, course]
  );

  const counterSerial = Number(counterRows[0]?.last_serial || 0);
  const requestsMaxSerial = await getMaxTransportApplicationSerialFromRequests(
    mysqlPool,
    academicYear,
    college,
    course
  );
  const nextSerial = Math.max(counterSerial, requestsMaxSerial) + 1;

  return {
    application_number: formatTransportApplicationNumber(college, course, nextSerial),
    application_serial: nextSerial,
    academic_year: academicYear,
    college_code: college,
    course_code: course,
  };
}

export function getDefaultTransportAcademicYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (month >= 6) {
    return `${year}-${year + 1}`;
  }
  return `${year - 1}-${year}`;
}

/** Step 1 / CRM intake calendar year (e.g. 2026) from batch or transport details. */
export function normalizeCalendarAcademicYear(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})/);
  if (match) return match[1];
  return raw;
}

export function batchToCalendarAcademicYear(batch) {
  const fromBatch = normalizeCalendarAcademicYear(batch);
  if (fromBatch) return fromBatch;
  return String(new Date().getFullYear());
}

export function calendarYearToAcademicYearSession(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{4}$/.test(raw)) return raw;
  const cal = normalizeCalendarAcademicYear(raw);
  if (cal && /^\d{4}$/.test(cal)) {
    return `${cal}-${Number(cal) + 1}`;
  }
  return raw;
}

export function resolveTransportAcademicYear(transportDetails, batch) {
  const fromTransport = String(
    transportDetails?.academicYear || transportDetails?.academic_year || ''
  ).trim();
  if (fromTransport) return calendarYearToAcademicYearSession(fromTransport);
  return calendarYearToAcademicYearSession(batchToCalendarAcademicYear(batch));
}

/** Fee catalog + tuition rows in `studentfees` use calendar intake year (e.g. 2026), not session. */
export function resolveFeeCatalogBatchYear(batch, resolvedBatch) {
  return normalizeCalendarAcademicYear(resolvedBatch || batch || '');
}
