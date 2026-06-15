/**
 * Backfill missing HMS `users.hostelId` values (BH26001 / GH25015 format).
 *
 * Usage:
 *   node src/scripts/backfillHostelStudentIds.js
 *   node src/scripts/backfillHostelStudentIds.js --apply
 *   node src/scripts/backfillHostelStudentIds.js --apply --admission-number=20260281
 */
import dotenv from 'dotenv';
import { connectHostel } from '../config-mongo/hostel.js';
import {
  assignHostelStudentId,
  isValidHostelStudentId,
  peekNextHostelStudentId,
} from '../utils/hostelStudentId.util.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const admissionFilter = (() => {
  const arg = process.argv.find((value) => value.startsWith('--admission-number='));
  return arg ? arg.split('=')[1]?.trim() : '';
})();

const uri = process.env.HOSTEL_MONGO_URI?.trim();
if (!uri) {
  console.error('HOSTEL_MONGO_URI is not set');
  process.exit(1);
}

const conn = await connectHostel();
const db = conn.db;
const users = db.collection('users');

const query = {
  $or: [{ hostelId: { $exists: false } }, { hostelId: null }, { hostelId: '' }],
  hostel: { $exists: true, $ne: null },
};
if (admissionFilter) {
  query.admissionNumber = admissionFilter;
}

const rows = await users.find(query).toArray();
console.log(`Found ${rows.length} hostel user(s) missing hostelId${apply ? ' — applying' : ' — dry run'}.`);

const report = [];

for (const user of rows) {
  try {
    const assignment = apply
      ? await assignHostelStudentId(db, {
          hostelObjectId: user.hostel,
          academicYear: user.academicYear,
          gender: user.gender,
          existingHostelId: user.hostelId,
        })
      : await peekNextHostelStudentId(db, {
          hostelObjectId: user.hostel,
          academicYear: user.academicYear,
          gender: user.gender,
        });

    const entry = {
      _id: String(user._id),
      name: user.name || '',
      admissionNumber: user.admissionNumber || '',
      academicYear: user.academicYear || '',
      source: user.source || '',
      hostelId: assignment.hostelId,
      assigned: apply,
      counterKey: assignment.counterKey,
    };
    report.push(entry);

    if (apply) {
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            hostelId: assignment.hostelId,
            updatedAt: new Date(),
          },
        }
      );
    }
  } catch (error) {
    report.push({
      _id: String(user._id),
      name: user.name || '',
      admissionNumber: user.admissionNumber || '',
      error: error.message || String(error),
    });
  }
}

console.log(JSON.stringify({ apply, updated: report.filter((row) => !row.error).length, report }, null, 2));

const invalidExisting = await users
  .find({ hostel: { $exists: true, $ne: null } })
  .project({ hostelId: 1, name: 1, admissionNumber: 1 })
  .toArray();
const badFormat = invalidExisting.filter((row) => row.hostelId && !isValidHostelStudentId(row.hostelId));
if (badFormat.length > 0) {
  console.log('\nUsers with non-standard hostelId format:', badFormat.length);
}

process.exit(0);
