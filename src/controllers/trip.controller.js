// src/controllers/trip.controller.js
import { PrismaClient, Prisma } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { verifyVanQrToken, signVanQrToken } from '../utils/qr.util.js';
import {
  ingestLocation,
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
// Both legs share the same BOARDING → DEPARTING → DEPARTED shape. There is
// NO driver-side "approaching" step any more: once a van is DEPARTED on its
// OUTBOUND leg it is simply "on the way", and the dispatcher's QR scan guards
// TWO checkpoints at the terminal:
//
//   1. CHECK-IN  — OUTBOUND + DEPARTED (or legacy ARRIVING) → QUEUED / BOARDING
//   2. EXIT      — RETURN   + DEPARTING → DEPARTED (van leaves the terminal)
//
// Everything else is driven by the driver's own buttons. The driver can NOT
// move a RETURN trip to DEPARTED themselves (that is the exit scan), and
// cannot COMPLETE an OUTBOUND trip (that is the check-in scan). A RETURN trip
// that is DEPARTED is finished by the driver's own "Finish Trip" button.
//
// A driver may run several trips at the same time, as long as they start from
// different municipalities (see assertNoDuplicateActiveTrip).
//
// Terminal boarding is a PER-COOPERATIVE resource: each cooperative has
// its own single boarding slot, so a van only queues behind other vans
// from the SAME cooperative, never behind vans from a different one.

const VALID_TRANSITIONS = {
  BOARDING:   ['DEPARTING', 'DELAYED', 'CANCELLED'],
  DEPARTING:  ['DEPARTED', 'DELAYED'], // DEPARTED on RETURN leg is gated, see below
  DEPARTED:   ['DELAYED', 'COMPLETED'], // COMPLETED gated by direction, see below
  ARRIVING:   ['DELAYED', 'COMPLETED'], // legacy only — drivers can no longer move INTO this
  QUEUED:     [], // only ever changed internally (promotion), never by API caller
  DELAYED:    ['BOARDING', 'DEPARTING', 'DEPARTED', 'COMPLETED'],
  COMPLETED:  [],
  CANCELLED:  [],
};

// Anything that isn't finished yet.
const ACTIVE_STATUSES = ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'QUEUED', 'DELAYED'];

// Outbound statuses the dispatcher's check-in scan accepts.
const CHECK_IN_STATUSES = ['DEPARTED', 'ARRIVING'];

const TRIP_INCLUDE = {
  driver: { select: { id: true, name: true, contactNumber: true, contactNumbers: true } },
  route:  true,
  van:    { include: { cooperative: true } },
};

// GPS ingestion limits
const MAX_TRIPS_PER_FIX = 10;
const MAX_BATCH_FIXES   = 50;

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

// Serialises concurrent start requests for the same driver (double-taps,
// retries) so the duplicate-trip check below can't be raced.
async function lockDriver(tx, driverId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${String(driverId)}))`;
}

// A driver may run several trips at once, but only ONE per municipality
// (origin) / route — just like a real driver can't leave the same town twice.
async function assertNoDuplicateActiveTrip(tx, driverId, route) {
  const duplicate = await tx.trip.findFirst({
    where: {
      driverId,
      status: { in: ACTIVE_STATUSES },
      route: {
        OR: [
          { id: route.id },
          { origin: { equals: route.origin, mode: 'insensitive' } },
        ],
      },
    },
  });

  if (duplicate) {
    throw new HttpError(
      400,
      `You already have an active trip from ${route.origin}. Finish it first, or start one from a different municipality.`,
    );
  }
}

// Sets the van back to IDLE only when it has no other unfinished trips.
async function releaseVanIfFree(tx, vanId, finishedTripId) {
  const stillActive = await tx.trip.count({
    where: { vanId, id: { not: finishedTripId }, status: { in: ACTIVE_STATUSES } },
  });
  if (stillActive === 0) {
    await tx.van.update({ where: { id: vanId }, data: { status: 'IDLE' } });
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

// ─── 0. Dispatcher: vans currently AT (or heading to) the terminal ──────────

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
      // Outbound vans that left their municipality and are waiting for the
      // dispatcher's check-in scan (no driver "approaching" step any more).
      prisma.trip.findMany({
        where: { status: { in: CHECK_IN_STATUSES }, direction: 'OUTBOUND' },
        include: TRIP_INCLUDE,
        orderBy: { scheduledTime: 'asc' },
      }),
      prisma.trip.findMany({
        where: { status: 'BOARDING', direction: 'RETURN' },
        include: TRIP_INCLUDE,
        orderBy: { scheduledTime: 'desc' },
      }),
      // Vans that tapped "Ready to Depart" on the RETURN leg and are
      // waiting for the dispatcher's exit scan.
      prisma.trip.findMany({
        where: { status: 'DEPARTING', direction: 'RETURN' },
        include: TRIP_INCLUDE,
        orderBy: { scheduledTime: 'desc' },
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
        status: trip.status,
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
//
// Accepts EITHER a single fix:
//   { tripId, lat, lng, speed?, accuracy?, heading?, timestamp? }
// OR a batch of buffered fixes (sent after a signal drop while moving):
//   { tripId, fixes: [{ lat, lng, speed?, accuracy?, heading?, timestamp }, ...] }
//
// `tripIds: [...]` may be used instead of / in addition to `tripId` to apply
// the same position to several of the driver's active trips at once.
// `timestamp` is the device's fix time in epoch ms.

function validateFix(f) {
  if (!f || typeof f.lat !== 'number' || typeof f.lng !== 'number' ||
      !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) {
    return 'lat and lng must be numbers.';
  }
  if (f.lat < -90 || f.lat > 90 || f.lng < -180 || f.lng > 180) {
    return 'Coordinates out of range.';
  }
  return null;
}

export const updateDriverLocation = async (req, res) => {
  try {
    const { tripId, tripIds, lat, lng, speed, accuracy, heading, timestamp, fixes } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const targetIds = Array.from(
      new Set(
        [...(Array.isArray(tripIds) ? tripIds : []), ...(tripId ? [tripId] : [])].filter(
          (id) => typeof id === 'string' && id.length > 0,
        ),
      ),
    );

    if (targetIds.length === 0) return res.status(400).json({ error: 'tripId is required.' });
    if (targetIds.length > MAX_TRIPS_PER_FIX) {
      return res.status(400).json({ error: `Too many trips in one update (max ${MAX_TRIPS_PER_FIX}).` });
    }

    // Build the list of fixes to ingest, oldest first.
    const isBatch = Array.isArray(fixes) && fixes.length > 0;
    let fixList;

    if (isBatch) {
      const sliced = fixes.slice(-MAX_BATCH_FIXES);
      const now = Date.now();
      const candidates = sliced.map((f, i) => ({
        lat: f?.lat,
        lng: f?.lng,
        speed: f?.speed,
        accuracy: f?.accuracy,
        heading: f?.heading,
        // Missing timestamps: spread them 1s apart ending now so order is kept.
        timestamp: Number.isFinite(f?.timestamp) ? f.timestamp : now - (sliced.length - 1 - i) * 1000,
      }));
      const valid = candidates.filter((f) => !validateFix(f));
      if (valid.length === 0) {
        return res.status(400).json({ error: validateFix(candidates[0]) ?? 'No valid fixes supplied.' });
      }
      fixList = valid.sort((a, b) => a.timestamp - b.timestamp);
    } else {
      const single = { lat, lng, speed, accuracy, heading, timestamp };
      const err = validateFix(single);
      if (err) return res.status(400).json({ error: err });
      fixList = [single];
    }

    const trips = await prisma.trip.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, driverId: true, status: true },
    });

    if (trips.length !== targetIds.length) return res.status(404).json({ error: 'Trip not found.' });
    if (trips.some((t) => t.driverId !== userId)) {
      return res.status(403).json({ error: 'You are not the driver of this trip.' });
    }

    const activeTrips = trips.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
    if (activeTrips.length === 0) {
      return res.status(400).json({ error: 'Trip is no longer active.' });
    }

    const results = [];
    let firstEntry = null;

    for (const t of activeTrips) {
      let acceptedEntry = null;
      let lastReason = null;
      let currentEntry = null;

      for (const fix of fixList) {
        const r = ingestLocation(t.id, fix);
        currentEntry = r.entry ?? currentEntry;
        if (r.accepted) acceptedEntry = r.entry;
        else lastReason = r.reason;
      }

      // Broadcast once per trip — the newest accepted position.
      if (acceptedEntry) {
        try {
          const io = getIo();
          io?.to('map').emit('van_moved', { tripId: t.id, ...acceptedEntry });
        } catch (err) {
          console.error('[updateDriverLocation emit]', err);
        }
      }

      results.push({
        tripId: t.id,
        accepted: !!acceptedEntry,
        reason: acceptedEntry ? null : lastReason,
      });

      if (!firstEntry) firstEntry = currentEntry;
    }

    return res.status(200).json({
      ok: true,
      entry: firstEntry,
      accepted: results.some((r) => r.accepted),
      results,
      serverTime: Date.now(),
    });
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

      if (newStatus === 'ARRIVING') {
        throw new HttpError(400, 'The "arriving" step has been removed. The dispatcher checks vans in at the terminal.');
      }

      const allowed = VALID_TRANSITIONS[trip.status] ?? [];
      if (!allowed.includes(newStatus)) {
        throw new HttpError(
          400,
          `Invalid transition. Cannot move from ${trip.status} to ${newStatus}.`,
        );
      }

      // A trip can only be COMPLETED on its RETURN leg — the OUTBOUND leg
      // must go through the dispatcher's QR check-in instead.
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

      // The van only becomes IDLE when its LAST active trip is finished.
      if (newStatus === 'COMPLETED' || newStatus === 'CANCELLED') {
        await releaseVanIfFree(tx, trip.vanId, id);
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
//   CHECK-IN — a van on its OUTBOUND leg has left its municipality
//     (DEPARTED, or legacy ARRIVING). Scanning it checks it into its
//     cooperative's terminal queue: straight to BOARDING if that
//     cooperative's slot is free, otherwise QUEUED behind other vans from
//     the same cooperative (other cooperatives never block each other).
//
//   EXIT — a van on its RETURN leg has tapped "Ready to Depart" (DEPARTING).
//     Scanning it confirms it physically left the terminal: DEPARTED, and
//     the actual departure time is recorded.
//
// A van may have several active trips. The scan picks the scannable one
// automatically (exit scans first, then the oldest outbound trip). The app
// may send an optional `tripId` to choose a specific trip.

const isExitScannable = (t) => t.direction === 'RETURN' && t.status === 'DEPARTING';
const isCheckInScannable = (t) => t.direction === 'OUTBOUND' && CHECK_IN_STATUSES.includes(t.status);

export const handleQrScan = async (req, res) => {
  try {
    const { qrToken, tripId: requestedTripId } = req.body;
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

      const activeTrips = await tx.trip.findMany({
        where: { vanId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        orderBy: { scheduledTime: 'desc' },
      });

      if (activeTrips.length === 0) {
        throw new HttpError(400, `${van.plateNumber} has no active trip right now.`);
      }

      let trip;
      if (requestedTripId) {
        trip = activeTrips.find((t) => t.id === requestedTripId);
        if (!trip) throw new HttpError(400, `That trip is not active for ${van.plateNumber}.`);
      } else {
        trip =
          activeTrips.find(isExitScannable) ??
          activeTrips
            .filter(isCheckInScannable)
            .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime))[0] ??
          activeTrips[0];
      }

      // ── EXIT scan: RETURN leg, driver is ready to leave the terminal ──
      if (isExitScannable(trip)) {
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
      if (!isCheckInScannable(trip)) {
        const hint =
          trip.direction === 'RETURN'
            ? trip.status === 'QUEUED'
              ? `${van.plateNumber} already checked in and is queued for boarding.`
              : trip.status === 'BOARDING'
                ? `${van.plateNumber} is still boarding — ask the driver to tap "Ready to Depart" first.`
                : `${van.plateNumber} has already left the terminal — no scan needed.`
            : trip.status === 'BOARDING'
              ? `${van.plateNumber} is still boarding — ask the driver to mark "Ready to Depart" first.`
              : trip.status === 'DEPARTING'
                ? `${van.plateNumber} hasn't left its municipality yet.`
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

// ─── 3. Driver's own active trips ─────────────────────────────────────────────

export const getMyTrips = async (req, res) => {
  try {
    const driverId = req.user.id;

    const trips = await prisma.trip.findMany({
      where: { driverId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      include: TRIP_INCLUDE,
      orderBy: { scheduledTime: 'desc' },
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

    if (van.status === 'MAINTENANCE') {
      return res.status(400).json({
        error: `Van ${van.plateNumber} is under maintenance. Contact the dispatcher.`,
      });
    }

    const newTrip = await prisma.$transaction(async (tx) => {
      await lockDriver(tx, driverUserId);

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

      // One active trip per municipality/route — but several at once overall.
      await assertNoDuplicateActiveTrip(tx, driverUserId, route);

      const vanClaim = await tx.van.updateMany({
        where: { id: van.id, status: { in: ['IDLE', 'ON_TRIP'] } },
        data:  { status: 'ON_TRIP' },
      });

      if (vanClaim.count === 0) {
        throw new HttpError(400, `Van ${van.plateNumber} is under maintenance. Contact the dispatcher.`);
      }

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
      // Vans already out on a trip can take another one (different municipality).
      prisma.van.findMany({
        where: { status: { in: ['IDLE', 'ON_TRIP'] } },
        include: { cooperative: true },
      }),
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
      await lockDriver(tx, driverId);

      const route = await tx.route.findUnique({ where: { id: routeId } });
      if (!route) throw new HttpError(400, 'Dispatch failed: route not found.');

      const van = await tx.van.findUnique({ where: { id: vanId } });
      if (!van) throw new HttpError(400, 'Dispatch failed: van not found.');
      if (van.status === 'MAINTENANCE') {
        throw new HttpError(400, 'Dispatch failed: this van is under maintenance.');
      }

      // A driver can be on several trips at once, but not twice from the
      // same municipality/route.
      await assertNoDuplicateActiveTrip(tx, driverId, route);

      await tx.van.update({ where: { id: vanId }, data: { status: 'ON_TRIP' } });

      return tx.trip.create({
        data: {
          routeId,
          vanId,
          driverId,
          status: 'BOARDING',
          direction: 'OUTBOUND',
          scheduledTime: new Date(),
          availableSeats: van.capacity ?? 14,
          totalSeats:     van.capacity ?? 14,
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
      orderBy: { scheduledTime: 'desc' },
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
