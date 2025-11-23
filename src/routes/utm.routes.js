import express from 'express';
import {
  buildUtmTrackedUrl,
  shortenUtmUrl,
  redirectShortUrl,
  getAllShortUrls,
  getUrlAnalytics,
  trackLongUrlClick,
} from '../controllers/utm.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

// Public routes
router.get('/redirect/:shortCode', redirectShortUrl);
router.post('/track-click', trackLongUrlClick);

// All other routes require authentication
router.use(protect);

// UTM URL builder routes
router.post('/build-url', buildUtmTrackedUrl);
router.post('/shorten', shortenUtmUrl);
router.get('/short-urls', getAllShortUrls);
router.get('/analytics/:urlId', getUrlAnalytics);

export default router;

