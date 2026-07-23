import mongoose from 'mongoose';
import { connectTransport } from '../config-mongo/transport.js';
import { connectHostel } from '../config-mongo/hostel.js';
import { getPool } from '../config-sql/database.js';
import {
  previewJoiningTransportRequestSync,
  syncJoiningBusToTransportRequestMysql,
} from './joiningTransportRequestSync.service.js';
import { resolveTransportAcademicYear } from '../utils/transportApplicationNumber.util.js';
import { assignHostelStudentId } from '../utils/hostelStudentId.util.js';
import {
  normalizeBrokenHostelRefField,
  resolveHmsTermFees,
  resolveNextBedAndLocker,
  toStoredHostelRefId,
  upsertHostelRoomOccupancyHistory,
} from '../utils/hostelHmsSync.util.js';

const { Types: { ObjectId } } = mongoose;

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

const refMatch = (value) => {
  const raw = String(value || '').trim();
  const oid = toObjectId(raw);
  const keys = new Set([raw]);
  if (oid) keys.add(oid);
  return { $in: [...keys] };
};

/**
 * HMS `users.rollNumber` has a unique index in production.
 * Many admission-time records do not yet have a real roll number, so we must
 * generate a stable non-empty fallback to avoid duplicate `null` key errors.
 */
const resolveHostelRollNumber = ({ joiningContext, existing, admissionNumber, joiningId }) => {
  const explicit = String(joiningContext?.rollNumber || '').trim();
  if (explicit) return explicit;

  const fromExisting = String(existing?.rollNumber || '').trim();
  if (fromExisting) return fromExisting;

  const adm = String(admissionNumber || '').trim();
  if (adm) return `ADM-${adm}`;

  const join = String(joiningId || '').trim();
  if (join) return `JOIN-${join}`;

  return undefined;
};

/**
 * Mirror bus selection into the Transport MongoDB (`studentfees` collection).
 */
export async function syncJoiningBusToTransportMongo({ joiningId, leadId, joiningContext, busLines }) {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) {
    console.warn('[joiningAccommodationSync] TRANSPORT_MONGO_URI not set; skipping bus sync');
    return;
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'bus') return;
  if (!transport.routeId || !transport.stageId) return;

  const conn = await connectTransport();
  const coll = conn.db.collection('studentfees');

  const busLine = (busLines || []).find((line) => line.accommodationType === 'bus') || busLines?.[0];
  const actualFare = busLine?.actualAmount ?? Number(transport.stageFare) ?? 0;
  const revisedFare = busLine?.revisedAmount ?? actualFare;

  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  const doc = {
    joiningId,
    leadId: leadId || null,
    admissionNumber: joiningContext.admissionNumber || '',
    studentName: joiningContext.studentName || '',
    routeId: transport.routeId,
    routeName: transport.routeName || '',
    stageId: transport.stageId,
    stageName: transport.stageName || '',
    academicYear: transportSessionYear,
    busId:
      transport.busId || transport.busNumber || transport.bus_id || null,
    busNumber:
      transport.busNumber || transport.busId || transport.bus_id || null,
    actualFare,
    revisedFare,
    isRevised: revisedFare !== actualFare,
    batch: joiningContext.intakeBatch || joiningContext.batch || '',
    feeHeadCode: 'TRN01',
    feeHeadName: 'Bus Fee',
    source: 'admissions_crm',
    isActive: true,
    updatedAt: new Date(),
  };

  await coll.replaceOne({ joiningId }, doc, { upsert: true });
}

/**
 * Create or update a hostel student row in HMS (`users` collection).
 */
export async function syncJoiningHostelToHmsMongo({ joiningId, leadId, joiningContext, hostelLines }) {
  const uri = process.env.HOSTEL_MONGO_URI?.trim();
  if (!uri) {
    console.warn('[joiningAccommodationSync] HOSTEL_MONGO_URI not set; skipping hostel sync');
    return;
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'hostel') return;
  if (!transport.hostelId || !transport.categoryId) return;

  const conn = await connectHostel();
  const db = conn.db;
  const users = db.collection('users');
  const studentmasters = db.collection('studentmasters');
  const hostelrequests = db.collection('hostelrequests');

  const admissionNumber = String(joiningContext.admissionNumber || '').trim();
  const lookupKey = admissionNumber
    ? { admissionNumber }
    : { joiningId, source: 'admissions_crm' };

  const hostelLine = (hostelLines || []).find((line) => line.accommodationType === 'hostel') || hostelLines?.[0];
  const actualFee = hostelLine?.actualAmount ?? Number(transport.hostelFee) ?? 0;
  const revisedFee = hostelLine?.revisedAmount ?? actualFee;

  const genderRaw = String(joiningContext.studentGender || '').trim().toLowerCase();
  const gender =
    genderRaw.startsWith('f') ? 'Female' : genderRaw.startsWith('m') ? 'Male' : joiningContext.studentGender || '';

  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  const existingRequestKey = admissionNumber
    ? { admissionNumber, academicYear: transportSessionYear }
    : { joiningId, academicYear: transportSessionYear, source: 'admissions_crm' };

  const existingRequest = await hostelrequests.findOne(existingRequestKey);
  const existingHostelSequenceId = existingRequest?.hostelSequenceId || null;

  const existingUser = await users.findOne(lookupKey);
  const resolvedRollNumber = resolveHostelRollNumber({
    joiningContext,
    existing: existingUser,
    admissionNumber,
    joiningId,
  });

  let collegeCode = joiningContext?.collegeCode || '';
  let courseCode = joiningContext?.courseCode || '';

  if (!collegeCode || !courseCode) {
    const pool = getPool();
    let sqlRow = null;
    if (admissionNumber) {
      const [rows] = await pool.execute(
        'SELECT managed_course_id, course FROM admissions WHERE admission_number = ? LIMIT 1',
        [admissionNumber]
      );
      if (rows?.[0]) sqlRow = rows[0];
    }
    if (!sqlRow && joiningId) {
      const [rows] = await pool.execute(
        'SELECT managed_course_id, course FROM joinings WHERE id = ? LIMIT 1',
        [joiningId]
      );
      if (rows?.[0]) sqlRow = rows[0];
    }
    if (sqlRow) {
      const { resolveTransportApplicationCodes } = await import('../utils/transportApplicationNumber.util.js');
      try {
        const { getPool: getSecondaryPool } = await import('../config-sql/database-secondary.js');
        const secPool = getSecondaryPool();
        const resolved = await resolveTransportApplicationCodes(secPool, {
          managedCourseId: sqlRow.managed_course_id,
          courseName: sqlRow.course,
        });
        if (resolved.collegeCode) collegeCode = resolved.collegeCode;
        if (resolved.courseCode) courseCode = resolved.courseCode;
      } catch (err) {
        console.warn('Failed to resolve fallback codes for sync:', err);
      }
    }
  }

  const hostelIdAssignment = await assignHostelStudentId(db, {
    hostelObjectId: transport.hostelId,
    academicYear: transportSessionYear,
    gender,
    existingHostelId: existingHostelSequenceId,
    collegeCode,
    courseCode,
  });

  const studentYear = Math.max(1, Number(joiningContext.yearOfStudy || joiningContext.currentYear || 1));
  const termFees = await resolveHmsTermFees(db, {
    academicYear: transportSessionYear,
    course: joiningContext.course || '',
    categoryName: transport.categoryName || '',
    studentYear,
  });

  let bedNumber = existingRequest?.bedNumber || '';
  let lockerNumber = existingRequest?.lockerNumber || '';
  const roomObjectId = toStoredHostelRefId(transport.roomId);
  if (transport.roomId && transport.roomNumber && (!bedNumber || !lockerNumber)) {
    const roomDoc = await db.collection('rooms').findOne({ _id: roomObjectId });
    const bedLocker = await resolveNextBedAndLocker(db, {
      roomId: transport.roomId,
      roomNumber: transport.roomNumber,
      academicYear: transportSessionYear,
      bedCount: roomDoc?.bedCount,
    });
    bedNumber = bedLocker.bedNumber || bedNumber;
    lockerNumber = bedLocker.lockerNumber || lockerNumber;
  }

  // 1. Upsert User (Login/Identity fields only, no room/hostel allocations)
  const userBaseDoc = {
    name: joiningContext.studentName || '',
    admissionNumber: admissionNumber || undefined,
    rollNumber: resolvedRollNumber,
    joiningId,
    leadId: leadId || null,
    role: 'student',
    course: joiningContext.course || '',
    branch: joiningContext.branch || '',
    gender,
    studentPhone: joiningContext.studentPhone || '',
    parentPhone: joiningContext.fatherPhone || '',
    batch: joiningContext.intakeBatch || joiningContext.batch || '',
    academicYear: transportSessionYear,
    applicationStatus: 'Active',
    graduationStatus: 'Enrolled',
    source: 'admissions_crm',
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  let userId = existingUser?._id;

  if (existingUser) {
    await users.updateOne({ _id: existingUser._id }, { $set: userBaseDoc });
  } else {
    const insertResult = await users.insertOne({
      ...userBaseDoc,
      createdAt: new Date(),
    });
    userId = insertResult.insertedId;
  }

  // 2. Upsert StudentMaster (Linked by admissionNumber)
  if (admissionNumber) {
    await studentmasters.updateOne(
      { admissionNumber },
      {
        $set: {
          userId,
          name: joiningContext.studentName || '',
          rollNumber: resolvedRollNumber || '',
          contacts: {
            studentPhone: joiningContext.studentPhone || '',
            parentPhone: joiningContext.fatherPhone || '',
          },
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  }

  // 3. Upsert HostelRequest (Academic Year source of truth for hostel allocations)
  const hostelRequestDoc = {
    status: 'active',
    hostelId: toStoredHostelRefId(transport.hostelId),
    hostelCategoryId: toStoredHostelRefId(transport.categoryId),
    roomId: roomObjectId,
    roomNumber: transport.roomNumber || '',
    bedNumber: bedNumber || undefined,
    lockerNumber: lockerNumber || undefined,
    hostelSequenceId: hostelIdAssignment.hostelId,
    academicYear: transportSessionYear,
    admissionNumber: admissionNumber || undefined,
    joiningId,
    leadId: leadId || null,
    actualHostelFee: actualFee,
    revisedHostelFee: revisedFee,
    isHostelFeeRevised: revisedFee !== actualFee,
    ...(termFees || {}),
    source: 'admissions_crm',
    updatedAt: new Date(),
  };

  await hostelrequests.updateOne(
    existingRequestKey,
    {
      $set: hostelRequestDoc,
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  // 4. Room occupancy history uses studentUserId (user._id reference)
  if (transport.roomId && userId) {
    await upsertHostelRoomOccupancyHistory(db, {
      studentUserId: userId,
      studentName: joiningContext.studentName || '',
      rollNumber: resolvedRollNumber || '',
      course: joiningContext.course || '',
      branch: joiningContext.branch || '',
      yearOfStudy: studentYear,
      academicYear: transportSessionYear,
      hostelId: transport.hostelId,
      categoryId: transport.categoryId,
      roomId: transport.roomId,
      roomNumber: transport.roomNumber || '',
      bedNumber,
      lockerNumber,
    });
  }

  return hostelIdAssignment;
}

/** Dry-run: document that would be upserted into Transport `studentfees`. */
export function previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines }) {
  const transportRequestPreview = previewJoiningTransportRequestSync({ joiningContext });
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) {
    return {
      ...transportRequestPreview,
      legacyStudentFees: { skipped: true, reason: 'TRANSPORT_MONGO_URI not set' },
    };
  }

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'bus') {
    return { skipped: true, reason: 'No bus accommodation on joining' };
  }
  if (!transport.routeId || !transport.stageId) {
    return { skipped: true, reason: 'Bus route or stage not selected' };
  }

  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType === 'bus');
  const busLine =
    accommodationLines.find((line) => line.accommodationType === 'bus') || accommodationLines[0];
  const actualFare = busLine?.actualAmount ?? Number(transport.stageFare) ?? 0;
  const revisedFare = busLine?.revisedAmount ?? actualFare;

  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  return {
    skipped: false,
    transportRequest: transportRequestPreview,
    collection: 'studentfees',
    database: 'transport',
    operation: 'replaceOne',
    filter: { joiningId },
    document: {
      joiningId,
      leadId: leadId || null,
      admissionNumber: joiningContext.admissionNumber || '',
      studentName: joiningContext.studentName || '',
      routeId: transport.routeId,
      routeName: transport.routeName || '',
      stageId: transport.stageId,
      stageName: transport.stageName || '',
      academicYear: transportSessionYear,
      actualFare,
      revisedFare,
      isRevised: revisedFare !== actualFare,
      batch: joiningContext.intakeBatch || joiningContext.batch || '',
      feeHeadCode: 'TRN01',
      feeHeadName: 'Bus Fee',
      source: 'admissions_crm',
    },
  };
}

/** Dry-run: document that would be inserted/updated in HMS collections. */
export function previewJoiningHostelSync({ joiningId, leadId, joiningContext, portalLines }) {
  const uri = process.env.HOSTEL_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'HOSTEL_MONGO_URI not set' };

  const transport = joiningContext?.transportDetails;
  if (!transport || transport.accommodationType !== 'hostel') {
    return { skipped: true, reason: 'No hostel accommodation on joining' };
  }
  if (!transport.hostelId || !transport.categoryId) {
    return { skipped: true, reason: 'Hostel or category not selected' };
  }

  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType === 'hostel');
  const hostelLine =
    accommodationLines.find((line) => line.accommodationType === 'hostel') || accommodationLines[0];
  const actualFee = hostelLine?.actualAmount ?? Number(transport.hostelFee) ?? 0;
  const revisedFee = hostelLine?.revisedAmount ?? actualFee;

  const genderRaw = String(joiningContext.studentGender || '').trim().toLowerCase();
  const gender =
    genderRaw.startsWith('f') ? 'Female' : genderRaw.startsWith('m') ? 'Male' : joiningContext.studentGender || '';

  const admissionNumber = String(joiningContext.admissionNumber || '').trim();
  const previewRollNumber =
    String(joiningContext.rollNumber || '').trim() ||
    (admissionNumber ? `ADM-${admissionNumber}` : String(joiningId || '').trim() ? `JOIN-${joiningId}` : undefined);
  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  return {
    skipped: false,
    database: 'hostel_hms',
    operations: [
      {
        collection: 'users',
        operation: 'upsert',
        lookup: admissionNumber ? { admissionNumber } : { joiningId, source: 'admissions_crm' },
        document: {
          name: joiningContext.studentName || '',
          admissionNumber: admissionNumber || undefined,
          rollNumber: previewRollNumber,
          joiningId,
          leadId: leadId || null,
          role: 'student',
          course: joiningContext.course || '',
          branch: joiningContext.branch || '',
          gender,
          studentPhone: joiningContext.studentPhone || '',
          parentPhone: joiningContext.fatherPhone || '',
          batch: joiningContext.batch || '',
          academicYear: transportSessionYear,
          applicationStatus: 'Active',
          graduationStatus: 'Enrolled',
          source: 'admissions_crm',
        },
      },
      ...(admissionNumber
        ? [
            {
              collection: 'studentmasters',
              operation: 'upsert',
              lookup: { admissionNumber },
              document: {
                admissionNumber,
                userId: '(user._id reference)',
                name: joiningContext.studentName || '',
                rollNumber: previewRollNumber || '',
                contacts: {
                  studentPhone: joiningContext.studentPhone || '',
                  parentPhone: joiningContext.fatherPhone || '',
                },
              },
            },
          ]
        : []),
      {
        collection: 'hostelrequests',
        operation: 'upsert',
        lookup: admissionNumber
          ? { admissionNumber, academicYear: transportSessionYear }
          : { joiningId, academicYear: transportSessionYear, source: 'admissions_crm' },
        document: {
          status: 'active',
          hostelId: transport.hostelId,
          hostelCategoryId: transport.categoryId,
          roomId: transport.roomId || undefined,
          roomNumber: transport.roomNumber || '',
          hostelSequenceId: collegeCode && courseCode
            ? `(assigned on save — ${collegeCode.trim().toUpperCase()}${courseCode.trim().toUpperCase()}${gender.startsWith('F') ? 'GH' : 'BH'} + 3-digit serial)`
            : '(assigned on save — BH26/GH26 + 3-digit serial per AY)',
          academicYear: transportSessionYear,
          admissionNumber: admissionNumber || undefined,
          joiningId,
          leadId: leadId || null,
          actualHostelFee: actualFee,
          revisedHostelFee: revisedFee,
          isHostelFeeRevised: revisedFee !== actualFee,
          source: 'admissions_crm',
        },
      },
    ],
  };
}

export async function syncJoiningAccommodationToExternalDbs({
  joiningId,
  leadId,
  joiningContext,
  portalLines,
  user = null,
}) {
  if (!joiningId) return;

  const accommodationType = joiningContext?.transportDetails?.accommodationType;
  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType);

  try {
    if (accommodationType === 'bus') {
      await syncJoiningBusToTransportRequestMysql({ joiningId, joiningContext, user });
      await syncJoiningBusToTransportMongo({
        joiningId,
        leadId,
        joiningContext,
        busLines: accommodationLines,
      });
    } else if (accommodationType === 'hostel') {
      await syncJoiningHostelToHmsMongo({
        joiningId,
        leadId,
        joiningContext,
        hostelLines: accommodationLines,
      });
    }
  } catch (err) {
    console.error(
      '[joiningAccommodationSync] External accommodation sync failed (SQL save still succeeded):',
      err?.message || err
    );
  }
}
