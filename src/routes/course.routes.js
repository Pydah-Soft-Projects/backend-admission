import express from 'express';
import {
  createBranch,
  createCourse,
  deleteBranch,
  deleteCourse,
  getCourse,
  listBranches,
  listCourses,
  updateBranch,
  updateCourse,
} from '../controllers/course.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect, isSuperAdmin);

router.route('/')
  .get(listCourses)
  .post(createCourse);

router.route('/branches')
  .get(listBranches);

router.route('/:courseId')
  .get(getCourse)
  .put(updateCourse)
  .delete(deleteCourse);

router.route('/:courseId/branches')
  .get(listBranches)
  .post(createBranch);

router.route('/:courseId/branches/:branchId')
  .put(updateBranch)
  .delete(deleteBranch);

export default router;



