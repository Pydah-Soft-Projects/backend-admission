
import express from 'express';
import { login, getMe, logout, createSSOSession, resetPasswordDirectly, checkUser } from '../controllers/auth.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

router.post('/login', login);
router.get('/me', protect, getMe);
router.post('/logout', protect, logout);
router.post('/sso-session', createSSOSession);

// Forgot Password
// Forgot Password (Direct Reset)
router.post('/forgot-password/check-user', checkUser);
router.post('/forgot-password/reset-direct', resetPasswordDirectly);

export default router;

