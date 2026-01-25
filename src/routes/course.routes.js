import express from 'express';
import {
  getCourse,
  listBranches,
  listCourses,
} from '../controllers/course.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Read-only routes (courses and branches are fetched from secondary database)
router.route('/')
  .get(listCourses);

router.route('/branches')
  .get(listBranches);

router.route('/:courseId')
  .get(getCourse);

router.route('/:courseId/branches')
  .get(listBranches);

// Note: Create, Update, and Delete operations are disabled
// Courses and branches are managed in the external secondary database system
export default router;



