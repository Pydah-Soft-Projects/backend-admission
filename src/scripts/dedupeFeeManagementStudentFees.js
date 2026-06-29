/**
 * Remove duplicate CRM-synced Fee Management studentfees rows.
 *
 * Usage:
 *   node src/scripts/dedupeFeeManagementStudentFees.js
 *   node src/scripts/dedupeFeeManagementStudentFees.js --apply
 *   node src/scripts/dedupeFeeManagementStudentFees.js --admissionNumber=20251139 --apply
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const admissionArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--admissionNumber='))
  ?.split('=')[1]
  ?.trim();

const normalizePart = (value) =>
  value === undefined || value === null || value === '' ? 'null' : String(value).trim();

const duplicateKeyFor = (doc) =>
  [
    normalizePart(doc.studentId),
    normalizePart(doc.feeHead),
    normalizePart(doc.academicYear),
    normalizePart(doc.studentYear),
    normalizePart(doc.semester),
    normalizePart(doc.remarks),
  ].join('|');

const getTime = (value) => {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
};

const sortRowsForSurvivor = (a, b) =>
  getTime(b.updatedAt) - getTime(a.updatedAt) ||
  getTime(b.createdAt) - getTime(a.createdAt) ||
  String(b._id).localeCompare(String(a._id));

if (!process.env.FEE_MANAGEMENT_MONGO_URI?.trim()) {
  throw new Error('FEE_MANAGEMENT_MONGO_URI is not configured');
}

await mongoose.connect(process.env.FEE_MANAGEMENT_MONGO_URI);
const db = mongoose.connection.db;
const coll = db.collection('studentfees');

let studentIds = [];
if (admissionArg) {
  studentIds = [admissionArg];
} else {
  studentIds = (
    await db.collection('crm_joining_student_fee_details').distinct('admissionNumber')
  )
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

const query = admissionArg
  ? { studentId: admissionArg }
  : {
      $or: [
        { source: 'admissions_crm' },
        { sourceKey: /^admissions_crm\|/ },
        { studentId: { $in: studentIds } },
      ],
    };

const rows = await coll.find(query).toArray();
const groups = new Map();
for (const row of rows) {
  const key = duplicateKeyFor(row);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const duplicateGroups = [...groups.entries()]
  .map(([key, groupRows]) => {
    const sorted = [...groupRows].sort(sortRowsForSurvivor);
    return {
      key,
      survivor: sorted[0],
      duplicates: sorted.slice(1),
    };
  })
  .filter((group) => group.duplicates.length > 0);

let deletedCount = 0;
if (apply) {
  const idsToDelete = duplicateGroups.flatMap((group) => group.duplicates.map((row) => row._id));
  if (idsToDelete.length > 0) {
    const result = await coll.deleteMany({ _id: { $in: idsToDelete } });
    deletedCount = result.deletedCount || 0;
  }
}

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      admissionNumber: admissionArg || '(CRM-synced students)',
      scannedRows: rows.length,
      duplicateGroups: duplicateGroups.length,
      duplicateRows: duplicateGroups.reduce((sum, group) => sum + group.duplicates.length, 0),
      deletedRows: deletedCount,
      sampleGroups: duplicateGroups.slice(0, 10).map((group) => ({
        key: group.key,
        keptId: String(group.survivor._id),
        duplicateIds: group.duplicates.map((row) => String(row._id)),
      })),
    },
    null,
    2
  )
);

await mongoose.disconnect();
