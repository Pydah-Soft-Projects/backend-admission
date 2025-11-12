export const hasElevatedAdminPrivileges = (roleName = '') => {
  return roleName === 'Super Admin' || roleName === 'Sub Super Admin';
};

export const isTrueSuperAdmin = (roleName = '') => roleName === 'Super Admin';


