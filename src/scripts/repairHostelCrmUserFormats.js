/**
 * Repair admissions_crm HMS users that stored {$in: [...]} instead of ObjectIds.
 * Also backfills occupancy history + bed/locker + term fees when possible.
 *
 *   node src/scripts/repairHostelCrmUserFormats.js
 *   node src/scripts/repairHostelCrmUserFormats.js --apply
 */
import dotenv from 'dotenv';
import { connectHostel } from '../config-mongo/hostel.js';
import {
  normalizeBrokenHostelRefField,
  resolveHmsTermFees,
  resolveNextBedAndLocker,
  toStoredHostelRefId,
  upsertHostelRoomOccupancyHistory,
} from '../utils/hostelHmsSync.util.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const conn = await connectHostel();
const db = conn.db;
const users = db.collection('users');

const rows = await users.find({ source: 'admissions_crm' }).toArray();
const report = [];

for (const user of rows) {
  const hostel = normalizeBrokenHostelRefField(user.hostel);
  const hostelCategory = normalizeBrokenHostelRefField(user.hostelCategory);
  const room = normalizeBrokenHostelRefField(user.room);
  const needsRefFix =
    (user.hostel && typeof user.hostel === 'object' && user.hostel.$in) ||
    (user.hostelCategory && typeof user.hostelCategory === 'object' && user.hostelCategory.$in) ||
    (user.room && typeof user.room === 'object' && user.room.$in);

  const termFees = await resolveHmsTermFees(db, {
    academicYear: user.academicYear,
    course: user.course,
    categoryName: user.category,
    studentYear: 1,
  });

  let bedNumber = user.bedNumber || '';
  let lockerNumber = user.lockerNumber || '';
  if (room && user.roomNumber && (!bedNumber || !lockerNumber)) {
    const roomDoc = await db.collection('rooms').findOne({ _id: room });
    const bedLocker = await resolveNextBedAndLocker(db, {
      roomId: String(room),
      roomNumber: user.roomNumber,
      academicYear: user.academicYear,
      bedCount: roomDoc?.bedCount,
    });
    bedNumber = bedLocker.bedNumber || bedNumber;
    lockerNumber = bedLocker.lockerNumber || lockerNumber;
  }

  const patch = {
    hostel,
    hostelCategory,
    room,
    applicationStatus: user.applicationStatus || 'Active',
    bedNumber: bedNumber || undefined,
    lockerNumber: lockerNumber || undefined,
    ...(termFees || {}),
    updatedAt: new Date(),
  };

  const entry = {
    _id: String(user._id),
    name: user.name,
    admissionNumber: user.admissionNumber,
    needsRefFix,
    patch,
  };

  if (apply) {
    await users.updateOne({ _id: user._id }, { $set: patch });
    if (room) {
      await upsertHostelRoomOccupancyHistory(db, {
        studentUserId: user._id,
        studentName: user.name,
        rollNumber: user.rollNumber || '',
        course: user.course || '',
        branch: user.branch || '',
        yearOfStudy: 1,
        academicYear: user.academicYear,
        hostelId: String(hostel),
        categoryId: String(hostelCategory),
        roomId: String(room),
        roomNumber: user.roomNumber || '',
        bedNumber,
        lockerNumber,
      });
    }
  }

  report.push(entry);
}

console.log(JSON.stringify({ apply, count: report.length, report }, null, 2));
process.exit(0);
