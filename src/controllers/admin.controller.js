// src/controllers/admin.controller.js
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { signVanQrToken } from '../utils/qr.util.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const ACTIVE_TRIP_STATUSES = ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'QUEUED', 'DELAYED'];
const VALID_ROLES = ['ADMIN', 'DISPATCHER', 'DRIVER'];

const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 5000; // the CSV export asks for the max

// A user as it is safe to send to the browser (never the hashes).
const SAFE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  driverId: true,
  contactNumber: true,
  role: true,
  isActive: true,
  approvalStatus: true,
  assignedVanId: true,
  assignedVan: { select: { id: true, plateNumber: true } },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendError(res, error, context, fallback, conflictMessage) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'That record no longer exists.' });
    if (error.code === 'P2002') {
      return res.status(409).json({ error: conflictMessage ?? 'That value is already in use.' });
    }
    if (error.code === 'P2003') {
      return res.status(409).json({ error: conflictMessage ?? 'This record is still in use by other data.' });
    }
  }
  console.error(`[${context}]`, error);
  return res.status(500).json({ error: fallback });
}

/**
 * Writes one audit entry for the signed-in admin. Never throws — an audit
 * failure must not undo or block the action that was just completed.
 * Exported so the auth and trip controllers can log through the same path.
 */
export async function writeAudit(req, { action, targetType, target, details }) {
  try {
    const actorId = req.user?.id ?? null;
    let actorName = req.user?.name ?? null;
    if (!actorName && actorId) {
      const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
      actorName = actor?.name ?? null;
    }
    await prisma.auditLog.create({
      data: {
        actorId,
        actorName: actorName ?? 'System',
        action,
        targetType: targetType ?? null,
        target: target ?? null,
        details: details ?? null,
      },
    });
  } catch (error) {
    console.error('[Audit Log Error]', error);
  }
}

// ─── Dashboard Stats ───

export const getSystemStats = async (req, res) => {
  try {
    const [totalUsers, totalVans, totalTrips, activeTrips, staff, fleet] = await Promise.all([
      prisma.user.count(),
      prisma.van.count(),
      prisma.trip.count(),
      prisma.trip.count({ where: { status: { in: ACTIVE_TRIP_STATUSES } } }),
      prisma.user.findMany({ select: SAFE_USER_SELECT, orderBy: { name: 'asc' } }),
      prisma.van.findMany({
        orderBy: { plateNumber: 'asc' },
        include: { driver: { select: { id: true, name: true } } },
      }),
    ]);

    // Every van's permanent scan token, so the admin table can show a QR for any van.
    const fleetWithQr = fleet.map((van) => ({ ...van, qrToken: signVanQrToken(van.id) }));

    return res.status(200).json({
      stats: { totalUsers, totalVans, totalTrips, activeTrips },
      staff,
      fleet: fleetWithQr,
    });
  } catch (error) {
    return sendError(res, error, 'Admin Stats Error', 'Failed to fetch system stats.');
  }
};

// ─── Staff Management ───

export const createUser = async (req, res) => {
  try {
    const { name, email, role, driverId, password, vanId } = req.body;

    if (!name?.trim() || !role || !password) {
      throw new HttpError(400, 'name, role and password are required.');
    }
    if (!VALID_ROLES.includes(role)) throw new HttpError(400, 'Invalid role.');
    if (role !== 'DRIVER' && !email?.trim()) throw new HttpError(400, 'Email address is required.');

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.$transaction(async (tx) => {
      // assignedVanId is unique; checking first gives a clean message instead of a raw P2002.
      if (role === 'DRIVER' && vanId) {
        const holder = await tx.user.findUnique({ where: { assignedVanId: vanId } });
        if (holder) throw new HttpError(400, `Van is already assigned to driver "${holder.name}".`);
      }

      return tx.user.create({
        data: {
          name: name.trim(),
          role,
          email: role !== 'DRIVER' ? email.trim() : null,
          driverId: role === 'DRIVER' ? driverId : null,
          assignedVanId: role === 'DRIVER' ? (vanId ?? null) : null,
          passwordHash: role !== 'DRIVER' ? hashedPassword : null,
          pinHash: role === 'DRIVER' ? hashedPassword : null,
          isActive: true,
        },
        select: SAFE_USER_SELECT,
      });
    });

    await writeAudit(req, {
      action: 'USER_CREATED',
      targetType: 'User',
      target: newUser.name,
      details: `Created a ${newUser.role.toLowerCase()} account${newUser.email ? ` (${newUser.email})` : ''}.`,
    });

    return res.status(201).json(newUser);
  } catch (error) {
    return sendError(
      res, error, 'Create User Error', 'Failed to create user.',
      'Email, Driver ID, or assigned van is already taken.',
    );
  }
};

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, driverId, isActive, vanId } = req.body;

    if (isActive === false && id === req.user?.id) {
      throw new HttpError(400, "You can't disable your own account.");
    }

    if (vanId !== undefined && vanId !== null) {
      const holder = await prisma.user.findUnique({ where: { assignedVanId: vanId } });
      if (holder && holder.id !== id) {
        throw new HttpError(400, `Van is already assigned to driver "${holder.name}".`);
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(driverId && { driverId }),
        ...(isActive !== undefined && { isActive }),
        ...(vanId !== undefined && { assignedVanId: vanId }), // vanId: null unassigns
      },
      select: SAFE_USER_SELECT,
    });

    const toggled = typeof isActive === 'boolean';
    await writeAudit(req, {
      action: toggled ? (isActive ? 'USER_ENABLED' : 'USER_DISABLED') : 'USER_UPDATED',
      targetType: 'User',
      target: updatedUser.name,
      details: toggled
        ? `${isActive ? 'Enabled' : 'Disabled'} the ${updatedUser.role.toLowerCase()} account.`
        : 'Updated account details.',
    });

    return res.status(200).json(updatedUser);
  } catch (error) {
    return sendError(res, error, 'Update User Error', 'Failed to update user.', 'Email or Driver ID is already taken.');
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, role: true },
    });
    if (!target) throw new HttpError(404, 'That user no longer exists.');

    if (id === req.user?.id) throw new HttpError(400, "You can't delete your own account.");

    if (target.role === 'ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (admins <= 1) throw new HttpError(400, 'This is the last admin account. Create another admin first.');
    }

    await prisma.user.delete({ where: { id } });

    await writeAudit(req, {
      action: 'USER_DELETED',
      targetType: 'User',
      target: target.name,
      details: `Deleted a ${target.role.toLowerCase()} account.`,
    });

    return res.status(200).json({ message: 'User deleted successfully.' });
  } catch (error) {
    return sendError(
      res, error, 'Delete User Error', 'Failed to delete this user.',
      'Cannot delete this user. They are tied to existing trips. Disable the account instead.',
    );
  }
};

// ─── Fleet & Driver Combined Management ───

export const createVan = async (req, res) => {
  try {
    const { plateNumber, capacity, status, driverName, driverPin } = req.body;

    if (driverName && driverPin) {
      const hashedPassword = await bcrypt.hash(driverPin, 10);

      const { van, driver } = await prisma.$transaction(async (tx) => {
        const newVan = await tx.van.create({ data: { plateNumber, capacity, status } });
        const newDriver = await tx.user.create({
          data: {
            name: driverName,
            role: 'DRIVER',
            driverId: plateNumber,
            assignedVanId: newVan.id,
            pinHash: hashedPassword,
            passwordHash: hashedPassword,
            isActive: true,
          },
        });
        return { van: newVan, driver: newDriver };
      });

      await writeAudit(req, {
        action: 'VAN_CREATED',
        targetType: 'Van',
        target: van.plateNumber,
        details: `Registered with driver ${driver.name}.`,
      });

      return res.status(201).json({
        ...van,
        qrToken: signVanQrToken(van.id),
        driver: { id: driver.id, name: driver.name, driverId: driver.driverId, role: driver.role, isActive: driver.isActive },
      });
    }

    const newVan = await prisma.van.create({ data: { plateNumber, capacity, status } });
    await writeAudit(req, { action: 'VAN_CREATED', targetType: 'Van', target: newVan.plateNumber, details: 'Registered a van.' });
    return res.status(201).json({ ...newVan, qrToken: signVanQrToken(newVan.id) });
  } catch (error) {
    return sendError(res, error, 'Create Van Error', 'Failed to register the van.', 'That plate number is already registered.');
  }
};

export const updateVan = async (req, res) => {
  try {
    const { id } = req.params;
    const { plateNumber, capacity, status } = req.body;
    const updatedVan = await prisma.van.update({ where: { id }, data: { plateNumber, capacity, status } });

    await writeAudit(req, {
      action: 'VAN_UPDATED',
      targetType: 'Van',
      target: updatedVan.plateNumber,
      details: `Status ${updatedVan.status}, capacity ${updatedVan.capacity}.`,
    });

    return res.status(200).json(updatedVan);
  } catch (error) {
    return sendError(res, error, 'Update Van Error', 'Failed to update van.', 'That plate number is already registered.');
  }
};

export const deleteVan = async (req, res) => {
  try {
    const { id } = req.params;

    const van = await prisma.van.findUnique({ where: { id }, select: { id: true, plateNumber: true } });
    if (!van) throw new HttpError(404, 'That van no longer exists.');

    await prisma.van.delete({ where: { id } });

    await writeAudit(req, { action: 'VAN_DELETED', targetType: 'Van', target: van.plateNumber, details: 'Removed the van.' });

    return res.status(200).json({ message: 'Van deleted successfully.' });
  } catch (error) {
    return sendError(
      res, error, 'Delete Van Error', 'Failed to delete this van.',
      'Cannot delete this van. It is assigned to a driver or tied to existing trips.',
    );
  }
};

// ─── Audit Trail ───
//
// GET /admin/audit-logs
//   ?search=   matches actor, action, target type, target or details
//   &action=   exact action, e.g. USER_CREATED
//   &from=&to= ISO timestamps
//   &cursor=   id of the last row of the previous page
//   &limit=    default 50, max 5000 (the CSV export uses the max)
//
// Returns { logs, nextCursor, total, actions }. `total` and `actions` are only
// computed on the first page (no cursor).

export const getAuditLogs = async (req, res) => {
  try {
    const { search, action, from, to, cursor } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || AUDIT_DEFAULT_LIMIT, 1), AUDIT_MAX_LIMIT);

    const where = {};
    if (action) where.action = String(action);

    const range = {};
    const fromDate = from ? new Date(String(from)) : null;
    const toDate = to ? new Date(String(to)) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime())) range.gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) range.lte = toDate;
    if (Object.keys(range).length > 0) where.timestamp = range;

    const q = typeof search === 'string' ? search.trim() : '';
    if (q) {
      where.OR = ['actorName', 'action', 'targetType', 'target', 'details'].map((field) => ({
        [field]: { contains: q, mode: 'insensitive' },
      }));
    }

    const isFirstPage = !cursor;

    const [rows, total, actionRows] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
      }),
      isFirstPage ? prisma.auditLog.count({ where }) : Promise.resolve(null),
      isFirstPage
        ? prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } })
        : Promise.resolve(null),
    ]);

    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;

    return res.status(200).json({
      logs,
      nextCursor: hasMore ? logs[logs.length - 1].id : null,
      ...(total !== null ? { total } : {}),
      ...(actionRows ? { actions: actionRows.map((r) => r.action) } : {}),
    });
  } catch (error) {
    return sendError(res, error, 'Get Audit Logs Error', 'Failed to load audit logs.');
  }
};

// ─── Driver applications ───

export const getPendingDrivers = async (req, res) => {
  try {
    const pending = await prisma.user.findMany({
      where: { role: 'DRIVER', approvalStatus: 'PENDING' },
      select: {
        id: true,
        name: true,
        driverId: true,
        contactNumber: true,
        licensePhotoUrl: true,
        createdAt: true,
        assignedVan: { select: { id: true, plateNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return res.status(200).json(pending);
  } catch (error) {
    return sendError(res, error, 'Get Pending Drivers Error', 'Failed to load pending driver applications.');
  }
};

export const approveDriver = async (req, res) => {
  try {
    const existing = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, role: true },
    });
    if (!existing || existing.role !== 'DRIVER') throw new HttpError(404, 'Driver not found.');

    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: { approvalStatus: 'APPROVED', rejectionReason: null },
      select: { id: true, name: true, driverId: true, approvalStatus: true },
    });

    await writeAudit(req, {
      action: 'DRIVER_APPROVED',
      targetType: 'Driver',
      target: updated.name,
      details: `Approved driver application${updated.driverId ? ` (ID ${updated.driverId})` : ''}.`,
    });

    return res.status(200).json({ message: `${updated.name} approved.`, driver: updated });
  } catch (error) {
    return sendError(res, error, 'Approve Driver Error', 'Failed to approve driver.');
  }
};

export const rejectDriver = async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    const result = await prisma.$transaction(async (tx) => {
      const driver = await tx.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, driverId: true, assignedVanId: true },
      });
      if (!driver) throw new HttpError(404, 'Driver not found.');

      // Detach the van first: User.assignedVanId points at it, so deleting
      // the van while it is still referenced would violate the foreign key.
      const updated = await tx.user.update({
        where: { id: driver.id },
        data: {
          approvalStatus: 'REJECTED',
          isActive: false,
          rejectionReason: reason || null,
          assignedVanId: null,
        },
        select: { id: true, name: true, driverId: true, approvalStatus: true },
      });

      // The van was created only for this application; with no driver
      // attached it has no purpose, so remove it.
      if (driver.assignedVanId) {
        await tx.van.delete({ where: { id: driver.assignedVanId } });
      }

      return updated;
    });

    await writeAudit(req, {
      action: 'DRIVER_REJECTED',
      targetType: 'Driver',
      target: result.name,
      details: reason ? `Rejected application. Reason: ${reason}` : 'Rejected application.',
    });

    return res.status(200).json({ message: `${result.name} rejected.`, driver: result });
  } catch (error) {
    return sendError(res, error, 'Reject Driver Error', 'Failed to reject driver.');
  }
};
