/** Lead source when reference is Direct on the joining form. */
export const JOINING_FORM_DIRECT_SOURCE = 'Direct';

/** Lead source for other references (staff name, custom reference, no reference). */
export const JOINING_FORM_DEFAULT_SOURCE = 'Joining Form';

/** @deprecated legacy label — new joinings use Direct / Joining Form from reference only. */
export const JOINING_FORM_EXISTING_LEAD_SOURCE = 'Joining Form (Existing Lead)';

export function isDirectReference(reference1) {
  return String(reference1 ?? '').trim().toLowerCase() === 'direct';
}

/**
 * Resolve CRM lead source for staff Add Joining Form / joining-form entry.
 * Reference Direct → Direct; otherwise Joining Form (same for new and existing CRM leads).
 */
export function resolveJoiningFormLeadSource({ reference1 } = {}) {
  if (isDirectReference(reference1)) {
    return JOINING_FORM_DIRECT_SOURCE;
  }
  return JOINING_FORM_DEFAULT_SOURCE;
}

/** @deprecated use JOINING_FORM_DIRECT_SOURCE */
export const ADD_JOINING_FORM_SOURCE = JOINING_FORM_DIRECT_SOURCE;

/** @deprecated use JOINING_FORM_DEFAULT_SOURCE */
export const ADD_JOINING_FORM_EXISTING_LEAD_SOURCE = JOINING_FORM_DEFAULT_SOURCE;
