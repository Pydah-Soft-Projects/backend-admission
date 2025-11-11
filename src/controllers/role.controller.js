import Role from '../models/Role.model.js';
import User from '../models/User.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Get all roles
// @route   GET /api/roles
// @access  Private (Super Admin)
export const getRoles = async (req, res) => {
  try {
    const roles = await Role.find().sort({ createdAt: -1 });

    return successResponse(res, roles, 'Roles retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get roles', 500);
  }
};

// @desc    Get single role
// @route   GET /api/roles/:id
// @access  Private (Super Admin)
export const getRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);

    if (!role) {
      return errorResponse(res, 'Role not found', 404);
    }

    return successResponse(res, role, 'Role retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get role', 500);
  }
};

// @desc    Create new role
// @route   POST /api/roles
// @access  Private (Super Admin)
export const createRole = async (req, res) => {
  try {
    const { name, permissions } = req.body;

    // Validate input
    if (!name) {
      return errorResponse(res, 'Please provide role name', 400);
    }

    // Check if role already exists
    const existingRole = await Role.findOne({ name });
    if (existingRole) {
      return errorResponse(res, 'Role with this name already exists', 400);
    }

    // Create role
    const role = await Role.create({
      name,
      permissions: permissions || [],
    });

    return successResponse(res, role, 'Role created successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to create role', 500);
  }
};

// @desc    Update role
// @route   PUT /api/roles/:id
// @access  Private (Super Admin)
export const updateRole = async (req, res) => {
  try {
    const { name, permissions } = req.body;

    const role = await Role.findById(req.params.id);

    if (!role) {
      return errorResponse(res, 'Role not found', 404);
    }

    // Don't allow changing Super Admin role name
    if (role.name === 'Super Admin' && name && name !== 'Super Admin') {
      return errorResponse(res, 'Cannot change Super Admin role name', 400);
    }

    // Update fields
    if (name) {
      // Check if name is already taken by another role
      const existingRole = await Role.findOne({ name, _id: { $ne: req.params.id } });
      if (existingRole) {
        return errorResponse(res, 'Role name already in use', 400);
      }
      role.name = name;
    }
    if (permissions !== undefined) role.permissions = permissions;

    await role.save();

    return successResponse(res, role, 'Role updated successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to update role', 500);
  }
};

// @desc    Delete role
// @route   DELETE /api/roles/:id
// @access  Private (Super Admin)
export const deleteRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);

    if (!role) {
      return errorResponse(res, 'Role not found', 404);
    }

    // Don't allow deleting Super Admin role
    if (role.name === 'Super Admin') {
      return errorResponse(res, 'Cannot delete Super Admin role', 400);
    }

    // Check if any users are using this role
    const usersWithRole = await User.countDocuments({ role: req.params.id });
    if (usersWithRole > 0) {
      return errorResponse(res, 'Cannot delete role. Users are assigned to this role', 400);
    }

    await role.deleteOne();

    return successResponse(res, null, 'Role deleted successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to delete role', 500);
  }
};

