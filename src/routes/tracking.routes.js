import express from 'express';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  updateDriverLocation,
  getLiveLocationsSnapshot,
} from '../controllers/trip.controller.js';

// --- Prisma 7 Database Connection Setup ---
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
// ------------------------------------------

const router = express.Router();

// Assume your existing auth middleware (only needs to populate req.user.id).
// Adjust the import path/name to match your project.
import { requireAuth, requireRole } from '../middleware/auth.js';

// ─── Public: all trips currently in progress ─────────────────────────────────
// Includes the last known phone GPS fix (if any) so polling clients can plot
// markers without waiting for the next `van_moved` socket push.
router.get('/live', async (req, res) => {
  try {
    const activeTrips = await prisma.trip.findMany({
      where: {
        status: {
          in: ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'],
        },
      },
      include: {
        driver: { select: { id: true, name: true } },
        van:    { select: { plateNumber: true, capacity: true } },
        route:  { select: { name: true, origin: true, destination: true } },
      },
    });

    // Merge in the freshest in-memory fix per trip.
    const snapshot = new Map(getLiveLocationsSnapshot());
    const now = Date.now();
    const LOCATION_STALE_MS = 120_000;

    const payload = activeTrips.map((trip) => {
      const loc = snapshot.get(trip.id);
      const isStale = loc && now - loc.timestamp > LOCATION_STALE_MS;
      return { ...trip, liveLocation: loc && !isStale ? loc : null };
    });

    return res.status(200).json(payload);
  } catch (error) {
    console.error('[Tracking Error]', error);
    return res.status(500).json({ error: 'Failed to fetch live trips' });
  }
});

// ─── Public: one trip's details + current GPS ────────────────────────────────
router.get('/live/:tripId', async (req, res) => {
  try {
    const { tripId } = req.params;

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        driver: { select: { id: true, name: true } },
        van:    { select: { plateNumber: true, capacity: true } },
        route:  { select: { name: true, origin: true, destination: true } },
      },
    });

    if (!trip) return res.status(404).json({ error: 'Trip not found.' });

    const snapshot = new Map(getLiveLocationsSnapshot());
    const loc = snapshot.get(tripId);
    const isStale = loc && Date.now() - loc.timestamp > 120_000;

    return res.status(200).json({
      ...trip,
      liveLocation: loc && !isStale ? loc : null,
    });
  } catch (error) {
    console.error('[Tracking Error]', error);
    return res.status(500).json({ error: 'Failed to fetch trip' });
  }
});

// ─── Driver: submit a GPS fix from their phone ───────────────────────────────
// The driver app calls this on every `watchPosition` tick as soon as it
// receives the `start_tracking` socket event (which is fired automatically
// when the trip enters BOARDING). No manual "share location" button needed.
router.post(
  '/location',
  requireAuth,
  requireRole('DRIVER'),
  updateDriverLocation,
);

export default router;
