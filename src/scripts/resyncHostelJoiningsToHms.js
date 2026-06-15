/**
 * Resync hostel joinings from Admissions CRM into HMS with the corrected sync format.
 * Also repairs existing HMS users created by admissions_crm.
 *
 * Usage:
 *   node src/scripts/resyncHostelJoiningsToHms.js
 *   node src/scripts/resyncHostelJoiningsToHms.js --apply
 *   node src/scripts/resyncHostelJoiningsToHms.js --apply --admission-number=20260281
 *   node src/scripts/resyncHostelJoiningsToHms.js --apply --year=2026
 */
import dns from 'dns';
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { connectHostel } from '../config-mongo/hostel.js';
import { syncJoiningHostelToHmsMongo } from '../services/joiningAccommodationSync.service.js';
import {
  normalizeBrokenHostelRefField,
  resolveHmsTermFees,
  resolveNextBedAndLocker,
  upsertHostelRoomOccupancyHistory,
} from '../utils/hostelHmsSync.util.js';
import {
  assignHostelStudentId,
  peekNextHostelStudentId,
} from '../utils/hostelStudentId.util.js';
import { normalizeCalendarAcademicYear } from '../utils/transportApplicationNumber.util.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ADMISSION_FILTER = (() => {
  const arg = process.argv.find((a) => a.startsWith('--admission-number='));
  return arg ? arg.split('=')[1]?.trim() || null : null;
})();
const YEAR_FILTER = (() => {
  const arg = process.argv.find((a) => a.startsWith('--year='));
  return arg ? arg.split('=')[1]?.trim() || null : null;
})();

const parseJson = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
};

const sanitizeStudentFeeDetailsForDb = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const batch =
    raw.batch != null && String(raw.batch).trim() !== ''
      ? String(raw.batch).trim().slice(0, 32)
      : undefined;
  const linesIn = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = linesIn
    .map((line) => {
      const structureId = String(line?.structureId ?? '').trim();
      if (!structureId) return null;
      let amount = null;
      if (line?.amount !== undefined && line?.amount !== null && line?.amount !== '') {
        const n = Number(line.amount);
        if (Number.isFinite(n) && n >= 0) amount = n;
      }
      const remarks = typeof line?.remarks === 'string' ? line.remarks.trim().slice(0, 2000) : '';
      return { structureId, amount, remarks };
    })
    .filter(Boolean);
  if (lines.length === 0 && !batch) return null;
  return { ...(batch ? { batch } : {}), lines };
};

const resolveIntakeBatchFromExtras = (registrationExtras, studentFeeDetails, admissionNumber = '') => {
  const fromFees = normalizeCalendarAcademicYear(studentFeeDetails?.batch ?? '');
  if (fromFees) return fromFees;
  const fromExtras = normalizeCalendarAcademicYear(
    registrationExtras?.academic_year ?? registrationExtras?.academicYear ?? ''
  );
  if (fromExtras) return fromExtras;
  const adm = String(admissionNumber || '').trim();
  if (/^20\d{2}/.test(adm)) return adm.slice(0, 4);
  return '';
};

const buildJoiningContext = (joiningRow, studentFeeDetails, registrationExtras, admissionNumber) => ({
  course: joiningRow?.course || '',
  branch: joiningRow?.branch || '',
  quota: joiningRow?.quota || '',
  batch:
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim()
      : '',
  admissionNumber: admissionNumber || '',
  studentName: joiningRow?.student_name || '',
  studentPhone: joiningRow?.student_phone || '',
  studentGender: joiningRow?.student_gender || '',
  fatherPhone: joiningRow?.father_phone || '',
  managedCourseId: joiningRow?.managed_course_id ?? null,
  collegeId:
    registrationExtras?.college_id ??
    registrationExtras?.collegeId ??
    registrationExtras?.school_or_college_id ??
    null,
  transportDetails:
    registrationExtras?.transport_details &&
    typeof registrationExtras.transport_details === 'object'
      ? registrationExtras.transport_details
      : null,
  intakeBatch: resolveIntakeBatchFromExtras(
    registrationExtras,
    studentFeeDetails,
    admissionNumber
  ),
});

const buildHostelPortalLines = (transportDetails) => {
  const byYear = transportDetails?.hostelFeesByYear;
  if (Array.isArray(byYear) && byYear.length > 0) {
    return byYear.map((row) => ({
      accommodationType: 'hostel',
      studentYear: row.studentYear,
      actualAmount: row.amount,
      revisedAmount: row.amount,
    }));
  }
  if (transportDetails?.hostelFee != null) {
    return [{
      accommodationType: 'hostel',
      studentYear: 1,
      actualAmount: Number(transportDetails.hostelFee),
      revisedAmount: Number(transportDetails.hostelFee),
    }];
  }
  return [{ accommodationType: 'hostel', actualAmount: 0, revisedAmount: 0 }];
};

async function repairExistingHmsUsers(db, apply) {
  const users = db.collection('users');
  const candidates = await users
    .find({
      $or: [
        { source: 'admissions_crm' },
        { hostel: { $type: 'object' } },
        { hostelCategory: { $type: 'object' } },
        { room: { $type: 'object' } },
        { hostelId: { $in: [null, ''] } },
        { hostelId: { $exists: false } },
      ],
    })
    .toArray();

  const repairs = [];
  for (const user of candidates) {
    const hostel = normalizeBrokenHostelRefField(user.hostel);
    const hostelCategory = normalizeBrokenHostelRefField(user.hostelCategory);
    const room = normalizeBrokenHostelRefField(user.room);
    const broken =
      (user.hostel && typeof user.hostel === 'object' && user.hostel.$in) ||
      (user.hostelCategory && typeof user.hostelCategory === 'object' && user.hostelCategory.$in) ||
      (user.room && typeof user.room === 'object' && user.room.$in);

    let hostelId = user.hostelId;
    if (!hostelId && hostel && user.academicYear) {
      const assignment = apply
        ? await assignHostelStudentId(db, {
            hostelObjectId: String(hostel),
            academicYear: user.academicYear,
            gender: user.gender,
          })
        : await peekNextHostelStudentId(db, {
            hostelObjectId: String(hostel),
            academicYear: user.academicYear,
            gender: user.gender,
          });
      hostelId = assignment.hostelId;
    }

    const termFees = await resolveHmsTermFees(db, {
      academicYear: user.academicYear,
      course: user.course,
      categoryName: user.category,
      studentYear: user.year || user.yearOfStudy || 1,
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
      hostelId,
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
      source: user.source || 'native',
      broken,
      hostelId,
      patch,
    };
    repairs.push(entry);

    if (apply) {
      await users.updateOne({ _id: user._id }, { $set: patch });
      if (room && user.academicYear) {
        await upsertHostelRoomOccupancyHistory(db, {
          studentUserId: user._id,
          studentName: user.name,
          rollNumber: user.rollNumber || '',
          course: user.course || '',
          branch: user.branch || '',
          yearOfStudy: user.year || 1,
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
  }

  return repairs;
}

async function loadHostelJoinings(pool) {
  const params = [];
  const filters = [`a.status != 'Admission Cancelled'`];
  if (ADMISSION_FILTER) {
    filters.push('a.admission_number = ?');
    params.push(ADMISSION_FILTER);
  }
  if (YEAR_FILTER) {
    filters.push('a.admission_number LIKE ?');
    params.push(`${YEAR_FILTER}%`);
  }

  const [rows] = await pool.execute(
    `
    SELECT
      a.admission_number,
      j.id AS joining_id,
      j.lead_id,
      j.course,
      j.branch,
      j.quota,
      j.student_name,
      j.student_phone,
      j.student_gender,
      j.father_phone,
      j.managed_course_id,
      j.lead_data AS joining_lead_data
    FROM admissions a
    INNER JOIN joinings j ON j.id = a.joining_id
    WHERE ${filters.join(' AND ')}
    ORDER BY a.admission_number
    `,
    params
  );

  const targets = [];
  for (const row of rows) {
    const leadData = parseJson(row.joining_lead_data);
    const registrationExtras = parseJson(leadData?._joiningRegistrationExtras);
    const studentFeeDetails = sanitizeStudentFeeDetailsForDb(leadData?._joiningStudentFeeDetails);
    const transport = registrationExtras?.transport_details;
    if (!transport || transport.accommodationType !== 'hostel') continue;
    if (!transport.hostelId || !transport.categoryId) continue;

    const admissionNumber = String(row.admission_number || '').trim();
    targets.push({
      joiningId: row.joining_id,
      leadId: row.lead_id,
      admissionNumber,
      joiningContext: buildJoiningContext(
        row,
        studentFeeDetails,
        registrationExtras,
        admissionNumber
      ),
      portalLines: buildHostelPortalLines(transport),
      transport,
    });
  }
  return targets;
}

async function main() {
  if (!process.env.HOSTEL_MONGO_URI?.trim()) {
    console.error('HOSTEL_MONGO_URI is not set');
    process.exit(1);
  }

  const pool = getPool();
  await connectHostel();
  const db = (await import('../config-mongo/hostel.js')).getHostelConnection().db;

  const repairs = await repairExistingHmsUsers(db, APPLY);
  const targets = await loadHostelJoinings(pool);

  const resyncReport = [];
  for (const target of targets) {
    const before = await db.collection('users').findOne({
      admissionNumber: target.admissionNumber,
    });
    let result = { skipped: true, reason: 'dry-run' };
    if (APPLY) {
      result = await syncJoiningHostelToHmsMongo({
        joiningId: target.joiningId,
        leadId: target.leadId,
        joiningContext: target.joiningContext,
        hostelLines: target.portalLines,
      });
    }
    const after = APPLY
      ? await db.collection('users').findOne({ admissionNumber: target.admissionNumber })
      : before;

    resyncReport.push({
      admissionNumber: target.admissionNumber,
      studentName: target.joiningContext.studentName,
      academicYear: target.transport?.academicYear,
      hostelIdBefore: before?.hostelId || null,
      hostelIdAfter: after?.hostelId || (APPLY ? result?.hostelId : null),
      hadBrokenRefs: Boolean(
        before?.hostel?.$in || before?.hostelCategory?.$in || before?.room?.$in
      ),
      assignment: result,
    });
  }

  console.log(
    JSON.stringify(
      {
        apply: APPLY,
        hmsRepairs: repairs.length,
        repairs,
        hostelJoiningsFound: targets.length,
        resyncReport,
      },
      null,
      2
    )
  );

  await closeDB();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
