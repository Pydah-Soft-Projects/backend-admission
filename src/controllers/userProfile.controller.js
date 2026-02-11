import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import bcrypt from 'bcryptjs';

// Helper function to format user data
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
        mobileNumber: userData.mobile_number,
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

// @desc    Update current user's profile (name, password)
// @route   PUT /api/users/me/profile
// @access  Private (All authenticated users)
export const updateMyProfile = async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { name, password, mobileNumber } = req.body;
        const pool = getPool();

        // Build update fields
        const updateFields = [];
        const updateValues = [];

        if (name) {
            updateFields.push('name = ?');
            updateValues.push(name.trim());
        }

        if (mobileNumber !== undefined) {
            if (mobileNumber) {
                // Check if mobile number is already in use by another user
                const [existingMobile] = await pool.execute(
                    'SELECT id FROM users WHERE mobile_number = ? AND id != ?',
                    [mobileNumber.trim(), userId]
                );
                if (existingMobile.length > 0) {
                    return errorResponse(res, 'Mobile number already in use', 400);
                }
                updateFields.push('mobile_number = ?');
                updateValues.push(mobileNumber.trim());
            } else {
                // Allow clearing mobile number
                updateFields.push('mobile_number = NULL');
            }
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

        // If no fields to update
        if (updateFields.length === 0) {
            return errorResponse(res, 'No fields to update', 400);
        }

        // Add updated_at
        updateFields.push('updated_at = NOW()');

        // Execute update
        updateValues.push(userId);
        await pool.execute(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
            updateValues
        );

        // Fetch updated user
        const [updatedUsers] = await pool.execute(
            'SELECT id, name, email, mobile_number, role_name, managed_by, is_manager, designation, permissions, is_active, time_tracking_enabled, created_at, updated_at FROM users WHERE id = ?',
            [userId]
        );

        const user = formatUser(updatedUsers[0]);

        return successResponse(res, user, 'Profile updated successfully', 200);
    } catch (error) {
        console.error('Update my profile error:', error);
        return errorResponse(res, error.message || 'Failed to update profile', 500);
    }
};
