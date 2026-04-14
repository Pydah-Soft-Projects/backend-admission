/**
 * Shared lead status resolver for channel-driven workflows.
 *
 * Source statuses:
 * - Counsellor: call_status
 * - PRO:        visit_status
 *
 * Canonical merged lead_status values:
 * - New
 * - Assigned
 * - Interested (includes "CET Applied")
 * - Not Interested
 * - Call Back (includes Re-Visit / Scheduled Revisit)
 * - Wrong Data
 * - Visited
 * - Confirmed
 */

const normalize = (v) => String(v ?? '').trim().toLowerCase();

export const isInterestedValue = (v) => {
  const s = normalize(v);
  return s === 'interested' || s === 'cet applied' || s === 'cet_applied';
};

function mapChannelStatusToLeadStatus(status) {
  const s = normalize(status);
  if (!s) return null;

  if (s === 'confirmed') return 'Confirmed';
  if (s === 'visited') return 'Visited';
  if (s === 'interested' || s === 'cet applied' || s === 'cet_applied') return 'Interested';
  if (s === 'not interested') return 'Not Interested';
  if (
    s === 'call back' ||
    s === 'callback' ||
    s === 're-visit' ||
    s === 'revisit' ||
    s === 'scheduled revisit'
  ) {
    return 'Call Back';
  }
  if (s === 'wrong data' || s === 'wrong number' || s === 'invalid number') return 'Wrong Data';
  if (s === 'assigned') return 'Assigned';
  if (s === 'new') return 'New';

  return null;
}

const LEAD_STATUS_PRIORITY = [
  'Confirmed',
  'Visited',
  'Interested',
  'Call Back',
  'Not Interested',
  'Wrong Data',
  'Assigned',
  'New',
];

function selectHigherPriorityStatus(a, b) {
  const ai = LEAD_STATUS_PRIORITY.indexOf(a);
  const bi = LEAD_STATUS_PRIORITY.indexOf(b);
  if (ai === -1) return b;
  if (bi === -1) return a;
  return ai <= bi ? a : b;
}

/** True when pipeline lead_status should become "Assigned" after assigning to a user (bulk or PUT). */
export function isPipelineNewLeadStatus(leadStatus) {
  const s = String(leadStatus ?? '').trim().toLowerCase();
  return !s || s === 'new';
}

/**
 * @param {string} desiredLeadStatus - Target lead_status from role rules (e.g. admin edit or unchanged current)
 * @param {string|null|undefined} callStatus
 * @param {string|null|undefined} visitStatus
 */
export function resolveLeadStatus(desiredLeadStatus, callStatus, visitStatus) {
  const mappedCall = mapChannelStatusToLeadStatus(callStatus);
  const mappedVisit = mapChannelStatusToLeadStatus(visitStatus);

  if (mappedCall && mappedVisit) {
    if (mappedCall === mappedVisit) return mappedCall;

    const desired = String(desiredLeadStatus ?? '').trim();
    if (desired && (desired === mappedCall || desired === mappedVisit)) {
      return desired;
    }
    return selectHigherPriorityStatus(mappedCall, mappedVisit);
  }

  if (mappedCall) return mappedCall;
  if (mappedVisit) return mappedVisit;
  return desiredLeadStatus || 'New';
}
