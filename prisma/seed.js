import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🧹 Wiping old dummy data from the database...');
  
  // ADD THESE THREE LINES TO DELETE THE GHOST DATA
  await prisma.trip.deleteMany({}); 
  await prisma.route.deleteMany({});
  await prisma.van.deleteMany({});

  // ... the rest of the script stays exactly the same ...
  console.log('🌴 Seeding PRODUCTION Catanduanes Data...');

  // 1. Staff Credentials
  const adminPass = await bcrypt.hash('admin123', 10);
  const dispatchPass = await bcrypt.hash('dispatch123', 10);
  const driverPin = await bcrypt.hash('1234', 10);

  await prisma.user.upsert({
    where: { email: 'admin@viracterminal.com' },
    update: {}, create: { role: 'ADMIN', name: 'Catanduanes Admin', email: 'admin@viracterminal.com', passwordHash: adminPass, isActive: true }
  });

  await prisma.user.upsert({
    where: { email: 'dispatch@viracterminal.com' },
    update: {}, create: { role: 'DISPATCHER', name: 'Virac Dispatcher', email: 'dispatch@viracterminal.com', passwordHash: dispatchPass, isActive: true }
  });

  await prisma.user.upsert({
    where: { driverId: 'DRV-VIRAC-01' },
    update: {}, create: { role: 'DRIVER', name: 'Juan Dela Cruz', driverId: 'DRV-VIRAC-01', pinHash: driverPin, isActive: true }
  });

  // 2. The Real Catanduanes Routes
  const viracOrigin = 'Virac Central Terminal (H6J9+RP7)';
  const municipalities = ['Bagamanoc', 'Baras', 'Bato', 'Caramoran', 'Gigmoto', 'Pandan', 'Panganiban', 'San Andres', 'San Miguel', 'Viga'];

  console.log('🛣️ Establishing Hub-and-Spoke Routes...');
  for (const town of municipalities) {
    const exists = await prisma.route.findFirst({ where: { destination: `${town} Terminal` }});
    if (!exists) {
      await prisma.route.create({ data: { name: `Virac to ${town}`, origin: viracOrigin, destination: `${town} Terminal` }});
    }
  }

  // 3. Register the Fleet (Clean Slate, no active trips)
  await prisma.van.upsert({
    where: { plateNumber: 'VIR-001' },
    update: { status: 'IDLE' }, // Force idle in production
    create: { plateNumber: 'VIR-001', capacity: 14, status: 'IDLE' }
  });

  await prisma.van.upsert({
    where: { plateNumber: 'VIR-002' },
    update: { status: 'IDLE' },
    create: { plateNumber: 'VIR-002', capacity: 14, status: 'IDLE' }
  });

  console.log('✅ PRODUCTION Database is ready and clean!');
  console.log('--------------------------------------------------');
  console.log(`To start operations, log in as Dispatcher and schedule a trip.`);
  console.log('--------------------------------------------------');
}

main().catch(console.error).finally(() => prisma.$disconnect());