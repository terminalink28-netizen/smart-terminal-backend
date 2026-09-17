import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export const registerDriver = async (req, res) => {
  try {
    const { name, driverId, pin, contactNumber } = req.body;

    if (!name || !driverId || !pin || !contactNumber) {
      return res.status(400).json({ error: 'name, driverId, pin, and contactNumber are all required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: "A photo of your driver's license is required." });
    }

    const existing = await prisma.user.findUnique({ where: { driverId } });
    if (existing) {
      return res.status(409).json({ error: 'That Driver ID is already registered.' });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const newDriver = await prisma.user.create({
      data: {
        name,
        role: 'DRIVER',
        driverId,
        contactNumber,
        pinHash,
        licensePhotoUrl: req.file.path, // Cloudinary URL, set by multer-storage-cloudinary
        isActive: true,
        approvalStatus: 'PENDING',
      },
      select: {
        id: true, name: true, driverId: true, contactNumber: true,
        licensePhotoUrl: true, approvalStatus: true, createdAt: true,
      },
    });

    return res.status(201).json({
      message: 'Registration submitted. An admin will review your account before you can log in.',
      driver: newDriver,
    });
  } catch (error) {
    console.error('[Driver Registration Error]', error);
    return res.status(500).json({ error: 'Failed to submit registration.' });
  }
};
