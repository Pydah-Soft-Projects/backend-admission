import { getPool } from '../config-sql/database.js';
import { generateToken } from '../utils/generateToken.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import bcrypt from 'bcryptjs';
import bulkSmsService from '../services/bulkSms.service.js';
import axios from 'axios';



// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('Login attempt for identifier:', email);

    // Validate input
    if (!email || !password) {
      console.log('Missing email or password');
      return errorResponse(res, 'Please provide email and password', 400);
    }

    // Get database pool
    let pool;
    try {
      pool = getPool();
    } catch (error) {
      console.error('Database connection error:', error);
      return errorResponse(res, 'Database connection failed', 500);
    }

    // Check for user in SQL database
    const normalizedIdentity = email.toLowerCase().trim();
    let query = 'SELECT id, name, email, mobile_number, password, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, auto_calling_enabled, created_at, updated_at FROM users WHERE email = ?';
    let queryParams = [normalizedIdentity];

    // Simple check: if it looks like a mobile number (only digits, length 10-15), try mobile login
    const isMobile = /^\d{10,15}$/.test(normalizedIdentity);
    if (isMobile) {
      console.log('Detected mobile number login');
      query = 'SELECT id, name, email, mobile_number, password, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, auto_calling_enabled, created_at, updated_at FROM users WHERE mobile_number = ?';
      // For mobile, we use the input as is (trim only)
      queryParams = [email.trim()];
    }

    const [users] = await pool.execute(query, queryParams);

    if (!users || users.length === 0) {
      console.log('User not found for identity:', normalizedIdentity);
      return errorResponse(res, 'Invalid credentials', 401);
    }

    const userData = users[0];

    // Validate userData structure
    if (!userData || !userData.id || !userData.email || !userData.password) {
      console.error('Invalid user data structure:', userData);
      return errorResponse(res, 'Database error: Invalid user data', 500);
    }

    console.log('User found:', userData.email, 'Active:', userData.is_active);

    // Check if user is active (MySQL returns 0/1 for BOOLEAN, handle both)
    if (userData.is_active === 0 || userData.is_active === false || userData.is_active === null) {
      console.log('User account is inactive');
      return errorResponse(res, 'Your account has been deactivated', 403);
    }

    // Check if password matches
    if (!userData.password) {
      console.error('User has no password set:', userData.email);
      return errorResponse(res, 'Database error: User password not found', 500);
    }

    const isMatch = await bcrypt.compare(password, userData.password);

    if (!isMatch) {
      console.log('Password mismatch for user:', email);
      return res.status(401).json({
        message: 'Normalised like mail or password is wrong like that', // As requested by user
        error: 'Invalid credentials'
      });
    }

    console.log('Password matched, generating token');

    // Format user object to match expected structure (camelCase)
    let permissions = {};
    try {
      if (userData.permissions) {
        if (typeof userData.permissions === 'string') {
          permissions = JSON.parse(userData.permissions);
        } else if (typeof userData.permissions === 'object') {
          permissions = userData.permissions;
        }
      }
    } catch (parseError) {
      console.error('Error parsing permissions JSON:', parseError);
      permissions = {};
    }

    const timeTrackingEnabled = userData.time_tracking_enabled === undefined
      ? true
      : (userData.time_tracking_enabled === 1 || userData.time_tracking_enabled === true);

    const user = {
      id: userData.id,
      _id: userData.id, // Keep _id for backward compatibility
      name: userData.name,
      email: userData.email,
      mobileNumber: userData.mobile_number,
      roleName: userData.role_name,
      managedBy: userData.managed_by,
      isManager: userData.is_manager === 1 || userData.is_manager === true,
      designation: userData.designation,
      permissions,
      isActive: userData.is_active === 1 || userData.is_active === true,
      timeTrackingEnabled,
      autoCallingEnabled: userData.auto_calling_enabled === 1 || userData.auto_calling_enabled === true,
      createdAt: userData.created_at,
      updatedAt: userData.updated_at,
    };

    // Generate token
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not set in environment variables');
      return errorResponse(res, 'Server configuration error', 500);
    }

    const token = generateToken(user.id);

    console.log('Login successful for user:', user.email);

    return successResponse(res, {
      token,
      user,
    }, 'Login successful', 200);
  } catch (error) {
    console.error('Login error:', error);
    console.error('Error stack:', error.stack);
    return errorResponse(res, error.message || 'Login failed', 500);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
export const getMe = async (req, res) => {
  try {
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
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, auto_calling_enabled, created_at, updated_at FROM users WHERE id = ?',
      [req.user.id || req.user._id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const userData = users[0];

    // Format user object to match expected structure (camelCase)
    let permissions = {};
    try {
      if (userData.permissions) {
        if (typeof userData.permissions === 'string') {
          permissions = JSON.parse(userData.permissions);
        } else if (typeof userData.permissions === 'object') {
          permissions = userData.permissions;
        }
      }
    } catch (parseError) {
      console.error('Error parsing permissions JSON:', parseError);
      permissions = {};
    }

    const timeTrackingEnabled = userData.time_tracking_enabled === undefined
      ? true
      : (userData.time_tracking_enabled === 1 || userData.time_tracking_enabled === true);

    const user = {
      id: userData.id,
      _id: userData.id, // Keep _id for backward compatibility
      name: userData.name,
      email: userData.email,
      roleName: userData.role_name,
      managedBy: userData.managed_by,
      isManager: userData.is_manager === 1 || userData.is_manager === true,
      designation: userData.designation,
      permissions,
      isActive: userData.is_active === 1 || userData.is_active === true,
      timeTrackingEnabled,
      autoCallingEnabled: userData.auto_calling_enabled === 1 || userData.auto_calling_enabled === true,
      createdAt: userData.created_at,
      updatedAt: userData.updated_at,
    };

    return successResponse(res, user, 'User retrieved successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to get user', 500);
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
export const logout = async (req, res) => {
  try {
    return successResponse(res, null, 'Logged out successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Logout failed', 500);
  }
};

// @desc    Create SSO session from CRM token
// @route   POST /api/auth/sso-session
// @access  Public (but requires valid SSO token verification)
export const createSSOSession = async (req, res) => {
  try {
    const { userId, role, portalId, ssoToken } = req.body;

    console.log('SSO session creation request for userId:', userId);

    // Validate input
    if (!userId || !ssoToken) {
      return errorResponse(res, 'User ID and SSO token are required', 400);
    }

    // Optional: Verify the SSO token again with CRM backend for extra security
    const CRM_BACKEND_URL = process.env.CRM_BACKEND_URL || 'http://localhost:3000';

    try {
      const verifyResponse = await axios.post(`${CRM_BACKEND_URL}/auth/verify-token`, {
        encryptedToken: ssoToken,
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const verifyResult = verifyResponse.data;

      if (!verifyResult.success || !verifyResult.valid) {
        console.log('SSO token verification failed:', verifyResult.message);
        return errorResponse(res, 'Invalid SSO token', 401);
      }

      // Verify the userId matches
      if (verifyResult.data.userId !== userId) {
        console.log('User ID mismatch in SSO token');
        return errorResponse(res, 'Token user ID mismatch', 401);
      }
    } catch (verifyError) {
      console.error('Error verifying SSO token with CRM backend:', verifyError.message);
      // Continue anyway if CRM backend is not available (for development)
      // In production, you might want to fail here
      if (process.env.NODE_ENV === 'production') {
        return errorResponse(res, 'SSO token verification failed', 500);
      }
    }

    // Get database pool
    let pool;
    try {
      pool = getPool();
    } catch (error) {
      console.error('Database connection error:', error);
      return errorResponse(res, 'Database connection failed', 500);
    }

    // Find user in admissions database
    const [users] = await pool.execute(
      'SELECT id, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ? AND is_active = 1',
      [userId]
    );

    if (users.length === 0) {
      console.log('User not found in admissions database:', userId);
      return errorResponse(res, 'User not found in admissions database', 404);
    }

    const userData = users[0];

    // Format user object to match expected structure (camelCase)
    let permissions = {};
    try {
      if (userData.permissions) {
        if (typeof userData.permissions === 'string') {
          permissions = JSON.parse(userData.permissions);
        } else if (typeof userData.permissions === 'object') {
          permissions = userData.permissions;
        }
      }
    } catch (parseError) {
      console.error('Error parsing permissions JSON:', parseError);
      permissions = {};
    }

    const timeTrackingEnabled = userData.time_tracking_enabled === undefined
      ? true
      : (userData.time_tracking_enabled === 1 || userData.time_tracking_enabled === true);

    const user = {
      id: userData.id,
      _id: userData.id, // Keep _id for backward compatibility
      name: userData.name,
      email: userData.email,
      roleName: userData.role_name,
      managedBy: userData.managed_by,
      isManager: userData.is_manager === 1 || userData.is_manager === true,
      designation: userData.designation,
      permissions,
      isActive: userData.is_active === 1 || userData.is_active === true,
      timeTrackingEnabled,
      createdAt: userData.created_at,
      updatedAt: userData.updated_at,
    };

    // Generate local session token
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not set in environment variables');
      return errorResponse(res, 'Server configuration error', 500);
    }

    const token = generateToken(user.id);

    console.log('SSO session created successfully for user:', user.email);

    return successResponse(res, {
      token,
      user,
    }, 'SSO session created successfully', 200);
  } catch (error) {
    console.error('SSO session creation error:', error);
    console.error('Error stack:', error.stack);
    return errorResponse(res, error.message || 'Failed to create SSO session', 500);
  }
};

// @desc    Check User Exists (For Forgot Password)
// @route   POST /api/auth/forgot-password/check-user
// @access  Public
export const checkUser = async (req, res) => {
  try {
    const { mobileNumber } = req.body;

    if (!mobileNumber) {
      return errorResponse(res, 'Mobile number is required', 400);
    }

    const pool = getPool();
    const [users] = await pool.execute(
      'SELECT id, name FROM users WHERE mobile_number = ?',
      [mobileNumber]
    );

    if (users.length === 0) {
      return errorResponse(res, 'No user found with this mobile number', 404);
    }

    return successResponse(res, {
      exists: true,
      name: users[0].name
    }, 'User found');

  } catch (error) {
    console.error('Check User error:', error);
    return errorResponse(res, 'Failed to check user', 500);
  }
};

// @desc    Reset Password Directly (No OTP)
// @route   POST /api/auth/forgot-password/reset-direct
// @access  Public
export const resetPasswordDirectly = async (req, res) => {
  try {
    const { mobileNumber } = req.body;

    if (!mobileNumber) {
      return errorResponse(res, 'Mobile number is required', 400);
    }

    const pool = getPool();

    // Check if user exists
    const [users] = await pool.execute(
      'SELECT id, name, email, mobile_number FROM users WHERE mobile_number = ?',
      [mobileNumber]
    );

    if (users.length === 0) {
      return errorResponse(res, 'No user found with this mobile number', 404);
    }

    const user = users[0];

    // Generate Random 3-digit Password with PYD prefix
    const randomNum = Math.floor(100 + Math.random() * 900); // 100 to 999
    const newPassword = `PYD${randomNum}`;

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update User Password
    await pool.execute(
      'UPDATE users SET password = ? WHERE mobile_number = ?',
      [hashedPassword, mobileNumber]
    );

    // Send confirmation SMS with new password
    const loginUrl = process.env.FRONTEND_URL || 'http://admissions.pydah.edu.in';

    try {
      await bulkSmsService.sendPasswordResetSuccess(
        mobileNumber,
        user.name,
        user.email,
        newPassword,
        loginUrl
      );
    } catch (smsError) {
      console.error("Failed to send password reset SMS:", smsError);
      // We still return success because the password WAS reset, but warn log is enough.
    }

    return successResponse(res, { message: 'Password reset successfully. Check your SMS.' }, 'Password reset and SMS sent');

  } catch (error) {
    console.error('Reset Password Direct error:', error);
    return errorResponse(res, 'Failed to reset password', 500);
  }
};

