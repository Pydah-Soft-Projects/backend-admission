/**
 * One-off: remove draft joining rows for a given student display name.
 *
 * Usage (from backend-admission):
 *   node src/scripts/cleanupDraftJoiningsByStudentName.js --dry-run
 *   node src/scripts/cleanupDraftJoiningsByStudentName.js --apply
 *
 * Default name: KASI PRASANNA KUMAR (override with --name "Other Name")
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { JOINING_STUDENT_FEE_MONGO_COLLECTION } from '../services/joiningStudentFeeMongoSync.service.js';

dotenv.config();

const TARGET_DEFAULT = 'KASI PRASANNA KUMAR';

function parseArgs(argv) {
  const out = { dryRun: true, name: TARGET_DEFAULT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.dryRun = false;
    if (a === '--dry-run') out.dryRun = true;
    if (a === '--name' && argv[i + 1]) {
      out.name = String(argv[++i]).trim();
    }
  }
  return out;
}

function normName(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

async function main() {
  const { dryRun, name } = parseArgs(process.argv);
  const target = normName(name);
  if (!target) {
    console.error('Empty --name');
    process.exit(1);
  }

  const pool = getPool();

  const targetLower = target.toLowerCase();

  const [candidates] = await pool.execute(
    `SELECT j.id, j.status, j.student_name, j.lead_id,
            JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.name')) AS lead_data_name,
            l.name AS lead_table_name,
            (SELECT COUNT(*) FROM admissions a WHERE a.joining_id = j.id) AS admission_count
     FROM joinings j
     LEFT JOIN leads l ON j.lead_id = l.id
     WHERE j.status = 'draft'
       AND (
         LOWER(TRIM(COALESCE(j.student_name, ''))) = ?
         OR LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$.name')), ''))) = ?
         OR LOWER(TRIM(COALESCE(l.name, ''))) = ?
       )`,
    [targetLower, targetLower, targetLower]
  );

  const rows = candidates.filter((r) =>
    [r.student_name, r.lead_data_name, r.lead_table_name].some((v) => normName(v) === target)
  );

  const blocked = rows.filter((r) => Number(r.admission_count) > 0);
  const deletable = rows.filter((r) => Number(r.admission_count) === 0);

  console.log(
    JSON.stringify(
      {
        dryRun,
        targetName: name,
        candidatesFromSql: candidates.length,
        matchedAfterNormalize: rows.length,
        blockedByAdmission: blocked.length,
        toDelete: deletable.length,
        ids: deletable.map((r) => r.id),
        blockedIds: blocked.map((r) => r.id),
      },
      null,
      2
    )
  );

  if (dryRun || deletable.length === 0) {
    if (blocked.length) {
      console.warn(
        'Skipped joinings linked to admissions (delete manually if needed):',
        blocked.map((b) => ({ id: b.id, admission_count: b.admission_count }))
      );
    }
    process.exit(0);
    return;
  }

  const ids = deletable.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `DELETE FROM joining_public_edit_tokens WHERE route_key IN (${placeholders})`,
      ids
    );

    const [delJoin] = await conn.execute(
      `DELETE FROM joinings WHERE id IN (${placeholders})`,
      ids
    );

    await conn.commit();
    console.log(JSON.stringify({ deletedJoinings: delJoin.affectedRows }, null, 2));
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (uri) {
    try {
      const m = await connectFeeManagement();
      const coll = m.db.collection(JOINING_STUDENT_FEE_MONGO_COLLECTION);
      const mr = await coll.deleteMany({ joiningId: { $in: ids } });
      console.log(JSON.stringify({ feeMongoDeleted: mr.deletedCount }, null, 2));
    } catch (e) {
      console.warn('Fee Mongo cleanup failed (SQL delete already committed):', e?.message || e);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
