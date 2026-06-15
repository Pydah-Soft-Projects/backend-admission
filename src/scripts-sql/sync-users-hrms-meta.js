/**
 * Link CRM users to HRMS employees and backfill designation from HRMS.
 *
 * Targets users who:
 * - have no hrms_id / emp_no, OR
 * - have an HRMS link but NULL designation (counselor / data entry / PRO roles).
 *
 * For unlinked users, matches HRMS employee by exact name (case-insensitive).
 *
 * Usage (dry-run):
 *   node src/scripts-sql/sync-users-hrms-meta.js
 *
 * Apply updates:
 *   node src/scripts-sql/sync-users-hrms-meta.js --apply
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { getPool, closeDB } from '../config-sql/database.js';
import { connectHRMS } from '../config-mongo/hrms.js';
import { fetchHrmsEmployeeMetaByLink } from '../controllers/user.controller.js';

dotenv.config();

const ROLES_WITH_DESIGNATION = new Set(['Student Counselor', 'Data Entry User', 'PRO']);

const normalizeNameKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

async function findHrmsEmployeeByName(name) {
  const nameKey = normalizeNameKey(name);
  if (!nameKey) return null;

  const hrmsConn = await connectHRMS();
  const Employee =
    hrmsConn.models.employees ||
    hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));

  const matches = await Employee.aggregate([
    {
      $addFields: {
        nameKey: {
          $toLower: {
            $trim: {
              input: { $ifNull: ['$employee_name', ''] },
            },
          },
        },
      },
    },
    { $match: { nameKey } },
    { $project: { _id: 1, emp_no: 1, employee_name: 1 } },
    { $limit: 5 },
  ]);

  if (!matches?.length) return null;
  if (matches.length > 1) {
    return { ambiguous: true, count: matches.length };
  }
  return { employee: matches[0] };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = getPool();

  const [users] = await pool.execute(
    `SELECT id, name, role_name, hrms_id, emp_no, designation
     FROM users
     WHERE is_active = 1
     ORDER BY name ASC`
  );

  const candidates = (users || []).filter((row) => {
    const hasLink =
      (row.hrms_id != null && String(row.hrms_id).trim() !== '') ||
      (row.emp_no != null && String(row.emp_no).trim() !== '');
    const needsDesignation =
      ROLES_WITH_DESIGNATION.has(row.role_name) &&
      (row.designation == null || String(row.designation).trim() === '');
    return !hasLink || needsDesignation;
  });

  console.log('\n=== Sync CRM users with HRMS (hrms_id / emp_no / designation) ===\n');
  console.log(`Mode: ${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`Active users: ${users.length}`);
  console.log(`Candidates: ${candidates.length}\n`);

  const planned = [];
  const skipped = [];

  for (const row of candidates) {
    const hasLink =
      (row.hrms_id != null && String(row.hrms_id).trim() !== '') ||
      (row.emp_no != null && String(row.emp_no).trim() !== '');

    let hrmsId = row.hrms_id;
    let empNo = row.emp_no;

    if (!hasLink) {
      const lookup = await findHrmsEmployeeByName(row.name);
      if (!lookup) {
        skipped.push({ name: row.name, reason: 'no_hrms_name_match' });
        continue;
      }
      if (lookup.ambiguous) {
        skipped.push({ name: row.name, reason: `ambiguous_hrms_name_match (${lookup.count})` });
        continue;
      }
      hrmsId = lookup.employee._id ? String(lookup.employee._id) : null;
      empNo = lookup.employee.emp_no != null ? String(lookup.employee.emp_no).trim() : null;
    }

    const meta = await fetchHrmsEmployeeMetaByLink({ hrms_id: hrmsId, emp_no: empNo }, 'sync-users-hrms-meta');
    if (!meta) {
      skipped.push({ name: row.name, reason: 'hrms_meta_not_found' });
      continue;
    }

    const nextHrmsId = meta.hrms_id || hrmsId || null;
    const nextEmpNo = meta.emp_no || empNo || null;
    const nextDesignation =
      ROLES_WITH_DESIGNATION.has(row.role_name) && meta.designation
        ? meta.designation
        : row.designation;

    const willUpdate =
      String(row.hrms_id ?? '') !== String(nextHrmsId ?? '') ||
      String(row.emp_no ?? '') !== String(nextEmpNo ?? '') ||
      (ROLES_WITH_DESIGNATION.has(row.role_name) &&
        String(row.designation ?? '') !== String(nextDesignation ?? ''));

    if (!willUpdate) {
      skipped.push({ name: row.name, reason: 'already_up_to_date' });
      continue;
    }

    planned.push({
      id: row.id,
      name: row.name,
      role: row.role_name,
      hrms_id: nextHrmsId,
      emp_no: nextEmpNo,
      department: meta.department,
      designation: nextDesignation,
    });
  }

  console.log(`Will update: ${planned.length}`);
  console.log(`Skipped: ${skipped.length}\n`);

  if (planned.length) {
    console.table(
      planned.slice(0, 30).map((p) => ({
        name: p.name,
        hrms_id: p.hrms_id,
        emp_no: p.emp_no,
        department: p.department,
        designation: p.designation,
      }))
    );
    if (planned.length > 30) {
      console.log(`... and ${planned.length - 30} more`);
    }
  }

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to write changes.\n');
    await closeDB();
    await mongoose.disconnect();
    return;
  }

  let applied = 0;
  for (const p of planned) {
    await pool.execute(
      `UPDATE users
       SET hrms_id = ?, emp_no = ?, designation = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        p.hrms_id,
        p.emp_no,
        ROLES_WITH_DESIGNATION.has(p.role) ? p.designation : null,
        p.id,
      ]
    );
    applied += 1;
  }

  console.log(`\nApplied updates: ${applied}\n`);
  await closeDB();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDB();
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
