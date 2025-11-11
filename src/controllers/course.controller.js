import mongoose from 'mongoose';
import Course from '../models/Course.model.js';
import Branch from '../models/Branch.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const toObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
};

export const createCourse = async (req, res) => {
  try {
    const { name, code, description } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Course name is required', 422);
    }

    const normalizedName = name.trim();
    const existing = await Course.findOne({ name: normalizedName });
    if (existing) {
      return errorResponse(res, 'A course with the same name already exists', 409);
    }

    if (code && code.trim()) {
      const existingCode = await Course.findOne({ code: code.trim() });
      if (existingCode) {
        return errorResponse(res, 'A course with the same code already exists', 409);
      }
    }

    const course = await Course.create({
      name: normalizedName,
      code: code?.trim() || undefined,
      description,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });

    return successResponse(res, course, 'Course created successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to create course', 500);
  }
};

export const listCourses = async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const includeBranches = req.query.includeBranches === 'true';

    const filter = showInactive ? {} : { isActive: true };
    const courses = await Course.find(filter).sort({ name: 1 }).lean();

    if (!includeBranches || courses.length === 0) {
      return successResponse(res, courses);
    }

    const courseIds = courses.map((course) => course._id);
    const branchFilter = { courseId: { $in: courseIds } };
    if (!showInactive) {
      branchFilter.isActive = true;
    }

    const branches = await Branch.find(branchFilter).sort({ name: 1 }).lean();
    const branchMap = branches.reduce((acc, branch) => {
      const key = branch.courseId.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(branch);
      return acc;
    }, {});

    const payload = courses.map((course) => ({
      ...course,
      branches: branchMap[course._id.toString()] || [],
    }));

    return successResponse(res, payload);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to fetch courses', 500);
  }
};

export const getCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const includeBranches = req.query.includeBranches === 'true';
    const showInactive = req.query.showInactive === 'true';

    const course = await Course.findById(courseId).lean();
    if (!course) {
      return errorResponse(res, 'Course not found', 404);
    }

    if (!includeBranches) {
      return successResponse(res, course);
    }

    const branchFilter = { courseId: course._id };
    if (!showInactive) {
      branchFilter.isActive = true;
    }
    const branches = await Branch.find(branchFilter).sort({ name: 1 }).lean();

    return successResponse(res, { ...course, branches });
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to retrieve course', 500);
  }
};

export const updateCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { name, code, description, isActive } = req.body;

    const course = await Course.findById(courseId);
    if (!course) {
      return errorResponse(res, 'Course not found', 404);
    }

    if (name && name.trim() && name.trim() !== course.name) {
      const existing = await Course.findOne({ name: name.trim(), _id: { $ne: courseId } });
      if (existing) {
        return errorResponse(res, 'Another course with the same name exists', 409);
      }
      course.name = name.trim();
    }

    if (code && code.trim() && code.trim() !== course.code) {
      const existingCode = await Course.findOne({ code: code.trim(), _id: { $ne: courseId } });
      if (existingCode) {
        return errorResponse(res, 'Another course with the same code exists', 409);
      }
      course.code = code.trim();
    } else if (code === '') {
      course.code = undefined;
    }

    if (description !== undefined) {
      course.description = description;
    }

    if (typeof isActive === 'boolean') {
      course.isActive = isActive;
    }

    course.updatedBy = req.user?._id;
    await course.save();

    return successResponse(res, course, 'Course updated successfully');
  } catch (error) {
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

    const course = await Course.findById(courseId);
    if (!course) {
      return errorResponse(res, 'Course not found', 404);
    }

    const existing = await Branch.findOne({ courseId, name: name.trim() });
    if (existing) {
      return errorResponse(res, 'Branch already exists for this course', 409);
    }

    if (code && code.trim()) {
      const existingCode = await Branch.findOne({ courseId, code: code.trim() });
      if (existingCode) {
        return errorResponse(res, 'Branch code already exists for this course', 409);
      }
    }

    const branch = await Branch.create({
      courseId,
      name: name.trim(),
      code: code?.trim() || undefined,
      description,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });

    return successResponse(res, branch, 'Branch created successfully', 201);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to create branch', 500);
  }
};

export const listBranches = async (req, res) => {
  try {
    const { courseId } = req.params;
    const showInactive = req.query.showInactive === 'true';
    const queryCourseId = courseId ? toObjectId(courseId) : null;

    const filter = {};
    if (queryCourseId) {
      filter.courseId = queryCourseId;
    }
    if (!showInactive) {
      filter.isActive = true;
    }

    const branches = await Branch.find(filter).sort({ name: 1 }).lean();
    return successResponse(res, branches);
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to fetch branches', 500);
  }
};

export const updateBranch = async (req, res) => {
  try {
    const { courseId, branchId } = req.params;
    const { name, code, description, isActive } = req.body;

    const branch = await Branch.findOne({ _id: branchId, courseId });
    if (!branch) {
      return errorResponse(res, 'Branch not found for the specified course', 404);
    }

    if (name && name.trim() && name.trim() !== branch.name) {
      const existing = await Branch.findOne({
        courseId,
        name: name.trim(),
        _id: { $ne: branchId },
      });
      if (existing) {
        return errorResponse(res, 'Another branch with the same name exists', 409);
      }
      branch.name = name.trim();
    }

    if (code !== undefined) {
      if (code && code.trim() && code.trim() !== branch.code) {
        const existingCode = await Branch.findOne({
          courseId,
          code: code.trim(),
          _id: { $ne: branchId },
        });
        if (existingCode) {
          return errorResponse(res, 'Another branch with the same code exists', 409);
        }
        branch.code = code.trim();
      } else if (code === '') {
        branch.code = undefined;
      }
    }

    if (description !== undefined) {
      branch.description = description;
    }

    if (typeof isActive === 'boolean') {
      branch.isActive = isActive;
    }

    branch.updatedBy = req.user?._id;
    await branch.save();

    return successResponse(res, branch, 'Branch updated successfully');
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to update branch', 500);
  }
};

export const deleteBranch = async (req, res) => {
  try {
    const { courseId, branchId } = req.params;

    const branch = await Branch.findOne({ _id: branchId, courseId });
    if (!branch) {
      return errorResponse(res, 'Branch not found', 404);
    }

    await Branch.deleteOne({ _id: branchId });
    return successResponse(res, null, 'Branch deleted successfully');
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to delete branch', 500);
  }
};

export const deleteCourse = async (req, res) => {
  try {
    const { courseId } = req.params;

    const course = await Course.findById(courseId);
    if (!course) {
      return errorResponse(res, 'Course not found', 404);
    }

    const branchCount = await Branch.countDocuments({ courseId });
    if (branchCount > 0) {
      return errorResponse(
        res,
        'Cannot delete course with existing branches. Please remove branches first.',
        409
      );
    }

    await Course.deleteOne({ _id: courseId });
    return successResponse(res, null, 'Course deleted successfully');
  } catch (error) {
    return errorResponse(res, error.message || 'Failed to delete course', 500);
  }
};


