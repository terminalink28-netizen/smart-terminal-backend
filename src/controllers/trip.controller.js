import { PrismaClient, Prisma } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

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

// ─── Small helpers ─────────────────────────────────────────────────────────────

/** A handled, "expected" error that should map to a 4xx response with a safe message. */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
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

// ─── 1. Update trip status ────────────────────────────────────────────────────

export const updateTripStatus = async (req, res) => {
  try {
    const { id }        = req.params;
    const { newStatus } = req.body;
    const userId        = req.user.id;

    if (
  newStatus === 'COMPLETED' ||
  newStatus === 'CANCELLED'
) {
  liveLocations.delete(updatedTrip.id);
}

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

    return res.status(200).json({ message: 'Status updated', trip: updatedTrip });
  } catch (error) {
    return handleError(res, error, 'updateTripStatus', 'Failed to update trip status.');
  }
};

// ─── 2. QR scan handler ───────────────────────────────────────────────────────

export const handleQrScan = async (req, res) => {
  try {
    const { tripId, vanId, action } = req.body;
    const userId = req.user.id;

    if (!tripId || !vanId || !action) {
      return res.status(400).json({ error: 'tripId, vanId, and action are all required.' });
    }

    if (action !== 'DEPARTURE' && action !== 'ARRIVAL') {
      return res.status(400).json({ error: 'Unknown QR action.' });
    }

    const updatedTrip = await prisma.$transaction(async (tx) => {
      const trip = await tx.trip.findUnique({ where: { id: tripId } });
      if (!trip) throw new HttpError(404, 'Trip not found.');

      // Guard against scanning a QR code belonging to a different van
      if (trip.vanId !== vanId) {
        throw new HttpError(400, 'This QR code does not match the van assigned to this trip.');
      }

      let targetStatus;
      if (action === 'DEPARTURE') {
        if (trip.status !== 'DEPARTING') {
          throw new HttpError(400, 'Trip is not ready for departure.');
        }
        targetStatus = 'DEPARTED';
      } else {
        // ARRIVAL
        if (trip.status !== 'DEPARTED' && trip.status !== 'DELAYED') {
          throw new HttpError(400, 'Trip has not departed yet.');
        }
        targetStatus = 'ARRIVING';
      }

      await tx.qrScanLog.create({
        data: { tripId, vanId, scannedById: userId, action },
      });

      const updated = await tx.trip.update({
        where: { id: tripId },
        data: {
          status: targetStatus,
          ...(action === 'DEPARTURE' ? { actualDeparture: new Date() } : {}),
          ...(action === 'ARRIVAL'   ? { actualArrival:   new Date() } : {}),
        },
        include: TRIP_INCLUDE,
      });

      await tx.tripStatusHistory.create({
        data: { tripId, status: targetStatus, recordedById: userId },
      });

      return updated;
    });

    emitFleetEvent(req, 'trip_status_changed', {
      tripId: updatedTrip.id,
      status: updatedTrip.status,
      trip:   updatedTrip,
    });

    return res.status(200).json({ message: `QR ${action} successful.`, trip: updatedTrip });
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

    return res.status(200).json(trips);
  } catch (error) {
    return handleError(res, error, 'getMyTrips', 'Failed to fetch assigned trips.');
  }
};

// ─── 4. Driver self-starts their own trip ────────────────────────────────────

export const selfStartTrip = async (req, res) => {
  try {
    const { origin, destination, routeName } = req.body;

    if (!origin || !destination || !routeName) {
      return res.status(400).json({ error: 'origin, destination, and routeName are all required.' });
    }

    // UUID mapped for the Trip table relation
    const driverUserId = req.user.id;
    // String mapped for the Van table search (e.g., 'VAN-001')
    const vanPlateNumber = req.user.driverId;

    if (!vanPlateNumber) {
      return res.status(400).json({
        error: 'Your account is not assigned to a specific van plate number. Contact the dispatcher.',
      });
    }

    const van = await prisma.van.findFirst({
      where: { plateNumber: vanPlateNumber },
    });

    if (!van) {
      return res.status(400).json({
        error: `Could not find a van with plate number ${vanPlateNumber} in the terminal database.`,
      });
    }

    const newTrip = await prisma.$transaction(async (tx) => {
      // 1. Prevent starting a new trip if the driver already has one active.
      //    Checked first, inside the transaction, to minimise the race window.
      const existingTrip = await tx.trip.findFirst({
        where: {
          driverId: driverUserId,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
      });

      if (existingTrip) {
        throw new HttpError(400, 'You already have an active trip. Please complete it first.');
      }

      // 2. Atomically claim the van: only succeeds if it's still IDLE.
      //    Prevents two concurrent requests from double-booking the same van.
      const vanClaim = await tx.van.updateMany({
        where: { id: van.id, status: 'IDLE' },
        data:  { status: 'ON_TRIP' },
      });

      if (vanClaim.count === 0) {
        throw new HttpError(400, `Van ${vanPlateNumber} is currently in use. Contact the dispatcher.`);
      }

      // 3. Find or create the route. Handle a race on the unique route name
      //    gracefully (P2002) by re-fetching the row another request created.
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

      // 4. Create the trip now that the van is reserved and the route exists.
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

    return res.status(201).json(newTrip);
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