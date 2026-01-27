import express from 'express';
import { login, getMe, logout, createSSOSession } from '../controllers/auth.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

router.post('/login', login);
router.get('/me', protect, getMe);
router.post('/logout', protect, logout);
router.post('/sso-session', createSSOSession);

export default router;

