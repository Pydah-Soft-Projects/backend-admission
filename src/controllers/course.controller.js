import { getPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

// Helper function to format course data from secondary database to camelCase
// Secondary DB schema: id (int), college_id (int), name, code, total_years, semesters_per_year, 
// year_semester_config (json), metadata (json), is_active (tinyint), created_at, updated_at
const formatCourse = (courseData) => {
  if (!courseData) return null;
  return {
    id: String(courseData.id), // Convert int to string for frontend compatibility
    _id: String(courseData.id), // Keep _id for backward compatibility
    name: courseData.name,
    code: courseData.code || null,
    description: courseData.metadata?.description || null, // Extract from metadata if available
    isActive: courseData.is_active === 1 || courseData.is_active === true,
    // Additional fields from secondary DB
    collegeId: courseData.college_id ? String(courseData.college_id) : null,
    totalYears: courseData.total_years || null,
    semestersPerYear: courseData.semesters_per_year || null,
    yearSemesterConfig: courseData.year_semester_config || null,
    metadata: courseData.metadata || null,
    createdAt: courseData.created_at,
    updatedAt: courseData.updated_at,
  };
};

// Helper function to format branch data from secondary database to camelCase
// Secondary DB schema: id (int), course_id (int), name, code, total_years, semesters_per_year,
// year_semester_config (json), metadata (json), is_active (tinyint), created_at, updated_at, academic_year_id (int)
const formatBranch = (branchData) => {
  if (!branchData) return null;
  return {
    id: String(branchData.id), // Convert int to string
    _id: String(branchData.id), // Keep _id for backward compatibility
    courseId: String(branchData.course_id), // Convert int to string
    name: branchData.name,
    code: branchData.code || null,
    description: branchData.metadata?.description || null, // Extract from metadata if available
    isActive: branchData.is_active === 1 || branchData.is_active === true,
    // Additional fields from secondary DB
    totalYears: branchData.total_years || null,
    semestersPerYear: branchData.semesters_per_year || null,
    yearSemesterConfig: branchData.year_semester_config || null,
    metadata: branchData.metadata || null,
    academicYearId: branchData.academic_year_id ? String(branchData.academic_year_id) : null,
    createdAt: branchData.created_at,
    updatedAt: branchData.updated_at,
  };
};

// Note: Create, Update, and Delete operations are disabled since courses/branches are read-only from secondary database
export const createCourse = async (req, res) => {
  return errorResponse(res, 'Courses are managed in the external system. Cannot create courses from this API.', 403);
};

export const listCourses = async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const includeBranches = req.query.includeBranches === 'true';
    const pool = getPool();

    // Build query for secondary database
    let query = 'SELECT id, college_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, created_at, updated_at FROM courses';
    const params = [];
    
    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(1); // tinyint(1) uses 1 for true
    }
    
    query += ' ORDER BY name ASC';

    const [courses] = await pool.execute(query, params);
    const formattedCourses = courses.map(formatCourse);

    if (!includeBranches || formattedCourses.length === 0) {
      return successResponse(res, formattedCourses);
    }

    // Get branches for all courses from course_branches table
    const courseIds = formattedCourses.map(c => parseInt(c.id)); // Convert back to int for query
    if (courseIds.length === 0) {
      return successResponse(res, formattedCourses.map(course => ({ ...course, branches: [] })));
    }

    let branchQuery = 'SELECT DISTINCT id, course_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, academic_year_id, created_at, updated_at FROM course_branches WHERE course_id IN (';
    branchQuery += courseIds.map(() => '?').join(',');
    branchQuery += ')';
    
    if (!showInactive) {
      branchQuery += ' AND is_active = ?';
      courseIds.push(1); // tinyint(1) uses 1 for true
    }
    
    branchQuery += ' ORDER BY name ASC';

    const [branches] = await pool.execute(branchQuery, courseIds);
    const formattedBranches = branches.map(formatBranch);

    // Deduplicate branches by ID first (in case of any duplicates from secondary DB)
    const uniqueBranchesMap = new Map();
    formattedBranches.forEach((branch) => {
      const branchId = branch.id || branch._id;
      if (branchId && !uniqueBranchesMap.has(branchId)) {
        uniqueBranchesMap.set(branchId, branch);
      }
    });
    const deduplicatedBranches = Array.from(uniqueBranchesMap.values());

    // Group deduplicated branches by course_id (as string for matching)
    const branchMap = deduplicatedBranches.reduce((acc, branch) => {
      const key = branch.courseId;
      if (!acc[key]) acc[key] = [];
      // Additional check to prevent duplicates within the same course
      const existingBranch = acc[key].find((b) => (b.id || b._id) === (branch.id || branch._id));
      if (!existingBranch) {
        acc[key].push(branch);
      }
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

    // Convert courseId to int for query (secondary DB uses int IDs)
    const courseIdInt = parseInt(courseId);
    if (isNaN(courseIdInt)) {
      return errorResponse(res, 'Invalid course ID', 400);
    }

    // Get course from secondary database
    const [courses] = await pool.execute(
      'SELECT id, college_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, created_at, updated_at FROM courses WHERE id = ?',
      [courseIdInt]
    );

    if (courses.length === 0) {
      return errorResponse(res, 'Course not found', 404);
    }

    const course = formatCourse(courses[0]);

    if (!includeBranches) {
      return successResponse(res, course);
    }

    // Get branches from course_branches table
    let branchQuery = 'SELECT DISTINCT id, course_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, academic_year_id, created_at, updated_at FROM course_branches WHERE course_id = ?';
    const branchParams = [courseIdInt];
    
    if (!showInactive) {
      branchQuery += ' AND is_active = ?';
      branchParams.push(1); // tinyint(1) uses 1 for true
    }
    
    branchQuery += ' ORDER BY name ASC';

    const [branches] = await pool.execute(branchQuery, branchParams);
    const formattedBranches = branches.map(formatBranch);

    // Deduplicate branches by ID (in case of any duplicates from secondary DB)
    const uniqueBranchesMap = new Map();
    formattedBranches.forEach((branch) => {
      const branchId = branch.id || branch._id;
      if (branchId && !uniqueBranchesMap.has(branchId)) {
        uniqueBranchesMap.set(branchId, branch);
      }
    });
    const deduplicatedBranches = Array.from(uniqueBranchesMap.values());

    return successResponse(res, { ...course, branches: deduplicatedBranches });
  } catch (error) {
    console.error('Get course error:', error);
    return errorResponse(res, error.message || 'Failed to retrieve course', 500);
  }
};

export const updateCourse = async (req, res) => {
  return errorResponse(res, 'Courses are managed in the external system. Cannot update courses from this API.', 403);
};

export const createBranch = async (req, res) => {
  return errorResponse(res, 'Branches are managed in the external system. Cannot create branches from this API.', 403);
};

export const listBranches = async (req, res) => {
  try {
    const { courseId } = req.params;
    const showInactive = req.query.showInactive === 'true';
    const pool = getPool();

    // Build query for course_branches table
    let query = 'SELECT DISTINCT id, course_id, name, code, total_years, semesters_per_year, year_semester_config, metadata, is_active, academic_year_id, created_at, updated_at FROM course_branches';
    const params = [];
    const conditions = [];

    if (courseId) {
      const courseIdInt = parseInt(courseId);
      if (isNaN(courseIdInt)) {
        return errorResponse(res, 'Invalid course ID', 400);
      }
      conditions.push('course_id = ?');
      params.push(courseIdInt);
    }

    if (!showInactive) {
      conditions.push('is_active = ?');
      params.push(1); // tinyint(1) uses 1 for true
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY name ASC';

    const [branches] = await pool.execute(query, params);
    const formattedBranches = branches.map(formatBranch);

    // Deduplicate branches by ID (in case of any duplicates from secondary DB)
    const uniqueBranchesMap = new Map();
    formattedBranches.forEach((branch) => {
      const branchId = branch.id || branch._id;
      if (branchId && !uniqueBranchesMap.has(branchId)) {
        uniqueBranchesMap.set(branchId, branch);
      }
    });
    const deduplicatedBranches = Array.from(uniqueBranchesMap.values());

    return successResponse(res, deduplicatedBranches);
  } catch (error) {
    console.error('List branches error:', error);
    return errorResponse(res, error.message || 'Failed to fetch branches', 500);
  }
};

export const updateBranch = async (req, res) => {
  return errorResponse(res, 'Branches are managed in the external system. Cannot update branches from this API.', 403);
};

export const deleteBranch = async (req, res) => {
  return errorResponse(res, 'Branches are managed in the external system. Cannot delete branches from this API.', 403);
};

export const deleteCourse = async (req, res) => {
  return errorResponse(res, 'Courses are managed in the external system. Cannot delete courses from this API.', 403);
};
