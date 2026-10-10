// src/controllers/trip.controller.js
import { PrismaClient, Prisma } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { verifyVanQrToken, signVanQrToken } from '../utils/qr.util.js';
import {
  recordLocation,
  getLiveLocation,
  clearTripLocation,
} from '../liveLocations.js';
import { getIo } from '../sockets/socket.js';

const pool    = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ─── State machine ────────────────────────────────────────────────────────────
//
// A trip is a full round trip, made of two legs tracked by `direction`:
//   OUTBOUND — municipality → terminal (driver self-starts here)
//   RETURN   — terminal → municipality (entered only via the dispatcher's
//              QR check-in at the terminal, or via queue promotion)
//
// Both legs share the same BOARDING → DEPARTING → DEPARTED → ARRIVING
// shape. The dispatcher's QR scan guards TWO checkpoints at the terminal:
//
//   1. CHECK-IN  — OUTBOUND + ARRIVING  → QUEUED / BOARDING (RETURN leg)
//   2. EXIT      — RETURN   + DEPARTING → DEPARTED (van leaves the terminal)
//
// Everything else is driven by the driver's own buttons. The driver can NOT
// move a RETURN trip to DEPARTED themselves (that is the exit scan), and
// cannot COMPLETE an OUTBOUND trip (that is the check-in scan). ARRIVING
// while RETURN is finished by the driver's own "Finish Trip" button.
//
// Terminal boarding is a PER-COOPERATIVE resource: each cooperative has
// its own single boarding slot, so a van only queues behind other vans
// from the SAME cooperative, never behind vans from a different one.

const VALID_TRANSITIONS = {
  BOARDING:   ['DEPARTING', 'DELAYED', 'CANCELLED'],
  DEPARTING:  ['DEPARTED', 'DELAYED'], // DEPARTED on RETURN leg is gated, see below
  DEPARTED:   ['ARRIVING', 'DELAYED'],
  ARRIVING:   ['DELAYED', 'COMPLETED'], // COMPLETED gated by direction, see below
  QUEUED:     [], // only ever changed internally (promotion), never by API caller
  DELAYED:    ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'COMPLETED'],
  COMPLETED:  [],
  CANCELLED:  [],
};

// Anything that isn't finished yet — used to block a driver from starting
// a second round trip while one is still in progress.
const ACTIVE_STATUSES = ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'QUEUED', 'DELAYED'];

const TRIP_INCLUDE = {
  driver: { select: { id: true, name: true, contactNumber: true, contactNumbers: true } },
  route:  true,
  van:    { include: { cooperative: true } },
};

// ─── Small helpers ─────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function withVanQrToken(trip) {
  if (!trip?.van?.id) return trip;
  return { ...trip, van: { ...trip.van, qrToken: signVanQrToken(trip.van.id) } };
}

function emitFleetEvent(event, payload) {
  try {
    const io = getIo();
    if (!io) return;
    io.emit(event, payload);
  } catch (err) {
    console.error(`[socket emit:${event}]`, err);
  }
}

function handleError(res, error, context, fallbackMessage = 'Internal server error.') {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error(`[${context}]`, error);
  return res.status(500).json({ error: fallbackMessage });
}

function broadcastStartTracking(trip) {
  try {
    const io = getIo();
    if (!io || !trip?.driverId) return;
    io.to(`driver:${trip.driverId}`).emit('start_tracking', {
      tripId: trip.id,
      status: trip.status,
      reason: 'Trip is boarding — start sharing your location.',
    });
  } catch (err) {
    console.error('[broadcastStartTracking]', err);
  }
}

function broadcastStopTracking(tripId, driverId) {
  try {
    const io = getIo();
    if (!io || !driverId) return;
    io.to(`driver:${driverId}`).emit('stop_tracking', { tripId });
  } catch (err) {
    console.error('[broadcastStopTracking]', err);
  }
}

// Promotes the longest-waiting QUEUED (RETURN-leg) trip for ONE cooperative
// into BOARDING once that cooperative's terminal boarding slot frees up.
// `cooperativeId` may be null — vans with no cooperative assigned share one
// "unassigned" slot together, scoped the same way as a real cooperative.
async function promoteNextQueuedTrip(tx, cooperativeId) {
  const stillBoardingAtTerminal = await tx.trip.findFirst({
    where: { status: 'BOARDING', direction: 'RETURN', van: { cooperativeId } },
  });
  if (stillBoardingAtTerminal) return null;

  const next = await tx.trip.findFirst({
    where: { status: 'QUEUED', direction: 'RETURN', van: { cooperativeId } },
    orderBy: { actualArrival: 'asc' }, // first checked in = first in line
  });
  if (!next) return null;

  const promoted = await tx.trip.update({
    where: { id: next.id },
    data: { status: 'BOARDING' },
    include: TRIP_INCLUDE,
  });

  await tx.tripStatusHistory.create({
    data: { tripId: next.id, status: 'BOARDING' },
  });

  return promoted;
}

// ─── 0. Dispatcher: vans currently AT the terminal, grouped by cooperative ───

export const getTerminalVans = async (req, res) => {
  try {
    const [
      idleVans,
      awaitingCheckIn,
      boardingAtTerminal,
      departingAtTerminal,
      queuedAtTerminal,
      cooperatives,
    ] = await Promise.all([
      prisma.van.findMany({
        where: { status: 'IDLE' },
        include: {
          driver: { select: { id: true, name: true, contactNumber: true, contactNumbers: true } },
          cooperative: true,
        },
        orderBy: { plateNumber: 'asc' },
      }),
      prisma.trip.findMany({
        where: { status: 'ARRIVING', direction: 'OUTBOUND' },
        include: TRIP_INCLUDE,
        orderBy: { id: 'desc' },
      }),
      prisma.trip.findMany({
        where: { status: 'BOARDING', direction: 'RETURN' },
        include: TRIP_INCLUDE,
        orderBy: { id: 'desc' },
      }),
      // Vans that tapped "Ready to Depart" on the RETURN leg and are
      // waiting for the dispatcher's exit scan.
      prisma.trip.findMany({
        where: { status: 'DEPARTING', direction: 'RETURN' },
        include: TRIP_INCLUDE,
        orderBy: { id: 'desc' },
      }),
      prisma.trip.findMany({
        where: { status: 'QUEUED', direction: 'RETURN' },
        include: TRIP_INCLUDE,
        orderBy: { actualArrival: 'asc' },
      }),
      prisma.cooperative.findMany({ orderBy: { name: 'asc' } }),
    ]);

    const groups = new Map();
    const ensureGroup = (id, name) => {
      const key = id ?? 'unassigned';
      if (!groups.has(key)) {
        groups.set(key, {
          cooperativeId: id ?? null,
          cooperativeName: name,
          awaitingScan: [],
          departing: [],
          boarding: [],
          queued: [],
          idle: [],
        });
      }
      return groups.get(key);
    };

    for (const c of cooperatives) ensureGroup(c.id, c.name);
    ensureGroup(null, 'Unassigned');

    const toEntry = (trip) => ({
      vanId: trip.van.id,
      plateNumber: trip.van.plateNumber,
      capacity: trip.van.capacity,
      driver: trip.driver,
      trip: {
        id: trip.id,
        routeName: trip.route?.name ?? null,
        origin: trip.route?.origin ?? null,
        destination: trip.route?.destination ?? null,
        availableSeats: trip.availableSeats,
        totalSeats: trip.totalSeats,
      },
    });

    for (const trip of awaitingCheckIn) {
      ensureGroup(trip.van.cooperativeId, trip.van.cooperative?.name ?? 'Unassigned').awaitingScan.push(toEntry(trip));
    }
    for (const trip of departingAtTerminal) {
      ensureGroup(trip.van.cooperativeId, trip.van.cooperative?.name ?? 'Unassigned').departing.push(toEntry(trip));
    }
    for (const trip of boardingAtTerminal) {
      ensureGroup(trip.van.cooperativeId, trip.van.cooperative?.name ?? 'Unassigned').boarding.push(toEntry(trip));
    }

    // queuedAtTerminal is ordered earliest-first overall; rank must be
    // computed within each cooperative's own line, so re-rank per group.
    const queuedByGroup = new Map();
    for (const trip of queuedAtTerminal) {
      const key = trip.van.cooperativeId ?? 'unassigned';
      if (!queuedByGroup.has(key)) queuedByGroup.set(key, []);
      queuedByGroup.get(key).push(trip);
    }
    for (const trips of queuedByGroup.values()) {
      const first = trips[0];
      const group = ensureGroup(first.van.cooperativeId, first.van.cooperative?.name ?? 'Unassigned');
      group.queued = trips.map((trip, index) => ({ ...toEntry(trip), queuePosition: index + 1 }));
    }

    for (const van of idleVans) {
      ensureGroup(van.cooperativeId, van.cooperative?.name ?? 'Unassigned').idle.push({
        vanId: van.id,
        plateNumber: van.plateNumber,
        capacity: van.capacity,
        driver: van.driver ?? null,
      });
    }

    const result = Array.from(groups.values())
      .filter(
        (g) =>
          g.awaitingScan.length ||
          g.departing.length ||
          g.boarding.length ||
          g.queued.length ||
          g.idle.length,
      )
      .sort((a, b) => a.cooperativeName.localeCompare(b.cooperativeName));

    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error, 'getTerminalVans', 'Failed to load vans at the terminal.');
  }
};

// ─── 0b. Driver GPS ingestion (HTTP path) ────────────────────────────────────

export const updateDriverLocation = async (req, res) => {
  try {
    const { tripId, lat, lng, speed, accuracy, heading } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    if (!tripId) return res.status(400).json({ error: 'tripId is required.' });
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng must be numbers.' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Coordinates out of range.' });
    }

    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, driverId: true, status: true },
    });

    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.driverId !== userId) {
      return res.status(403).json({ error: 'You are not the driver of this trip.' });
    }
    if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Trip is no longer active.' });
    }

    const entry = recordLocation(tripId, { lat, lng, speed, accuracy, heading });

    try {
      const io = getIo();
      io?.to('map').emit('van_moved', { tripId, ...entry });
    } catch (err) {
      console.error('[updateDriverLocation emit]', err);
    }

    return res.status(200).json({ ok: true, entry });
  } catch (error) {
    return handleError(res, error, 'updateDriverLocation', 'Failed to record location.');
  }
};

// ─── 0c. Driver: persist seat counts on the trip ─────────────────────────────

export const updateTripSeats = async (req, res) => {
  try {
    const { id } = req.params;
    const { availableSeats, totalSeats } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    if (typeof availableSeats !== 'number' || typeof totalSeats !== 'number') {
      return res.status(400).json({ error: 'availableSeats and totalSeats must be numbers.' });
    }
    if (totalSeats < 1 || totalSeats > 100) {
      return res.status(400).json({ error: 'totalSeats must be between 1 and 100.' });
    }
    if (availableSeats < 0 || availableSeats > totalSeats) {
      return res.status(400).json({ error: 'availableSeats must be between 0 and totalSeats.' });
    }

    const trip = await prisma.trip.findUnique({
      where: { id },
      select: { id: true, driverId: true, status: true },
    });

    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.driverId !== userId) {
      return res.status(403).json({ error: 'You are not the driver of this trip.' });
    }
    if (trip.status === 'COMPLETED' || trip.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Trip is no longer active.' });
    }

    await prisma.trip.update({
      where: { id },
      data: {
        availableSeats: Math.round(availableSeats),
        totalSeats:     Math.round(totalSeats),
      },
    });

    emitFleetEvent('seat_update_broadcast', {
      tripId: id,
      availableSeats: Math.round(availableSeats),
      totalSeats: Math.round(totalSeats),
    });

    return res.status(200).json({
      ok: true,
      availableSeats: Math.round(availableSeats),
      totalSeats: Math.round(totalSeats),
    });
  } catch (error) {
    return handleError(res, error, 'updateTripSeats', 'Failed to save seat counts.');
  }
};

// ─── 1. Update trip status (driver-initiated, both legs) ─────────────────────

export const updateTripStatus = async (req, res) => {
  try {
    const { id }        = req.params;
    const { newStatus } = req.body;
    const userId        = req.user.id;
    let promotedTrip     = null;

    const updatedTrip = await prisma.$transaction(async (tx) => {
      const trip = await tx.trip.findUnique({
        where: { id },
        include: { van: { select: { cooperativeId: true } } },
      });
      if (!trip) throw new HttpError(404, 'Trip not found.');

      const allowed = VALID_TRANSITIONS[trip.status] ?? [];
      if (!allowed.includes(newStatus)) {
        throw new HttpError(
          400,
          `Invalid transition. Cannot move from ${trip.status} to ${newStatus}.`,
        );
      }

      // A trip can only be COMPLETED on its RETURN leg — the OUTBOUND leg's
      // ARRIVING must go through the dispatcher's QR check-in instead.
      if (newStatus === 'COMPLETED' && trip.direction !== 'RETURN') {
        throw new HttpError(
          400,
          'This van must be checked in by the dispatcher at the terminal before the trip can continue.',
        );
      }

      // Leaving the terminal on the RETURN leg must be confirmed by the
      // dispatcher's QR scan (see handleQrScan), not by the driver.
      if (newStatus === 'DEPARTED' && trip.direction === 'RETURN') {
        throw new HttpError(
          400,
          'Leaving the terminal must be confirmed by the dispatcher scanning your QR code.',
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

      if (newStatus === 'COMPLETED' || newStatus === 'CANCELLED') {
        await tx.van.update({
          where: { id: trip.vanId },
          data:  { status: 'IDLE' },
        });
      }

      // Leaving the cooperative's BOARDING slot (RETURN leg) frees it up —
      // advance whichever queued van, from the SAME cooperative, has been
      // waiting longest.
      if (trip.status === 'BOARDING' && trip.direction === 'RETURN' && newStatus !== 'BOARDING') {
        promotedTrip = await promoteNextQueuedTrip(tx, trip.van.cooperativeId);
      }

      return updated;
    });

    emitFleetEvent('trip_status_changed', {
      tripId: updatedTrip.id,
      status: updatedTrip.status,
      trip:   updatedTrip,
    });

    if (updatedTrip.status === 'COMPLETED' || updatedTrip.status === 'CANCELLED') {
      clearTripLocation(updatedTrip.id);
      broadcastStopTracking(updatedTrip.id, updatedTrip.driverId);
      emitFleetEvent('trip_removed', { tripId: updatedTrip.id });
    }

    if (promotedTrip) {
      emitFleetEvent('trip_status_changed', {
        tripId: promotedTrip.id,
        status: promotedTrip.status,
        trip:   promotedTrip,
      });
    }

    return res.status(200).json({ message: 'Status updated', trip: withVanQrToken(updatedTrip) });
  } catch (error) {
    return handleError(res, error, 'updateTripStatus', 'Failed to update trip status.');
  }
};

// ─── 2. QR scan handler — the two terminal checkpoints ───────────────────────
//
// The dispatcher's scan guards TWO checkpoints at the terminal:
//
//   CHECK-IN — a van reaches ARRIVING on its OUTBOUND leg. Scanning it
//     checks it into its cooperative's terminal queue: straight to BOARDING
//     if that cooperative's slot is free, otherwise QUEUED behind other vans
//     from the same cooperative (other cooperatives never block each other).
//
//   EXIT — a van on its RETURN leg has tapped "Ready to Depart" (DEPARTING).
//     Scanning it confirms it physically left the terminal: DEPARTED, and
//     the actual departure time is recorded.

export const handleQrScan = async (req, res) => {
  try {
    const { qrToken } = req.body;
    const userId = req.user.id;

    if (!qrToken) return res.status(400).json({ error: 'qrToken is required.' });

    const vanId = verifyVanQrToken(qrToken);
    if (!vanId) return res.status(400).json({ error: 'Invalid or unrecognized QR code.' });

    const result = await prisma.$transaction(async (tx) => {
      const van = await tx.van.findUnique({
        where: { id: vanId },
        include: { cooperative: true },
      });
      if (!van) throw new HttpError(404, 'This QR code refers to a van that no longer exists.');

      const trip = await tx.trip.findFirst({
        where: { vanId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        orderBy: { id: 'desc' },
      });

      if (!trip) throw new HttpError(400, `${van.plateNumber} has no active trip right now.`);

      // ── EXIT scan: RETURN leg, driver is ready to leave the terminal ──
      if (trip.direction === 'RETURN' && trip.status === 'DEPARTING') {
        const departed = await tx.trip.update({
          where: { id: trip.id },
          data: { status: 'DEPARTED', actualDeparture: new Date() },
          include: TRIP_INCLUDE,
        });

        await tx.tripStatusHistory.create({
          data: { tripId: trip.id, status: 'DEPARTED', recordedById: userId },
        });

        await tx.qrScanLog.create({
          data: {
            tripId: trip.id,
            vanId,
            scannedById: userId,
            action: 'TERMINAL_EXIT_DEPARTED',
          },
        });

        return {
          kind: 'EXIT',
          trip: departed,
          queued: false,
          queuePosition: null,
          cooperativeName: van.cooperative?.name ?? null,
        };
      }

      // ── CHECK-IN scan: OUTBOUND leg, van has reached the terminal ──
      if (trip.direction !== 'OUTBOUND' || trip.status !== 'ARRIVING') {
        const hint =
          trip.direction === 'RETURN'
            ? trip.status === 'QUEUED'
              ? `${van.plateNumber} already checked in and is queued for boarding.`
              : trip.status === 'BOARDING'
                ? `${van.plateNumber} is still boarding — ask the driver to tap "Ready to Depart" first.`
                : `${van.plateNumber} has already left the terminal — no scan needed.`
            : trip.status === 'BOARDING'
              ? `${van.plateNumber} is still boarding — ask the driver to mark "Ready to Depart" first.`
              : `${van.plateNumber} isn't ready to be checked in yet (currently ${trip.status.toLowerCase()}).`;
        throw new HttpError(400, hint);
      }

      const currentlyBoardingAtTerminal = await tx.trip.findFirst({
        where: { status: 'BOARDING', direction: 'RETURN', van: { cooperativeId: van.cooperativeId } },
      });

      const nextStatus = currentlyBoardingAtTerminal ? 'QUEUED' : 'BOARDING';

      const updated = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: nextStatus,
          direction: 'RETURN',
          actualArrival: trip.actualArrival ?? new Date(),
        },
        include: TRIP_INCLUDE,
      });

      await tx.tripStatusHistory.create({
        data: { tripId: trip.id, status: nextStatus, recordedById: userId },
      });

      await tx.qrScanLog.create({
        data: {
          tripId: trip.id,
          vanId,
          scannedById: userId,
          action: nextStatus === 'BOARDING' ? 'TERMINAL_CHECK_IN_BOARDING' : 'TERMINAL_CHECK_IN_QUEUED',
        },
      });

      let queuePosition = null;
      if (nextStatus === 'QUEUED') {
        const aheadCount = await tx.trip.count({
          where: {
            status: 'QUEUED',
            direction: 'RETURN',
            actualArrival: { lt: updated.actualArrival },
            van: { cooperativeId: van.cooperativeId },
          },
        });
        queuePosition = aheadCount + 1;
      }

      return {
        kind: 'CHECK_IN',
        trip: updated,
        queued: nextStatus === 'QUEUED',
        queuePosition,
        cooperativeName: van.cooperative?.name ?? null,
      };
    });

    emitFleetEvent('trip_status_changed', {
      tripId: result.trip.id,
      status: result.trip.status,
      trip: result.trip,
    });

    const plate   = result.trip.van?.plateNumber ?? 'Van';
    const coopTag = result.cooperativeName ? ` (${result.cooperativeName})` : '';
    const dest    = result.trip.route?.origin ?? 'its municipality';
    const message =
      result.kind === 'EXIT'
        ? `${plate}${coopTag} cleared to leave — departed for ${dest}.`
        : result.queued
          ? `${plate}${coopTag} checked in — queued for boarding, position ${result.queuePosition}.`
          : `${plate}${coopTag} checked in — now boarding for the return trip.`;

    return res.status(200).json({
      message,
      kind: result.kind,
      trip: result.trip,
      queued: result.queued,
      queuePosition: result.queuePosition,
    });
  } catch (error) {
    return handleError(res, error, 'handleQrScan', 'Failed to process QR scan.');
  }
};

// ─── 3. Driver's own active trip ──────────────────────────────────────────────

export const getMyTrips = async (req, res) => {
  try {
    const driverId = req.user.id;

    const trips = await prisma.trip.findMany({
      where: { driverId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      include: TRIP_INCLUDE,
      orderBy: { id: 'desc' },
    });

    return res.status(200).json(trips.map(withVanQrToken));
  } catch (error) {
    return handleError(res, error, 'getMyTrips', 'Failed to fetch assigned trips.');
  }
};

// ─── 4. Driver self-starts the outbound leg ──────────────────────────────────

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
        where: { driverId: driverUserId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
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
          route = await tx.route.create({ data: { name: routeName, origin, destination } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            route = await tx.route.findFirst({ where: { name: routeName } });
          } else {
            throw err;
          }
        }
      }

      if (!route) throw new HttpError(500, 'Failed to resolve route for this trip.');

      return tx.trip.create({
        data: {
          routeId: route.id,
          vanId: van.id,
          driverId: driverUserId,
          status: 'BOARDING',
          direction: 'OUTBOUND',
          scheduledTime: new Date(),
          availableSeats: van.capacity,
          totalSeats:     van.capacity,
        },
        include: TRIP_INCLUDE,
      });
    });

    emitFleetEvent('trip_dispatched', { trip: newTrip });
    emitFleetEvent('trip_status_changed', {
      tripId: newTrip.id,
      status: newTrip.status,
      trip:   newTrip,
    });

    broadcastStartTracking(newTrip);

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
      prisma.van.findMany({ where: { status: 'IDLE' }, include: { cooperative: true } }),
      prisma.user.findMany({ where: { role: 'DRIVER', isActive: true } }),
    ]);
    return res.status(200).json({ routes, vans, drivers });
  } catch (error) {
    return handleError(res, error, 'getDispatchResources', 'Failed to load dispatch resources.');
  }
};

// ─── 6. Dispatcher: create an outbound trip directly ─────────────────────────

export const createTrip = async (req, res) => {
  try {
    const { routeId, vanId, driverId } = req.body;

    if (!routeId || !vanId || !driverId) {
      return res.status(400).json({ error: 'routeId, vanId, and driverId are all required.' });
    }

    const trip = await prisma.$transaction(async (tx) => {
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
      if (!route) throw new HttpError(400, 'Dispatch failed: route not found.');

      const van = await tx.van.findUnique({ where: { id: vanId } });

      return tx.trip.create({
        data: {
          routeId,
          vanId,
          driverId,
          status: 'BOARDING',
          direction: 'OUTBOUND',
          scheduledTime: new Date(),
          availableSeats: van?.capacity ?? 14,
          totalSeats:     van?.capacity ?? 14,
        },
        include: TRIP_INCLUDE,
      });
    });

    emitFleetEvent('trip_dispatched', { trip });
    emitFleetEvent('trip_status_changed', {
      tripId: trip.id,
      status: trip.status,
      trip,
    });

    broadcastStartTracking(trip);

    return res.status(201).json({ message: 'Trip successfully dispatched!', trip });
  } catch (error) {
    return handleError(res, error, 'createTrip', 'Failed to dispatch trip.');
  }
};

// ─── 7. Public live trips (WITH last known GPS fix) ───────────────────────────

export const getLiveTrips = async (req, res) => {
  try {
    const activeTrips = await prisma.trip.findMany({
      where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      include: TRIP_INCLUDE,
      orderBy: { id: 'desc' },
    });

    const withLive = activeTrips.map((trip) => ({
      ...trip,
      liveLocation: getLiveLocation(trip.id),
    }));

    return res.status(200).json(withLive);
  } catch (error) {
    console.error('[getLiveTrips]', error);
    return res.status(500).json({ error: 'Failed to fetch live dispatch data.' });
  }
};
