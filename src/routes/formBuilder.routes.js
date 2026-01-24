import express from 'express';
import {
  listForms,
  getForm,
  createForm,
  updateForm,
  deleteForm,
  listFields,
  createField,
  updateField,
  deleteField,
  reorderFields,
} from '../controllers/formBuilder.controller.js';
import { protect } from '../middleware/auth.middleware.js';
import { isSuperAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

// Public route for getting form (for public lead form)
router.get('/forms/public/:formId', getForm);

// All other routes require authentication
router.use(protect);

// Form routes
router.route('/forms')
  .get(listForms)
  .post(isSuperAdmin, createForm);

router.route('/forms/:formId')
  .get(getForm)
  .put(isSuperAdmin, updateForm)
  .delete(isSuperAdmin, deleteForm);

// Field routes
router.route('/forms/:formId/fields')
  .get(listFields)
  .post(isSuperAdmin, createField);

router.route('/forms/:formId/fields/reorder')
  .put(isSuperAdmin, reorderFields);

router.route('/fields/:fieldId')
  .put(isSuperAdmin, updateField)
  .delete(isSuperAdmin, deleteField);

export default router;
