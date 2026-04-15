/**
 * Read-only forensic script:
 * Investigate what happened AFTER leads were assigned to a specific user.
 *
 * Usage:
 *   node src/scripts-sql/investigate-user-assignment-aftermath.js --user-name="POTABHATULA DAMODHAR" --from=2026-04-08 --to=2026-04-16
 *
 * Optional filters:
 *   --mandal="Kakinada Rural"
 *   --student-group="Inter-MPC"
 *   --limit=20
 *
 * Notes:
 * - This script is strictly read-only (SELECT queries only).
 * - "--to" is exclusive for date window (same style as other scripts).
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const SYSTEM_AUTOMATION_USER_ID = '00000000-0000-0000-0000-000000000000';

function parseArgs() {
  const out = {
    userName: '',
    from: null,
    to: null,
    mandal: null,
    studentGroup: null,
    limit: 20,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--user-name=')) out.userName = arg.slice('--user-name='.length).trim();
    if (arg.startsWith('--from=')) out.from = arg.slice('--from='.length).trim() || null;
    if (arg.startsWith('--to=')) out.to = arg.slice('--to='.length).trim() || null;
    if (arg.startsWith('--mandal=')) out.mandal = arg.slice('--mandal='.length).trim() || null;
    if (arg.startsWith('--student-group=')) out.studentGroup = arg.slice('--student-group='.length).trim() || null;
    if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length).trim());
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
    }
  }

  return out;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function toIso(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function formatDateOnly(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function addCount(map, key, inc = 1) {
  map.set(key, (map.get(key) || 0) + inc);
}

async function fetchUser(pool, userName) {
  const [rows] = await pool.execute(
    `
    SELECT id, name, email, role_name, is_active
    FROM users
    WHERE LOWER(name) = LOWER(?)
    LIMIT 1
    `,
    [userName]
  );
  return rows?.[0] || null;
}

async function fetchAssignmentsToUser(pool, userId, filters) {
  const where = [
    "a.type = 'status_change'",
    "JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL",
    "JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo')) = ?",
  ];
  const params = [userId];

  if (filters.from) {
    where.push('DATE(a.created_at) >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('DATE(a.created_at) < ?');
    params.push(filters.to);
  }
  if (filters.mandal) {
    where.push('l.mandal = ?');
    params.push(filters.mandal);
  }
  if (filters.studentGroup) {
    where.push('l.student_group = ?');
    params.push(filters.studentGroup);
  }

  const [rows] = await pool.execute(
    `
    SELECT
      a.id AS activity_id,
      a.lead_id,
      a.created_at AS assigned_at,
      DATE(a.created_at) AS assigned_date,
      a.performed_by AS assigned_by,
      l.name AS lead_name,
      l.phone AS lead_phone,
      l.enquiry_number,
      l.mandal,
      l.district,
      l.student_group,
      l.target_date,
      l.lead_status AS current_status,
      COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')), ''), '(not set)') AS logged_target_role
    FROM activity_logs a
    LEFT JOIN leads l ON l.id = a.lead_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.created_at ASC
    `,
    params
  );

  return rows || [];
}

async function fetchCurrentLeadSnapshot(pool, leadIds) {
  if (!leadIds.length) return [];

  const chunks = chunkArray(leadIds, 400);
  const out = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `
      SELECT
        l.id,
        l.name,
        l.enquiry_number,
        l.lead_status,
        l.target_date,
        l.cycle_number,
        l.assigned_to,
        l.assigned_to_pro,
        l.assigned_at,
        l.pro_assigned_at,
        l.mandal,
        l.student_group,
        uc.name AS assigned_to_name,
        up.name AS assigned_to_pro_name
      FROM leads l
      LEFT JOIN users uc ON uc.id = l.assigned_to
      LEFT JOIN users up ON up.id = l.assigned_to_pro
      WHERE l.id IN (${placeholders})
      `,
      chunk
    );
    out.push(...rows);
  }
  return out;
}

async function fetchAssignmentEventsForLeads(pool, leadIds) {
  if (!leadIds.length) return [];
  const chunks = chunkArray(leadIds, 350);
  const out = [];

  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `
      SELECT
        a.lead_id,
        a.created_at,
        a.performed_by,
        COALESCE(u.name, '(unknown)') AS performed_by_name,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo')) AS new_assignee_id,
        COALESCE(unew.name, '(unknown)') AS new_assignee_name,
        COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.targetRole')), ''), '(not set)') AS target_role
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.performed_by
      LEFT JOIN users unew ON unew.id = JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.assignment.assignedTo'))
      WHERE a.type = 'status_change'
        AND JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL
        AND a.lead_id IN (${placeholders})
      ORDER BY a.lead_id, a.created_at ASC
      `,
      chunk
    );
    out.push(...rows);
  }
  return out;
}

async function fetchReclaimEventsForUserLeads(pool, leadIds, userId) {
  if (!leadIds.length) return [];
  const chunks = chunkArray(leadIds, 350);
  const out = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `
      SELECT
        a.lead_id,
        a.created_at,
        a.comment,
        a.performed_by,
        COALESCE(u.name, '(automation)') AS performed_by_name,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) AS previous_assignee,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousCycle')) AS previous_cycle,
        JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.newCycle')) AS new_cycle
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.type = 'status_change'
        AND a.lead_id IN (${placeholders})
        AND JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee') IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.reclamation.previousAssignee')) = ?
      ORDER BY a.created_at ASC
      `,
      [...chunk, userId]
    );
    out.push(...rows);
  }
  return out;
}

async function fetchPostAssignmentActivity(pool, leadIds, minBaselineAt) {
  if (!leadIds.length) return [];
  const chunks = chunkArray(leadIds, 350);
  const out = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `
      SELECT
        a.lead_id,
        a.created_at,
        a.performed_by,
        COALESCE(u.name, '(unknown)') AS performed_by_name,
        a.old_status,
        a.new_status,
        CASE
          WHEN JSON_EXTRACT(a.metadata, '$.assignment.assignedTo') IS NOT NULL THEN 1
          ELSE 0
        END AS is_assignment_event
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.type = 'status_change'
        AND a.lead_id IN (${placeholders})
        AND a.created_at >= ?
      ORDER BY a.lead_id, a.created_at ASC
      `,
      [...chunk, minBaselineAt]
    );
    out.push(...rows);
  }
  return out;
}

async function fetchPostAssignmentCommunications(pool, leadIds, minBaselineAt) {
  if (!leadIds.length) return [];
  const chunks = chunkArray(leadIds, 350);
  const out = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `
      SELECT
        c.lead_id,
        c.sent_at,
        c.sent_by,
        COALESCE(u.name, '(unknown)') AS sent_by_name,
        c.type,
        COALESCE(c.duration_seconds, 0) AS duration_seconds
      FROM communications c
      LEFT JOIN users u ON u.id = c.sent_by
      WHERE c.lead_id IN (${placeholders})
        AND c.sent_at >= ?
      ORDER BY c.lead_id, c.sent_at ASC
      `,
      [...chunk, minBaselineAt]
    );
    out.push(...rows);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.userName) {
    console.error('Missing required --user-name argument');
    process.exit(1);
  }

  const pool = getPool();

  try {
    const user = await fetchUser(pool, args.userName);
    if (!user) {
      console.error(`User not found by exact name: "${args.userName}"`);
      process.exit(1);
    }

    console.log('\n=== Investigation Target ===');
    console.table([{
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role_name,
      active: user.is_active ? 'Yes' : 'No',
      from: args.from || '(none)',
      toExclusive: args.to || '(none)',
      mandal: args.mandal || '(all)',
      studentGroup: args.studentGroup || '(all)',
      sampleLimit: args.limit,
    }]);

    const assignmentRows = await fetchAssignmentsToUser(pool, user.id, args);
    if (!assignmentRows.length) {
      console.log('\nNo assignment events found for the selected filters.');
      return;
    }

    const leadFirstAssignedAt = new Map();
    const leadLatestAssignedAt = new Map();
    const assignedByDate = new Map();
    const assignedByRole = new Map();
    const allLeadIds = new Set();

    for (const row of assignmentRows) {
      const leadId = row.lead_id;
      allLeadIds.add(leadId);

      const assignedAt = new Date(row.assigned_at);
      const dateKey = formatDateOnly(row.assigned_date);

      if (!leadFirstAssignedAt.has(leadId) || assignedAt < leadFirstAssignedAt.get(leadId)) {
        leadFirstAssignedAt.set(leadId, assignedAt);
      }
      if (!leadLatestAssignedAt.has(leadId) || assignedAt > leadLatestAssignedAt.get(leadId)) {
        leadLatestAssignedAt.set(leadId, assignedAt);
      }

      addCount(assignedByDate, dateKey, 1);
      addCount(assignedByRole, String(row.logged_target_role || '(not set)'), 1);
    }

    const uniqueLeadIds = [...allLeadIds];
    const minBaselineAt = [...leadFirstAssignedAt.values()].reduce((min, d) => (d < min ? d : min));

    console.log('\n=== Assignment Event Summary ===');
    console.table([{
      assignmentEvents: assignmentRows.length,
      distinctLeadsAssigned: uniqueLeadIds.length,
      firstAssignmentAt: toIso(minBaselineAt),
      lastAssignmentAt: toIso([...leadLatestAssignedAt.values()].reduce((max, d) => (d > max ? d : max))),
    }]);

    console.log('\n=== Assigned Event Count by Date ===');
    console.table(
      [...assignedByDate.entries()]
        .map(([date, count]) => ({ date, assignmentEvents: count }))
        .sort((a, b) => a.date.localeCompare(b.date))
    );

    console.log('\n=== Logged Target Role in Assignment Metadata ===');
    console.table(
      [...assignedByRole.entries()]
        .map(([targetRole, count]) => ({ targetRole, assignmentEvents: count }))
        .sort((a, b) => b.assignmentEvents - a.assignmentEvents)
    );

    const leadSnapshot = await fetchCurrentLeadSnapshot(pool, uniqueLeadIds);
    const leadById = new Map(leadSnapshot.map((x) => [x.id, x]));

    let stillWithUser = 0;
    let movedToOther = 0;
    let currentlyUnassigned = 0;
    let reclaimedCycleGt1 = 0;

    const movedToUserCounts = new Map();
    const movedLeadsRows = [];

    for (const leadId of uniqueLeadIds) {
      const snap = leadById.get(leadId);
      if (!snap) continue;

      if (Number(snap.cycle_number || 1) > 1) reclaimedCycleGt1 += 1;

      const withUser = snap.assigned_to === user.id || snap.assigned_to_pro === user.id;
      const hasAnyAssignee = Boolean(snap.assigned_to || snap.assigned_to_pro);

      if (withUser) {
        stillWithUser += 1;
      } else if (hasAnyAssignee) {
        movedToOther += 1;
        const newOwner = snap.assigned_to_name || snap.assigned_to_pro_name || '(unknown)';
        addCount(movedToUserCounts, newOwner, 1);
        movedLeadsRows.push({
          leadId: snap.id,
          enquiryNumber: snap.enquiry_number || '',
          leadName: snap.name || '',
          currentStatus: snap.lead_status || '',
          assignedTo: snap.assigned_to_name || '',
          assignedToPro: snap.assigned_to_pro_name || '',
          cycleNumber: snap.cycle_number || 1,
          mandal: snap.mandal || '',
          studentGroup: snap.student_group || '',
        });
      } else {
        currentlyUnassigned += 1;
      }
    }

    console.log('\n=== Current Position of Originally Assigned Leads ===');
    console.table([{
      totalDistinctLeads: uniqueLeadIds.length,
      stillWithUser,
      movedToOtherUser: movedToOther,
      currentlyUnassigned,
      cycleNumberGreaterThan1: reclaimedCycleGt1,
    }]);

    console.log('\n=== Top Current Owners (for moved leads) ===');
    console.table(
      [...movedToUserCounts.entries()]
        .map(([owner, count]) => ({ owner, leads: count }))
        .sort((a, b) => b.leads - a.leads || a.owner.localeCompare(b.owner))
        .slice(0, args.limit)
    );

    const assignmentEventsAll = await fetchAssignmentEventsForLeads(pool, uniqueLeadIds);
    const reassignedAwayCounts = new Map();
    let reassignedAwayEvents = 0;
    let assignedBackToUserEvents = 0;

    for (const evt of assignmentEventsAll) {
      const baseline = leadFirstAssignedAt.get(evt.lead_id);
      if (!baseline) continue;
      if (new Date(evt.created_at) <= baseline) continue;

      const newAssigneeId = String(evt.new_assignee_id || '');
      if (!newAssigneeId) continue;

      if (newAssigneeId === user.id) {
        assignedBackToUserEvents += 1;
      } else {
        reassignedAwayEvents += 1;
        addCount(reassignedAwayCounts, evt.new_assignee_name || '(unknown)', 1);
      }
    }

    const reclaimEvents = await fetchReclaimEventsForUserLeads(pool, uniqueLeadIds, user.id);
    const automatedReclaims = reclaimEvents.filter((r) => r.performed_by === SYSTEM_AUTOMATION_USER_ID).length;
    const manualReclaims = reclaimEvents.length - automatedReclaims;

    const postActivityRows = await fetchPostAssignmentActivity(pool, uniqueLeadIds, toIso(minBaselineAt));
    let nonAssignmentStatusUpdates = 0;
    let statusUpdatesByTargetUser = 0;
    let statusUpdatesByOthers = 0;

    for (const row of postActivityRows) {
      const baseline = leadFirstAssignedAt.get(row.lead_id);
      if (!baseline) continue;
      if (new Date(row.created_at) <= baseline) continue;
      if (Number(row.is_assignment_event) === 1) continue;

      nonAssignmentStatusUpdates += 1;
      if (row.performed_by === user.id) {
        statusUpdatesByTargetUser += 1;
      } else {
        statusUpdatesByOthers += 1;
      }
    }

    const commRows = await fetchPostAssignmentCommunications(pool, uniqueLeadIds, toIso(minBaselineAt));
    let callsByTargetUser = 0;
    let callsByOthers = 0;
    let smsByTargetUser = 0;
    let smsByOthers = 0;

    for (const row of commRows) {
      const baseline = leadFirstAssignedAt.get(row.lead_id);
      if (!baseline) continue;
      if (new Date(row.sent_at) <= baseline) continue;

      const isTargetUser = row.sent_by === user.id;
      if (row.type === 'call') {
        if (isTargetUser) callsByTargetUser += 1;
        else callsByOthers += 1;
      } else if (row.type === 'sms') {
        if (isTargetUser) smsByTargetUser += 1;
        else smsByOthers += 1;
      }
    }

    console.log('\n=== What Happened After Initial Assignment (For Same Lead Set) ===');
    console.table([{
      reassignedAwayEvents,
      assignedBackToUserEvents,
      reclaimEventsFromThisUser: reclaimEvents.length,
      automatedReclaims,
      manualReclaims,
      nonAssignmentStatusUpdates,
      statusUpdatesByTargetUser,
      statusUpdatesByOthers,
      callsByTargetUser,
      callsByOthers,
      smsByTargetUser,
      smsByOthers,
    }]);

    console.log('\n=== Reassigned Away Destination (Events) ===');
    console.table(
      [...reassignedAwayCounts.entries()]
        .map(([newOwner, count]) => ({ newOwner, events: count }))
        .sort((a, b) => b.events - a.events || a.newOwner.localeCompare(b.newOwner))
        .slice(0, args.limit)
    );

    if (movedLeadsRows.length > 0) {
      console.log(`\n=== Sample Leads No Longer With ${user.name} (Top ${Math.min(args.limit, movedLeadsRows.length)}) ===`);
      console.table(movedLeadsRows.slice(0, args.limit));
    }

    if (reclaimEvents.length > 0) {
      console.log(`\n=== Sample Reclaim Events From ${user.name} (Top ${Math.min(args.limit, reclaimEvents.length)}) ===`);
      console.table(
        reclaimEvents.slice(0, args.limit).map((row) => ({
          leadId: row.lead_id,
          at: toIso(row.created_at),
          previousCycle: row.previous_cycle,
          newCycle: row.new_cycle,
          by: row.performed_by_name,
          comment: row.comment,
        }))
      );
    }
  } finally {
    await closeDB();
  }
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

