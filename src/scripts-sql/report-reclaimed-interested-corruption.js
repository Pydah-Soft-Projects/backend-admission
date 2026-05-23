/**
 * Audit: leads auto-reclaimed while the counsellor/PRO channel status was "Interested"
 * (or pipeline lead_status was Interested), using activity_logs as source of truth.
 *
 * Shows: previous assignee (by role), status at reclaim, next assignee after reclaim.
 *
 * Usage (read-only):
 *   node src/scripts-sql/report-reclaimed-interested-corruption.js
 *   node src/scripts-sql/report-reclaimed-interested-corruption.js --from=2026-01-01 --to=2026-05-01
 *   node src/scripts-sql/report-reclaimed-interested-corruption.js --interested-only
 *   node src/scripts-sql/report-reclaimed-interested-corruption.js --previous-user-name="JOHN DOE"
 *   node src/scripts-sql/report-reclaimed-interested-corruption.js --role=counsellor
 *   node src/scripts-sql/report-reclaimed-interested-corruption.js --limit=500 --csv=./reclaimed-interested.csv
 *
 * Options:
 *   --from=YYYY-MM-DD     inclusive reclaim date (activity_logs.created_at)
 *   --to=YYYY-MM-DD       exclusive reclaim date
 *   --interested-only     only rows flagged as Interested-at-reclaim corruption
 *   --previous-user-name= filter by previous assignee (exact name, case-insensitive)
 *   --role=counsellor|pro|all   filter by metadata.reclamation.reclaimedRole
 *   --limit=N             max detail rows (default 2000)
 *   --csv=path            write detail rows to CSV
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const AUTOMATION_USER_ID = '00000000-0000-0000-0000-000000000000';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const INTERESTED_VALUES = new Set(['interested', 'cet applied', 'cet_applied']);

function parseArgs() {
  const out = {
    from: null,
    to: null,
    interestedOnly: false,
    previousUserName: '',
    role: 'all',
    limit: 2000,
    csv: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length).trim() || null;
    if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length).trim() || null;
    if (arg === '--interested-only') out.interestedOnly = true;
    if (arg.startsWith('--previous-user-name=')) {
      out.previousUserName = arg.slice('--previous-user-name='.length).trim();
    }
    if (arg.startsWith('--role=')) out.role = arg.slice('--role='.length).trim().toLowerCase() || 'all';
    if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
    }
    if (arg.startsWith('--csv=')) out.csv = arg.slice('--csv='.length).trim() || null;
  }

  return out;
}

function validateArgs(args) {
  if (args.from && !YMD.test(args.from)) throw new Error('Invalid --from (YYYY-MM-DD)');
  if (args.to && !YMD.test(args.to)) throw new Error('Invalid --to (YYYY-MM-DD)');
  if (!['all', 'counsellor', 'pro'].includes(args.role)) {
    throw new Error('Invalid --role (counsellor|pro|all)');
  }
}

function buildDateClause(column, from, to) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push(`DATE(${column}) >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`DATE(${column}) < ?`);
    params.push(to);
  }
  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

function isInterestedStatus(s) {
  return INTERESTED_VALUES.has(norm(s));
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function writeCsv(filePath, rows, columns) {
  const header = columns.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => csvEscape(row[c.key])).join(',')
  );
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, [header, ...lines].join('\n'), 'utf8');
}

async function fetchReclaimRows(pool, args) {
  const reclaimDate = buildDateClause('a.created_at', args.from, args.to);
  const roleFilter =
    args.role === 'counsellor'
      ? ` AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole'))) = 'counsellor'`
      : args.role === 'pro'
        ? ` AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole'))) = 'pro'`
        : '';

  const previousUserFilter = args.previousUserName
    ? ` AND LOWER(prev_u.name) = LOWER(?)`
    : '';

  const interestedOnlySql = args.interestedOnly
    ? `
      AND (
        LOWER(TRIM(COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.reclaim_old_status_col, ''), '')))
          IN ('interested', 'cet applied', 'cet_applied')
        OR LOWER(TRIM(COALESCE(re.last_channel_status, ''))) IN ('interested', 'cet applied', 'cet_applied')
        OR LOWER(TRIM(COALESCE(re.last_lead_status_logged, ''))) IN ('interested', 'cet applied', 'cet_applied')
      )
    `
    : '';

  const safeLimit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
    ? Math.floor(Number(args.limit))
    : 2000;

  const params = [
    AUTOMATION_USER_ID,
    ...reclaimDate.params,
    AUTOMATION_USER_ID,
    AUTOMATION_USER_ID,
    AUTOMATION_USER_ID,
    AUTOMATION_USER_ID,
  ];
  if (args.previousUserName) params.push(args.previousUserName);

  const [rows] = await pool.execute(
    `
    WITH reclaim_events AS (
      SELECT
        a.id AS reclaim_activity_id,
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status AS reclaim_old_status_col,
        a.new_status AS reclaim_new_status_col,
        a.comment AS reclaim_comment,
        a.performed_by AS reclaim_performed_by,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) AS previous_assignee_id,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousCycle')) AS previous_cycle,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.newCycle')) AS new_cycle,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.oldStatus')) AS pipeline_status_meta,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole')) AS reclaimed_role
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND a.performed_by = ?
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        ${reclaimDate.sql}
        ${roleFilter}
    ),
    reclaim_with_last_status AS (
      SELECT
        re.*,
        (
          SELECT COALESCE(
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.callStatus')), ''),
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.visitStatus')), ''),
            NULLIF(al2.new_status, '')
          )
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_channel_status,
        (
          SELECT JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.statusChannel'))
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
            AND JSON_EXTRACT(al2.metadata, '$.statusChannel') IS NOT NULL
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_status_channel,
        (
          SELECT al2.new_status
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
            AND al2.new_status IS NOT NULL
            AND TRIM(al2.new_status) <> ''
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_lead_status_logged,
        (
          SELECT al2.created_at
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_user_activity_at
      FROM reclaim_events re
    )
    SELECT
      re.reclaim_activity_id,
      re.lead_id,
      l.enquiry_number,
      l.name AS lead_name,
      l.lead_status AS current_lead_status,
      l.call_status AS current_call_status,
      l.visit_status AS current_visit_status,
      l.cycle_number AS current_cycle,
      l.assigned_to AS current_assigned_to,
      l.assigned_to_pro AS current_assigned_to_pro,
      re.reclaimed_at,
      re.reclaimed_role,
      re.previous_assignee_id,
      prev_u.name AS previous_assignee_name,
      prev_u.role_name AS previous_assignee_role,
      re.previous_cycle,
      re.new_cycle,
      COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.reclaim_old_status_col, '')) AS pipeline_at_reclaim,
      re.reclaim_new_status_col AS status_after_reclaim,
      re.last_channel_status,
      re.last_status_channel,
      re.last_lead_status_logged,
      re.last_user_activity_at,
      (
        SELECT JSON_UNQUOTE(JSON_EXTRACT(al3.metadata, '$.assignment.assignedTo'))
        FROM activity_logs al3
        WHERE al3.lead_id = re.lead_id
          AND al3.created_at > re.reclaimed_at
          AND JSON_EXTRACT(al3.metadata, '$.assignment.assignedTo') IS NOT NULL
          AND TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(al3.metadata, '$.assignment.assignedTo')), '')) <> ''
        ORDER BY al3.created_at ASC
        LIMIT 1
      ) AS next_assignee_id,
      (
        SELECT al3.created_at
        FROM activity_logs al3
        WHERE al3.lead_id = re.lead_id
          AND al3.created_at > re.reclaimed_at
          AND JSON_EXTRACT(al3.metadata, '$.assignment.assignedTo') IS NOT NULL
          AND TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(al3.metadata, '$.assignment.assignedTo')), '')) <> ''
        ORDER BY al3.created_at ASC
        LIMIT 1
      ) AS next_assigned_at
    FROM reclaim_with_last_status re
    JOIN leads l ON l.id = re.lead_id
    LEFT JOIN users prev_u ON prev_u.id = re.previous_assignee_id
    WHERE 1=1
      ${previousUserFilter}
      ${interestedOnlySql}
    ORDER BY re.reclaimed_at DESC
    LIMIT ${safeLimit}
    `,
    params
  );

  const nextUserIds = [
    ...new Set(rows.map((r) => r.next_assignee_id).filter(Boolean)),
  ];
  let nextUserById = new Map();
  if (nextUserIds.length > 0) {
    const placeholders = nextUserIds.map(() => '?').join(',');
    const [users] = await pool.execute(
      `SELECT id, name, role_name FROM users WHERE id IN (${placeholders})`,
      nextUserIds
    );
    nextUserById = new Map(
      (users || []).map((u) => [u.id, { name: u.name, roleName: u.role_name }])
    );
  }

  return rows.map((row) => {
    const nextMeta = row.next_assignee_id ? nextUserById.get(row.next_assignee_id) : null;
    return {
      ...row,
      next_assignee_name: nextMeta?.name || null,
      next_assignee_role: nextMeta?.roleName || null,
    };
  });
}

async function fetchSummary(pool, args) {
  const reclaimDate = buildDateClause('a.created_at', args.from, args.to);
  const roleFilter =
    args.role === 'counsellor'
      ? ` AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole'))) = 'counsellor'`
      : args.role === 'pro'
        ? ` AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole'))) = 'pro'`
        : '';

  const [rows] = await pool.execute(
    `
    WITH reclaim_events AS (
      SELECT
        a.id,
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) AS previous_assignee_id,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.oldStatus')) AS pipeline_status_meta,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole')) AS reclaimed_role
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND a.performed_by = ?
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        ${reclaimDate.sql}
        ${roleFilter}
    ),
    reclaim_enriched AS (
      SELECT
        re.*,
        COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.old_status, '')) AS pipeline_at_reclaim,
        (
          SELECT COALESCE(
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.callStatus')), ''),
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.visitStatus')), ''),
            NULLIF(al2.new_status, '')
          )
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_channel_status
      FROM reclaim_events re
    )
    SELECT
      COUNT(*) AS total_reclaim_events,
      COUNT(DISTINCT lead_id) AS distinct_leads,
      SUM(
        CASE
          WHEN LOWER(TRIM(pipeline_at_reclaim)) IN ('interested', 'cet applied', 'cet_applied')
            OR LOWER(TRIM(last_channel_status)) IN ('interested', 'cet applied', 'cet_applied')
          THEN 1 ELSE 0
        END
      ) AS interested_corruption_events,
      COUNT(DISTINCT CASE
        WHEN LOWER(TRIM(pipeline_at_reclaim)) IN ('interested', 'cet applied', 'cet_applied')
          OR LOWER(TRIM(last_channel_status)) IN ('interested', 'cet applied', 'cet_applied')
        THEN lead_id END) AS interested_corruption_leads
    FROM reclaim_enriched
    `,
    [AUTOMATION_USER_ID, ...reclaimDate.params, AUTOMATION_USER_ID]
  );

  const [byRole] = await pool.execute(
    `
    WITH reclaim_events AS (
      SELECT
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.oldStatus')) AS pipeline_status_meta,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole')) AS reclaimed_role
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND a.performed_by = ?
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        ${reclaimDate.sql}
        ${roleFilter}
    ),
    reclaim_enriched AS (
      SELECT
        re.*,
        COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.old_status, '')) AS pipeline_at_reclaim,
        (
          SELECT COALESCE(
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.callStatus')), ''),
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.visitStatus')), ''),
            NULLIF(al2.new_status, '')
          )
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_channel_status
      FROM reclaim_events re
    )
    SELECT
      COALESCE(reclaimed_role, '(unknown)') AS reclaimed_role,
      COUNT(*) AS reclaim_events,
      SUM(
        CASE
          WHEN LOWER(TRIM(pipeline_at_reclaim)) IN ('interested', 'cet applied', 'cet_applied')
            OR LOWER(TRIM(last_channel_status)) IN ('interested', 'cet applied', 'cet_applied')
          THEN 1 ELSE 0
        END
      ) AS interested_corruption_events
    FROM reclaim_enriched
    GROUP BY COALESCE(reclaimed_role, '(unknown)')
    ORDER BY interested_corruption_events DESC, reclaim_events DESC
    `,
    [AUTOMATION_USER_ID, ...reclaimDate.params, AUTOMATION_USER_ID]
  );

  const [byPreviousUser] = await pool.execute(
    `
    WITH reclaim_events AS (
      SELECT
        a.lead_id,
        a.created_at AS reclaimed_at,
        a.old_status,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) AS previous_assignee_id,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.oldStatus')) AS pipeline_status_meta,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.reclaimedRole')) AS reclaimed_role
      FROM activity_logs a
      WHERE a.type = 'status_change'
        AND a.performed_by = ?
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        ${reclaimDate.sql}
        ${roleFilter}
    ),
    reclaim_enriched AS (
      SELECT
        re.*,
        COALESCE(NULLIF(re.pipeline_status_meta, ''), NULLIF(re.old_status, '')) AS pipeline_at_reclaim,
        (
          SELECT COALESCE(
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.callStatus')), ''),
            NULLIF(JSON_UNQUOTE(JSON_EXTRACT(al2.metadata, '$.visitStatus')), ''),
            NULLIF(al2.new_status, '')
          )
          FROM activity_logs al2
          WHERE al2.lead_id = re.lead_id
            AND al2.created_at < re.reclaimed_at
            AND al2.performed_by <> ?
            AND al2.type = 'status_change'
          ORDER BY al2.created_at DESC
          LIMIT 1
        ) AS last_channel_status
      FROM reclaim_events re
    )
    SELECT
      u.id AS previous_assignee_id,
      u.name AS previous_assignee_name,
      u.role_name AS previous_assignee_role,
      COUNT(*) AS reclaim_events,
      SUM(
        CASE
          WHEN LOWER(TRIM(re.pipeline_at_reclaim)) IN ('interested', 'cet applied', 'cet_applied')
            OR LOWER(TRIM(re.last_channel_status)) IN ('interested', 'cet applied', 'cet_applied')
          THEN 1 ELSE 0
        END
      ) AS interested_corruption_events
    FROM reclaim_enriched re
    LEFT JOIN users u ON u.id = re.previous_assignee_id
  GROUP BY u.id, u.name, u.role_name
    HAVING interested_corruption_events > 0
    ORDER BY interested_corruption_events DESC, reclaim_events DESC
    LIMIT 50
    `,
    [AUTOMATION_USER_ID, ...reclaimDate.params, AUTOMATION_USER_ID]
  );

  return { summary: rows?.[0] || {}, byRole: byRole || [], byPreviousUser: byPreviousUser || [] };
}

function enrichRow(row) {
  const pipelineAtReclaim = row.pipeline_at_reclaim || '';
  const lastChannel = row.last_channel_status || '';
  const lastLeadLogged = row.last_lead_status_logged || '';

  const interestedAtReclaim =
    isInterestedStatus(pipelineAtReclaim) ||
    isInterestedStatus(lastChannel) ||
    isInterestedStatus(lastLeadLogged);

  let interestedReason = '';
  if (isInterestedStatus(pipelineAtReclaim)) interestedReason = 'pipeline_at_reclaim';
  else if (isInterestedStatus(lastChannel)) interestedReason = `last_channel (${row.last_status_channel || 'unknown'})`;
  else if (isInterestedStatus(lastLeadLogged)) interestedReason = 'last_logged_lead_status';

  return {
    ...row,
    interested_at_reclaim: interestedAtReclaim,
    interested_reason: interestedReason,
  };
}

async function main() {
  const args = parseArgs();
  validateArgs(args);

  const pool = getPool();

  console.log('\n=== Reclaimed "Interested" corruption audit (activity_logs) ===');
  console.table([
    {
      from: args.from || '(all time)',
      toExclusive: args.to || '(all time)',
      interestedOnly: args.interestedOnly,
      previousUser: args.previousUserName || '(any)',
      role: args.role,
      limit: args.limit,
      csv: args.csv || '(none)',
    },
  ]);

  const { summary, byRole, byPreviousUser } = await fetchSummary(pool, args);

  console.log('\n=== Summary ===');
  console.table([
    {
      totalReclaimEvents: Number(summary.total_reclaim_events || 0),
      distinctLeadsReclaimed: Number(summary.distinct_leads || 0),
      interestedCorruptionEvents: Number(summary.interested_corruption_events || 0),
      interestedCorruptionLeads: Number(summary.interested_corruption_leads || 0),
    },
  ]);

  if (Number(summary.total_reclaim_events) > 0) {
    const pct = (
      (Number(summary.interested_corruption_events || 0) /
        Number(summary.total_reclaim_events)) *
      100
    ).toFixed(1);
    console.log(
      `Interested-at-reclaim rate: ${pct}% of reclaim events (${summary.interested_corruption_events}/${summary.total_reclaim_events})`
    );
  }

  console.log('\n=== By reclaimed role ===');
  console.table(
    byRole.map((r) => ({
      reclaimedRole: r.reclaimed_role,
      reclaimEvents: Number(r.reclaim_events),
      interestedCorruptionEvents: Number(r.interested_corruption_events),
    }))
  );

  console.log('\n=== Top previous assignees (Interested corruption only) ===');
  if (byPreviousUser.length === 0) {
    console.log('(none in range)');
  } else {
    console.table(
      byPreviousUser.map((r) => ({
        previousAssignee: r.previous_assignee_name || r.previous_assignee_id || '(unknown)',
        role: r.previous_assignee_role || '',
        interestedCorruptionEvents: Number(r.interested_corruption_events),
        totalReclaimFromThem: Number(r.reclaim_events),
      }))
    );
  }

  let detailRows = await fetchReclaimRows(pool, args);
  detailRows = detailRows.map(enrichRow);

  if (args.interestedOnly) {
    detailRows = detailRows.filter((r) => r.interested_at_reclaim);
  }

  console.log(`\n=== Detail rows (${detailRows.length}) ===`);
  if (detailRows.length === 0) {
    console.log('No rows match filters.');
  } else {
    console.table(
      detailRows.slice(0, 40).map((r) => ({
        reclaimedAt: r.reclaimed_at,
        enquiry: r.enquiry_number || '',
        leadName: r.lead_name || '',
        interested: r.interested_at_reclaim ? 'YES' : 'no',
        reason: r.interested_reason || '',
        reclaimedRole: r.reclaimed_role || '',
        previousCounsellor: r.previous_assignee_name || '',
        previousRole: r.previous_assignee_role || '',
        pipelineAtReclaim: r.pipeline_at_reclaim || '',
        lastChannelStatus: r.last_channel_status || '',
        lastChannel: r.last_status_channel || '',
        statusAfterReclaim: r.status_after_reclaim || '',
        nextAssignee: r.next_assignee_name || '(not reassigned yet)',
        nextRole: r.next_assignee_role || '',
        currentCallStatus: r.current_call_status || '',
        currentLeadStatus: r.current_lead_status || '',
      }))
    );
    if (detailRows.length > 40) {
      console.log(`... and ${detailRows.length - 40} more (use --csv or raise --limit)`);
    }
  }

  if (args.csv && detailRows.length > 0) {
    const columns = [
      { key: 'reclaimed_at', header: 'reclaimed_at' },
      { key: 'enquiry_number', header: 'enquiry_number' },
      { key: 'lead_name', header: 'lead_name' },
      { key: 'interested_at_reclaim', header: 'interested_at_reclaim' },
      { key: 'interested_reason', header: 'interested_reason' },
      { key: 'reclaimed_role', header: 'reclaimed_role' },
      { key: 'previous_assignee_name', header: 'previous_assignee_name' },
      { key: 'previous_assignee_role', header: 'previous_assignee_role' },
      { key: 'pipeline_at_reclaim', header: 'pipeline_at_reclaim' },
      { key: 'last_channel_status', header: 'last_channel_status' },
      { key: 'last_status_channel', header: 'last_status_channel' },
      { key: 'last_lead_status_logged', header: 'last_lead_status_logged' },
      { key: 'status_after_reclaim', header: 'status_after_reclaim' },
      { key: 'previous_cycle', header: 'previous_cycle' },
      { key: 'new_cycle', header: 'new_cycle' },
      { key: 'next_assignee_name', header: 'next_assignee_name' },
      { key: 'next_assignee_role', header: 'next_assignee_role' },
      { key: 'next_assigned_at', header: 'next_assigned_at' },
      { key: 'current_lead_status', header: 'current_lead_status' },
      { key: 'current_call_status', header: 'current_call_status' },
      { key: 'current_visit_status', header: 'current_visit_status' },
      { key: 'reclaim_activity_id', header: 'reclaim_activity_id' },
      { key: 'lead_id', header: 'lead_id' },
    ];
    writeCsv(args.csv, detailRows, columns);
    console.log(`\nWrote CSV: ${path.resolve(args.csv)}`);
  }

  await closeDB();
}

main().catch(async (err) => {
  console.error('\nScript failed:', err?.message || err);
  try {
    await closeDB();
  } catch {
    // noop
  }
  process.exit(1);
});
