import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PLATE_RE = /^[A-Z0-9\- ]{4,15}$/i;

export const registerDriver = async (req, res) => {
  try {
    const { name, driverId, pin, contactNumber, plateNumber, capacity } = req.body;

    if (!name || !driverId || !pin || !contactNumber || !plateNumber || !capacity) {
      return res.status(400).json({
        error: 'name, driverId, pin, contactNumber, plateNumber, and capacity are all required.',
      });
    }
    if (!PLATE_RE.test(plateNumber.trim())) {
      return res.status(400).json({ error: 'Invalid plate number format.' });
    }
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap > 30) {
      return res.status(400).json({ error: 'Capacity must be a whole number between 1 and 30.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: "A photo of your driver's license is required." });
    }

    const normalizedPlate = plateNumber.trim().toUpperCase();

    const existingDriverId = await prisma.user.findUnique({ where: { driverId } });
    if (existingDriverId) {
      return res.status(409).json({ error: 'That Driver ID is already registered.' });
    }

    const existingPlate = await prisma.van.findUnique({ where: { plateNumber: normalizedPlate } });
    if (existingPlate) {
      return res.status(409).json({ error: 'That plate number is already registered.' });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const newDriver = await prisma.$transaction(async (tx) => {
      // Van starts IDLE. It will be flipped to ON_TRIP the first time the
      // driver self-starts or a dispatcher assigns them a trip — at which
      // point `start_tracking` is broadcast and the driver's phone begins
      // streaming GPS automatically (no manual tap needed).
      const van = await tx.van.create({
        data: {
          plateNumber: normalizedPlate,
          capacity: cap,
          status: 'IDLE',
        },
      });

      return tx.user.create({
        data: {
          name,
          role: 'DRIVER',
          driverId,
          contactNumber,
          pinHash,
          licensePhotoUrl: req.file.path,
          assignedVanId: van.id,
          isActive: true,
          approvalStatus: 'PENDING',
        },
        select: {
          id: true, name: true, driverId: true, contactNumber: true,
          licensePhotoUrl: true, approvalStatus: true, createdAt: true,
          assignedVan: { select: { plateNumber: true } },
        },
      });
    });

    return res.status(201).json({
      message: 'Registration submitted. An admin will review your account before you can log in.',
      driver: newDriver,
    });
  } catch (error) {
    console.error('[Driver Registration Error]', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Driver ID or plate number is already taken.' });
    }
    return res.status(500).json({ error: 'Failed to submit registration.' });
  }
};
