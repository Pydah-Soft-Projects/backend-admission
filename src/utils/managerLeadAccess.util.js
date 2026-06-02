/**
 * Manager access to a lead: same scope as GET /api/manager/leads
 * (assigned_to is the manager or a direct report).
 */
export async function managerCanAccessLead(pool, managerId, lead) {
  if (!managerId || !lead) return false;

  const assignedTo = lead.assigned_to ?? null;
  if (!assignedTo) return false;
  if (assignedTo === managerId) return true;

  const [teamMembers] = await pool.execute(
    'SELECT id FROM users WHERE managed_by = ?',
    [managerId]
  );
  const teamMemberIds = teamMembers.map((m) => m.id);
  return teamMemberIds.includes(assignedTo);
}
