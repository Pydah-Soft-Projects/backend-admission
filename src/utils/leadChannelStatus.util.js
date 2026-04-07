/**
 * Call status (counsellor) and visit status (PRO) on leads.
 * If either channel is "Interested" (case-insensitive), lead_status must be Interested.
 */

export const isInterestedValue = (v) => String(v ?? '').trim().toLowerCase() === 'interested';

/**
 * @param {string} desiredLeadStatus - Target lead_status from role rules (e.g. admin edit or unchanged current)
 * @param {string|null|undefined} callStatus
 * @param {string|null|undefined} visitStatus
 */
export function resolveLeadStatus(desiredLeadStatus, callStatus, visitStatus) {
  if (isInterestedValue(callStatus) || isInterestedValue(visitStatus)) {
    return 'Interested';
  }
  return desiredLeadStatus;
}
