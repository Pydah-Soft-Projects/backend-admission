import User from '../models/User.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const VALID_ROLES = ['Super Admin', 'Sub Super Admin', 'User'];

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

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Super Admin)
export const getUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });

    return successResponse(res, users, 'Users retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get users', 500);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (Super Admin)
export const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    return successResponse(res, user, 'User retrieved successfully', 200);
  } catch (error) {
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
      return errorResponse(res, 'Role name must be Super Admin, Sub Super Admin, or User', 400);
    }

    if (roleName === 'User' && (!designation || !designation.trim())) {
      return errorResponse(res, 'Designation is required for users', 400);
    }

    if (roleName === 'Sub Super Admin' && (permissions && typeof permissions !== 'object')) {
      return errorResponse(res, 'Permissions must be provided as an object for sub super admins', 400);
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    const sanitizedPermissions =
      roleName === 'Sub Super Admin' ? sanitizePermissions(permissions) : {};

    const user = await User.create({
      name,
      email,
      password,
      roleName,
      designation: roleName === 'User' ? designation?.trim() : undefined,
      permissions: sanitizedPermissions,
    });

    user.password = undefined;

    return successResponse(res, user, 'User created successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to create user', 500);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Super Admin)
export const updateUser = async (req, res) => {
  try {
    const { name, email, roleName, isActive, designation, permissions } = req.body;

    const user = await User.findById(req.params.id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    if (name) user.name = name;

    if (email) {
      const existingUser = await User.findOne({ email, _id: { $ne: req.params.id } });
      if (existingUser) {
        return errorResponse(res, 'Email already in use', 400);
      }
      user.email = email;
    }

    // Handle isManager boolean (separate from roleName)
    // Capture the current state BEFORE modifying
    const wasManager = user.isManager || false;
    if (req.body.isManager !== undefined) {
      user.isManager = Boolean(req.body.isManager);
    }

    if (roleName) {
      if (!VALID_ROLES.includes(roleName)) {
        return errorResponse(res, 'Role name must be Super Admin, Sub Super Admin, or User', 400);
      }
      // Don't allow setting roleName to 'Manager' - use isManager boolean instead
      if (roleName === 'Manager') {
        return errorResponse(res, 'Use isManager boolean field instead of setting roleName to Manager', 400);
      }
      user.roleName = roleName;
      // If changing role away from Manager-like role, clear isManager
      if (roleName !== 'User' && roleName !== 'Sub Super Admin') {
        user.isManager = false;
      }
    }

    // Handle managedBy field for team management
    if (req.body.managedBy !== undefined) {
      if (req.body.managedBy === null || req.body.managedBy === '') {
        user.managedBy = null;
      } else {
        const manager = await User.findById(req.body.managedBy);
        if (!manager) {
          return errorResponse(res, 'Manager not found', 404);
        }
        if (!manager.isManager) {
          return errorResponse(res, 'Only users with Manager privileges can manage team members', 400);
        }
        user.managedBy = req.body.managedBy;
      }
    }

    if (typeof isActive === 'boolean') {
      user.isActive = isActive;
    }

    if (user.roleName === 'User') {
      // Only validate designation requirement if:
      // 1. Designation is being explicitly updated (provided in request)
      // 2. Role is being changed TO User (roleName was provided and is 'User')
      // Do NOT require designation if we're only updating other fields like managedBy, isManager, isActive, etc.
      const isRoleChangeToUser = roleName === 'User' && user.roleName !== 'User';
      const isDesignationUpdate = designation !== undefined;
      
      if (isDesignationUpdate) {
        if (designation && designation.trim()) {
          user.designation = designation.trim();
        } else if (!user.designation) {
          // If designation is explicitly set to empty and user doesn't have one, require it
          return errorResponse(res, 'Designation is required for users', 400);
        }
      } else if (isRoleChangeToUser && !user.designation) {
        // Only require designation if role is being changed TO User and they don't have one
        return errorResponse(res, 'Designation is required for users', 400);
      }
      // If user already has designation, keep it (don't require it for other updates)
      user.permissions = {};
    } else if (user.roleName === 'Sub Super Admin') {
      if (permissions && typeof permissions !== 'object') {
        return errorResponse(res, 'Permissions must be provided as an object for sub super admins', 400);
      }
      user.permissions = sanitizePermissions(permissions);
      user.designation = undefined;
    } else {
      // Super Admin or other roles
      user.permissions = {};
      user.designation = undefined;
    }

    await user.save();
    
    // If revoking manager, clear managedBy for all team members
    if (wasManager && !user.isManager) {
      await User.updateMany(
        { managedBy: user._id },
        { $set: { managedBy: null } }
      );
    }
    
    user.password = undefined;

    return successResponse(res, user, 'User updated successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to update user', 500);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (Super Admin)
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Don't allow deleting yourself
    if (user._id.toString() === req.user._id.toString()) {
      return errorResponse(res, 'You cannot delete your own account', 400);
    }

    await user.deleteOne();

    return successResponse(res, null, 'User deleted successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to delete user', 500);
  }
};

