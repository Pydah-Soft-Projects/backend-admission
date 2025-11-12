import jwt from 'jsonwebtoken';
import User from '../models/User.model.js';
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

      // Get user from token
      req.user = await User.findById(decoded.id);

      if (!req.user) {
        return errorResponse(res, 'User not found', 404);
      }

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

