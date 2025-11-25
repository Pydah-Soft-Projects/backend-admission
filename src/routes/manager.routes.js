import express from 'express';
import {
  getTeamMembers,
  getManagerLeads,
  getManagerAnalytics,
  getUnfollowedLeads,
  notifyTeam,
  getTeamAnalyticsForAdmin,
} from '../controllers/manager.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Get manager's team members
router.get('/team', getTeamMembers);

// Get all leads (manager's + team's)
router.get('/leads', getManagerLeads);

// Get manager analytics
router.get('/analytics', getManagerAnalytics);

// Get unfollowed leads
router.get('/unfollowed-leads', getUnfollowedLeads);

// Send notifications to team
router.post('/notify-team', notifyTeam);

// Get team analytics for super admin (by manager ID)
router.get('/team-analytics/:managerId', getTeamAnalyticsForAdmin);

export default router;

