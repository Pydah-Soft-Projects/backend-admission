import { getPool } from '../config-sql/database.js';
import { generateToken } from '../utils/generateToken.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import bcrypt from 'bcryptjs';
import bulkSmsService, { PASSWORD_RESET_LOGIN_HOST } from '../services/bulkSms.service.js';
import { sendEmail } from '../services/unifiedEmail.service.js';
import axios from 'axios';
import { connectHRMS } from '../config-mongo/hrms.js';
import { matchHrmsEmployeePassword } from '../utils/employeePasswordAuth.util.js';

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildPasswordResetEmailHtml = ({ name, username, password, loginUrl }) => {
  const safeName = escapeHtml(name || 'User');
  const safeUsername = escapeHtml(username || '');
  const safePassword = escapeHtml(password || '');
  const safeLoginUrl = escapeHtml(loginUrl);
  const loginHref = loginUrl.startsWith('http') ? loginUrl : `https://${loginUrl}`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Password Reset - CRM Admissions</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f3f4f6;padding:24px 12px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
              <tr>
                <td style="background-color:#1e3a5f;padding:28px 24px;text-align:center;">
                  <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#93c5fd;margin-bottom:8px;">Pydah Group</div>
                  <h1 style="margin:0;font-size:22px;line-height:1.3;color:#ffffff;font-weight:700;">Password Reset Successful</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 24px;">
                  <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hello <strong>${safeName}</strong>,</p>
                  <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">
                    Your password has been reset. Use the credentials below to sign in to the Admissions CRM.
                  </p>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
                    <tr>
                      <td style="padding:18px 20px;">
                        <p style="margin:0 0 12px;font-size:12px;letter-spacing:0.6px;text-transform:uppercase;color:#64748b;font-weight:700;">Your login credentials</p>
                        <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#334155;">
                          <span style="display:inline-block;min-width:90px;color:#64748b;">Username</span>
                          <strong style="color:#0f172a;">${safeUsername}</strong>
                        </p>
                        <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#334155;">
                          <span style="display:inline-block;min-width:90px;color:#64748b;">Password</span>
                          <strong style="font-size:16px;letter-spacing:1px;color:#0f172a;background:#e0f2fe;padding:4px 10px;border-radius:6px;">${safePassword}</strong>
                        </p>
                        <p style="margin:0;font-size:14px;line-height:1.5;color:#334155;">
                          <span style="display:inline-block;min-width:90px;color:#64748b;">Login</span>
                          <a href="${loginHref}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${safeLoginUrl}</a>
                        </p>
                      </td>
                    </tr>
                  </table>
                  <div style="text-align:center;margin:24px 0 8px;">
                    <a href="${loginHref}" style="display:inline-block;padding:12px 28px;background-color:#1e3a5f;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
                      Login to Admissions CRM
                    </a>
                  </div>
                  <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
                    For security, please change this password after logging in. If you did not request this reset, contact your administrator immediately.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px 24px;border-top:1px solid #e5e7eb;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">This is an automated message from CRM Admissions. Please do not reply.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
};

const sendPasswordResetEmail = async ({ email, name, username, password }) => {
  if (!email || !String(email).trim()) {
    return { success: false, skipped: true, reason: 'no_email' };
  }

  const loginUrl = PASSWORD_RESET_LOGIN_HOST;
  const htmlContent = buildPasswordResetEmailHtml({
    name,
    username: username || email,
    password,
    loginUrl,
  });

  return sendEmail({
    to: String(email).trim(),
    subject: 'Your new Admissions CRM password',
    htmlContent,
    textContent: [
      `Hello ${name || 'User'},`,
      '',
      'Your password has been reset. Use these credentials to sign in:',
      `Username: ${username || email}`,
      `Password: ${password}`,
      `Login: https://${loginUrl}`,
      '',
      'Please change this password after logging in.',
      '',
      '— CRM Admissions Team',
    ].join('\n'),
  });
};

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
    const normalizedIdentity = email.trim();
    const normalizedEmail = normalizedIdentity.toLowerCase();
    
    // Check if it's a mobile number
    const isMobile = /^\d{10,15}$/.test(normalizedIdentity);
    
    let query, queryParams;
    if (isMobile) {
      console.log('Detected mobile number login');
      query = 'SELECT * FROM users WHERE mobile_number = ?';
      queryParams = [normalizedIdentity];
    } else {
      // Search by email OR emp_no
      query = 'SELECT * FROM users WHERE email = ? OR emp_no = ?';
      queryParams = [normalizedEmail, normalizedIdentity];
    }

    const [users] = await pool.execute(query, queryParams);

    if (!users || users.length === 0) {
      console.log('User not found for identity:', normalizedIdentity);
      return errorResponse(res, 'Invalid credentials', 401);
    }

    const userData = users[0];

    // Validate userData structure (id and role_name are mandatory, email/password can be null)
    if (!userData || !userData.id || !userData.role_name) {
      console.error('Invalid user data structure (missing mandatory fields):', userData);
      return errorResponse(res, 'Database error: Invalid user data', 500);
    }

    console.log('User found:', userData.email, 'Active:', userData.is_active);

    // Check if user is active (MySQL returns 0/1 for BOOLEAN, handle both)
    if (userData.is_active === 0 || userData.is_active === false || userData.is_active === null) {
      console.log('User account is inactive');
      return errorResponse(res, 'Your account has been deactivated', 403);
    }

    // Password: CRM MySQL users table and/or HRMS Mongo (users collection, then employees)
    let isMatch = false;
    let sqlMatch = false;
    let hrmsMatch = false;

    const hasEmployeeLink =
      (userData.emp_no != null && String(userData.emp_no).trim() !== '') ||
      (userData.hrms_id != null && String(userData.hrms_id).trim() !== '');

    if (userData.password) {
      sqlMatch = await bcrypt.compare(password, userData.password);
    }

    if (hasEmployeeLink) {
      console.log('Authenticating HRMS-linked user:', {
        emp_no: userData.emp_no,
        hrms_id: userData.hrms_id,
      });

      try {
        const hrmsConn = await connectHRMS();
        const hrmsResult = await matchHrmsEmployeePassword(hrmsConn, {
          plainPassword: password,
          emp_no: userData.emp_no,
          hrms_id: userData.hrms_id,
        });
        hrmsMatch = hrmsResult.matched;
        if (hrmsMatch) {
          console.log(`Authenticated via HRMS mongo (${hrmsResult.collection})`);
        } else if (hrmsResult.reason === 'not_found') {
          console.log('User/employee not found in HRMS mongo:', userData.emp_no || userData.hrms_id);
        } else if (hrmsResult.reason === 'no_password') {
          console.log(
            `No password on HRMS ${hrmsResult.collection} record:`,
            userData.emp_no || userData.hrms_id
          );
        }
      } catch (hrmsError) {
        console.error('HRMS Login Error:', hrmsError);
      }

      isMatch = sqlMatch || hrmsMatch;
      if (!isMatch && !userData.password && !hrmsMatch) {
        console.log('No valid password in CRM users or HRMS mongo (users/employees)');
      }
    } else {
      if (!userData.password) {
        console.error('User has no password set:', userData.email);
        return errorResponse(res, 'Database error: User password not found', 500);
      }
      isMatch = sqlMatch;
    }

    if (!isMatch) {
      console.log('Password mismatch for user:', email);
      return res.status(401).json({
        message: 'Invalid Credentials',
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
      'SELECT id, hrms_id, emp_no, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, auto_calling_enabled, created_at, updated_at FROM users WHERE id = ?',
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
      emp_no: userData.emp_no,
      hrms_id: userData.hrms_id,
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
      'SELECT id, hrms_id, emp_no, name, email, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ? AND is_active = 1',
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
    const identifier = String(
      req.body?.identifier || req.body?.mobileNumber || req.body?.email || ''
    ).trim();

    if (!identifier) {
      return errorResponse(res, 'Mobile number or email is required', 400);
    }

    const pool = getPool();
    const isEmail = identifier.includes('@');
    const mobileDigits = identifier.replace(/\D/g, '').slice(-10);

    let users;
    if (isEmail) {
      [users] = await pool.execute(
        'SELECT id, name, email, mobile_number FROM users WHERE LOWER(email) = LOWER(?)',
        [identifier]
      );
    } else {
      if (mobileDigits.length !== 10) {
        return errorResponse(res, 'Enter a valid 10-digit mobile number or email address', 400);
      }
      [users] = await pool.execute(
        'SELECT id, name, email, mobile_number FROM users WHERE mobile_number = ?',
        [mobileDigits]
      );
    }

    if (users.length === 0) {
      return errorResponse(
        res,
        isEmail
          ? 'No user found with this email address'
          : 'No user found with this mobile number',
        404
      );
    }

    const user = users[0];
    return successResponse(res, {
      exists: true,
      name: user.name,
      email: user.email || null,
      mobileNumber: user.mobile_number || null,
      identifierType: isEmail ? 'email' : 'mobile',
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
    const identifier = String(
      req.body?.identifier || req.body?.mobileNumber || req.body?.email || ''
    ).trim();

    if (!identifier) {
      return errorResponse(res, 'Mobile number or email is required', 400);
    }

    const pool = getPool();
    const isEmail = identifier.includes('@');
    const mobileDigits = identifier.replace(/\D/g, '').slice(-10);

    let users;
    if (isEmail) {
      [users] = await pool.execute(
        'SELECT id, name, email, mobile_number FROM users WHERE LOWER(email) = LOWER(?)',
        [identifier]
      );
    } else {
      if (mobileDigits.length !== 10) {
        return errorResponse(res, 'Enter a valid 10-digit mobile number or email address', 400);
      }
      [users] = await pool.execute(
        'SELECT id, name, email, mobile_number FROM users WHERE mobile_number = ?',
        [mobileDigits]
      );
    }

    if (users.length === 0) {
      return errorResponse(
        res,
        isEmail
          ? 'No user found with this email address'
          : 'No user found with this mobile number',
        404
      );
    }

    const user = users[0];

    // Generate Random 3-digit Password with PYD prefix
    const randomNum = Math.floor(100 + Math.random() * 900); // 100 to 999
    const newPassword = `PYD${randomNum}`;

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update User Password by id (works for email or mobile lookup)
    await pool.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, user.id]
    );

    // Send confirmation SMS + email with new password (Login: admissions.pydah.edu.in)
    const delivery = { sms: false, email: false };
    const smsMobile = String(user.mobile_number || '').replace(/\D/g, '').slice(-10);

    try {
      if (smsMobile.length === 10) {
        const smsResult = await bulkSmsService.sendPasswordResetSuccess(
          smsMobile,
          user.name,
          user.email,
          newPassword
        );
        delivery.sms = smsResult?.success !== false;
      } else {
        console.warn('Password reset SMS skipped — user has no valid mobile number.');
      }
    } catch (smsError) {
      console.error('Failed to send password reset SMS:', smsError);
    }

    try {
      const emailResult = await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        username: user.email,
        password: newPassword,
      });
      delivery.email = Boolean(emailResult?.success);
      if (emailResult?.skipped) {
        console.warn('Password reset email skipped — user has no email on file.');
      } else if (!emailResult?.success) {
        console.warn('Password reset email failed:', emailResult?.channels || emailResult);
      }
    } catch (emailError) {
      console.error('Failed to send password reset email:', emailError);
    }

    const channels = [
      delivery.sms ? 'SMS' : null,
      delivery.email ? 'email' : null,
    ].filter(Boolean);

    const channelText = channels.length > 0
      ? `Check your ${channels.join(' and ')}.`
      : 'Password was reset, but delivery failed. Please contact support.';

    return successResponse(
      res,
      {
        message: `Password reset successfully. ${channelText}`,
        delivery,
        email: user.email || null,
        mobileNumber: user.mobile_number || null,
      },
      channels.length > 0
        ? `Password reset and sent via ${channels.join(' and ')}`
        : 'Password reset successfully'
    );

  } catch (error) {
    console.error('Reset Password Direct error:', error);
    return errorResponse(res, 'Failed to reset password', 500);
  }
};

