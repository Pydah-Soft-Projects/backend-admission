/**
 * Public read-only locations API (states, districts, mandals).
 * No auth required - used for dropdowns in public lead form and authenticated pages.
 */
import express from 'express';
import {
  listStates,
  listDistricts,
  listMandals,
  listSchools,
  listColleges,
} from '../controllers/locations.controller.js';

const router = express.Router();

router.get('/states', listStates);
router.get('/districts', listDistricts);
router.get('/mandals', listMandals);
router.get('/schools', listSchools);
router.get('/colleges', listColleges);

export default router;
