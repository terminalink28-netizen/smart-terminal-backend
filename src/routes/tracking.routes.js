import express from 'express';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// --- Prisma 7 Database Connection Setup ---
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
// ------------------------------------------

const router = express.Router();

// Public endpoint: Get all trips currently in progress
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

    return res.status(200).json(activeTrips);
  } catch (error) {
    console.error('[Tracking Error]', error);
    return res.status(500).json({ error: 'Failed to fetch live trips' });
  }
});

export default router;