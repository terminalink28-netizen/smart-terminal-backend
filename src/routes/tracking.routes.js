// src/routes/tracking.routes.js
import express from 'express';
import { getLiveTrips, updateDriverLocation } from '../controllers/trip.controller.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// Public feed — identical payload to /api/trips/live.
router.get('/live', getLiveTrips);

// Driver GPS ingestion alias. `requireRoles` takes an ARRAY — passing a
// bare string here (as the previous version did) would crash at request
// time with `'DRIVER'.map is not a function`.
router.post('/location', requireAuth, requireRoles(['DRIVER']), updateDriverLocation);

export default router;
