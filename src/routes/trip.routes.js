import express from 'express';
import {
  getMyTrips,
  createTrip,
  updateTripStatus,
  handleQrScan,
  getDispatchResources,
  selfStartTrip,
  getLiveTrips,
} from '../controllers/trip.controller.js';

import { requireAuth, requireRoles } from '../middleware/auth.js'; 

const router = express.Router();

// ─── Public routes ────────────────────────────────────────────────────────────

// Unlocked so the Public Tracking page can fetch live fleet data without a login
router.get('/live', getLiveTrips);

// ─── Driver routes ────────────────────────────────────────────────────────────

router.get('/my-trips', requireAuth, requireRoles(['DRIVER']), getMyTrips);
router.post('/self-start', requireAuth, requireRoles(['DRIVER']), selfStartTrip);

// ─── Dispatcher & Admin routes ────────────────────────────────────────────────

router.get('/resources', requireAuth, requireRoles(['DISPATCHER', 'ADMIN']), getDispatchResources);
router.post('/', requireAuth, requireRoles(['DISPATCHER', 'ADMIN']), createTrip);
router.patch('/:id/status', requireAuth, requireRoles(['DISPATCHER', 'DRIVER', 'ADMIN']), updateTripStatus);
router.post('/qr-scan', requireAuth, requireRoles(['DISPATCHER', 'ADMIN']), handleQrScan);

export default router;