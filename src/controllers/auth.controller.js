import User from '../models/User.model.js';
import { generateToken } from '../utils/generateToken.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('Login attempt for email:', email);

    // Validate input
    if (!email || !password) {
      console.log('Missing email or password');
      return errorResponse(res, 'Please provide email and password', 400);
    }

    // Check for user
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      console.log('User not found for email:', email);
      return errorResponse(res, 'Invalid credentials', 401);
    }

    console.log('User found:', user.email, 'Active:', user.isActive);

    // Check if user is active
    if (!user.isActive) {
      console.log('User account is inactive');
      return errorResponse(res, 'Your account has been deactivated', 403);
    }

    // Check if password matches
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      console.log('Password mismatch for user:', email);
      return errorResponse(res, 'Invalid credentials', 401);
    }

    console.log('Password matched, generating token');

    // Generate token
    const token = generateToken(user._id);

    // Remove password from response
    user.password = undefined;

    console.log('Login successful for user:', user.email);

    return successResponse(res, {
      token,
      user,
    }, 'Login successful', 200);
  } catch (error) {
    console.error('Login error:', error);
    return errorResponse(res, error.message || 'Login failed', 500);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

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
    // Since we're using JWT, logout is handled on the client side
    // But we can add token blacklisting here if needed
    return successResponse(res, null, 'Logged out successfully', 200);
  } catch (error) {
    return errorResponse(res, error.message || 'Logout failed', 500);
  }
};

