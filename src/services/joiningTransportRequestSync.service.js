import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  assignTransportApplicationNumber,
  resolveTransportAcademicYear,
  resolveTransportApplicationCodesForJoining,
  transportApplicationScopeMatches,
} from '../utils/transportApplicationNumber.util.js';

const tableExistsCache = new Map();

async function secondaryHasTransportRequestsTable(pool) {
  if (tableExistsCache.has('transport_requests')) {
    return tableExistsCache.get('transport_requests');
  }
  try {
    const [rows] = await pool.execute("SHOW TABLES LIKE 'transport_requests'");
    const ok = rows.length > 0;
    tableExistsCache.set('transport_requests', ok);
    return ok;
  } catch {
    tableExistsCache.set('transport_requests', false);
    return false;
  }
}

async function findTransportRequestForYear(pool, admissionNumber, academicYear) {
  const [rows] = await pool.execute(
    `SELECT id, status, application_number, application_serial, academic_year
     FROM transport_requests
     WHERE admission_number = ?
       AND COALESCE(academic_year, ?) = ?
     ORDER BY request_date DESC
     LIMIT 1`,
    [admissionNumber, academicYear, academicYear]
  );
  return rows[0] || null;
}

/**
 * Upsert an approved student transport request in student_database.transport_requests
 * and assign a per-academic-year application number (0001, 0002, …).
 */
export async function syncJoiningBusToTransportRequestMysql({ joiningId, joiningContext, user = null }) {
  let pool;
  try {
    pool = getSecondaryPool();
  } catch (err) {
    console.warn('[joiningTransportRequestSync] Secondary DB unavailable:', err?.message || err);
    return { skipped: true, reason: 'Secondary DB unavailable' };
  }

  const hasTable = await secondaryHasTransportRequestsTable(pool);
  if (!hasTable) {
    return { skipped: true, reason: 'transport_requests table not found' };
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'bus') {
    return { skipped: true, reason: 'No bus accommodation on joining' };
  }
  if (!transport.routeId || !transport.stageId) {
    return { skipped: true, reason: 'Bus route or stage not selected' };
  }

  const admissionNumber = String(joiningContext.admissionNumber || '').trim();
  if (!admissionNumber) {
    return { skipped: true, reason: 'Admission number missing' };
  }

  const academicYear = resolveTransportAcademicYear(
    transport,
    joiningContext.intakeBatch || joiningContext.batch
  );
  const studentName = String(joiningContext.studentName || '').trim();
  const routeId = String(transport.routeId).trim();
  const routeName = String(transport.routeName || '').trim();
  const stageName = String(transport.stageName || '').trim();
  const fare = Number(transport.stageFare) || 0;
  const busId = String(
    transport.busId || transport.busNumber || transport.bus_id || ''
  ).trim() || null;

  const raisedBy = user?.name ? String(user.name).trim() : 'admissions_crm';
  const raisedById = user?.empNo != null && !Number.isNaN(Number(user.empNo)) ? Number(user.empNo) : null;

  const { collegeCode, courseCode } = await resolveTransportApplicationCodesForJoining(
    pool,
    joiningContext
  );

  const existing = await findTransportRequestForYear(pool, admissionNumber, academicYear);
  const existingNumberMatchesScope =
    existing?.application_number &&
    transportApplicationScopeMatches(existing.application_number, collegeCode, courseCode);

  if (existing?.status === 'approved' && existingNumberMatchesScope) {
    await pool.execute(
      `UPDATE transport_requests
       SET student_name = ?, route_id = ?, route_name = ?, stage_name = ?, fare = ?,
           bus_id = ?, academic_year = ?, raised_by = ?, raised_by_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [studentName, routeId, routeName, stageName, fare, busId, academicYear, raisedBy, raisedById, existing.id]
    );
    return {
      skipped: false,
      operation: 'update',
      requestId: existing.id,
      admissionNumber,
      academicYear,
      college_code: collegeCode,
      course_code: courseCode,
      bus_id: busId,
      application_number: existing.application_number,
      application_serial: existing.application_serial,
      joiningId,
    };
  }

  let requestId = existing?.id || null;

  if (!requestId) {
    const [studentRows] = await pool.execute(
      'SELECT current_year FROM students WHERE admission_number = ? OR admission_no = ? LIMIT 1',
      [admissionNumber, admissionNumber]
    );
    const yearOfStudy =
      studentRows[0]?.current_year != null ? Number(studentRows[0].current_year) : 1;

    const [insertResult] = await pool.execute(
      `INSERT INTO transport_requests
       (admission_number, student_name, route_id, route_name, stage_name, fare, bus_id,
        raised_by, raised_by_id, status, year_of_study, academic_year, request_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NOW(), NOW())`,
      [
        admissionNumber,
        studentName,
        routeId,
        routeName,
        stageName,
        fare,
        busId,
        raisedBy,
        raisedById,
        yearOfStudy,
        academicYear,
      ]
    );
    requestId = insertResult.insertId;
  } else {
    await pool.execute(
      `UPDATE transport_requests
       SET student_name = ?, route_id = ?, route_name = ?, stage_name = ?, fare = ?,
           bus_id = ?, academic_year = ?, raised_by = ?, raised_by_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [studentName, routeId, routeName, stageName, fare, busId, academicYear, raisedBy, raisedById, requestId]
    );
  }

  const application = await assignTransportApplicationNumber(
    pool,
    academicYear,
    collegeCode,
    courseCode,
    existingNumberMatchesScope ? existing.application_number : null,
    existingNumberMatchesScope ? (existing?.application_serial ?? null) : null
  );

  await pool.execute(
    `UPDATE transport_requests
     SET status = 'approved',
         bus_id = ?,
         application_number = ?,
         application_serial = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [busId, application.application_number, application.application_serial, requestId]
  );

  return {
    skipped: false,
    operation: existing ? 'approve-update' : 'insert-approve',
    requestId,
    admissionNumber,
    academicYear,
    college_code: collegeCode,
    course_code: courseCode,
    bus_id: busId,
    application_number: application.application_number,
    application_serial: application.application_serial,
    joiningId,
  };
}

/** Dry-run preview for transport_requests sync. */
export function previewJoiningTransportRequestSync({ joiningContext }) {
  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'bus') {
    return { skipped: true, reason: 'No bus accommodation on joining' };
  }
  if (!transport.routeId || !transport.stageId) {
    return { skipped: true, reason: 'Bus route or stage not selected' };
  }

  const admissionNumber = String(joiningContext.admissionNumber || '').trim();
  if (!admissionNumber) {
    return { skipped: true, reason: 'Admission number missing' };
  }

  const academicYear = resolveTransportAcademicYear(
    transport,
    joiningContext.intakeBatch || joiningContext.batch
  );

  return {
    skipped: false,
    database: 'student_database',
    table: 'transport_requests',
    operation: 'upsert-approved',
    document: {
      admission_number: admissionNumber,
      student_name: joiningContext.studentName || '',
      route_id: transport.routeId,
      route_name: transport.routeName || '',
      stage_name: transport.stageName || '',
      fare: Number(transport.stageFare) || 0,
      bus_id:
        transport.busId || transport.busNumber || transport.bus_id || null,
      academic_year: academicYear,
      status: 'approved',
      raised_by: 'admissions_crm',
      application_number: '(assigned on save — COLLEGE-COURSE-0001 per AY)',
    },
  };
}
