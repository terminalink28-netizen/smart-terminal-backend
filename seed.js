import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Using your exact Prisma 7 + PG Adapter configuration
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seedUsers() {
  try {
    const passwordHash = await bcrypt.hash('password123', 10);
    const pinHash = await bcrypt.hash('1234', 10);

    console.log('Seeding database via Prisma...');

    // upsert is perfect for seeding: it creates the user, or does nothing if they already exist
    const dispatcher = await prisma.user.upsert({
      where: { email: 'dispatcher@coop.com' },
      update: {}, 
      create: {
        name: 'Terminal Dispatcher',
        email: 'dispatcher@coop.com',
        role: 'DISPATCHER', // <-- Changed to uppercase
        isActive: true,
        passwordHash: passwordHash, 
      },
    });

    const driver1 = await prisma.user.upsert({
      where: { email: 'driver01@coop.com' },
      update: {},
      create: {
        name: 'Van 01 Driver',
        email: 'driver01@coop.com',
        role: 'DRIVER', // <-- Changed to uppercase
        isActive: true,
        passwordHash: passwordHash,
        driverId: 'VAN-001',
        pinHash: pinHash,
      },
    });

    const driver2 = await prisma.user.upsert({
      where: { email: 'driver02@coop.com' },
      update: {},
      create: {
        name: 'Van 02 Driver',
        email: 'driver02@coop.com',
        role: 'DRIVER', // <-- Changed to uppercase
        isActive: true,
        passwordHash: passwordHash,
        driverId: 'VAN-002',
        pinHash: pinHash,
      },
    });

    console.log('✅ Test accounts successfully seeded!');
    console.log(`Created: ${dispatcher.email}, ${driver1.email}, ${driver2.email}`);
// --- Admin Account ---
    const admin = await prisma.user.upsert({
      where: { email: 'admin@coop.com' },
      update: {}, 
      create: {
        name: 'System Admin',
        email: 'admin@coop.com',
        role: 'ADMIN', // Strict uppercase matching your Prisma Enum
        isActive: true,
        passwordHash: passwordHash, 
      },
    });
  } catch (err) {
    console.error('❌ Error seeding data:', err);
  } finally {
    await prisma.$disconnect();
  }
}

seedUsers();