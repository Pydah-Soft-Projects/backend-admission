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

const normalize = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

export const isInterestedValue = (v) => {
  const s = normalize(v);
  return s === 'interested' || s === 'cet applied' || s === 'cet_applied';
};

/** Map free-text / legacy values to canonical lead_status (case-insensitive). */
export function canonicalizeLeadStatus(status) {
  const mapped = mapChannelStatusToLeadStatus(status);
  if (mapped) return mapped;
  const trimmed = String(status ?? '').trim();
  return trimmed || 'New';
}

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
  const current = canonicalizeLeadStatus(desiredLeadStatus);

  // 1. Get the best status from active channel updates
  let bestChannel = null;
  if (mappedCall && mappedVisit) {
    bestChannel = selectHigherPriorityStatus(mappedCall, mappedVisit);
  } else {
    bestChannel = mappedCall || mappedVisit;
  }

  // 2. Resolve against current canonical status
  if (bestChannel) {
    // We have a channel update. We should never "downgrade" from a high-priority state
    // (like Visited or Confirmed) unless it's an explicit admin override (not handled here).
    return selectHigherPriorityStatus(bestChannel, current);
  }

  // 3. Fallback to current or default
  return canonicalizeLeadStatus(current || 'New');
}

function isHighPriorityPipelineStatus(status) {
  const i = LEAD_STATUS_PRIORITY.indexOf(status);
  return i >= 0 && i <= 1; // Confirmed, Visited
}

/**
 * Merged lead_status after explicitly writing call_status or visit_status.
 * The channel being written drives the pipeline unless the other channel is Confirmed/Visited.
 * (Avoids visit "Interested" blocking call "Not Interested" on manager/counsellor updates.)
 *
 * @param {'call_status'|'visit_status'} channel
 * @param {string} newChannelValue
 * @param {string|null|undefined} otherChannelValue
 * @param {string|null|undefined} currentLeadStatus
 */
export function resolveLeadStatusAfterChannelWrite(
  channel,
  newChannelValue,
  otherChannelValue,
  currentLeadStatus
) {
  const mappedWritten = mapChannelStatusToLeadStatus(newChannelValue);
  if (!mappedWritten) return canonicalizeLeadStatus(currentLeadStatus);

  const mappedOther = mapChannelStatusToLeadStatus(otherChannelValue);
  if (mappedOther && isHighPriorityPipelineStatus(mappedOther)) {
    return selectHigherPriorityStatus(mappedOther, mappedWritten);
  }

  return mappedWritten;
}

/**
 * Activity log channel for role defaults (managers write call/visit, not raw lead_status).
 * @param {{ statusChannel?: string, isManager?: boolean, roleName?: string, newStatus?: string }} opts
 */
export function defaultActivityStatusChannel(opts) {
  const { statusChannel, isManager, roleName, newStatus } = opts;
  if (statusChannel) return statusChannel;
  if (roleName === 'PRO') return 'visit_status';
  if (roleName === 'Student Counselor') return 'call_status';
  if (isManager && newStatus) {
    const s = normalize(newStatus);
    if (s === 'scheduled revisit' || s === 're-visit' || s === 'revisit') return 'visit_status';
    return 'call_status';
  }
  return 'lead_status';
}
