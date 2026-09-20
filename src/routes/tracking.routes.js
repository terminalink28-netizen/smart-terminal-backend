// src/routes/tracking.routes.js
import express from 'express';
import { getLiveTrips, updateDriverLocation } from '../controllers/trip.controller.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// Public feed — identical payload to /api/trips/live.
router.get('/live', getLiveTrips);

// Driver GPS ingestion alias (if your driver app prefers /api/tracking/location).
router.post('/location', requireAuth, requireRoles('DRIVER'), updateDriverLocation);

export default router;
