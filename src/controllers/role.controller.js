import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

// Helper function to format role data
const formatRole = (roleData) => {
  if (!roleData) return null;
  return {
    id: roleData.id,
    _id: roleData.id,
    name: roleData.name,
    permissions: typeof roleData.permissions === 'string' 
      ? JSON.parse(roleData.permissions) 
      : roleData.permissions || [],
    createdAt: roleData.created_at,
    updatedAt: roleData.updated_at,
  };
};

// @desc    Get all roles
// @route   GET /api/roles
// @access  Private (Super Admin)
export const getRoles = async (req, res) => {
  try {
    const pool = getPool();
    const [roles] = await pool.execute(
      'SELECT * FROM roles ORDER BY created_at DESC'
    );

    const formattedRoles = roles.map(formatRole);

    return successResponse(res, formattedRoles, 'Roles retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting roles:', error);
    return errorResponse(res, error.message || 'Failed to get roles', 500);
  }
};

// @desc    Get single role
// @route   GET /api/roles/:id
// @access  Private (Super Admin)
export const getRole = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    if (!id || typeof id !== 'string' || id.length !== 36) {
      return errorResponse(res, 'Invalid role ID', 400);
    }

    const [roles] = await pool.execute(
      'SELECT * FROM roles WHERE id = ?',
      [id]
    );

    if (roles.length === 0) {
      return errorResponse(res, 'Role not found', 404);
    }

    const role = formatRole(roles[0]);

    return successResponse(res, role, 'Role retrieved successfully', 200);
  } catch (error) {
    console.error('Error getting role:', error);
    return errorResponse(res, error.message || 'Failed to get role', 500);
  }
};

// @desc    Create new role
// @route   POST /api/roles
// @access  Private (Super Admin)
export const createRole = async (req, res) => {
  try {
    const { name, permissions } = req.body;
    const pool = getPool();

    // Validate input
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return errorResponse(res, 'Please provide role name', 400);
    }

    // Check if role already exists
    const [existing] = await pool.execute(
      'SELECT id FROM roles WHERE name = ?',
      [name.trim()]
    );

    if (existing.length > 0) {
      return errorResponse(res, 'Role with this name already exists', 400);
    }

    // Create role
    const roleId = uuidv4();
    await pool.execute(
      'INSERT INTO roles (id, name, permissions, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [
        roleId,
        name.trim(),
        JSON.stringify(Array.isArray(permissions) ? permissions : []),
      ]
    );

    // Fetch created role
    const [roles] = await pool.execute(
      'SELECT * FROM roles WHERE id = ?',
      [roleId]
    );

    const role = formatRole(roles[0]);

    return successResponse(res, role, 'Role created successfully', 201);
  } catch (error) {
    console.error('Error creating role:', error);
    return errorResponse(res, error.message || 'Failed to create role', 500);
  }
};

// @desc    Update role
// @route   PUT /api/roles/:id
// @access  Private (Super Admin)
export const updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, permissions } = req.body;
    const pool = getPool();

    if (!id || typeof id !== 'string' || id.length !== 36) {
      return errorResponse(res, 'Invalid role ID', 400);
    }

    // Check if role exists
    const [roles] = await pool.execute(
      'SELECT * FROM roles WHERE id = ?',
      [id]
    );

    if (roles.length === 0) {
      return errorResponse(res, 'Role not found', 404);
    }

    const role = roles[0];

    // Don't allow changing Super Admin role name
    if (role.name === 'Super Admin' && name && name !== 'Super Admin') {
      return errorResponse(res, 'Cannot change Super Admin role name', 400);
    }

    // Build update query
    const updateFields = [];
    const updateParams = [];

    if (name) {
      // Check if name is already taken by another role
      const [existing] = await pool.execute(
        'SELECT id FROM roles WHERE name = ? AND id != ?',
        [name.trim(), id]
      );

      if (existing.length > 0) {
        return errorResponse(res, 'Role name already in use', 400);
      }

      updateFields.push('name = ?');
      updateParams.push(name.trim());
    }

    if (permissions !== undefined) {
      updateFields.push('permissions = ?');
      updateParams.push(JSON.stringify(Array.isArray(permissions) ? permissions : []));
    }

    if (updateFields.length === 0) {
      // No fields to update, return existing role
      return successResponse(res, formatRole(role), 'Role updated successfully', 200);
    }

    // Update role
    updateFields.push('updated_at = NOW()');
    updateParams.push(id);

    await pool.execute(
      `UPDATE roles SET ${updateFields.join(', ')} WHERE id = ?`,
      updateParams
    );

    // Fetch updated role
    const [updated] = await pool.execute(
      'SELECT * FROM roles WHERE id = ?',
      [id]
    );

    return successResponse(res, formatRole(updated[0]), 'Role updated successfully', 200);
  } catch (error) {
    console.error('Error updating role:', error);
    return errorResponse(res, error.message || 'Failed to update role', 500);
  }
};

// @desc    Delete role
// @route   DELETE /api/roles/:id
// @access  Private (Super Admin)
export const deleteRole = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    if (!id || typeof id !== 'string' || id.length !== 36) {
      return errorResponse(res, 'Invalid role ID', 400);
    }

    // Check if role exists
    const [roles] = await pool.execute(
      'SELECT * FROM roles WHERE id = ?',
      [id]
    );

    if (roles.length === 0) {
      return errorResponse(res, 'Role not found', 404);
    }

    const role = roles[0];

    // Don't allow deleting Super Admin role
    if (role.name === 'Super Admin') {
      return errorResponse(res, 'Cannot delete Super Admin role', 400);
    }

    // Check if any users are using this role
    // Note: In SQL schema, users have role_name as string, not a foreign key to roles table
    // So we check if any users have this role name
    const [usersWithRole] = await pool.execute(
      'SELECT COUNT(*) as total FROM users WHERE role_name = ?',
      [role.name]
    );

    if (usersWithRole[0].total > 0) {
      return errorResponse(res, 'Cannot delete role. Users are assigned to this role', 400);
    }

    // Delete role
    await pool.execute(
      'DELETE FROM roles WHERE id = ?',
      [id]
    );

    return successResponse(res, null, 'Role deleted successfully', 200);
  } catch (error) {
    console.error('Error deleting role:', error);
    return errorResponse(res, error.message || 'Failed to delete role', 500);
  }
};

