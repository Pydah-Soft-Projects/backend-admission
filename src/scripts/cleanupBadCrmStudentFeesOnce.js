/**
 * One-off: remove CRM-pushed studentfees rows that break the fee portal FeeCollection UI.
 * Usage: node src/scripts/cleanupBadCrmStudentFeesOnce.js [admissionNumber]
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const { Types: { ObjectId } } = mongoose;

const TUI = new ObjectId('6996e24c2e1678e398839187');
const TRN = new ObjectId('6996e24c2e1678e39883918a');
const HST = new ObjectId('6996e24d2e1678e398839196');
const SESSION = /^\d{4}-\d{4}$/;

await mongoose.connect(process.env.FEE_MANAGEMENT_MONGO_URI);
const db = mongoose.connection.db;
const coll = db.collection('studentfees');

const admissionArg = process.argv[2]?.trim();
let studentFilter = {};
if (admissionArg) {
  studentFilter = { studentId: admissionArg };
} else {
  const crmIds = await db
    .collection('crm_joining_student_fee_details')
    .distinct('admissionNumber');
  studentFilter = { studentId: { $in: crmIds.filter(Boolean) } };
}

const tuitionBad = await coll.deleteMany({
  ...studentFilter,
  feeHead: TUI,
  academicYear: { $regex: SESSION },
});

const transportExtra = await coll.deleteMany({
  ...studentFilter,
  feeHead: TRN,
  studentYear: { $gt: 1 },
});

const hostelExtra = await coll.deleteMany({
  ...studentFilter,
  feeHead: HST,
  studentYear: { $gt: 1 },
});

console.log({
  admissionNumber: admissionArg || '(CRM-pushed students only)',
  deletedTuitionSessionRows: tuitionBad.deletedCount,
  deletedTransportYearGt1: transportExtra.deletedCount,
  deletedHostelYearGt1: hostelExtra.deletedCount,
});

await mongoose.disconnect();
