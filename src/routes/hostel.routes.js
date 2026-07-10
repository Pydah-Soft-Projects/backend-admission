import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  listHostelAcademicYears,
  listHostels,
  listHostelCategories,
  listHostelRooms,
  getHostelFee,
  getHostelStudentDetails,
} from '../controllers/hostel.controller.js';

const router = express.Router();

router.use(protect);

router.get('/academic-years', listHostelAcademicYears);
router.get('/hostels', listHostels);
router.get('/categories', listHostelCategories);
router.get('/rooms', listHostelRooms);
router.get('/fee', getHostelFee);
router.get('/student', getHostelStudentDetails);

export default router;
