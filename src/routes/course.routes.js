import express from 'express';
import {
  getCourse,
  listColleges,
  listBranches,
  listCourses,
} from '../controllers/course.controller.js';
import {
  listCourseProgramLevels,
  getCertificateGuidanceForLevel,
} from '../controllers/secondaryJoiningContext.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

// Public routes (required for public lead form)
router.get('/colleges', listColleges);
router.get('/branches', listBranches);
router.get('/', listCourses);
router.get('/:courseId', getCourse);
router.get('/:courseId/branches', listBranches);

// All other routes require authentication
router.use(protect);

// Must be registered after public routes but captured correctly
router.get('/program-levels', listCourseProgramLevels);
router.get('/certificate-guidance', getCertificateGuidanceForLevel);

// Note: Create, Update, and Delete operations are disabled
// Courses and branches are managed in the external secondary database system
export default router;



