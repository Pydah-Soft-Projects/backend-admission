import express from 'express';
import { listRegistrationForms, getRegistrationForm } from '../controllers/registrationForm.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

router.use(protect);

router.get('/forms', listRegistrationForms);
router.get('/forms/:formId', getRegistrationForm);

export default router;
