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
  listStudentQuotas,
} from '../controllers/secondaryJoiningContext.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

// Order matters: every static path must be registered before `/:courseId`,
// otherwise it would swallow `/program-levels`, `/certificate-guidance`, etc.

router.get('/colleges', listColleges);
router.get('/branches', listBranches);
router.get('/', listCourses);
router.get('/program-levels', protect, listCourseProgramLevels);
router.get('/student-quotas', protect, listStudentQuotas);
router.get('/certificate-guidance', protect, getCertificateGuidanceForLevel);
router.get('/:courseId', getCourse);
router.get('/:courseId/branches', listBranches);

export default router;



