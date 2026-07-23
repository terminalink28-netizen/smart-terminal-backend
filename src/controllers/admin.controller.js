import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { signVanQrToken } from '../utils/qr.util.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Dashboard Stats ───
export const getSystemStats = async (req, res) => {
  try {
    const [totalUsers, totalVans, totalTrips, activeTrips] = await Promise.all([
      prisma.user.count(),
      prisma.van.count(),
      prisma.trip.count(),
      prisma.trip.count({
        where: { status: { in: ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING'] } }
      })
    ]);

    const staff = await prisma.user.findMany({
      select: { id: true, name: true, email: true, driverId: true, role: true, isActive: true }
    });

    const fleet = await prisma.van.findMany({
  orderBy: { plateNumber: 'asc' }
});

// Attach each van's permanent scan token so the admin table can show
// a "View QR" action for any van, not just newly-created ones.
const fleetWithQr = fleet.map((van) => ({
  ...van,
  qrToken: signVanQrToken(van.id),
}));

return res.status(200).json({
  stats: { totalUsers, totalVans, totalTrips, activeTrips },
  staff,
  fleet: fleetWithQr, // <-- changed from `fleet`
});
  } catch (error) {
    console.error('[Admin Stats Error]', error);
    return res.status(500).json({ error: 'Failed to fetch system stats.' });
  }
};

// ─── Staff Management ───
export const createUser = async (req, res) => {
  try {
    const { name, email, role, driverId, password } = req.body;
    
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        role,
        email: role !== 'DRIVER' ? email : null,
        driverId: role === 'DRIVER' ? driverId : null,
        passwordHash: role !== 'DRIVER' ? hashedPassword : null,
        pinHash: role === 'DRIVER' ? hashedPassword : null,
        isActive: true
      }
    });

    return res.status(201).json(newUser);
  } catch (error) {
    console.error('[Create User Error]', error);
    return res.status(500).json({ error: 'Failed to create user. Email or Driver ID may already exist.' });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, driverId, isActive } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(driverId && { driverId }),
        ...(isActive !== undefined && { isActive })
      },
      select: { id: true, name: true, email: true, driverId: true, role: true, isActive: true }
    });

    return res.status(200).json(updatedUser);
  } catch (error) {
    console.error('[Update User Error]', error);
    return res.status(500).json({ error: 'Failed to update user.' });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.user.delete({ where: { id } });
    return res.status(200).json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('[Delete User Error]', error);
    return res.status(500).json({ error: 'Cannot delete this user. They may be tied to existing trips.' });
  }
};

// ─── Fleet & Driver Combined Management ───
export const createVan = async (req, res) => {
  try {
    const { plateNumber, capacity, status, driverName, driverPin } = req.body;
    
    if (driverName && driverPin) {
      const hashedPassword = await bcrypt.hash(driverPin, 10);
      
      const { van, driver } = await prisma.$transaction(async (tx) => {
        const newVan = await tx.van.create({
          data: { plateNumber, capacity, status }
        });
        
        const newDriver = await tx.user.create({
          data: {
            name: driverName,
            role: 'DRIVER',
            driverId: plateNumber,
            pinHash: hashedPassword,
            passwordHash: hashedPassword,
            isActive: true
          }
        });

        return { van: newVan, driver: newDriver };
      });

      return res.status(201).json({
        ...van,
        qrToken: signVanQrToken(van.id), // <-- new: permanent scan token for this van
        driver: {
          id: driver.id,
          name: driver.name,
          driverId: driver.driverId,
          role: driver.role,
          isActive: driver.isActive,
        },
      });
    } 
    
    const newVan = await prisma.van.create({
      data: { plateNumber, capacity, status }
    });
    return res.status(201).json({
      ...newVan,
      qrToken: signVanQrToken(newVan.id), // <-- new
    });
    
  } catch (error) {
    console.error('[Create Van Error]', error);
    return res.status(500).json({ error: 'Failed to register fleet unit. The Plate Number may already exist in the database.' });
  }
};

export const updateVan = async (req, res) => {
  try {
    const { id } = req.params;
    const { plateNumber, capacity, status } = req.body;
    const updatedVan = await prisma.van.update({
      where: { id },
      data: { plateNumber, capacity, status }
    });
    return res.status(200).json(updatedVan);
  } catch (error) {
    console.error('[Update Van Error]', error);
    return res.status(500).json({ error: 'Failed to update van.' });
  }
};

export const deleteVan = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.van.delete({ where: { id } });
    return res.status(200).json({ message: 'Van deleted successfully.' });
  } catch (error) {
    console.error('[Delete Van Error]', error);
    return res.status(500).json({ error: 'Cannot delete this van. It is tied to existing trips.' });
  }
};

// ─── Audit Trail ───
export const getAuditLogs = async (req, res) => {
  try {
    return res.status(200).json({ logs: [] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load audit logs.' });
  }
};