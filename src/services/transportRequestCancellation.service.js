import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { connectTransport } from '../config-mongo/transport.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { calendarYearToAcademicYearSession } from '../utils/transportApplicationNumber.util.js';
import { FEE_PORTAL_STUDENT_FEES_COLLECTION } from './joiningStudentFeeMongoSync.service.js';

const BUS_FEE_HEAD_ID = '6996e24c2e1678e39883918a';
const BUS_FEE_HEAD_CODE = 'TRN01';

const ACTIVE_TRANSPORT_STATUSES = new Set(['pending', 'approved']);

async function findTransportRequestRow(pool, { admissionNumber, academicYear, requestId }) {
  if (requestId) {
    const [rows] = await pool.execute(
      `SELECT id, admission_number, academic_year, status, application_number
       FROM transport_requests WHERE id = ? LIMIT 1`,
      [requestId]
    );
    return rows[0] || null;
  }

  const normalizedAy = academicYear ? calendarYearToAcademicYearSession(academicYear) : null;
  let sql = `SELECT id, admission_number, academic_year, status, application_number
             FROM transport_requests WHERE admission_number = ?`;
  const params = [admissionNumber];
  if (normalizedAy) {
    sql += ' AND academic_year = ?';
    params.push(normalizedAy);
  }
  sql += ` AND status IN ('pending', 'approved')
           ORDER BY request_date DESC, id DESC LIMIT 1`;
  const [rows] = await pool.execute(sql, params);
  return rows[0] || null;
}

/**
 * Mark bus fee rows inactive in Fee Management `studentfees` (remarks = Transport / TRN01).
 */
export async function deactivateBusStudentFeesInFeeManagement({
  admissionNumber,
  academicYear,
  reason = '',
}) {
  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) {
    return { skipped: true, reason: 'FEE_MANAGEMENT_MONGO_URI not set' };
  }

  const studentId = String(admissionNumber || '').trim();
  if (!studentId) {
    return { skipped: true, reason: 'admissionNumber required' };
  }

  const sessionYear = academicYear ? calendarYearToAcademicYearSession(academicYear) : null;
  const conn = await connectFeeManagement();
  const coll = conn.db.collection(FEE_PORTAL_STUDENT_FEES_COLLECTION);
  const now = new Date();

  const filter = {
    studentId,
    $or: [
      { remarks: 'Transport' },
      { feeHeadId: BUS_FEE_HEAD_ID },
      { feeHeadCode: BUS_FEE_HEAD_CODE },
      { 'feeHead.code': BUS_FEE_HEAD_CODE },
    ],
  };
  if (sessionYear) {
    filter.academicYear = sessionYear;
  }

  const result = await coll.updateMany(filter, {
    $set: {
      isActive: false,
      cancellationReason: String(reason || '').trim() || undefined,
      updatedAt: now,
    },
  });

  return {
    skipped: false,
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
  };
}

async function deactivateTransportMongoBusMirror({ joiningId, admissionNumber, reason }) {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'TRANSPORT_MONGO_URI not set' };

  const conn = await connectTransport();
  const coll = conn.db.collection('studentfees');
  const now = new Date();
  const lookup = joiningId
    ? { joiningId }
    : admissionNumber
      ? { admissionNumber: String(admissionNumber).trim() }
      : null;
  if (!lookup) return { skipped: true, reason: 'joiningId or admissionNumber required' };

  const result = await coll.updateOne(lookup, {
    $set: {
      isActive: false,
      status: 'cancelled',
      cancellationReason: String(reason || '').trim() || undefined,
      updatedAt: now,
    },
  });

  return {
    skipped: false,
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
  };
}

async function deactivateTransportMongoRequests({ admissionNumber, academicYear, reason }) {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'TRANSPORT_MONGO_URI not set' };

  try {
    const conn = await connectTransport();
    const coll = conn.db.collection('transport_requests');
    const now = new Date();
    const admNo = String(admissionNumber || '').trim();
    if (!admNo) return { skipped: true, reason: 'admissionNumber required' };

    const filter = { admission_number: admNo };
    if (academicYear) {
      filter.academic_year = academicYear;
    }

    const result = await coll.updateMany(filter, {
      $set: {
        status: 'cancelled',
        cancellation_reason: String(reason || '').trim() || undefined,
        updated_at: now,
      },
    });

    return {
      skipped: false,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0,
    };
  } catch (err) {
    return { skipped: true, error: err?.message || err };
  }
}

/**
 * Cancel an active transport_requests row and deactivate linked bus fee ledger rows.
 */
export async function cancelStudentTransportRequest({
  admissionNumber,
  academicYear,
  requestId,
  reason,
  joiningId,
}) {
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) {
    throw new Error('Cancellation reason is required');
  }

  let row = null;
  let pool = null;
  try {
    pool = getSecondaryPool();
    row = await findTransportRequestRow(pool, {
      admissionNumber,
      academicYear,
      requestId,
    });
  } catch {
    /* mysql optional */
  }

  // Also check Mongo if MySQL row not found
  if (!row && admissionNumber) {
    try {
      const conn = await connectTransport();
      const coll = conn.db.collection('transport_requests');
      const filter = { admission_number: String(admissionNumber).trim() };
      if (academicYear) filter.academic_year = academicYear;
      const mongoRow = await coll.findOne(filter, { sort: { request_date: -1 } });
      if (mongoRow) {
        row = {
          id: String(mongoRow._id),
          admission_number: mongoRow.admission_number,
          academic_year: mongoRow.academic_year,
          status: mongoRow.status,
          application_number: mongoRow.application_number,
        };
      }
    } catch {
      /* ignore */
    }
  }

  if (!row) {
    throw new Error('No active transport request found to cancel');
  }

  const status = String(row.status || '').trim().toLowerCase();
  if (!ACTIVE_TRANSPORT_STATUSES.has(status)) {
    throw new Error(`Transport request is already ${status || 'inactive'}`);
  }

  const resolvedAdmission = String(row.admission_number || admissionNumber || '').trim();
  const resolvedAy = row.academic_year || calendarYearToAcademicYearSession(academicYear);

  if (pool && Number.isFinite(Number(row.id))) {
    await pool.execute(
      `UPDATE transport_requests
       SET status = 'cancelled',
           cancellation_reason = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [trimmedReason, row.id]
    ).catch(() => {});
  }

  const feeResult = await deactivateBusStudentFeesInFeeManagement({
    admissionNumber: resolvedAdmission,
    academicYear: resolvedAy,
    reason: trimmedReason,
  });

  const transportMongoResult = await deactivateTransportMongoBusMirror({
    joiningId,
    admissionNumber: resolvedAdmission,
    reason: trimmedReason,
  });

  const transportRequestsMongoResult = await deactivateTransportMongoRequests({
    admissionNumber: resolvedAdmission,
    academicYear: resolvedAy,
    reason: trimmedReason,
  });

  return {
    requestId: row.id,
    admissionNumber: resolvedAdmission,
    academicYear: resolvedAy,
    applicationNumber: row.application_number || null,
    status: 'cancelled',
    cancellationReason: trimmedReason,
    feeManagement: feeResult,
    transportMongo: transportMongoResult,
    transportRequestsMongo: transportRequestsMongoResult,
  };
}
