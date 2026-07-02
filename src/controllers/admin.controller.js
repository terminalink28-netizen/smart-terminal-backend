import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export const getSystemStats = async (req, res) => {
  try {
    // Run all database queries in parallel for maximum speed
    const [totalUsers, totalVans, totalTrips, activeTrips] = await Promise.all([
      prisma.user.count(),
      prisma.van.count(),
      prisma.trip.count(),
      prisma.trip.count({
        where: { status: { in: ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING'] } }
      })
    ]);

    // Fetch lists for the tables
    const staff = await prisma.user.findMany({
      select: { id: true, name: true, email: true, driverId: true, role: true, isActive: true }
    });

    const fleet = await prisma.van.findMany({
      orderBy: { plateNumber: 'asc' }
    });

    return res.status(200).json({
      stats: { totalUsers, totalVans, totalTrips, activeTrips },
      staff,
      fleet
    });
  } catch (error) {
    console.error('[Admin Stats Error]', error);
    return res.status(500).json({ error: 'Failed to fetch system stats.' });
  }
};