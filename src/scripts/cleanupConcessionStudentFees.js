/**
 * Remove/revert Fee Management studentfees rows that came from the CRM concessions builder.
 *
 * Concessions/revised fee data belongs in SQL secondary `overall_concessions`.
 * Fee Mongo `studentfees` should keep only configured catalog/accommodation fees.
 *
 * Usage:
 *   node src/scripts/cleanupConcessionStudentFees.js
 *   node src/scripts/cleanupConcessionStudentFees.js --apply
 *   node src/scripts/cleanupConcessionStudentFees.js --admissionNumber=20251139 --apply
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const { Types: { ObjectId } } = mongoose;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const admissionArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--admissionNumber='))
  ?.split('=')[1]
  ?.trim();

const toObjectId = (value) => {
  try {
    return new ObjectId(String(value || '').trim());
  } catch {
    return null;
  }
};

const feeHeadValues = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const objectId = toObjectId(raw);
  return objectId ? [raw, objectId] : [raw];
};

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
const crm = db.collection('crm_joining_student_fee_details');
const studentfees = db.collection('studentfees');

const crmQuery = admissionArg ? { admissionNumber: admissionArg } : {};
const mirrors = await crm.find(crmQuery).toArray();

let inspectedLines = 0;
let rowsMatched = 0;
let rowsToDelete = 0;
let rowsDeleted = 0;
let rowsToRestore = 0;
let rowsRestored = 0;
const samples = [];

for (const mirror of mirrors) {
  const admissionNumber = String(mirror.admissionNumber || '').trim();
  if (!admissionNumber || !Array.isArray(mirror.lines)) continue;

  for (const line of mirror.lines) {
    const isConcessionLine =
      line?.concessionType === 'CONCESSION' ||
      line?.concessionType === 'REVISED_FEE' ||
      line?.isRevised === true;
    if (!isConcessionLine) continue;

    inspectedLines += 1;
    const feeHeadMatches = feeHeadValues(line.feeHeadId);
    if (feeHeadMatches.length === 0) continue;

    const studentYear = Number(line.studentYear) > 0 ? Number(line.studentYear) : 1;
    const actualAmount = Number(line.actualAmount) || 0;
    const matchQuery = {
      studentId: admissionNumber,
      feeHead: { $in: feeHeadMatches },
      studentYear: { $in: [studentYear, String(studentYear)] },
    };
    const existingRows = await studentfees
      .find(matchQuery)
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .toArray();
    if (existingRows.length === 0) continue;

    rowsMatched += existingRows.length;
    if (actualAmount <= 0) {
      rowsToDelete += existingRows.length;
      if (apply) {
        const result = await studentfees.deleteMany({ _id: { $in: existingRows.map((row) => row._id) } });
        rowsDeleted += result.deletedCount || 0;
      }
      if (samples.length < 10) {
        samples.push({
          action: 'delete-builder-only',
          admissionNumber,
          feeHeadId: String(line.feeHeadId || ''),
          studentYear,
          matchedIds: existingRows.map((row) => String(row._id)),
        });
      }
      continue;
    }

    const sortedRows = [...existingRows].sort(sortRowsForSurvivor);
    const survivor = sortedRows[0];
    const duplicates = sortedRows.slice(1);
    const needsRestore = Number(survivor.amount) !== actualAmount;
    if (needsRestore) rowsToRestore += 1;
    rowsToDelete += duplicates.length;

    if (apply) {
      if (duplicates.length > 0) {
        const deleteResult = await studentfees.deleteMany({
          _id: { $in: duplicates.map((row) => row._id) },
        });
        rowsDeleted += deleteResult.deletedCount || 0;
      }
      if (needsRestore) {
        const updateResult = await studentfees.updateOne(
          { _id: survivor._id },
          {
            $set: {
              amount: actualAmount,
              updatedAt: new Date(),
            },
            $unset: {
              concessionType: '',
              revisedAmount: '',
              concessionAmount: '',
            },
          },
        );
        rowsRestored += updateResult.modifiedCount || 0;
      }
    }

    if ((needsRestore || duplicates.length > 0) && samples.length < 10) {
      samples.push({
        action: 'restore-configured-amount',
        admissionNumber,
        feeHeadId: String(line.feeHeadId || ''),
        studentYear,
        actualAmount,
        keptId: String(survivor._id),
        duplicateIds: duplicates.map((row) => String(row._id)),
      });
    }
  }
}

console.log(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      admissionNumber: admissionArg || '(all CRM mirrors)',
      mirrorsScanned: mirrors.length,
      concessionLinesInspected: inspectedLines,
      studentFeeRowsMatched: rowsMatched,
      rowsToRestore,
      rowsRestored,
      rowsToDelete,
      rowsDeleted,
      sampleActions: samples,
    },
    null,
    2
  )
);

await mongoose.disconnect();
