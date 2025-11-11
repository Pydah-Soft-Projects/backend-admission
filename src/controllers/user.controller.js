import User from '../models/User.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

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
    const { name, email, password, roleName } = req.body;

    // Validate input
    if (!name || !email || !password || !roleName) {
      return errorResponse(res, 'Please provide name, email, password, and roleName', 400);
    }

    // Validate roleName
    if (roleName !== 'Super Admin' && roleName !== 'User') {
      return errorResponse(res, 'Role name must be either "Super Admin" or "User"', 400);
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    // Create user
    const user = await User.create({
      name,
      email,
      password,
      roleName,
    });

    // Remove password from response
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
    const { name, email, roleName, isActive } = req.body;

    const user = await User.findById(req.params.id);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Update fields
    if (name) user.name = name;
    if (email) {
      // Check if email is already taken by another user
      const existingUser = await User.findOne({ email, _id: { $ne: req.params.id } });
      if (existingUser) {
        return errorResponse(res, 'Email already in use', 400);
      }
      user.email = email;
    }
    if (roleName) {
      // Validate roleName
      if (roleName !== 'Super Admin' && roleName !== 'User') {
        return errorResponse(res, 'Role name must be either "Super Admin" or "User"', 400);
      }
      user.roleName = roleName;
    }
    if (typeof isActive === 'boolean') user.isActive = isActive;

    await user.save();

    // Remove password from response
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

