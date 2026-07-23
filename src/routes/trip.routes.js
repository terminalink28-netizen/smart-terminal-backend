import express from 'express';
import {
  getLiveTrips,
  getDispatchResources,
  createTrip,
  getMyTrips,
  selfStartTrip,
  updateTripStatus,
  handleQrScan,
  getTerminalVans,          // <-- new
} from '../controllers/trip.controller.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// ─── Public Routes ───
router.get('/live', getLiveTrips);

// ─── Dispatcher & Admin Routes ───
router.get('/dispatch-resources', requireAuth, requireRoles(['ADMIN', 'DISPATCHER']), getDispatchResources);
router.post('/dispatch', requireAuth, requireRoles(['ADMIN', 'DISPATCHER']), createTrip);
router.get('/terminal', requireAuth, requireRoles(['ADMIN', 'DISPATCHER']), getTerminalVans); // <-- new

// ─── Driver Routes ───
router.get('/my-trips', requireAuth, requireRoles(['DRIVER']), getMyTrips);
router.post('/self-start', requireAuth, requireRoles(['DRIVER']), selfStartTrip);

// ─── Shared Status Updates ───
router.patch('/:id/status', requireAuth, updateTripStatus);
router.post('/qr-scan', requireAuth, handleQrScan);

export default router;