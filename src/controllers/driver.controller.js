import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export const getAvailableVans = async (req, res) => {
  try {
    const vans = await prisma.van.findMany({
      where: { driver: null }, // vans with no driver assigned via the reverse relation
      select: { id: true, plateNumber: true, capacity: true, status: true },
      orderBy: { plateNumber: 'asc' },
    });
    return res.status(200).json(vans);
  } catch (error) {
    console.error('[Get Available Vans Error]', error);
    return res.status(500).json({ error: 'Failed to load available vans.' });
  }
};

export const registerDriver = async (req, res) => {
  try {
    const { name, driverId, pin, contactNumber, vanId } = req.body;

    if (!name || !driverId || !pin || !contactNumber || !vanId) {
      return res.status(400).json({ error: 'name, driverId, pin, contactNumber, and vanId are all required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: "A photo of your driver's license is required." });
    }

    const existingDriverId = await prisma.user.findUnique({ where: { driverId } });
    if (existingDriverId) {
      return res.status(409).json({ error: 'That Driver ID is already registered.' });
    }

    const van = await prisma.van.findUnique({ where: { id: vanId }, include: { driver: true } });
    if (!van) {
      return res.status(400).json({ error: 'Selected van does not exist.' });
    }
    if (van.driver) {
      return res.status(409).json({ error: `${van.plateNumber} was just assigned to another driver. Please pick a different van.` });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const newDriver = await prisma.user.create({
      data: {
        name,
        role: 'DRIVER',
        driverId,
        contactNumber,
        pinHash,
        licensePhotoUrl: req.file.path,
        assignedVanId: vanId,
        isActive: true,
        approvalStatus: 'PENDING',
      },
      select: {
        id: true, name: true, driverId: true, contactNumber: true,
        licensePhotoUrl: true, approvalStatus: true, createdAt: true,
        assignedVan: { select: { plateNumber: true } },
      },
    });

    return res.status(201).json({
      message: 'Registration submitted. An admin will review your account before you can log in.',
      driver: newDriver,
    });
  } catch (error) {
    console.error('[Driver Registration Error]', error);
    // Race condition: two drivers submitted for the same van within milliseconds
    // of each other — the DB's unique constraint on assignedVanId catches it.
    if (error.code === 'P2002' && error.meta?.target?.includes('assignedVanId')) {
      return res.status(409).json({ error: 'That van was just taken by another applicant. Please pick a different van.' });
    }
    return res.status(500).json({ error: 'Failed to submit registration.' });
  }
};
