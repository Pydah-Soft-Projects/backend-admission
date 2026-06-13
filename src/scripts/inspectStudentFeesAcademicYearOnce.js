/** Compare studentfees academicYear vs studentYear for tuition rows. */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
await mongoose.connect(process.env.FEE_MANAGEMENT_MONGO_URI);
const db = mongoose.connection.db;
const tui = '6996e24c2e1678e398839187';
const sample = await db
  .collection('studentfees')
  .aggregate([
    { $match: { feeHead: tui } },
    { $group: { _id: { studentId: '$studentId', academicYear: '$academicYear' }, years: { $addToSet: '$studentYear' }, count: { $sum: 1 } } },
    { $limit: 5 },
  ])
  .toArray();
console.log('TUI01 groups sample:', JSON.stringify(sample, null, 2));
const multi = await db
  .collection('studentfees')
  .find({ studentId: /^2025/ })
  .sort({ studentYear: 1 })
  .limit(8)
  .project({ studentId: 1, feeHead: 1, academicYear: 1, studentYear: 1, amount: 1, remarks: 1 })
  .toArray();
console.log('2025* rows:', JSON.stringify(multi, null, 2));
const trn = await db
  .collection('studentfees')
  .find({ feeHead: '6996e24c2e1678e39883918a', studentYear: { $gt: 1 } })
  .limit(5)
  .toArray();
console.log('TRN01 year>1:', JSON.stringify(trn, null, 2));
await mongoose.disconnect();
