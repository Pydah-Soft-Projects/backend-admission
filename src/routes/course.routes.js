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

// All routes require authentication
router.use(protect);

// Must be registered before "/:courseId" so paths are not captured as IDs
router.get('/program-levels', listCourseProgramLevels);
router.get('/certificate-guidance', getCertificateGuidanceForLevel);

// Read-only routes (courses and branches are fetched from secondary database)
router.route('/')
  .get(listCourses);

router.route('/branches')
  .get(listBranches);

router.route('/colleges')
  .get(listColleges);

router.route('/:courseId')
  .get(getCourse);

router.route('/:courseId/branches')
  .get(listBranches);

// Note: Create, Update, and Delete operations are disabled
// Courses and branches are managed in the external secondary database system
export default router;



