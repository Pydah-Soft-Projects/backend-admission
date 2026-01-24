import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

// Helper function to format course data from SQL to camelCase
const formatCourse = (courseData) => {
  if (!courseData) return null;
  return {
    id: courseData.id,
    _id: courseData.id, // Keep _id for backward compatibility
    name: courseData.name,
    code: courseData.code,
    description: courseData.description,
    isActive: courseData.is_active === 1 || courseData.is_active === true,
    createdBy: courseData.created_by,
    updatedBy: courseData.updated_by,
    createdAt: courseData.created_at,
    updatedAt: courseData.updated_at,
  };
};

// Helper function to format branch data from SQL to camelCase
const formatBranch = (branchData) => {
  if (!branchData) return null;
  return {
    id: branchData.id,
    _id: branchData.id, // Keep _id for backward compatibility
    courseId: branchData.course_id,
    name: branchData.name,
    code: branchData.code,
    description: branchData.description,
    isActive: branchData.is_active === 1 || branchData.is_active === true,
    createdBy: branchData.created_by,
    updatedBy: branchData.updated_by,
    createdAt: branchData.created_at,
    updatedAt: branchData.updated_at,
  };
};

export const createCourse = async (req, res) => {
  try {
    const { name, code, description } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Course name is required', 422);
    }

    const pool = getPool();
    const normalizedName = name.trim();
    const userId = req.user?.id || req.user?._id;

    // Check if course with same name exists
    const [existingByName] = await pool.execute(
      'SELECT id FROM courses WHERE name = ?',
      [normalizedName]
    );
    if (existingByName.length > 0) {
      return errorResponse(res, 'A course with the same name already exists', 409);
    }

    // Check if course with same code exists
    if (code && code.trim()) {
      const [existingByCode] = await pool.execute(
        'SELECT id FROM courses WHERE code = ?',
        [code.trim()]
      );
      if (existingByCode.length > 0) {
        return errorResponse(res, 'A course with the same code already exists', 409);
      }
    }

    // Generate UUID
    const courseId = uuidv4();

    // Insert course
    await pool.execute(
      `INSERT INTO courses (id, name, code, description, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        courseId,
        normalizedName,
        code?.trim() || null,
        description || null,
        userId || null,
        userId || null
      ]
    );

    // Fetch created course
    const [courses] = await pool.execute(
      'SELECT id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM courses WHERE id = ?',
      [courseId]
    );

    const course = formatCourse(courses[0]);

    return successResponse(res, course, 'Course created successfully', 201);
  } catch (error) {
    console.error('Create course error:', error);
    return errorResponse(res, error.message || 'Failed to create course', 500);
  }
};

export const listCourses = async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const includeBranches = req.query.includeBranches === 'true';
    const pool = getPool();

    // Build query
    let query = 'SELECT id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM courses';
    const params = [];
    
    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(true);
    }
    
    query += ' ORDER BY name ASC';

    const [courses] = await pool.execute(query, params);
    const formattedCourses = courses.map(formatCourse);

    if (!includeBranches || formattedCourses.length === 0) {
      return successResponse(res, formattedCourses);
    }

    // Get branches for all courses
    const courseIds = formattedCourses.map(c => c.id);
    let branchQuery = 'SELECT id, course_id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM branches WHERE course_id IN (';
    branchQuery += courseIds.map(() => '?').join(',');
    branchQuery += ')';
    
    if (!showInactive) {
      branchQuery += ' AND is_active = ?';
      courseIds.push(true);
    }
    
    branchQuery += ' ORDER BY name ASC';

    const [branches] = await pool.execute(branchQuery, courseIds);
    const formattedBranches = branches.map(formatBranch);

    // Group branches by course_id
    const branchMap = formattedBranches.reduce((acc, branch) => {
      const key = branch.courseId;
      if (!acc[key]) acc[key] = [];
      acc[key].push(branch);
      return acc;
    }, {});

    // Add branches to courses
    const payload = formattedCourses.map((course) => ({
      ...course,
      branches: branchMap[course.id] || [],
    }));

    return successResponse(res, payload);
  } catch (error) {
    console.error('List courses error:', error);
    return errorResponse(res, error.message || 'Failed to fetch courses', 500);
  }
};

export const getCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const includeBranches = req.query.includeBranches === 'true';
    const showInactive = req.query.showInactive === 'true';
    const pool = getPool();

    // Get course
    const [courses] = await pool.execute(
      'SELECT id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM courses WHERE id = ?',
      [courseId]
    );

    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    const course = formatCourse(courses[0]);

    if (!includeBranches) {
      return successResponse(res, course);
    }

    // Get branches
    let branchQuery = 'SELECT id, course_id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM branches WHERE course_id = ?';
    const branchParams = [courseId];
    
    if (!showInactive) {
      branchQuery += ' AND is_active = ?';
      branchParams.push(true);
    }
    
    branchQuery += ' ORDER BY name ASC';

    const [branches] = await pool.execute(branchQuery, branchParams);
    const formattedBranches = branches.map(formatBranch);

    return successResponse(res, { ...course, branches: formattedBranches });
  } catch (error) {
    console.error('Get course error:', error);
    return errorResponse(res, error.message || 'Failed to retrieve course', 500);
  }
};

export const updateCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { name, code, description, isActive } = req.body;
    const pool = getPool();
    const userId = req.user?.id || req.user?._id;

    // Get current course
    const [courses] = await pool.execute(
      'SELECT id, name, code FROM courses WHERE id = ?',
      [courseId]
    );

    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    const currentCourse = courses[0];
    const updateFields = [];
    const updateValues = [];

    if (name && name.trim() && name.trim() !== currentCourse.name) {
      // Check if name already exists
      const [existing] = await pool.execute(
        'SELECT id FROM courses WHERE name = ? AND id != ?',
        [name.trim(), courseId]
      );
      if (existing.length > 0) {
        return errorResponse(res, 'Another course with the same name exists', 409);
      }
      updateFields.push('name = ?');
      updateValues.push(name.trim());
    }

    if (code !== undefined) {
      if (code && code.trim() && code.trim() !== currentCourse.code) {
        // Check if code already exists
        const [existingCode] = await pool.execute(
          'SELECT id FROM courses WHERE code = ? AND id != ?',
          [code.trim(), courseId]
        );
        if (existingCode.length > 0) {
          return errorResponse(res, 'Another course with the same code exists', 409);
        }
        updateFields.push('code = ?');
        updateValues.push(code.trim());
      } else if (code === '') {
        updateFields.push('code = ?');
        updateValues.push(null);
      }
    }

    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description || null);
    }

    if (typeof isActive === 'boolean') {
      updateFields.push('is_active = ?');
      updateValues.push(isActive);
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_by = ?');
      updateValues.push(userId || null);
      updateFields.push('updated_at = NOW()');
      updateValues.push(courseId);

      await pool.execute(
        `UPDATE courses SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // Fetch updated course
    const [updatedCourses] = await pool.execute(
      'SELECT id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM courses WHERE id = ?',
      [courseId]
    );

    const course = formatCourse(updatedCourses[0]);

    return successResponse(res, course, 'Course updated successfully');
  } catch (error) {
    console.error('Update course error:', error);
    return errorResponse(res, error.message || 'Failed to update course', 500);
  }
};

export const createBranch = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { name, code, description } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Branch name is required', 422);
    }

    const pool = getPool();
    const userId = req.user?.id || req.user?._id;

    // Check if course exists
    const [courses] = await pool.execute(
      'SELECT id FROM courses WHERE id = ?',
      [courseId]
    );
    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    // Check if branch with same name exists for this course
    const [existingByName] = await pool.execute(
      'SELECT id FROM branches WHERE course_id = ? AND name = ?',
      [courseId, name.trim()]
    );
    if (existingByName.length > 0) {
      return errorResponse(res, 'Branch already exists for this course', 409);
    }

    // Check if branch with same code exists for this course
    if (code && code.trim()) {
      const [existingByCode] = await pool.execute(
        'SELECT id FROM branches WHERE course_id = ? AND code = ?',
        [courseId, code.trim()]
      );
      if (existingByCode.length > 0) {
        return errorResponse(res, 'Branch code already exists for this course', 409);
      }
    }

    // Generate UUID
    const branchId = uuidv4();

    // Insert branch
    await pool.execute(
      `INSERT INTO branches (id, course_id, name, code, description, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        branchId,
        courseId,
        name.trim(),
        code?.trim() || null,
        description || null,
        userId || null,
        userId || null
      ]
    );

    // Fetch created branch
    const [branches] = await pool.execute(
      'SELECT id, course_id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM branches WHERE id = ?',
      [branchId]
    );

    const branch = formatBranch(branches[0]);

    return successResponse(res, branch, 'Branch created successfully', 201);
  } catch (error) {
    console.error('Create branch error:', error);
    return errorResponse(res, error.message || 'Failed to create branch', 500);
  }
};

export const listBranches = async (req, res) => {
  try {
    const { courseId } = req.params;
    const showInactive = req.query.showInactive === 'true';
    const pool = getPool();

    // Build query
    let query = 'SELECT id, course_id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM branches';
    const params = [];
    const conditions = [];

    if (courseId) {
      conditions.push('course_id = ?');
      params.push(courseId);
    }

    if (!showInactive) {
      conditions.push('is_active = ?');
      params.push(true);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY name ASC';

    const [branches] = await pool.execute(query, params);
    const formattedBranches = branches.map(formatBranch);

    return successResponse(res, formattedBranches);
  } catch (error) {
    console.error('List branches error:', error);
    return errorResponse(res, error.message || 'Failed to fetch branches', 500);
  }
};

export const updateBranch = async (req, res) => {
  try {
    const { courseId, branchId } = req.params;
    const { name, code, description, isActive } = req.body;
    const pool = getPool();
    const userId = req.user?.id || req.user?._id;

    // Check if branch exists for this course
    const [branches] = await pool.execute(
      'SELECT id, name, code FROM branches WHERE id = ? AND course_id = ?',
      [branchId, courseId]
    );

    if (branches.length === 0) {
      return errorResponse(res, 'Branch not found for the specified course', 404);
    }

    const currentBranch = branches[0];
    const updateFields = [];
    const updateValues = [];

    if (name && name.trim() && name.trim() !== currentBranch.name) {
      // Check if name already exists for this course
      const [existing] = await pool.execute(
        'SELECT id FROM branches WHERE course_id = ? AND name = ? AND id != ?',
        [courseId, name.trim(), branchId]
      );
      if (existing.length > 0) {
        return errorResponse(res, 'Another branch with the same name exists', 409);
      }
      updateFields.push('name = ?');
      updateValues.push(name.trim());
    }

    if (code !== undefined) {
      if (code && code.trim() && code.trim() !== currentBranch.code) {
        // Check if code already exists for this course
        const [existingCode] = await pool.execute(
          'SELECT id FROM branches WHERE course_id = ? AND code = ? AND id != ?',
          [courseId, code.trim(), branchId]
        );
        if (existingCode.length > 0) {
          return errorResponse(res, 'Another branch with the same code exists', 409);
        }
        updateFields.push('code = ?');
        updateValues.push(code.trim());
      } else if (code === '') {
        updateFields.push('code = ?');
        updateValues.push(null);
      }
    }

    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description || null);
    }

    if (typeof isActive === 'boolean') {
      updateFields.push('is_active = ?');
      updateValues.push(isActive);
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_by = ?');
      updateValues.push(userId || null);
      updateFields.push('updated_at = NOW()');
      updateValues.push(branchId);

      await pool.execute(
        `UPDATE branches SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // Fetch updated branch
    const [updatedBranches] = await pool.execute(
      'SELECT id, course_id, name, code, description, is_active, created_by, updated_by, created_at, updated_at FROM branches WHERE id = ?',
      [branchId]
    );

    const branch = formatBranch(updatedBranches[0]);

    return successResponse(res, branch, 'Branch updated successfully');
  } catch (error) {
    console.error('Update branch error:', error);
    return errorResponse(res, error.message || 'Failed to update branch', 500);
  }
};

export const deleteBranch = async (req, res) => {
  try {
    const { courseId, branchId } = req.params;
    const pool = getPool();

    // Check if branch exists for this course
    const [branches] = await pool.execute(
      'SELECT id FROM branches WHERE id = ? AND course_id = ?',
      [branchId, courseId]
    );

    if (branches.length === 0) {
      return errorResponse(res, 'Branch not found', 404);
    }

    // Delete branch (foreign key constraints will handle related records)
    await pool.execute(
      'DELETE FROM branches WHERE id = ?',
      [branchId]
    );

    return successResponse(res, null, 'Branch deleted successfully');
  } catch (error) {
    console.error('Delete branch error:', error);
    return errorResponse(res, error.message || 'Failed to delete branch', 500);
  }
};

export const deleteCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const pool = getPool();

    // Check if course exists
    const [courses] = await pool.execute(
      'SELECT id FROM courses WHERE id = ?',
      [courseId]
    );

    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    // Check if course has branches
    const [branches] = await pool.execute(
      'SELECT COUNT(*) as count FROM branches WHERE course_id = ?',
      [courseId]
    );

    if (branches[0].count > 0) {
      return errorResponse(
        res,
        'Cannot delete course with existing branches. Please remove branches first.',
        409
      );
    }

    // Delete course (foreign key constraints will handle related records)
    await pool.execute(
      'DELETE FROM courses WHERE id = ?',
      [courseId]
    );

    return successResponse(res, null, 'Course deleted successfully');
  } catch (error) {
    console.error('Delete course error:', error);
    return errorResponse(res, error.message || 'Failed to delete course', 500);
  }
};


