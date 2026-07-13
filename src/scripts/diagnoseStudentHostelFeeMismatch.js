/**
 * Diagnose hostel fee mismatch between Admissions Step 3 and HMS portal.
 *
 * Usage:
 *   node src/scripts/diagnoseStudentHostelFeeMismatch.js --name="P.PREETHI SADGUNAVATHI"
 *   node src/scripts/diagnoseStudentHostelFeeMismatch.js --admission-number=2026xxxx
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import mysql from 'mysql2/promise';
import { connectHostel } from '../config-mongo/hostel.js';
import { getPool, closeDB } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { calendarYearToAcademicYearSession } from '../utils/transportApplicationNumber.util.js';
import { mapCourseLabel } from '../data/admissionsCourseBranchMap2026.js';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const { ObjectId } = mongoose.Types;

const nameArg = process.argv.find((a) => a.startsWith('--name='))?.split('=').slice(1).join('=').trim();
const admissionArg = process.argv.find((a) => a.startsWith('--admission-number='))?.split('=')[1]?.trim();

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

const sumHmsFeePortalAmount = (doc) => {
  const termTotal =
    (Number(doc.term1Fee) || 0) + (Number(doc.term2Fee) || 0) + (Number(doc.term3Fee) || 0);
  let additionalTotal = 0;
  const additional = doc.additionalFees;
  if (additional && typeof additional === 'object' && !Array.isArray(additional)) {
    for (const value of Object.values(additional)) {
      additionalTotal += Number(value) || 0;
    }
  }
  const total = termTotal + additionalTotal;
  return Number.isFinite(total) && total > 0 ? total : null;
};

const refMatch = (value) => {
  const raw = String(value || '').trim();
  let oid = null;
  try {
    if (/^[a-fA-F0-9]{24}$/.test(raw)) oid = new ObjectId(raw);
  } catch {
    oid = null;
  }
  const keys = new Set([raw]);
  if (oid) keys.add(oid);
  return { $in: [...keys] };
};

async function loadStudentContext(primary, name, admissionNumber) {
  let sql = `SELECT a.admission_number, a.student_name, a.course, a.branch, a.joining_id,
                    a.lead_data, j.lead_data AS joining_lead_data, j.quota
             FROM admissions a
             LEFT JOIN joinings j ON j.id = a.joining_id
             WHERE `;
  const params = [];
  if (admissionNumber) {
    sql += 'a.admission_number = ?';
    params.push(admissionNumber);
  } else {
    sql += 'UPPER(TRIM(a.student_name)) LIKE UPPER(?)';
    params.push(`%${name}%`);
  }
  sql += ' ORDER BY a.updated_at DESC LIMIT 3';
  const [rows] = await primary.execute(sql, params);
  return rows;
}

async function diagnoseHostelFees(db, { hostelId, categoryId, academicYear, course, totalYears = 4 }) {
  const baseQuery = { hostel: refMatch(hostelId), category: refMatch(categoryId) };
  const courseRegex = course ? new RegExp(`^${String(course).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null;

  const legacyAttempts = [];
  if (academicYear && courseRegex) {
    legacyAttempts.push({ label: 'legacy: year+course', query: { ...baseQuery, academicYear, course: courseRegex } });
  }
  if (academicYear) {
    legacyAttempts.push({ label: 'legacy: year only', query: { ...baseQuery, academicYear } });
  }

  const legacyHits = [];
  for (const attempt of legacyAttempts) {
    const docs = await db.collection('hostelfeestructures').find(attempt.query).toArray();
    if (docs.length > 0) {
      legacyHits.push({
        attempt: attempt.label,
        count: docs.length,
        rows: docs.map((d) => ({
          _id: String(d._id),
          amount: d.amount,
          course: d.course,
          studentYear: d.studentYear ?? null,
          academicYear: d.academicYear,
        })),
      });
    }
  }

  const category = await db.collection('hostelcategories').findOne({ _id: refMatch(categoryId).$in[0] });
  const categoryName = String(category?.name || '').trim();

  const portalQuery = {
    academicYear,
    category: categoryName,
    isActive: { $ne: false },
  };
  if (course) {
    const mapped = mapCourseLabel(course);
    portalQuery.$or = [
      { course: new RegExp(`^${String(course).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      ...(mapped
        ? [{ course: new RegExp(`^${String(mapped).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }]
        : []),
    ];
  }

  const portalDocs = categoryName
    ? await db.collection('feestructures').find(portalQuery).toArray()
    : [];

  return {
    categoryName,
    legacyHits,
    portalRows: portalDocs.map((d) => ({
      _id: String(d._id),
      course: typeof d.course === 'object' ? String(d.course) : d.course,
      category: d.category,
      year: d.year ?? null,
      term1Fee: d.term1Fee ?? null,
      term2Fee: d.term2Fee ?? null,
      term3Fee: d.term3Fee ?? null,
      additionalFees: d.additionalFees ?? null,
      computedTotal: sumHmsFeePortalAmount(d),
      academicYear: d.academicYear,
    })),
    admissionsWouldUse: legacyHits[0]?.rows?.[0]?.amount ?? portalRowsFirstAmount(portalDocs),
    hmsPortalWouldShow: portalRowsFirstAmount(portalDocs) ?? legacyHits[0]?.rows?.[0]?.amount,
  };
}

function portalRowsFirstAmount(portalDocs) {
  if (!portalDocs?.length) return null;
  return sumHmsFeePortalAmount(portalDocs[0]);
}

async function main() {
  if (!nameArg && !admissionArg) {
    console.error('Pass --name="STUDENT NAME" or --admission-number=XXXXXXXX');
    process.exit(1);
  }

  const primary = await getPool();
  const secondary = getSecondaryPool();
  const hostelConn = await connectHostel();
  const hdb = hostelConn.db;

  const students = await loadStudentContext(primary, nameArg, admissionArg);
  if (!students.length) {
    console.error('No matching admission found.');
    process.exit(1);
  }

  for (const row of students) {
    const admLead = parseJson(row.lead_data);
    const joinLead = parseJson(row.joining_lead_data);
    const reg =
      joinLead._joiningRegistrationExtras ||
      admLead._joiningRegistrationExtras ||
      {};
    const transport =
      reg.transport_details && typeof reg.transport_details === 'object'
        ? reg.transport_details
        : {};

    const academicYearCalendar =
      String(reg.academic_year ?? reg.academicYear ?? '').trim() ||
      String(transport.academicYear || '').slice(0, 4);
    const academicSession =
      transport.academicYear ||
      (academicYearCalendar ? calendarYearToAcademicYearSession(academicYearCalendar) : '');

    console.log('\n' + '='.repeat(72));
    console.log('STUDENT:', row.student_name);
    console.log('Admission:', row.admission_number);
    console.log('Course:', row.course, '/', row.branch);
    console.log('Academic session:', academicSession || '(unknown)');
    console.log('Step 3 transport_details:', JSON.stringify(transport, null, 2));

    const [transportReq] = await secondary.execute(
      `SELECT application_number, academic_year, route_name, stage_name, fare, bus_id, status
       FROM transport_requests
       WHERE admission_number = ?
       ORDER BY updated_at DESC LIMIT 3`,
      [row.admission_number]
    );
    console.log('\n--- Secondary transport_requests ---');
    console.log(JSON.stringify(transportReq, null, 2));

    const hmsUser = await hdb.collection('users').findOne({ admissionNumber: row.admission_number });
    console.log('\n--- HMS users row ---');
    if (hmsUser) {
      console.log(
        JSON.stringify(
          {
            _id: String(hmsUser._id),
            hostelId: hmsUser.hostelId,
            roomNumber: hmsUser.roomNumber,
            bedNumber: hmsUser.bedNumber,
            academicYear: hmsUser.academicYear,
            hostel: hmsUser.hostel ? String(hmsUser.hostel) : null,
            category: hmsUser.category ? String(hmsUser.category) : null,
          },
          null,
          2
        )
      );
    } else {
      console.log('(not registered in HMS users)');
    }

    const hostelId = transport.hostelId || (hmsUser?.hostel ? String(hmsUser.hostel) : null);
    const categoryId = transport.categoryId || (hmsUser?.category ? String(hmsUser.category) : null);

    if (!hostelId || !categoryId || !academicSession) {
      console.log('\nSkipping fee lookup — missing hostelId/categoryId/academicYear.');
      continue;
    }

    const hostelDoc = await hdb.collection('hostels').findOne({ _id: refMatch(hostelId).$in[0] });
    const categoryDoc = await hdb.collection('hostelcategories').findOne({ _id: refMatch(categoryId).$in[0] });

    console.log('\n--- Resolved hostel/category ---');
    console.log('Hostel:', hostelDoc?.name, `(id ${hostelId})`);
    console.log('Category:', categoryDoc?.name, `(id ${categoryId})`);

    const feeDiag = await diagnoseHostelFees(hdb, {
      hostelId,
      categoryId,
      academicYear: academicSession,
      course: row.course,
      totalYears: Number(reg.program_total_years ?? reg.programTotalYears) || 4,
    });

    console.log('\n--- Fee source comparison ---');
    console.log(JSON.stringify(feeDiag, null, 2));

    const step3Stored = transport.hostelFeesByYear || [];
    const step3First = transport.hostelFee ?? step3Stored[0]?.amount ?? null;

    console.log('\n--- Summary ---');
    console.log('Stored in joining (Step 3):', step3First, step3Stored.length ? step3Stored : '');
    console.log('Admissions API would pick (legacy first):', feeDiag.admissionsWouldUse);
    console.log('HMS feestructures computed total:', feeDiag.portalRows[0]?.computedTotal ?? 'n/a');

    if (
      feeDiag.legacyHits.length > 0 &&
      feeDiag.portalRows.length > 0 &&
      feeDiag.legacyHits[0].rows[0]?.amount !== feeDiag.portalRows[0]?.computedTotal
    ) {
      console.log('\nLIKELY CAUSE: Admissions uses hostelfeestructures (legacy) first.');
      console.log(
        `Legacy amount ${feeDiag.legacyHits[0].rows[0]?.amount} vs HMS portal feestructures ${feeDiag.portalRows[0]?.computedTotal}.`
      );
      console.log('HMS UI shows feestructures; Step 3 shows legacy hostelfeestructures.');
    } else if (feeDiag.portalRows[0]?.computedTotal) {
      const t = feeDiag.portalRows[0];
      const parts = [t.term1Fee, t.term2Fee, t.term3Fee].filter((x) => x != null);
      if (parts.length > 1 && Number(t.computedTotal) !== Number(parts[0])) {
        console.log('\nLIKELY CAUSE: HMS portal sums term fees:', parts.join(' + '), '=', t.computedTotal);
      }
    }
  }

  await closeDB();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
