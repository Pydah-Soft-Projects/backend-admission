import express from 'express';
import {
  getJoiningPublicBootstrap,
  saveJoiningPublicDraft,
  submitJoiningPublic,
} from '../controllers/joiningPublic.controller.js';

const router = express.Router();

// Query form first (DLT: `.../joining/public?t={#var#}`). `/:token` must not capture `submit`.
router.get('/', getJoiningPublicBootstrap);
router.post('/', saveJoiningPublicDraft);
router.post('/submit', submitJoiningPublic);
router.get('/:token', getJoiningPublicBootstrap);
router.post('/:token', saveJoiningPublicDraft);
router.post('/:token/submit', submitJoiningPublic);

export default router;
