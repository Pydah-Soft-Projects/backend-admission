import mongoose from 'mongoose';
import { connectTransport } from '../config-mongo/transport.js';
import { connectHostel } from '../config-mongo/hostel.js';
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

  const existing = await users.findOne(lookupKey);

  const hostelIdAssignment = await assignHostelStudentId(db, {
    hostelObjectId: transport.hostelId,
    academicYear: transportSessionYear,
    gender,
    existingHostelId: existing?.hostelId,
  });

  const studentYear = Math.max(1, Number(joiningContext.yearOfStudy || joiningContext.currentYear || 1));
  const termFees = await resolveHmsTermFees(db, {
    academicYear: transportSessionYear,
    course: joiningContext.course || '',
    categoryName: transport.categoryName || '',
    studentYear,
  });

  let bedNumber = existing?.bedNumber || '';
  let lockerNumber = existing?.lockerNumber || '';
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

  const baseDoc = {
    name: joiningContext.studentName || '',
    admissionNumber: admissionNumber || undefined,
    rollNumber: joiningContext.rollNumber || existing?.rollNumber || undefined,
    joiningId,
    leadId: leadId || null,
    role: 'student',
    course: joiningContext.course || '',
    branch: joiningContext.branch || '',
    gender,
    category: transport.categoryName || '',
    studentPhone: joiningContext.studentPhone || '',
    parentPhone: joiningContext.fatherPhone || '',
    batch: joiningContext.intakeBatch || joiningContext.batch || '',
    academicYear: transportSessionYear,
    hostel: toStoredHostelRefId(transport.hostelId),
    hostelCategory: toStoredHostelRefId(transport.categoryId),
    room: roomObjectId,
    roomNumber: transport.roomNumber || '',
    bedNumber: bedNumber || undefined,
    lockerNumber: lockerNumber || undefined,
    hostelId: hostelIdAssignment.hostelId,
    hostelStatus: 'Active',
    applicationStatus: 'Active',
    graduationStatus: 'Enrolled',
    actualHostelFee: actualFee,
    revisedHostelFee: revisedFee,
    isHostelFeeRevised: revisedFee !== actualFee,
    ...(termFees || {}),
    source: 'admissions_crm',
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  let userId = existing?._id;

  if (existing) {
    await users.updateOne({ _id: existing._id }, { $set: baseDoc });
  } else {
    const insertResult = await users.insertOne({
      ...baseDoc,
      createdAt: new Date(),
    });
    userId = insertResult.insertedId;
  }

  if (transport.roomId && userId) {
    await upsertHostelRoomOccupancyHistory(db, {
      studentUserId: userId,
      studentName: joiningContext.studentName || '',
      rollNumber: joiningContext.rollNumber || '',
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

/** Dry-run: document that would be inserted/updated in HMS `users`. */
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
  const transportSessionYear = resolveTransportAcademicYear(
    transport,
    joiningContext?.intakeBatch || joiningContext?.batch || ''
  );

  return {
    skipped: false,
    collection: 'users',
    database: 'hostel_hms',
    operation: 'upsert',
    lookup: admissionNumber ? { admissionNumber } : { joiningId, source: 'admissions_crm' },
    document: {
      name: joiningContext.studentName || '',
      admissionNumber: admissionNumber || undefined,
      joiningId,
      leadId: leadId || null,
      role: 'student',
      course: joiningContext.course || '',
      branch: joiningContext.branch || '',
      gender,
      category: transport.categoryName || '',
      studentPhone: joiningContext.studentPhone || '',
      parentPhone: joiningContext.fatherPhone || '',
      batch: joiningContext.batch || '',
      academicYear: transportSessionYear,
      hostel: transport.hostelId,
      hostelCategory: transport.categoryId,
      room: transport.roomId || undefined,
      roomNumber: transport.roomNumber || '',
      hostelId: '(assigned on save — BH26/GH26 + 3-digit serial per AY)',
      hostelStatus: 'Active',
      graduationStatus: 'Enrolled',
      actualHostelFee: actualFee,
      revisedHostelFee: revisedFee,
      isHostelFeeRevised: revisedFee !== actualFee,
      source: 'admissions_crm',
    },
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
