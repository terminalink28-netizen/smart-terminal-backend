// src/controllers/driver.controller.js
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PLATE_RE = /^[A-Z0-9\- ]{4,15}$/i;
const PHONE_RE = /^[+\d][\d\s-]{6,14}$/;
const MAX_CONTACT_NUMBERS = 5;

// ─── Registration ─────────────────────────────────────────────────────────────

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
    if (!PHONE_RE.test(String(contactNumber).trim())) {
      return res.status(400).json({ error: 'Invalid contact number format.' });
    }
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap > 30) {
      return res.status(400).json({ error: 'Capacity must be a whole number between 1 and 30.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: "A photo of your driver's license is required." });
    }

    const normalizedPlate = plateNumber.trim().toUpperCase();
    const normalizedPhone = String(contactNumber).trim();

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
          // The singular field stays for backward compatibility with older
          // frontends; the array is what the new multi-number UI reads/writes.
          contactNumber: normalizedPhone,
          contactNumbers: [normalizedPhone],
          pinHash,
          licensePhotoUrl: req.file.path,
          assignedVanId: van.id,
          isActive: true,
          approvalStatus: 'PENDING',
        },
        select: {
          id: true,
          name: true,
          driverId: true,
          contactNumber: true,
          contactNumbers: true,
          licensePhotoUrl: true,
          approvalStatus: true,
          createdAt: true,
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

// ─── Contact numbers (driver self-service) ────────────────────────────────────

export const getMyContactNumbers = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { contactNumber: true, contactNumbers: true },
    });

    if (!user) return res.status(404).json({ error: 'Driver not found.' });

    // Prefer the array; fall back to the singular field for legacy accounts
    // that were created before the array existed.
    let numbers = Array.isArray(user.contactNumbers) ? user.contactNumbers : [];
    if (numbers.length === 0 && user.contactNumber) {
      numbers = [user.contactNumber];
    }

    return res.status(200).json({ contactNumbers: numbers });
  } catch (error) {
    console.error('[getMyContactNumbers]', error);
    return res.status(500).json({ error: 'Failed to load contact numbers.' });
  }
};

export const updateMyContactNumbers = async (req, res) => {
  try {
    const { contactNumbers } = req.body;

    if (!Array.isArray(contactNumbers)) {
      return res.status(400).json({ error: 'contactNumbers must be an array.' });
    }

    const cleaned = contactNumbers
      .map((n) => String(n ?? '').trim())
      .filter((n) => n.length > 0);

    if (cleaned.length > MAX_CONTACT_NUMBERS) {
      return res.status(400).json({
        error: `Maximum of ${MAX_CONTACT_NUMBERS} contact numbers allowed.`,
      });
    }

    // Reject duplicates.
    const deduped = Array.from(new Set(cleaned));
    if (deduped.length !== cleaned.length) {
      return res.status(400).json({ error: 'Duplicate numbers are not allowed.' });
    }

    for (const n of deduped) {
      if (!PHONE_RE.test(n)) {
        return res.status(400).json({ error: `Invalid phone number: ${n}` });
      }
    }

    // Keep the singular field in sync so old clients still work — set it to
    // the first number in the list (or null if the list is empty).
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        contactNumbers: deduped,
        contactNumber: deduped[0] ?? null,
      },
    });

    return res.status(200).json({ contactNumbers: deduped });
  } catch (error) {
    console.error('[updateMyContactNumbers]', error);
    return res.status(500).json({ error: 'Failed to save contact numbers.' });
  }
};
