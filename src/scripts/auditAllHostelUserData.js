import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const conn = await mongoose.createConnection(process.env.HOSTEL_MONGO_URI).asPromise();
const db = conn.db;

function isBrokenRef(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.$in));
}

const allUsers = await db.collection('users').find({ hostel: { $exists: true, $ne: null } }).toArray();

const brokenRefs = allUsers.filter(
  (u) => isBrokenRef(u.hostel) || isBrokenRef(u.hostelCategory) || isBrokenRef(u.room)
);
const missingHostelId = allUsers.filter(
  (u) => !u.hostelId || String(u.hostelId).trim() === ''
);
const missingOccupancyCandidates = allUsers.filter(
  (u) => u.room && u.academicYear && u.hostelStatus === 'Active'
);

console.log('Total users with hostel:', allUsers.length);
console.log('Broken ref fields:', brokenRefs.length);
console.log('Missing hostelId:', missingHostelId.length);
console.log('Active users with room+year:', missingOccupancyCandidates.length);

const crmUsers = allUsers.filter((u) => u.source === 'admissions_crm');
console.log('admissions_crm users:', crmUsers.length);

for (const u of [...new Set([...brokenRefs, ...missingHostelId, ...crmUsers])]) {
  console.log(JSON.stringify({
    _id: String(u._id),
    name: u.name,
    source: u.source || 'native',
    admissionNumber: u.admissionNumber,
    academicYear: u.academicYear,
    hostelId: u.hostelId || null,
    brokenHostel: isBrokenRef(u.hostel),
    brokenCategory: isBrokenRef(u.hostelCategory),
    brokenRoom: isBrokenRef(u.room),
    hasBed: Boolean(u.bedNumber),
    hasTermFees: u.totalCalculatedFee != null,
    hasApplicationStatus: Boolean(u.applicationStatus),
  }));
}

// Check occupancy history coverage for active room users
let missingHistory = 0;
for (const u of missingOccupancyCandidates) {
  const studentId = u._id;
  const hist = await db.collection('roomoccupancyhistories').findOne({
    student: studentId,
    academicYear: u.academicYear,
    status: { $in: ['Active', 'Extended'] },
    allocatedTo: null,
  });
  if (!hist) missingHistory += 1;
}
console.log('\nActive room users missing occupancy history:', missingHistory);

await conn.close();
