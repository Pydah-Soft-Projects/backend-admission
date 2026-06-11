const JOINING_KEY = 'joining';

const getJoiningPermission = (user) => {
  const permissions = user?.permissions;
  if (!permissions || typeof permissions !== 'object') return undefined;
  return permissions[JOINING_KEY];
};

export const isLegacyJoiningWrite = (entry) => {
  if (!entry?.access || entry.permission !== 'write') return false;
  return (
    entry.editReference === undefined &&
    entry.editAdmission === undefined &&
    entry.approveFeeRequest === undefined
  );
};

/** Reference edits are restricted to Super Admin only (not grantable to other roles). */
export const canJoiningEditReference = (user) => {
  if (!user) return false;
  return user.roleName === 'Super Admin';
};

export const canJoiningEditAdmission = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  if (user.roleName !== 'Sub Super Admin') return false;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  return Boolean(entry.editAdmission);
};

/** Submit revised fee requests from Step 4 — any joining desk Read & Write user. */
export const canSubmitFeeRequest = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  if (user.roleName !== 'Sub Super Admin') return false;
  const entry = getJoiningPermission(user);
  return Boolean(entry?.access && entry.permission === 'write');
};

/** Approve / reject fee requests on the Fee Requests desk (requires explicit approveFeeRequest flag). */
export const canApproveFeeRequest = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  if (user.roleName !== 'Sub Super Admin') return false;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  return Boolean(entry.approveFeeRequest);
};
