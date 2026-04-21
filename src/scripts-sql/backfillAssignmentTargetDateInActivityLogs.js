/**
 * Copy leads.target_date into activity_logs.metadata.assignment.targetDate for
 * assignment events that are missing it (so Call Reports → User Performance
 * can show the date that was on the lead when you backfilled the DB, or the
 * current lead target for older rows).
 *
 * Only updates rows where:
 * - type = status_change
 * - metadata has assignment.assignedTo (generated target_user_id)
 * - assignment.targetDate is missing or blank
 * - joined lead has target_date NOT NULL
 *
 * Dry-run (default):
 *   node src/scripts-sql/backfillAssignmentTargetDateInActivityLogs.js
 *
 * Apply (no row limit):
 *   node src/scripts-sql/backfillAssignmentTargetDateInActivityLogs.js --apply
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = getPool();

  const [[countRow]] = await pool.execute(
    `
    SELECT COUNT(*) AS cnt
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      AND l.target_date IS NOT NULL
      AND (
        JSON_EXTRACT(a.metadata, '$.assignment.targetDate') IS NULL
        OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetDate')), '')) = ''
      )
    `
  );

  const total = Number(countRow?.cnt || 0);
  console.log('\n=== Backfill assignment.targetDate on activity_logs ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Matching assignment logs (missing JSON target, lead has target_date): ${total}\n`);

  if (total === 0) {
    await closeDB();
    return;
  }

  const [sample] = await pool.execute(
    `
    SELECT
      a.id,
      a.lead_id,
      DATE(a.created_at) AS log_date,
      DATE_FORMAT(l.target_date, '%Y-%m-%d') AS lead_target_ymd
    FROM activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      AND l.target_date IS NOT NULL
      AND (
        JSON_EXTRACT(a.metadata, '$.assignment.targetDate') IS NULL
        OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetDate')), '')) = ''
      )
    ORDER BY a.created_at DESC
    LIMIT 30
    `
  );
  console.table(sample || []);

  if (!apply) {
    console.log('\nRe-run with --apply to UPDATE all matching rows (no LIMIT).\n');
    await closeDB();
    return;
  }

  const [result] = await pool.execute(
    `
    UPDATE activity_logs a
    INNER JOIN leads l ON l.id = a.lead_id
    SET
      a.metadata = JSON_SET(
        COALESCE(CAST(a.metadata AS JSON), JSON_OBJECT()),
        '$.assignment.targetDate',
        DATE_FORMAT(l.target_date, '%Y-%m-%d')
      ),
      a.updated_at = NOW()
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      AND l.target_date IS NOT NULL
      AND (
        JSON_EXTRACT(a.metadata, '$.assignment.targetDate') IS NULL
        OR TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetDate')), '')) = ''
      )
    `
  );

  console.log(`UPDATE complete. affectedRows: ${Number(result?.affectedRows ?? 0)}\n`);
  await closeDB();
}

main().catch(async (err) => {
  console.error('\nScript failed:', err?.message || err);
  await closeDB().catch(() => {});
  process.exit(1);
});
