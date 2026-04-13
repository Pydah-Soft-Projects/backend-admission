/**
 * Report: per user, per calendar date — assignments from activity_logs.
 *
 * Run from backend-admission (loads .env from cwd):
 *   node src/scripts-sql/report-assignments-by-user-and-date.js
 *
 * Optional date filter (inclusive from, exclusive to, YYYY-MM-DD):
 *   node src/scripts-sql/report-assignments-by-user-and-date.js --from=2025-01-01 --to=2026-01-01
 *
 * Same-day "waves" (e.g. 300 leads morning, 300 afternoon): a new wave starts when
 * the gap between consecutive assignment log timestamps exceeds --gap-minutes (default 45).
 *   node src/scripts-sql/report-assignments-by-user-and-date.js --gap-minutes=30
 *
 * Section 3+4 (leads table snapshots): add --snapshots
 *
 * Note on "lead_status" under each wave: counts use the **current** `leads.lead_status`
 * for those lead IDs (not the status at the moment of assignment).
 *
 * Uses the same MySQL settings as the API (DB_HOST, DB_NAME, etc.).
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

function parseArgs() {
  const out = {
    from: null,
    to: null,
    gapMinutes: 45,
    snapshots: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length).trim() || null;
    if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length).trim() || null;
    if (arg.startsWith('--gap-minutes=')) {
      const n = parseFloat(arg.slice('--gap-minutes='.length), 10);
      if (Number.isFinite(n) && n > 0) out.gapMinutes = n;
    }
    if (arg === '--snapshots') out.snapshots = true;
  }
  return out;
}

function datePredicate(column, from, to) {
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
  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

function formatDay(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') return value.slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Split ordered assignment events into waves: same assignee + calendar day,
 * new wave when idle gap > gapMinutes since previous log.
 */
function buildWaves(rows, gapMinutes) {
  const gapMs = gapMinutes * 60 * 1000;
  /** @type {Array<{ partitionKey: string, assignee_id: string, assignee_name: string, assignee_role: string, assignment_day: string, started_at: Date, ended_at: Date, last_ts: Date, leadIds: Set<string>, target_roles: Set<string> }>} */
  const waves = [];
  let wave = null;

  const flush = () => {
    if (wave && wave.leadIds.size > 0) waves.push(wave);
  };

  const startWave = (row, t) => ({
    partitionKey: `${row.assignee_id}|${formatDay(row.assignment_day)}`,
    assignee_id: row.assignee_id,
    assignee_name: row.assignee_name,
    assignee_role: row.assignee_role,
    assignment_day: formatDay(row.assignment_day),
    started_at: t,
    ended_at: t,
    last_ts: t,
    leadIds: new Set([row.lead_id]),
    target_roles: new Set(),
  });

  for (const row of rows) {
    const t = new Date(row.created_at);
    if (Number.isNaN(t.getTime())) continue;

    const pk = `${row.assignee_id}|${formatDay(row.assignment_day)}`;

    if (!wave || wave.partitionKey !== pk) {
      flush();
      wave = startWave(row, t);
      const tr = row.logged_target_role;
      if (tr && tr !== '(not set)') wave.target_roles.add(tr);
      continue;
    }

    if (t - wave.last_ts > gapMs) {
      flush();
      wave = startWave(row, t);
      const tr = row.logged_target_role;
      if (tr && tr !== '(not set)') wave.target_roles.add(tr);
      continue;
    }

    wave.leadIds.add(row.lead_id);
    wave.last_ts = t;
    wave.ended_at = t;
    const tr = row.logged_target_role;
    if (tr && tr !== '(not set)') wave.target_roles.add(tr);
  }
  flush();

  waves.sort((a, b) => {
    const n = a.assignee_name.localeCompare(b.assignee_name);
    if (n !== 0) return n;
    const d = a.assignment_day.localeCompare(b.assignment_day);
    if (d !== 0) return d;
    return a.started_at - b.started_at;
  });

  const idxByPk = new Map();
  for (const w of waves) {
    const next = (idxByPk.get(w.partitionKey) || 0) + 1;
    idxByPk.set(w.partitionKey, next);
    w.wave_in_day = next;
  }

  return waves;
}

async function fetchLeadStatusCounts(pool, leadIds) {
  const ids = [...leadIds];
  if (ids.length === 0) return new Map();
  const statusToCount = new Map();
  const chunkSize = 400;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const ph = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT lead_status, COUNT(*) AS c FROM leads WHERE id IN (${ph}) GROUP BY lead_status`,
      chunk
    );
    for (const r of rows) {
      const key = r.lead_status == null ? '(null)' : String(r.lead_status);
      const c = typeof r.c === 'bigint' ? Number(r.c) : Number(r.c);
      statusToCount.set(key, (statusToCount.get(key) || 0) + c);
    }
  }
  return statusToCount;
}

function mapToStatusTable(statusMap) {
  return [...statusMap.entries()]
    .map(([lead_status, count]) => ({ lead_status, count }))
    .sort((a, b) => b.count - a.count || a.lead_status.localeCompare(b.lead_status));
}

async function main() {
  const { from, to, gapMinutes, snapshots } = parseArgs();
  const pool = getPool();

  
  const d1 = datePredicate('a.created_at', from, to);
  const d2 = datePredicate('l.assigned_at', from, to);
  const d3 = datePredicate('l.pro_assigned_at', from, to);

  console.log('\n=== 1) Event-based: activity_logs (assignment metadata) ===\n');
  const [events] = await pool.execute(
    `
    SELECT
      u.id AS assignee_user_id,
      u.name AS assignee_name,
      u.email AS assignee_email,
      u.role_name AS assignee_role,
      DATE(a.created_at) AS assignment_date,
      COUNT(*) AS leads_assigned_events,
      COUNT(DISTINCT a.lead_id) AS distinct_leads_touched
    FROM activity_logs a
    JOIN users u
      ON u.id = JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo'))
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      ${d1.where}
    GROUP BY
      u.id, u.name, u.email, u.role_name, DATE(a.created_at)
    ORDER BY u.name, assignment_date
    `,
    d1.params
  );
  console.table(events);

  console.log('\n=== 2) Event-based with logged targetRole (bulk assign sets PRO/counsellor) ===\n');
  const [byRole] = await pool.execute(
    `
    SELECT
      u.id AS assignee_user_id,
      u.name AS assignee_name,
      u.role_name AS assignee_role,
      COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')), ''),
        '(not set)'
      ) AS logged_target_role,
      DATE(a.created_at) AS assignment_date,
      COUNT(*) AS leads_assigned_events
    FROM activity_logs a
    JOIN users u
      ON u.id = JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo'))
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      ${d1.where}
    GROUP BY
      u.id, u.name, u.role_name,
      COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')), ''),
        '(not set)'
      ),
      DATE(a.created_at)
    ORDER BY u.name, assignment_date, logged_target_role
    `,
    [...d1.params]
  );
  console.table(byRole);

  console.log(
    `\n=== 3) Same-day waves (gap > ${gapMinutes} min → new wave) + **current** lead_status counts per wave ===\n` +
      'Leads in wave = distinct lead_ids in that time cluster. Status = present `leads.lead_status`.\n'
  );

  const [rawRows] = await pool.execute(
    `
    SELECT
      JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo')) AS assignee_id,
      u.name AS assignee_name,
      u.role_name AS assignee_role,
      COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')), ''),
        '(not set)'
      ) AS logged_target_role,
      DATE(a.created_at) AS assignment_day,
      a.created_at AS created_at,
      a.lead_id AS lead_id
    FROM activity_logs a
    JOIN users u
      ON u.id = JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo'))
    WHERE a.type = 'status_change'
      AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
      ${d1.where}
    ORDER BY u.id, DATE(a.created_at), a.created_at
    `,
    d1.params
  );

  const waves = buildWaves(rawRows, gapMinutes);

  for (const w of waves) {
    const leadIds = [...w.leadIds];
    const statusMap = await fetchLeadStatusCounts(pool, leadIds);
    const assignedInWave = leadIds.length;
    const foundInLeads = [...statusMap.values()].reduce((a, b) => a + b, 0);
    const rolesLabel = [...w.target_roles].sort().join(', ') || '(not set)';

    console.log(
      `\n--- ${w.assignee_name} (${w.assignee_role}) | ${w.assignment_day} | wave ${w.wave_in_day} of day | ` +
        `${w.started_at.toISOString()} → ${w.ended_at.toISOString()} | ${assignedInWave} leads | logged targetRole: ${rolesLabel} ---`
    );
    if (foundInLeads !== assignedInWave) {
      console.log(
        `    (note: ${assignedInWave - foundInLeads} lead id(s) in logs had no row in leads or duplicate id handling — check data)`
      );
    }
    console.table(mapToStatusTable(statusMap));
  }

  if (waves.length === 0) {
    console.log('(no assignment events in range)');
  }

  if (snapshots) {
    console.log('\n=== 4) Snapshot: leads.assigned_to × DATE(assigned_at) ===\n');
    const [snapCounsellor] = await pool.execute(
      `
      SELECT
        u.id AS user_id,
        u.name,
        u.email,
        u.role_name,
        DATE(l.assigned_at) AS assigned_at_date,
        COUNT(*) AS lead_count_currently_assigned
      FROM leads l
      JOIN users u ON u.id = l.assigned_to
      WHERE l.assigned_to IS NOT NULL
        AND l.assigned_at IS NOT NULL
        ${d2.where}
      GROUP BY u.id, u.name, u.email, u.role_name, DATE(l.assigned_at)
      ORDER BY u.name, assigned_at_date
      `,
      d2.params
    );
    console.table(snapCounsellor);

    console.log('\n=== 5) Snapshot: leads.assigned_to_pro × DATE(pro_assigned_at) ===\n');
    const [snapPro] = await pool.execute(
      `
      SELECT
        u.id AS user_id,
        u.name,
        u.email,
        u.role_name,
        DATE(l.pro_assigned_at) AS pro_assigned_at_date,
        COUNT(*) AS lead_count_currently_assigned_to_pro
      FROM leads l
      JOIN users u ON u.id = l.assigned_to_pro
      WHERE l.assigned_to_pro IS NOT NULL
        AND l.pro_assigned_at IS NOT NULL
        ${d3.where}
      GROUP BY u.id, u.name, u.email, u.role_name, DATE(l.pro_assigned_at)
      ORDER BY u.name, pro_assigned_at_date
      `,
      d3.params
    );
    console.table(snapPro);
  }

  if (from || to || snapshots) {
    console.log('\n(Run options:)', { from, to, gapMinutes, snapshots });
  }

  await closeDB();
}

main().catch((err) => {
  console.error(err);
  closeDB().finally(() => process.exit(1));
});
