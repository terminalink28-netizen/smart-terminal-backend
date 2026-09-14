import { PrismaClient, Prisma } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { verifyVanQrToken, signVanQrToken } from '../utils/qr.util.js';

const pool    = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ─── State machine ────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
  SCHEDULED:  ['BOARDING', 'CANCELLED', 'DELAYED'],
  BOARDING:   ['DEPARTING', 'DELAYED'],
  DEPARTING:  ['DEPARTED', 'DELAYED'],
  DEPARTED:   ['ARRIVING', 'DELAYED'],
  ARRIVING:   ['COMPLETED', 'DELAYED'],
  DELAYED:    ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'COMPLETED'],
  COMPLETED:  [],
  CANCELLED:  [],
};

const ALL_STATUSES = Object.keys(VALID_TRANSITIONS);

// Statuses that mean a driver/van is already actively on a trip
const ACTIVE_STATUSES = ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];

const TRIP_INCLUDE = {
  driver: { select: { id: true, name: true } },
  route:  true,
  van:    true,
};

// Maps a van's CURRENT trip status to the action a QR scan performs.
// This is what makes a single printed sticker on the van work correctly
// at every checkpoint — the backend derives the right transition from
// whatever state the trip is actually in; the scanner just scans.
const SCAN_TRANSITIONS = {
  DEPARTING: { nextStatus: 'DEPARTED',  action: 'DEPARTURE',  setField: 'actualDeparture' },
  DEPARTED:  { nextStatus: 'ARRIVING',  action: 'ARRIVAL',    setField: 'actualArrival'   },
  DELAYED:   { nextStatus: 'ARRIVING',  action: 'ARRIVAL',    setField: 'actualArrival'   },
  ARRIVING:  { nextStatus: 'COMPLETED', action: 'COMPLETION', setField: null              },
};

// ─── Small helpers ─────────────────────────────────────────────────────────────

/** A handled, "expected" error that should map to a 4xx response with a safe message. */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Attaches this trip's van QR token to driver-facing trip responses, so the
 * frontend can render a scannable code (e.g. for trip completion) without a
 * separate round-trip. The token is a pure function of the van's id — no
 * extra DB lookup, and safe to regenerate on every response.
 *
 * Deliberately NOT applied to public/dispatcher-facing endpoints like
 * getLiveTrips — that route has no auth at all, and leaking this token
 * there would let anyone advance a trip's status without scanning anything.
 */
function withVanQrToken(trip) {
  if (!trip?.van?.id) return trip;
  return { ...trip, van: { ...trip.van, qrToken: signVanQrToken(trip.van.id) } };
}

/**
 * Broadcast a real-time fleet/trip update over Socket.IO, if an io instance is
 * registered on the Express app (e.g. `app.set('io', io)` at startup).
 * Never throws — a missing socket layer should not fail the HTTP request.
 */
function emitFleetEvent(req, event, payload) {
  try {
    const io = req.app?.get?.('io');
    if (!io) return;
    io.emit(event, payload);
  } catch (err) {
    console.error(`[socket emit:${event}]`, err);
  }
}

/** Centralised error responder: known HttpErrors get their message, everything else is generic. */
function handleError(res, error, context, fallbackMessage = 'Internal server error.') {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error(`[${context}]`, error);
  return res.status(500).json({ error: fallbackMessage });
}

// ─── 0. Dispatcher: vans currently AT the terminal ────────────────────────────
//
// "At the terminal" means: IDLE (parked, no active trip — just completed one
// or never started one) OR BOARDING (assigned a route, still loading
// passengers on-site). The moment a van's trip moves to DEPARTING or beyond,
// it has physically left, so it drops out of this list entirely.
//
// A van's driver is now resolved via the real Van.driver relation
// (User.assignedVanId), not string-matching driverId to plateNumber.

export const getTerminalVans = async (req, res) => {
  try {
    const [idleVans, boardingTrips] = await Promise.all([
      prisma.van.findMany({
        where: { status: 'IDLE' },
        include: { driver: { select: { id: true, name: true } } },
        orderBy: { plateNumber: 'asc' },
      }),
      prisma.trip.findMany({
        where: { status: 'BOARDING' },
        include: TRIP_INCLUDE,
        orderBy: { id: 'desc' },
      }),
    ]);

    const idleEntries = idleVans.map((van) => ({
      vanId: van.id,
      plateNumber: van.plateNumber,
      capacity: van.capacity,
      terminalStatus: 'IDLE',
      driver: van.driver ?? null,
      trip: null,
    }));

    const boardingEntries = boardingTrips.map((trip) => ({
      vanId: trip.van.id,
      plateNumber: trip.van.plateNumber,
      capacity: trip.van.capacity,
      terminalStatus: 'BOARDING',
      driver: trip.driver,
      trip: {
        id: trip.id,
        routeName: trip.route?.name ?? null,
        origin: trip.route?.origin ?? null,
        destination: trip.route?.destination ?? null,
        scheduledTime: trip.scheduledTime,
      },
    }));

    return res.status(200).json([...boardingEntries, ...idleEntries]);
  } catch (error) {
    return handleError(res, error, 'getTerminalVans', 'Failed to load vans at the terminal.');
  }
};


// ─── 1. Update trip status ────────────────────────────────────────────────────

export const updateTripStatus = async (req, res) => {
  try {
    const { id }        = req.params;
    const { newStatus } = req.body;
    const userId        = req.user.id;

    const updatedTrip = await prisma.$transaction(async (tx) => {
      const trip = await tx.trip.findUnique({ where: { id } });
      if (!trip) throw new HttpError(404, 'Trip not found.');

      const allowed = VALID_TRANSITIONS[trip.status] ?? [];
      if (!allowed.includes(newStatus)) {
        throw new HttpError(
          400,
          `Invalid transition. Cannot move from ${trip.status} to ${newStatus}.`,
        );
      }

      const updated = await tx.trip.update({
        where:   { id },
        data:    { status: newStatus },
        include: TRIP_INCLUDE,
      });

      await tx.tripStatusHistory.create({
        data: { tripId: id, status: newStatus, recordedById: userId },
      });

      // If the trip is over, release the van so it can be dispatched again
      if (newStatus === 'COMPLETED' || newStatus === 'CANCELLED') {
        await tx.van.update({
          where: { id: trip.vanId },
          data:  { status: 'IDLE' },
        });
      }

      return updated;
    });

    emitFleetEvent(req, 'trip_status_changed', {
      tripId: updatedTrip.id,
      status: updatedTrip.status,
      trip:   updatedTrip,
    });

    return res.status(200).json({ message: 'Status updated', trip: withVanQrToken(updatedTrip) });
  } catch (error) {
    return handleError(res, error, 'updateTripStatus', 'Failed to update trip status.');
  }
};

// ─── 2. QR scan handler ───────────────────────────────────────────────────────
//
// Scans a signed, permanent van QR token (issued once at van creation —
// see admin.controller.js's createVan / getVanQrToken). No tripId or
// action is ever trusted from the client: the token only identifies the
// van, and the backend looks up that van's CURRENT active trip to decide
// what a scan should do. This means one printed sticker on the van works
// correctly at every checkpoint of every future trip, and a scan can
// never be used to force an arbitrary status transition.

export const handleQrScan = async (req, res) => {
  try {
    const { qrToken } = req.body;
    const userId = req.user.id;

    if (!qrToken) {
      return res.status(400).json({ error: 'qrToken is required.' });
    }

    const vanId = verifyVanQrToken(qrToken);
    if (!vanId) {
      return res.status(400).json({ error: 'Invalid or unrecognized QR code.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const van = await tx.van.findUnique({ where: { id: vanId } });
      if (!van) throw new HttpError(404, 'This QR code refers to a van that no longer exists.');

      const trip = await tx.trip.findFirst({
        where: { vanId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        orderBy: { id: 'desc' },
      });

      if (!trip) {
        throw new HttpError(400, `${van.plateNumber} has no active trip right now.`);
      }

      if (trip.status === 'BOARDING') {
        throw new HttpError(
          400,
          `${van.plateNumber} is still boarding — the driver needs to mark "I've Departed" first before this scan can advance it.`,
        );
      }

      const transition = SCAN_TRANSITIONS[trip.status];
      if (!transition) {
        throw new HttpError(400, `${van.plateNumber} is in an unexpected state (${trip.status}) and can't be advanced by scan.`);
      }

      const updateData = { status: transition.nextStatus };
      if (transition.setField) updateData[transition.setField] = new Date();

      const updatedTrip = await tx.trip.update({
        where: { id: trip.id },
        data: updateData,
        include: TRIP_INCLUDE,
      });

      await tx.tripStatusHistory.create({
        data: { tripId: trip.id, status: transition.nextStatus, recordedById: userId },
      });

      await tx.qrScanLog.create({
        data: { tripId: trip.id, vanId, scannedById: userId, action: transition.action },
      });

      // Once the trip is fully wrapped up, release the van so it can be
      // assigned to a new trip again.
      if (transition.nextStatus === 'COMPLETED') {
        await tx.van.update({ where: { id: vanId }, data: { status: 'IDLE' } });
      }

      return { trip: updatedTrip, action: transition.action };
    });

    emitFleetEvent(req, 'trip_status_changed', {
      tripId: result.trip.id,
      status: result.trip.status,
      trip:   result.trip,
    });

    return res.status(200).json({
      message: `${result.trip.van?.plateNumber ?? 'Van'} → ${result.trip.status}`,
      trip: result.trip,
      action: result.action,
    });
  } catch (error) {
    return handleError(res, error, 'handleQrScan', 'Failed to process QR scan.');
  }
};

// ─── 3. Fetch driver's own active trips ───────────────────────────────────────

export const getMyTrips = async (req, res) => {
  try {
    const driverId = req.user.id;

    const trips = await prisma.trip.findMany({
      where: {
        driverId,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      include: TRIP_INCLUDE,
      orderBy: {
        id: 'desc',
      },
    });

    return res.status(200).json(trips.map(withVanQrToken));
  } catch (error) {
    return handleError(res, error, 'getMyTrips', 'Failed to fetch assigned trips.');
  }
};

// ─── 4. Driver self-starts their own trip ────────────────────────────────────
//
// The driver's van is now resolved via the real assignedVan relation
// instead of matching driverId text against Van.plateNumber — a typo or
// formatting drift can no longer silently orphan a driver from their van.

export const selfStartTrip = async (req, res) => {
  try {
    const { origin, destination, routeName } = req.body;

    if (!origin || !destination || !routeName) {
      return res.status(400).json({ error: 'origin, destination, and routeName are all required.' });
    }

    const driverUserId = req.user.id;

    const driverWithVan = await prisma.user.findUnique({
      where: { id: driverUserId },
      include: { assignedVan: true },
    });

    if (!driverWithVan?.assignedVan) {
      return res.status(400).json({
        error: 'Your account is not assigned to a van. Contact the dispatcher.',
      });
    }

    const van = driverWithVan.assignedVan;

    if (van.status !== 'IDLE') {
      return res.status(400).json({
        error: `Van ${van.plateNumber} is currently in use. Contact the dispatcher.`,
      });
    }

    const newTrip = await prisma.$transaction(async (tx) => {
      const existingTrip = await tx.trip.findFirst({
        where: {
          driverId: driverUserId,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      });

      if (existingTrip) {
        throw new HttpError(400, 'You already have an active trip. Please complete it first.');
      }

      const vanClaim = await tx.van.updateMany({
        where: { id: van.id, status: 'IDLE' },
        data:  { status: 'ON_TRIP' },
      });

      if (vanClaim.count === 0) {
        throw new HttpError(400, `Van ${van.plateNumber} is currently in use. Contact the dispatcher.`);
      }

      let route = await tx.route.findFirst({ where: { name: routeName } });

      if (!route) {
        try {
          route = await tx.route.create({
            data: { name: routeName, origin, destination },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            route = await tx.route.findFirst({ where: { name: routeName } });
          } else {
            throw err;
          }
        }
      }

      if (!route) {
        throw new HttpError(500, 'Failed to resolve route for this trip.');
      }

      return tx.trip.create({
        data: {
          routeId: route.id,
          vanId: van.id,
          driverId: driverUserId,
          status: 'BOARDING',
          scheduledTime: new Date(),
        },
        include: TRIP_INCLUDE,
      });
    });

    emitFleetEvent(req, 'trip_dispatched', { trip: newTrip });
    emitFleetEvent(req, 'trip_status_changed', {
      tripId: newTrip.id,
      status: newTrip.status,
      trip:   newTrip,
    });

    return res.status(201).json(withVanQrToken(newTrip));
  } catch (error) {
    return handleError(res, error, 'selfStartTrip', 'An unexpected error occurred while starting your trip. Please try again.');
  }
};

// ─── 5. Dispatcher: fetch available resources ─────────────────────────────────

export const getDispatchResources = async (req, res) => {
  try {
    const [routes, vans, drivers] = await Promise.all([
      prisma.route.findMany({ orderBy: { name: 'asc' } }),
      prisma.van.findMany({ where: { status: 'IDLE' } }),
      prisma.user.findMany({ where: { role: 'DRIVER', isActive: true } }),
    ]);
    return res.status(200).json({ routes, vans, drivers });
  } catch (error) {
    return handleError(res, error, 'getDispatchResources', 'Failed to load dispatch resources.');
  }
};

// ─── 6. Dispatcher: create trip (assigns specific van + driver) ───────────────

export const createTrip = async (req, res) => {
  try {
    const { routeId, vanId, driverId } = req.body;

    if (!routeId || !vanId || !driverId) {
      return res.status(400).json({ error: 'routeId, vanId, and driverId are all required.' });
    }

    const trip = await prisma.$transaction(async (tx) => {
      // Atomically claim the van: only succeeds if it's still IDLE, closing
      // the race window where two dispatches target the same van at once.
      const vanClaim = await tx.van.updateMany({
        where: { id: vanId, status: 'IDLE' },
        data:  { status: 'ON_TRIP' },
      });

      if (vanClaim.count === 0) {
        throw new HttpError(400, 'Dispatch failed: this van is already in use.');
      }

      const driverActiveTrip = await tx.trip.findFirst({
        where: { driverId, status: { in: ACTIVE_STATUSES } },
      });

      if (driverActiveTrip) {
        throw new HttpError(400, 'Dispatch failed: this driver is currently on duty.');
      }

      const route = await tx.route.findUnique({ where: { id: routeId } });
      if (!route) {
        throw new HttpError(400, 'Dispatch failed: route not found.');
      }

      return tx.trip.create({
        data: { routeId, vanId, driverId, status: 'BOARDING', scheduledTime: new Date() },
        include: TRIP_INCLUDE,
      });
    });

    emitFleetEvent(req, 'trip_dispatched', { trip });
    emitFleetEvent(req, 'trip_status_changed', {
      tripId: trip.id,
      status: trip.status,
      trip,
    });

    return res.status(201).json({ message: 'Trip successfully dispatched!', trip });
  } catch (error) {
    return handleError(res, error, 'createTrip', 'Failed to dispatch trip.');
  }
};

// ─── 7. Fetch all active live trips (Public & Dispatcher) ─────────────────────

export const getLiveTrips = async (req, res) => {
  try {
    const activeTrips = await prisma.trip.findMany({
      where: {
        status: { notIn: ['COMPLETED', 'CANCELLED'] }
      },
      include: {
        driver: { select: { id: true, name: true } },
        route: true,
        van: true
      },
      orderBy: { id: 'desc' } // Make sure this matches your schema (id instead of createdAt)
    });

    return res.status(200).json(activeTrips);
  } catch (error) {
    console.error('[getLiveTrips]', error);
    return res.status(500).json({ error: 'Failed to fetch live dispatch data.' });
  }
};
