import jwt from 'jsonwebtoken';
import { getPool } from '../config-sql/database.js';
import { errorResponse } from '../utils/response.util.js';
import { hasElevatedAdminPrivileges, isTrueSuperAdmin } from '../utils/role.util.js';

export const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return errorResponse(res, 'Not authorized to access this route', 401);
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get database pool
      let pool;
      try {
        pool = getPool();
      } catch (error) {
        console.error('Database connection error:', error);
        return errorResponse(res, 'Database connection failed', 500);
      }

      // Get user from SQL database
      const [users] = await pool.execute(
        'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE id = ?',
        [decoded.id]
      );

      if (users.length === 0) {
        return errorResponse(res, 'User not found', 404);
      }

      const userData = users[0];

      // Format user object to match expected structure (camelCase)
      req.user = {
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
        createdAt: userData.created_at,
        updatedAt: userData.updated_at,
      };

      if (!req.user.isActive) {
        return errorResponse(res, 'User account is inactive', 403);
      }

      next();
    } catch (error) {
      return errorResponse(res, 'Not authorized to access this route', 401);
    }
  } catch (error) {
    return errorResponse(res, 'Authentication error', 500);
  }
};

// Check if user is Super Admin
export const isSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }

  if (!hasElevatedAdminPrivileges(req.user.roleName)) {
    return errorResponse(res, 'Access denied. Super Admin only', 403);
  }

  next();
};

// Check if user has specific permission (for future use)
export const hasPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return errorResponse(res, 'Not authenticated', 401);
    }

    if (hasElevatedAdminPrivileges(req.user.roleName)) {
      return next();
    }

    // For now, only Super Admin has permissions
    return errorResponse(res, 'Access denied. Insufficient permissions', 403);
  };
};

