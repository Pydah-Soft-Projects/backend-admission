import express from 'express';
import {
  listStates,
  getState,
  createState,
  updateState,
  deleteState,
  listDistricts,
  getDistrict,
  createDistrict,
  updateDistrict,
  deleteDistrict,
  listMandals,
  getMandal,
  createMandal,
  updateMandal,
  deleteMandal,
  listSchools,
  getSchool,
  createSchool,
  updateSchool,
  deleteSchool,
  bulkCreateSchools,
  listColleges,
  getCollege,
  createCollege,
  updateCollege,
  deleteCollege,
  bulkCreateColleges,
} from '../controllers/masterData.controller.js';
import { protect, isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect);
router.use(isSuperAdmin);

// States
router.route('/states').get(listStates).post(createState);
router.route('/states/:id').get(getState).put(updateState).delete(deleteState);

// Districts (optional filter: ?stateId=...)
router.route('/districts').get(listDistricts).post(createDistrict);
router
  .route('/districts/:id')
  .get(getDistrict)
  .put(updateDistrict)
  .delete(deleteDistrict);

// Mandals (optional filter: ?districtId=...)
router.route('/mandals').get(listMandals).post(createMandal);
router
  .route('/mandals/:id')
  .get(getMandal)
  .put(updateMandal)
  .delete(deleteMandal);

// Schools (bulk must be before :id)
router.route('/schools').get(listSchools).post(createSchool);
router.post('/schools/bulk', bulkCreateSchools);
router
  .route('/schools/:id')
  .get(getSchool)
  .put(updateSchool)
  .delete(deleteSchool);

// Colleges (bulk must be before :id)
router.route('/colleges').get(listColleges).post(createCollege);
router.post('/colleges/bulk', bulkCreateColleges);
router
  .route('/colleges/:id')
  .get(getCollege)
  .put(updateCollege)
  .delete(deleteCollege);

export default router;
