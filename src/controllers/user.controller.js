import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const VALID_ROLES = ['Super Admin', 'Sub Super Admin', 'Student Counselor', 'Data Entry User'];

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
    name: userData.name,
    email: userData.email,
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
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users ORDER BY created_at DESC'
    );

    const formattedUsers = users.map(formatUser);

    return successResponse(res, formattedUsers, 'Users retrieved successfully', 200);
  } catch (error) {
    console.error('Get users error:', error);
    return errorResponse(res, error.message || 'Failed to get users', 500);
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
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ?',
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
    const { name, email, password, roleName, designation, permissions } = req.body;

    if (!name || !email || !password || !roleName) {
      return errorResponse(res, 'Please provide name, email, password, and roleName', 400);
    }

    if (!VALID_ROLES.includes(roleName)) {
      return errorResponse(res, 'Invalid role. Must be one of: Super Admin, Sub Super Admin, User, Student Counselor, Data Entry User', 400);
    }



    if (roleName === 'Sub Super Admin' && (permissions && typeof permissions !== 'object')) {
      return errorResponse(res, 'Permissions must be provided as an object for sub super admins', 400);
    }

    const pool = getPool();

    // Check if user exists
    const [existingUsers] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (existingUsers.length > 0) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    const sanitizedPermissions =
      roleName === 'Sub Super Admin' ? sanitizePermissions(permissions) : {};

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate UUID
    const userId = uuidv4();

    // Insert user
    await pool.execute(
      `INSERT INTO users (id, name, email, password, role_name, designation, permissions, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        userId,
        name.trim(),
        email.toLowerCase().trim(),
        hashedPassword,
        roleName,
        roleName === 'Student Counselor' || roleName === 'Data Entry User' ? (designation?.trim() || null) : null,
        JSON.stringify(sanitizedPermissions),
        true
      ]
    );

    // Fetch created user
    const [users] = await pool.execute(
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE id = ?',
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
    const { name, email, password, roleName, isActive, designation, permissions } = req.body;
    const pool = getPool();

    // Get current user
    const [users] = await pool.execute(
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active FROM users WHERE id = ?',
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

    if (email) {
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
        return errorResponse(res, 'Invalid role. Must be one of: Super Admin, Sub Super Admin, Student Counselor, Data Entry User', 400);
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
    if (finalRoleName === 'Student Counselor' || finalRoleName === 'Data Entry User') {
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

    // Fetch updated user
    const [updatedUsers] = await pool.execute(
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE id = ?',
      [req.params.id]
    );

    const user = formatUser(updatedUsers[0]);

    return successResponse(res, user, 'User updated successfully', 200);
  } catch (error) {
    console.error('Update user error:', error);
    return errorResponse(res, error.message || 'Failed to update user', 500);
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

