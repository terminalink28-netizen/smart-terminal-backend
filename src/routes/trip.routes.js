// src/routes/trip.routes.js
import express from 'express';
import * as tripController from '../controllers/trip.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// ─── Public: live trips + last known GPS fix ────────────────────────────────
router.get('/live', tripController.getLiveTrips);

// ─── Driver: submit a GPS fix (called continuously by the driver app) ───────
router.post(
  '/location',
  requireAuth,
  requireRole('DRIVER'),
  tripController.updateDriverLocation,
);

// ─── Existing trip endpoints ────────────────────────────────────────────────
router.post('/',            requireAuth, requireRole('DISPATCHER'), tripController.createTrip);
router.post('/self-start',  requireAuth, requireRole('DRIVER'),     tripController.selfStartTrip);
router.post('/qr-scan',     requireAuth, requireRole('DRIVER'),     tripController.handleQrScan);
router.get('/mine',         requireAuth, requireRole('DRIVER'),     tripController.getMyTrips);
router.get('/terminal-vans',requireAuth, requireRole('DISPATCHER'), tripController.getTerminalVans);
router.patch('/:id/status', requireAuth, tripController.updateTripStatus);

export default router;
