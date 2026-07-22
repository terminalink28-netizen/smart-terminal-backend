import 'dotenv/config'; // Ensures environment variables load first
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// --- Prisma 7 Database Connection Setup ---
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
// ------------------------------------------

// Helper to check if a string is a valid email format
const isEmail = (identifier) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
};

export const login = async (req, res) => {
  try {
    const { identifier, secret } = req.body;
    
    // Diagnostic Log 1: Check what the server received
    console.log(`\n--- NEW LOGIN ATTEMPT ---`);
    console.log(`Identifier: ${identifier}`);

    if (!identifier || !secret) {
      return res.status(400).json({ error: 'Identifier and secret are required.' });
    }

    let user = null;
    let isValidSecret = false;

    if (isEmail(identifier)) {
      console.log(`Flow: Staff (Email)`);
      user = await prisma.user.findUnique({ where: { email: identifier } });
      
      // Diagnostic Log 2: Did we find the user?
      console.log(`Database User Found:`, user ? 'YES' : 'NO');
      if (user) console.log(`User Keys from DB:`, Object.keys(user));

      // Bulletproof check: Handle both Prisma generation styles
      const dbPasswordHash = user?.passwordHash || user?.password_hash;
      
      if (user && dbPasswordHash) {
        isValidSecret = await bcrypt.compare(secret, dbPasswordHash);
        console.log(`Password Match:`, isValidSecret);
      } else {
        console.log(`Error: Missing password hash in database object.`);
      }
    } else {
      console.log(`Flow: Driver (ID)`);
      // Bulletproof check for driver ID queries
      user = await prisma.user.findFirst({
        where: { OR: [{ driverId: identifier }, { driver_id_string: identifier }] }
      });
      
      const dbPinHash = user?.pinHash || user?.pin_hash;
      if (user && dbPinHash) {
        isValidSecret = await bcrypt.compare(secret, dbPinHash);
      }
    }

    if (!user || !isValidSecret) {
      console.log(`Result: Denied (Invalid Credentials)`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const isActive = user.isActive !== undefined ? user.isActive : user.is_active;
    if (!isActive) {
      return res.status(403).json({ error: 'Account is deactivated. Contact Admin.' });
    }

    console.log(`Result: Success! Generating token...`);
    
    const tokenPayload = {
      id: user.id,
      role: user.role,
      name: user.name,
      driverId: user.driverId || user.driver_id_string
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '12h' });

    // Inside src/controllers/auth.controller.js (or similar)

res.cookie('token', token, {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: 24 * 60 * 60 * 1000
});

return res.status(200).json({ message: 'Login successful', user: tokenPayload, token });

  } catch (error) {
    console.error('[Auth Error]', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
};

export const logout = (req, res) => {
  res.clearCookie('token');
  return res.status(200).json({ message: 'Logged out successfully' });
};