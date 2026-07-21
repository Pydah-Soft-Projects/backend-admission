import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { connectTransport } from '../config-mongo/transport.js';
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
 * Upsert an approved student transport request in Transport MongoDB `transport_requests` collection
 * and assign a per-academic-year application number (0001, 0002, …).
 */
export async function syncJoiningBusToTransportRequestMysql({ joiningId, joiningContext, user = null }) {
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

  let pool = null;
  try {
    pool = getSecondaryPool();
  } catch {
    /* secondary db optional */
  }

  let collegeCode = 'PCE';
  let courseCode = 'BTECH';
  if (pool) {
    try {
      const codes = await resolveTransportApplicationCodesForJoining(pool, joiningContext);
      collegeCode = codes.collegeCode || collegeCode;
      courseCode = codes.courseCode || courseCode;
    } catch {
      /* ignore */
    }
  }

  let application = null;
  let mongoConn = null;
  try {
    mongoConn = await connectTransport();
    const mongoColl = mongoConn.db.collection('transport_requests');
    const filter = { admission_number: admissionNumber, academic_year: academicYear };
    const existingMongo = await mongoColl.findOne(filter);

    application = await assignTransportApplicationNumber(
      pool,
      academicYear,
      collegeCode,
      courseCode,
      existingMongo?.application_number || null,
      existingMongo?.application_serial || null
    );

    const now = new Date();
    const doc = {
      joining_id: joiningId || null,
      admission_number: admissionNumber,
      student_name: studentName,
      route_id: routeId,
      route_name: routeName,
      stage_name: stageName,
      fare,
      bus_id: busId,
      academic_year: academicYear,
      application_college_code: collegeCode,
      application_course_code: courseCode,
      application_number: application.application_number,
      application_serial: application.application_serial,
      status: 'approved',
      raised_by: raisedBy,
      raised_by_id: raisedById,
      request_date: existingMongo?.request_date || now,
      updated_at: now,
    };

    await mongoColl.replaceOne(filter, doc, { upsert: true });
    console.log(`[joiningTransportRequestSync] Successfully upserted Transport Mongo request ${application.application_number} for ${admissionNumber}`);
  } catch (mongoErr) {
    console.error('[joiningTransportRequestSync] Mongo transport_requests error:', mongoErr?.message || mongoErr);
  }

  // Secondary MySQL sync if pool is available
  let requestId = null;
  if (pool) {
    try {
      const hasTable = await secondaryHasTransportRequestsTable(pool);
      if (hasTable) {
        const existing = await findTransportRequestForYear(pool, admissionNumber, academicYear);
        requestId = existing?.id || null;
        if (!requestId) {
          const [studentRows] = await pool.execute(
            'SELECT current_year FROM students WHERE admission_number = ? OR admission_no = ? LIMIT 1',
            [admissionNumber, admissionNumber]
          );
          const yearOfStudy = studentRows[0]?.current_year != null ? Number(studentRows[0].current_year) : 1;

          const [insertResult] = await pool.execute(
            `INSERT INTO transport_requests
             (admission_number, student_name, route_id, route_name, stage_name, fare, bus_id,
              raised_by, raised_by_id, status, year_of_study, academic_year, application_number, application_serial, request_date, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, NOW(), NOW())`,
            [admissionNumber, studentName, routeId, routeName, stageName, fare, busId, raisedBy, raisedById, yearOfStudy, academicYear, application?.application_number || null, application?.application_serial || null]
          );
          requestId = insertResult.insertId;
        } else {
          await pool.execute(
            `UPDATE transport_requests
             SET student_name = ?, route_id = ?, route_name = ?, stage_name = ?, fare = ?,
                 bus_id = ?, academic_year = ?, status = 'approved', application_number = ?, application_serial = ?, updated_at = NOW()
             WHERE id = ?`,
            [studentName, routeId, routeName, stageName, fare, busId, academicYear, application?.application_number || null, application?.application_serial || null, requestId]
          );
        }
      }
    } catch (sqlErr) {
      console.warn('[joiningTransportRequestSync] Secondary MySQL sync warning:', sqlErr?.message || sqlErr);
    }
  }

  return {
    skipped: false,
    admissionNumber,
    academicYear,
    application_number: application?.application_number || null,
    application_serial: application?.application_serial || null,
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
