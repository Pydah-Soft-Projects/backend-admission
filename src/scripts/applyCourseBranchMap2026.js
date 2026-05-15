/**
 * Apply course/branch canonical labels + secondary managed ids for all 2026 admissions.
 *
 *   node src/scripts/applyCourseBranchMap2026.js --dry-run
 *   node src/scripts/applyCourseBranchMap2026.js --apply
 */
import dotenv from 'dotenv';
import { loadMasterRowsFromExcel } from './importAdmissionsMasterFromExcel.js';
import { mapCourseAndBranch, resolveSecondaryManagedIds } from '../data/admissionsCourseBranchMap2026.js';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { formatAdmission } from '../controllers/admission.controller.js';
import { syncToSecondaryDatabase } from '../utils/studentSync.util.js';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const master = loadMasterRowsFromExcel();
  const pool = getPool();
  const secondary = getSecondaryPool();
  const conn = await pool.getConnection();

  const changes = [];
  const notFound = [];

  try {
    if (apply) await conn.beginTransaction();

    for (const row of master) {
      const mapped = mapCourseAndBranch(row.course, row.branch);
      const ids = resolveSecondaryManagedIds(row.course, row.branch);

      const [adm] = await conn.execute(
        'SELECT id, admission_number, course, branch, joining_id, lead_id, managed_course_id, managed_branch_id FROM admissions WHERE admission_number = ? LIMIT 1',
        [row.admissionNumber]
      );
      if (!adm.length) {
        notFound.push(row.admissionNumber);
        continue;
      }
      const a = adm[0];
      const before = {
        course: a.course,
        branch: a.branch,
        managed_course_id: a.managed_course_id,
        managed_branch_id: a.managed_branch_id,
      };
      const after = {
        course: ids.course,
        branch: ids.branch,
        managed_course_id: ids.managedCourseId,
        managed_branch_id: ids.managedBranchId,
      };

      if (
        before.course !== after.course ||
        before.branch !== after.branch ||
        String(before.managed_course_id || '') !== String(after.managed_course_id || '') ||
        String(before.managed_branch_id || '') !== String(after.managed_branch_id || '')
      ) {
        changes.push({ admissionNumber: row.admissionNumber, studentName: row.studentName, before, after });
      }

      if (apply) {
        await conn.execute(
          `UPDATE admissions SET course = ?, branch = ?, managed_course_id = ?, managed_branch_id = ?, updated_at = NOW() WHERE id = ?`,
          [after.course, after.branch, after.managed_course_id, after.managed_branch_id, a.id]
        );
        if (a.joining_id) {
          await conn.execute(
            `UPDATE joinings SET course = ?, branch = ?, managed_course_id = ?, managed_branch_id = ?,
             lead_data = JSON_SET(
               COALESCE(CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END, JSON_OBJECT()),
               '$.course', ?, '$.branch', ?, '$.courseInterested', ?
             ), updated_at = NOW() WHERE id = ?`,
            [
              after.course,
              after.branch,
              after.managed_course_id,
              after.managed_branch_id,
              after.course,
              after.branch,
              after.course,
              a.joining_id,
            ]
          );
        }
        if (a.lead_id) {
          await conn.execute(
            `UPDATE leads SET course_interested = ?, updated_at = NOW() WHERE id = ?`,
            [`${after.course} - ${after.branch}`, a.lead_id]
          );
        }
        await secondary.execute(
          `UPDATE students SET course = ?, branch = ?, updated_at = NOW() WHERE admission_number = ?`,
          [after.course, after.branch, row.admissionNumber]
        );
      }
    }

    if (apply) await conn.commit();

    const resyncOnly = process.argv.includes('--resync-all');
    if (apply && resyncOnly) {
      for (const row of master) {
        try {
          const [r] = await pool.execute('SELECT * FROM admissions WHERE admission_number = ? LIMIT 1', [
            row.admissionNumber,
          ]);
          if (!r.length) continue;
          const formatted = await formatAdmission(r[0], pool);
          await syncToSecondaryDatabase(formatted, row.admissionNumber, {
            leadId: r[0].lead_id,
            joiningId: r[0].joining_id,
          });
        } catch (e) {
          console.warn(`Resync ${row.admissionNumber}:`, e.message);
        }
      }
    }

    const [courseCounts] = await conn.execute(
      `SELECT course, branch, COUNT(1) c FROM admissions WHERE admission_number LIKE '2026%'
       GROUP BY course, branch ORDER BY course, branch`
    );

    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          masterRows: master.length,
          changes: changes.length,
          notFound,
          sampleChanges: changes.slice(0, 15),
          finalCourseBranch: courseCounts,
        },
        null,
        2
      )
    );
  } catch (e) {
    if (apply) await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
