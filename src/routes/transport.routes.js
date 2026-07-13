import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  listTransportRoutes,
  getTransportRouteDetail,
  getNextTransportApplicationNumberPreview,
  getStudentTransportRequest,
  cancelStudentTransportRequestHandler,
} from '../controllers/transport.controller.js';

const router = express.Router();

router.use(protect);

router.get('/next-application-number', getNextTransportApplicationNumberPreview);
router.get('/requests', getStudentTransportRequest);
router.post('/requests/cancel', cancelStudentTransportRequestHandler);
router.get('/routes', listTransportRoutes);
router.get('/routes/:routeId', getTransportRouteDetail);

export default router;
