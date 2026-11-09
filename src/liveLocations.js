// src/liveLocations.js
//
// In-memory store for the last known GPS fix per active trip.
// Swap for Redis if you ever scale beyond one backend instance.

const liveLocations = new Map(); // tripId -> { lat, lng, speed, smoothedSpeed, accuracy, heading, timestamp, positionTrusted }
const rejectStreaks = new Map(); // tripId -> consecutive "implausible jump" rejections

export const LOCATION_STALE_MS   = 120_000; // 2 min — matches the client threshold
export const UNUSABLE_ACCURACY_M = 250;     // fixes worse than this are not plotted

const SPEED_SMOOTHING_ALPHA = 0.4;
const MAX_FUTURE_SKEW_MS    = 5_000;   // client clocks may run slightly ahead
const MAX_PLAUSIBLE_SPEED   = 60;      // m/s (~216 km/h) — faster than this between fixes is a GPS glitch
const MIN_JUMP_DISTANCE_M   = 100;     // ignore "jump" detection for tiny movements
const MAX_REJECT_STREAK     = 3;       // after this many glitch rejections, accept the new position
const FRESH_TRUSTED_MS      = 30_000;  // a good fix newer than this is not overwritten by a bad one
const MIN_HEADING_SPEED     = 1;       // m/s — below this, GPS heading is unreliable
const MIN_HEADING_MOVE_M    = 8;       // minimum movement to derive a heading from positions

// ─── Geo helpers ─────────────────────────────────────────────────────────────

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDegrees(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Uses the device's own fix time when it is sane (so buffered fixes sent after
 * a dead zone keep their real time). Returns null when the fix is too old to
 * be useful.
 */
function resolveTimestamp(timestamp, now) {
  if (!Number.isFinite(timestamp)) return now;
  if (timestamp > now + MAX_FUTURE_SKEW_MS) return now;
  if (now - timestamp > LOCATION_STALE_MS) return null;
  return timestamp;
}

// ─── Ingestion ───────────────────────────────────────────────────────────────

/**
 * Validates and stores a fix. Returns { entry, accepted, reason }.
 * `entry` is always the CURRENT stored entry for the trip (or null).
 * Only broadcast on `van_moved` when `accepted` is true.
 */
export function ingestLocation(tripId, fix = {}) {
  const { lat, lng, speed, accuracy, heading, timestamp } = fix;

  if (!tripId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { entry: null, accepted: false, reason: 'invalid' };
  }

  const now = Date.now();
  const stored = liveLocations.get(tripId) ?? null;
  const prev = stored && now - stored.timestamp <= LOCATION_STALE_MS ? stored : null;

  const ts = resolveTimestamp(timestamp, now);
  if (ts === null) return { entry: prev, accepted: false, reason: 'too_old' };

  // Out-of-order / duplicate fixes (common after reconnect or batch upload).
  if (stored && ts <= stored.timestamp) {
    return { entry: prev, accepted: false, reason: 'out_of_order' };
  }

  const acc = Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null;
  const trusted = acc === null || acc <= UNUSABLE_ACCURACY_M;

  // A bad fix (tunnel, overpass) must not yank a recent good position away.
  if (!trusted && prev?.positionTrusted && now - prev.timestamp < FRESH_TRUSTED_MS) {
    return { entry: prev, accepted: false, reason: 'low_accuracy' };
  }

  // Movement since the previous good fix.
  const comparable = !!(prev && prev.positionTrusted && trusted);
  const dtSec = comparable ? (ts - prev.timestamp) / 1000 : 0;
  const dist = comparable ? distanceMeters(prev.lat, prev.lng, lat, lng) : 0;

  // Reject impossible teleports, but never get stuck: after a few in a row,
  // assume the vehicle really is there (e.g. long signal loss).
  if (comparable && dtSec > 0 && dist > MIN_JUMP_DISTANCE_M && dist / dtSec > MAX_PLAUSIBLE_SPEED) {
    const streak = (rejectStreaks.get(tripId) ?? 0) + 1;
    if (streak <= MAX_REJECT_STREAK) {
      rejectStreaks.set(tripId, streak);
      return { entry: prev, accepted: false, reason: 'implausible_jump' };
    }
  }
  rejectStreaks.delete(tripId);

  // Speed: device value, else derived from movement.
  let rawSpeed = Number.isFinite(speed) && speed >= 0 ? speed : null;
  if (rawSpeed === null && comparable && dtSec >= 0.5 && dtSec <= 30) {
    rawSpeed = Math.min(dist / dtSec, MAX_PLAUSIBLE_SPEED);
  }

  const smoothedSpeed =
    rawSpeed === null
      ? prev?.smoothedSpeed ?? null
      : prev?.smoothedSpeed == null
      ? rawSpeed
      : prev.smoothedSpeed * (1 - SPEED_SMOOTHING_ALPHA) + rawSpeed * SPEED_SMOOTHING_ALPHA;

  // Heading: trust the device only when actually moving.
  const validHeading = Number.isFinite(heading) && heading >= 0 && heading < 360;
  let nextHeading = prev?.heading ?? stored?.heading ?? null;
  if (validHeading && (rawSpeed === null || rawSpeed >= MIN_HEADING_SPEED)) {
    nextHeading = heading;
  } else if (comparable && dist >= MIN_HEADING_MOVE_M) {
    nextHeading = bearingDegrees(prev.lat, prev.lng, lat, lng);
  } else if (validHeading && nextHeading === null) {
    nextHeading = heading;
  }

  const entry = {
    lat,
    lng,
    speed: rawSpeed,
    smoothedSpeed,
    accuracy: acc,
    heading: nextHeading,
    timestamp: ts,
    positionTrusted: trusted,
  };

  liveLocations.set(tripId, entry);
  return { entry, accepted: true, reason: null };
}

/**
 * Backwards-compatible wrapper. Returns the stored entry (which is what gets
 * broadcast on `van_moved`).
 */
export function recordLocation(tripId, fix) {
  return ingestLocation(tripId, fix).entry;
}

/** Returns the fix for a trip, or null if missing / stale. Prunes stale entries. */
export function getLiveLocation(tripId) {
  const data = liveLocations.get(tripId);
  if (!data) return null;
  if (Date.now() - data.timestamp > LOCATION_STALE_MS) {
    liveLocations.delete(tripId);
    rejectStreaks.delete(tripId);
    return null;
  }
  return data;
}

/** Returns [[tripId, fix], ...] for every non-stale fix. Prunes as it goes. */
export function getLiveLocationsSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [tripId, data] of liveLocations) {
    if (now - data.timestamp > LOCATION_STALE_MS) {
      liveLocations.delete(tripId);
      rejectStreaks.delete(tripId);
      continue;
    }
    out.push([tripId, data]);
  }
  return out;
}

/** Drop a single trip's fix (called on COMPLETED / CANCELLED). */
export function clearTripLocation(tripId) {
  liveLocations.delete(tripId);
  rejectStreaks.delete(tripId);
}

/** Wipe everything (called on boot and on graceful shutdown). */
export function clearLiveLocations() {
  liveLocations.clear();
  rejectStreaks.clear();
}
