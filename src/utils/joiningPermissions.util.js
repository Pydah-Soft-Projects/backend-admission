const JOINING_KEY = 'joining';

const getJoiningPermission = (user) => {
  const permissions = user?.permissions;
  if (!permissions || typeof permissions !== 'object') return undefined;
  return permissions[JOINING_KEY];
};

export const isLegacyJoiningWrite = (entry) => {
  if (!entry?.access || entry.permission !== 'write') return false;
  return entry.editReference === undefined && entry.editAdmission === undefined;
};

export const canJoiningEditReference = (user) => {
  if (!user) return false;
  if (user.roleName === 'Super Admin') return true;
  if (user.roleName !== 'Sub Super Admin') return false;
  const entry = getJoiningPermission(user);
  if (!entry?.access || entry.permission !== 'write') return false;
  if (isLegacyJoiningWrite(entry)) return true;
  return Boolean(entry.editReference);
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
