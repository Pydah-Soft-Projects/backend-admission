import mongoose from 'mongoose';
import { connectTransport } from '../config-mongo/transport.js';
import { connectHostel } from '../config-mongo/hostel.js';

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

  const doc = {
    joiningId,
    leadId: leadId || null,
    admissionNumber: joiningContext.admissionNumber || '',
    studentName: joiningContext.studentName || '',
    routeId: transport.routeId,
    routeName: transport.routeName || '',
    stageId: transport.stageId,
    stageName: transport.stageName || '',
    actualFare,
    revisedFare,
    isRevised: revisedFare !== actualFare,
    batch: joiningContext.batch || '',
    feeHeadCode: 'TRN01',
    feeHeadName: 'Bus Fee',
    source: 'admissions_crm',
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

  const baseDoc = {
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
    academicYear: transport.academicYear || '',
    hostel: refMatch(transport.hostelId),
    hostelCategory: refMatch(transport.categoryId),
    room: transport.roomId ? refMatch(transport.roomId) : undefined,
    roomNumber: transport.roomNumber || '',
    hostelStatus: 'Active',
    graduationStatus: 'Enrolled',
    actualHostelFee: actualFee,
    revisedHostelFee: revisedFee,
    isHostelFeeRevised: revisedFee !== actualFee,
    source: 'admissions_crm',
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  const existing = await users.findOne(lookupKey);
  if (existing) {
    await users.updateOne({ _id: existing._id }, { $set: baseDoc });
    return;
  }

  await users.insertOne({
    ...baseDoc,
    createdAt: new Date(),
  });
}

/** Dry-run: document that would be upserted into Transport `studentfees`. */
export function previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines }) {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'TRANSPORT_MONGO_URI not set' };

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

  return {
    skipped: false,
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
      actualFare,
      revisedFare,
      isRevised: revisedFare !== actualFare,
      batch: joiningContext.batch || '',
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
      academicYear: transport.academicYear || '',
      hostel: transport.hostelId,
      hostelCategory: transport.categoryId,
      room: transport.roomId || undefined,
      roomNumber: transport.roomNumber || '',
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
}) {
  if (!joiningId) return;

  const accommodationType = joiningContext?.transportDetails?.accommodationType;
  const accommodationLines = (portalLines || []).filter((line) => line.accommodationType);

  try {
    if (accommodationType === 'bus') {
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
