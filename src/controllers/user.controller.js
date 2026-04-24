import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { connectHRMS } from '../config-mongo/hrms.js';

const VALID_ROLES = ['Super Admin', 'Sub Super Admin', 'Student Counselor', 'Data Entry User', 'PRO'];

const sanitizePermissions = (permissions = {}) => {
  if (!permissions || typeof permissions !== 'object') {
    return {};
  }
  const sanitized = {};
  Object.entries(permissions).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const access = Boolean(value.access);
    const permission = value.permission === 'write' ? 'write' : value.permission === 'read' ? 'read' : 'read';
    sanitized[key] = {
      access,
      permission,
    };
  });
  return sanitized;
};

// Helper function to format user data from SQL to camelCase
const formatUser = (userData) => {
  if (!userData) return null;
  const timeTrackingEnabled = userData.time_tracking_enabled === undefined
    ? true
    : (userData.time_tracking_enabled === 1 || userData.time_tracking_enabled === true);
  return {
    id: userData.id,
    _id: userData.id, // Keep _id for backward compatibility
    hrms_id: userData.hrms_id,
    emp_no: userData.emp_no,
    name: userData.name,
    email: userData.email,
    mobileNumber: userData.mobile_number,
    roleName: userData.role_name,
    managedBy: userData.managed_by,
    isManager: userData.is_manager === 1 || userData.is_manager === true,
    designation: userData.designation,
    permissions: typeof userData.permissions === 'string'
      ? JSON.parse(userData.permissions)
      : userData.permissions || {},
    isActive: userData.is_active === 1 || userData.is_active === true,
    timeTrackingEnabled,
    createdAt: userData.created_at,
    updatedAt: userData.updated_at,
  };
};

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Super Admin)
export const getUsers = async (req, res) => {
  try {
    const pool = getPool();

    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users ORDER BY created_at DESC'
    );

    const formattedUsers = users.map(formatUser);

    // Hydrate users with HRMS organizational details if linked
    const empNoStrings = [
      ...new Set(
        formattedUsers
          .filter((u) => u.emp_no != null && String(u.emp_no).trim() !== '')
          .map((u) => String(u.emp_no).trim())
      ),
    ];
    const empNoNumbers = [
      ...new Set(
        empNoStrings
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && !Number.isNaN(n))
      ),
    ];
    if (empNoStrings.length > 0) {
      try {
        const hrmsConn = await connectHRMS();
        const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
        const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
        const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
        const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));
        const Designation = hrmsConn.models.designations || hrmsConn.model('designations', new hrmsConn.base.Schema({}, { strict: false }));

        // HRMS may store emp_no as Number or String; $in with only strings misses numeric docs (list shows blank div/dept until per-user HRMS fetch).
        const empNoOr = [];
        if (empNoStrings.length) empNoOr.push({ emp_no: { $in: empNoStrings } });
        if (empNoNumbers.length) empNoOr.push({ emp_no: { $in: empNoNumbers } });
        const hrmsEmployeesRaw = await Employee.find(empNoOr.length === 1 ? empNoOr[0] : { $or: empNoOr })
          .select('emp_no division_id department_id employee_group_id designation_id dynamicFields');

        const seenEmp = new Set();
        const hrmsEmployees = [];
        for (const emp of hrmsEmployeesRaw || []) {
          const k = String(emp.emp_no ?? '').trim();
          if (!k || seenEmp.has(k)) continue;
          seenEmp.add(k);
          hrmsEmployees.push(emp);
        }

        if (hrmsEmployees.length > 0) {
          const divIds = [...new Set(hrmsEmployees.map(e => e.division_id).filter(id => id))];
          const deptIds = [...new Set(hrmsEmployees.map(e => e.department_id).filter(id => id))];
          const groupIds = [...new Set(hrmsEmployees.map(e => e.employee_group_id).filter(id => id))];
          const designationIds = [...new Set(hrmsEmployees.map(e => e.designation_id).filter(id => id))];

          const [divisions, departments, groups, designations] = await Promise.all([
            Division.find({ _id: { $in: divIds } }).select('name'),
            Department.find({ _id: { $in: deptIds } }).select('name'),
            Group.find({ _id: { $in: groupIds } }).select('name'),
            Designation.find({ _id: { $in: designationIds } }).select('name')
          ]);

          const divMap = Object.fromEntries(divisions.map(d => [d._id.toString(), d.name]));
          const deptMap = Object.fromEntries(departments.map(d => [d._id.toString(), d.name]));
          const groupMap = Object.fromEntries(groups.map(g => [g._id.toString(), g.name]));
          const designationMap = Object.fromEntries(designations.map(d => [d._id.toString(), d.name]));

          const extractDesignationName = (emp) => {
            const byId = emp.designation_id ? designationMap[emp.designation_id.toString()] : null;
            if (byId) return byId;
            const dynamicFields = emp.dynamicFields || {};
            if (typeof dynamicFields.designation_name === 'string' && dynamicFields.designation_name.trim()) {
              return dynamicFields.designation_name.trim();
            }
            const rawDesignation = dynamicFields.designation;
            if (typeof rawDesignation === 'string' && rawDesignation.trim()) {
              try {
                const parsed = JSON.parse(rawDesignation);
                if (parsed?.name && String(parsed.name).trim()) return String(parsed.name).trim();
              } catch {
                // ignore parse errors and fallback
              }
            }
            return null;
          };

          const hrmsMap = Object.fromEntries(
            hrmsEmployees.map((emp) => {
              const key = String(emp.emp_no ?? '').trim();
              return [
                key,
                {
                  division: emp.division_id ? divMap[emp.division_id.toString()] || '-' : '-',
                  department: emp.department_id ? deptMap[emp.department_id.toString()] || '-' : '-',
                  group: emp.employee_group_id ? groupMap[emp.employee_group_id.toString()] || '-' : '-',
                  designation: extractDesignationName(emp) || null,
                },
              ];
            })
          );

          formattedUsers.forEach((user) => {
            const key = user.emp_no != null ? String(user.emp_no).trim() : '';
            if (key && hrmsMap[key]) {
              user.division = hrmsMap[key].division;
              user.department = hrmsMap[key].department;
              user.group = hrmsMap[key].group;
              // HRMS designation is source of truth; fallback to SQL designation if unavailable
              user.designation = hrmsMap[key].designation || user.designation || null;
            }
          });
        }
      } catch (hrmsError) {
        console.error('HRMS hydration error in getUsers:', hrmsError);
      }
    }

    return successResponse(res, formattedUsers, 'Users retrieved successfully', 200);
  } catch (error) {
    console.error('Get users error:', error);
    return errorResponse(res, error.message || 'Failed to get users', 500);
  }
};

// @desc    Get lightweight assignable users list
// @route   GET /api/users/assignable
// @access  Private (Super Admin)
export const getAssignableUsers = async (req, res) => {
  try {
    const pool = getPool();
    const [users] = await pool.execute(
      `SELECT id, name, email, role_name, is_active
       FROM users
       WHERE is_active = 1
         AND role_name IN ('Sub Super Admin', 'Student Counselor', 'Data Entry User', 'PRO')
       ORDER BY name ASC`
    );

    const payload = (users || []).map((u) => ({
      id: u.id,
      _id: u.id,
      name: u.name,
      email: u.email,
      roleName: u.role_name,
      isActive: u.is_active === 1 || u.is_active === true,
    }));

    return successResponse(res, payload, 'Assignable users retrieved successfully', 200);
  } catch (error) {
    console.error('Get assignable users error:', error);
    return errorResponse(res, error.message || 'Failed to get assignable users', 500);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (Super Admin or Manager for their team members)
export const getUser = async (req, res) => {
  try {
    const isAdmin = req.user.roleName === 'Super Admin' || req.user.roleName === 'Sub Super Admin';
    const isManager = req.user.isManager === true;

    // If not admin or manager, deny access
    if (!isAdmin && !isManager) {
      return errorResponse(res, 'Access denied', 403);
    }

    const pool = getPool();

    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ?',
      [req.params.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = formatUser(users[0]);

    // If manager (not admin), check if the requested user is in their team
    if (isManager && !isAdmin) {
      const managedById = user.managedBy;
      const managerId = req.user.id || req.user._id;

      if (managedById !== managerId) {
        return errorResponse(res, 'Access denied. You can only view your team members.', 403);
      }
    }

    return successResponse(res, user, 'User retrieved successfully', 200);
  } catch (error) {
    console.error('Get user error:', error);
    return errorResponse(res, error.message || 'Failed to get user', 500);
  }
};

// @desc    Create new user
// @route   POST /api/users
// @access  Private (Super Admin)
export const createUser = async (req, res) => {
  try {
    const { name, email, password, roleName, designation, permissions, mobileNumber, hrms_id, emp_no } = req.body;

    if (!VALID_ROLES.includes(roleName)) {
      return errorResponse(res, 'Invalid role. Must be one of: Super Admin, Sub Super Admin, Student Counselor, Data Entry User, PRO', 400);
    }

    if (roleName === 'Sub Super Admin' && (permissions && typeof permissions !== 'object')) {
      return errorResponse(res, 'Permissions must be provided as an object for sub super admins', 400);
    }

    const pool = getPool();

    // Check if user exists (email only if provided)
    if (email && email.trim()) {
      const [existingUsers] = await pool.execute(
        'SELECT id FROM users WHERE email = ?',
        [email.toLowerCase().trim()]
      );

      if (existingUsers.length > 0) {
        return errorResponse(res, 'User with this email already exists', 400);
      }
    }

    if (mobileNumber) {
      const [existingMobile] = await pool.execute(
        'SELECT id FROM users WHERE mobile_number = ?',
        [mobileNumber.trim()]
      );

      if (existingMobile.length > 0) {
        return errorResponse(res, 'User with this mobile number already exists', 400);
      }
    }

    const sanitizedPermissions =
      roleName === 'Sub Super Admin' ? sanitizePermissions(permissions) : {};

    // Hash password (only if not an HRMS user)
    let hashedPassword = null;
    if (!emp_no) {
      if (!password) {
        return errorResponse(res, 'Password is required for non-HRMS users', 400);
      }
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password, salt);
    }

    // Generate UUID
    const userId = uuidv4();

    // Insert user
    await pool.execute(
      `INSERT INTO users (id, hrms_id, emp_no, name, email, mobile_number, password, role_name, designation, permissions, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        userId,
        hrms_id || null,
        emp_no || null,
        name.trim(),
        email && email.trim() ? email.toLowerCase().trim() : null,
        mobileNumber ? mobileNumber.trim() : null,
        hashedPassword,
        roleName,
        roleName === 'Student Counselor' || roleName === 'Data Entry User' || roleName === 'PRO' ? (designation?.trim() || null) : null,
        JSON.stringify(sanitizedPermissions),
        true
      ]
    );

    // Fetch created user
    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE id = ?',
      [userId]
    );

    const user = formatUser(users[0]);

    return successResponse(res, user, 'User created successfully', 201);
  } catch (error) {
    console.error('Create user error:', error);
    return errorResponse(res, error.message || 'Failed to create user', 500);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Super Admin)
export const updateUser = async (req, res) => {
  try {
    const { name, email, password, roleName, isActive, designation, permissions, mobileNumber, unassignLeads, hrms_id, emp_no } = req.body;
    const pool = getPool();

    // Get current user
    const [users] = await pool.execute(
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active FROM users WHERE id = ?',
      [req.params.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const currentUser = users[0];
    const wasManager = currentUser.is_manager === 1 || currentUser.is_manager === true;

    // Build update fields
    const updateFields = [];
    const updateValues = [];

    if (name) {
      updateFields.push('name = ?');
      updateValues.push(name.trim());
    }

    if (email && email.trim()) {
      // Check if email is already in use by another user
      const [existingUsers] = await pool.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email.toLowerCase().trim(), req.params.id]
      );
      if (existingUsers.length > 0) {
        return errorResponse(res, 'Email already in use', 400);
      }
      updateFields.push('email = ?');
      updateValues.push(email.toLowerCase().trim());
    } else if (email === null || email === '') {
      // Explicitly clearing email
      updateFields.push('email = NULL');
    }

    if (mobileNumber !== undefined) {
      if (mobileNumber) {
        // Check if mobile number is already in use by another user
        const [existingMobile] = await pool.execute(
          'SELECT id FROM users WHERE mobile_number = ? AND id != ?',
          [mobileNumber.trim(), req.params.id]
        );
        if (existingMobile.length > 0) {
          return errorResponse(res, 'Mobile number already in use', 400);
        }
        updateFields.push('mobile_number = ?');
        updateValues.push(mobileNumber.trim());
      } else {
        // Allow clearing mobile number
        updateFields.push('mobile_number = NULL');
      }
    }

    if (password) {
      if (password.length < 6) {
        return errorResponse(res, 'Password must be at least 6 characters long', 400);
      }
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }

    if (hrms_id !== undefined) {
      updateFields.push('hrms_id = ?');
      updateValues.push(hrms_id || null);
    }

    if (emp_no !== undefined) {
      updateFields.push('emp_no = ?');
      updateValues.push(emp_no || null);
    }

    // Handle isManager boolean
    let newIsManager = currentUser.is_manager === 1 || currentUser.is_manager === true;
    if (req.body.isManager !== undefined) {
      newIsManager = Boolean(req.body.isManager);
      updateFields.push('is_manager = ?');
      updateValues.push(newIsManager);
    }

    // Determine final roleName
    let finalRoleName = currentUser.role_name;
    if (roleName) {
      if (!VALID_ROLES.includes(roleName)) {
        return errorResponse(res, 'Invalid role. Must be one of: Super Admin, Sub Super Admin, Student Counselor, Data Entry User, PRO', 400);
      }
      if (roleName === 'Manager') {
        return errorResponse(res, 'Use isManager boolean field instead of setting roleName to Manager', 400);
      }
      finalRoleName = roleName;
      updateFields.push('role_name = ?');
      updateValues.push(roleName);
      // If changing role away from Manager-like role, clear isManager
      if (roleName !== 'Sub Super Admin') {
        newIsManager = false;
        updateFields.push('is_manager = ?');
        updateValues.push(false);
      }
    }

    // Handle managedBy field
    if (req.body.managedBy !== undefined) {
      if (req.body.managedBy === null || req.body.managedBy === '') {
        updateFields.push('managed_by = ?');
        updateValues.push(null);
      } else {
        // Verify manager exists and is a manager
        const [managers] = await pool.execute(
          'SELECT id, is_manager FROM users WHERE id = ?',
          [req.body.managedBy]
        );
        if (managers.length === 0) {
          return errorResponse(res, 'Manager not found', 404);
        }
        if (managers[0].is_manager !== 1 && managers[0].is_manager !== true) {
          return errorResponse(res, 'Only users with Manager privileges can manage team members', 400);
        }
        updateFields.push('managed_by = ?');
        updateValues.push(req.body.managedBy);
      }
    }

    if (typeof isActive === 'boolean') {
      updateFields.push('is_active = ?');
      updateValues.push(isActive);
    }

    // Handle designation and permissions based on role
    if (finalRoleName === 'Student Counselor' || finalRoleName === 'Data Entry User' || finalRoleName === 'PRO') {
      if (designation !== undefined) {
        updateFields.push('designation = ?');
        updateValues.push(designation && designation.trim() ? designation.trim() : null);
      }
      updateFields.push('permissions = ?');
      updateValues.push(JSON.stringify({}));
    } else if (finalRoleName === 'Sub Super Admin') {
      if (permissions && typeof permissions !== 'object') {
        return errorResponse(res, 'Permissions must be provided as an object for sub super admins', 400);
      }
      const sanitizedPerms = sanitizePermissions(permissions);
      updateFields.push('permissions = ?');
      updateValues.push(JSON.stringify(sanitizedPerms));
      updateFields.push('designation = ?');
      updateValues.push(null);
    } else {
      // Super Admin
      updateFields.push('permissions = ?');
      updateValues.push(JSON.stringify({}));
      updateFields.push('designation = ?');
      updateValues.push(null);
    }

    // Add updated_at
    updateFields.push('updated_at = NOW()');

    // Execute update
    if (updateFields.length > 0) {
      updateValues.push(req.params.id);
      await pool.execute(
        `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // If revoking manager, clear managedBy for all team members
    if (wasManager && !newIsManager) {
      await pool.execute(
        'UPDATE users SET managed_by = NULL WHERE managed_by = ?',
        [req.params.id]
      );
    }

    // Unassign leads if requested during deactivation
    if (isActive === false && unassignLeads) {
      const isProRole = currentUser.role_name === 'PRO';
      const assignmentCol = isProRole ? 'assigned_to_pro' : 'assigned_to';
      const assignmentAtCol = isProRole ? 'pro_assigned_at' : 'assigned_at';
      const assignmentByCol = isProRole ? 'pro_assigned_by' : 'assigned_by';
      const currentUserId = req.user.id || req.user._id;

      // Get all leads assigned to this user
      const [leadsToUnassign] = await pool.execute(
        `SELECT id, lead_status FROM leads WHERE ${assignmentCol} = ?`,
        [req.params.id]
      );

      if (leadsToUnassign.length > 0) {
        const leadIds = leadsToUnassign.map((l) => l.id);
        const placeholders = leadIds.map(() => '?').join(',');

        // Unassign leads
        await pool.execute(
          `UPDATE leads SET ${assignmentCol} = NULL, ${assignmentAtCol} = NULL, ${assignmentByCol} = NULL, lead_status = 'New', updated_at = NOW() WHERE id IN (${placeholders})`,
          leadIds
        );

        // Add activity logs
        for (const lead of leadsToUnassign) {
          const activityLogId = uuidv4();
          await pool.execute(
            `INSERT INTO activity_logs (
              id, lead_id, type, old_status, new_status, comment, performed_by, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              activityLogId,
              lead.id,
              'status_change',
              lead.lead_status || 'Assigned',
              'New',
              `Assignment removed due to user deactivation`,
              currentUserId,
              JSON.stringify({
                unassignment: {
                  removedFrom: req.params.id,
                  removedBy: currentUserId,
                  reason: 'User Deactivation'
                },
              }),
            ]
          );
        }
      }
    }

    // Fetch updated user
    const [updatedUsers] = await pool.execute(
      'SELECT id, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE id = ?',
      [req.params.id]
    );

    const user = formatUser(updatedUsers[0]);

    return successResponse(res, user, 'User updated successfully', 200);
  } catch (error) {
    console.error('Update user error:', error);
    return errorResponse(res, error.message || 'Failed to update user', 500);
  }
};

// @desc    Search employees from HRMS MongoDB
// @route   GET /api/users/hrms/search
// @access  Private (Super Admin)
export const searchHrmsEmployees = async (req, res) => {
  try {
    const { name } = req.query;

    if (!name || name.length < 2) {
      return successResponse(res, [], 'Please provide at least 2 characters for search');
    }

    const hrmsConn = await connectHRMS();
    
    // Define models if they don't exist
    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));

    // Search by employee_name (case-insensitive partial match)
    const employees = await Employee.find({
      employee_name: { $regex: name, $options: 'i' }
    }).limit(20).select('_id emp_no employee_name email phone_number division_id department_id employee_group_id');

    // Collect IDs for bulk resolution
    const divIds = [...new Set(employees.map(e => e.division_id).filter(id => id))];
    const deptIds = [...new Set(employees.map(e => e.department_id).filter(id => id))];
    const groupIds = [...new Set(employees.map(e => e.employee_group_id).filter(id => id))];

    const [divisions, departments, groups] = await Promise.all([
      Division.find({ _id: { $in: divIds } }).select('name'),
      Department.find({ _id: { $in: deptIds } }).select('name'),
      Group.find({ _id: { $in: groupIds } }).select('name')
    ]);

    const divMap = Object.fromEntries(divisions.map(d => [d._id.toString(), d.name]));
    const deptMap = Object.fromEntries(departments.map(d => [d._id.toString(), d.name]));
    const groupMap = Object.fromEntries(groups.map(g => [g._id.toString(), g.name]));

    // Map fields for frontend consistency (employee_name -> name)
    const formattedEmployees = employees.map(emp => ({
      _id: emp._id,
      id: emp._id,
      emp_no: emp.emp_no,
      name: emp.employee_name,
      email: emp.email,
      mobileNumber: emp.phone_number,
      division: emp.division_id ? divMap[emp.division_id.toString()] || '-' : '-',
      department: emp.department_id ? deptMap[emp.department_id.toString()] || '-' : '-',
      group: emp.employee_group_id ? groupMap[emp.employee_group_id.toString()] || '-' : '-'
    }));

    return successResponse(res, formattedEmployees, 'Employees retrieved successfully');
  } catch (error) {
    console.error('Search HRMS employees error:', error);
    return errorResponse(res, 'Failed to search HRMS employees', 500);
  }
};

// @desc    Get employee details from HRMS by emp_no
// @route   GET /api/users/hrms/:empNo
// @access  Private (Super Admin)
export const getHrmsEmployeeByEmpNo = async (req, res) => {
  try {
    const { empNo } = req.params;
    const empNoStr = String(empNo ?? '').trim();
    const empNoNum = Number(empNoStr);

    const hrmsConn = await connectHRMS();
    
    const Employee = hrmsConn.models.employees || hrmsConn.model('employees', new hrmsConn.base.Schema({}, { strict: false }));
    const Division = hrmsConn.models.divisions || hrmsConn.model('divisions', new hrmsConn.base.Schema({}, { strict: false }));
    const Department = hrmsConn.models.departments || hrmsConn.model('departments', new hrmsConn.base.Schema({}, { strict: false }));
    const Group = hrmsConn.models.employeegroups || hrmsConn.model('employeegroups', new hrmsConn.base.Schema({}, { strict: false }));

    const empNoOr = [{ emp_no: empNoStr }];
    if (Number.isFinite(empNoNum) && !Number.isNaN(empNoNum)) empNoOr.push({ emp_no: empNoNum });
    const employee = await Employee.findOne(empNoOr.length === 1 ? empNoOr[0] : { $or: empNoOr });

    if (!employee) {
      return errorResponse(res, 'Employee not found in HRMS', 404);
    }

    // Resolve IDs to names
    let division = '-';
    let department = '-';
    let group = '-';

    if (employee.division_id) {
      const divDoc = await Division.findById(employee.division_id);
      if (divDoc) division = divDoc.name;
    }

    if (employee.department_id) {
      const deptDoc = await Department.findById(employee.department_id);
      if (deptDoc) department = deptDoc.name;
    }

    if (employee.employee_group_id) {
      const groupDoc = await Group.findById(employee.employee_group_id);
      if (groupDoc) group = groupDoc.name;
    }

    const result = {
      _id: employee._id,
      id: employee._id,
      emp_no: employee.emp_no,
      name: employee.employee_name,
      email: employee.email,
      mobileNumber: employee.phone_number,
      division,
      department,
      group
    };

    return successResponse(res, result, 'Employee details retrieved successfully');
  } catch (error) {
    console.error('Get HRMS employee error:', error);
    return errorResponse(res, 'Failed to fetch HRMS employee details', 500);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (Super Admin)
export const deleteUser = async (req, res) => {
  try {
    const pool = getPool();

    // Check if user exists
    const [users] = await pool.execute(
      'SELECT id FROM users WHERE id = ?',
      [req.params.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    // Don't allow deleting yourself
    const currentUserId = req.user.id || req.user._id;
    if (users[0].id === currentUserId) {
      return errorResponse(res, 'You cannot delete your own account', 400);
    }

    // Delete user (foreign key constraints will handle managed_by relationships)
    await pool.execute(
      'DELETE FROM users WHERE id = ?',
      [req.params.id]
    );

    return successResponse(res, null, 'User deleted successfully', 200);
  } catch (error) {
    console.error('Delete user error:', error);
    return errorResponse(res, error.message || 'Failed to delete user', 500);
  }
};

