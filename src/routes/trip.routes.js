import express from 'express';
import {
  getLiveTrips,
  getDispatchResources,
  createTrip,
  getMyTrips,
  selfStartTrip,
  updateTripStatus,
  handleQrScan
} from '../controllers/trip.controller.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// ─── Public Routes ───
router.get('/live', getLiveTrips);

// ─── Dispatcher & Admin Routes ───
// These fetch available vans/drivers and allow manual dispatching
router.get('/dispatch-resources', requireAuth, requireRoles(['ADMIN', 'DISPATCHER']), getDispatchResources);
router.post('/dispatch', requireAuth, requireRoles(['ADMIN', 'DISPATCHER']), createTrip);

// ─── Driver Routes ───
// These allow drivers to fetch their assignments and start their own trips
router.get('/my-trips', requireAuth, requireRoles(['DRIVER']), getMyTrips);
router.post('/self-start', requireAuth, requireRoles(['DRIVER']), selfStartTrip);

// ─── Shared Shared Status Updates ───
router.patch('/:id/status', requireAuth, updateTripStatus);
router.post('/qr-scan', requireAuth, handleQrScan);

export default router;