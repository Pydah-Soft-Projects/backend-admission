/**
 * One-off inspector: list Fee Management Mongo collections and sample CRM sync docs.
 * Usage: node src/scripts/inspectFeePortalMongoOnce.js
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
if (!uri) {
  console.error('FEE_MANAGEMENT_MONGO_URI not set');
  process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
console.log('COLLECTIONS:', cols.join(', '));

const inspect = async (name, sortField = 'updatedAt') => {
  if (!cols.includes(name)) return;
  const count = await db.collection(name).countDocuments();
  const sample = await db
    .collection(name)
    .find({})
    .sort({ [sortField]: -1 })
    .limit(2)
    .toArray();
  console.log(`\n=== ${name} (count=${count}) ===`);
  console.log(JSON.stringify(sample, null, 2));
};

await inspect('crm_joining_student_fee_details');
await inspect('studentfees');

const agg = await db
  .collection('studentfees')
  .aggregate([{ $group: { _id: '$feeHead', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 8 }])
  .toArray();
console.log('\n=== studentfees by feeHead ===');
console.log(JSON.stringify(agg, null, 2));

const crmWithAdm = await db
  .collection('crm_joining_student_fee_details')
  .countDocuments({ admissionNumber: { $ne: '' } });
const crmTotal = await db.collection('crm_joining_student_fee_details').countDocuments();
console.log(`\nCRM records: ${crmTotal}, with admissionNumber: ${crmWithAdm}`);

const crmAdms = await db
  .collection('crm_joining_student_fee_details')
  .find({ admissionNumber: { $ne: '' } })
  .project({ admissionNumber: 1, lineCount: { $size: { $ifNull: ['$lines', []] } } })
  .limit(30)
  .toArray();
let overlap = 0;
for (const c of crmAdms) {
  const n = await db.collection('studentfees').countDocuments({ studentId: c.admissionNumber });
  if (n > 0) overlap += 1;
}
console.log(`CRM admissions with studentfees rows (sample ${crmAdms.length}): ${overlap}`);

const noLines = await db
  .collection('crm_joining_student_fee_details')
  .countDocuments({ $or: [{ lines: { $size: 0 } }, { lines: { $exists: false } }] });
console.log(`CRM records with empty lines: ${noLines}`);
await inspect('studentfeedetails');
await inspect('studentfeeassignments');
await inspect('student_fees');
await inspect('students');

const heads = await db
  .collection('feeheads')
  .find({ code: { $in: ['TRN01', 'HST01', 'TUI01', 'ADM01'] } })
  .project({ code: 1, name: 1, _id: 1 })
  .toArray();
console.log('\n=== feeheads sample ===');
console.log(JSON.stringify(heads, null, 2));

const fsCount = await db.collection('feestructures').countDocuments();
const fsSample = await db.collection('feestructures').find({}).limit(1).toArray();
console.log(`\nfeestructures count=${fsCount}`);
if (fsSample[0]) {
  console.log('feestructures sample keys:', Object.keys(fsSample[0]));
}

await mongoose.disconnect();
