import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  listTransportRoutes,
  getTransportRouteDetail,
} from '../controllers/transport.controller.js';

const router = express.Router();

router.use(protect);

router.get('/routes', listTransportRoutes);
router.get('/routes/:routeId', getTransportRouteDetail);

export default router;
