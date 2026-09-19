// src/liveLocations.js
//
// In-memory store for the last known GPS fix per active trip.
// Swap for Redis if you ever scale beyond one backend instance.

const liveLocations = new Map(); // tripId -> { lat, lng, speed, smoothedSpeed, accuracy, heading, timestamp, positionTrusted }

export const LOCATION_STALE_MS     = 120_000; // 2 min — matches the client threshold
export const UNUSABLE_ACCURACY_M   = 250;     // fixes worse than this are not plotted
const SPEED_SMOOTHING_ALPHA        = 0.4;

/**
 * Records a single fix from the driver's phone. Returns the stored entry
 * (which is what gets broadcast on `van_moved`). Smoothing is applied here
 * so every subscriber sees the same value.
 */
export function recordLocation(tripId, { lat, lng, speed, accuracy, heading }) {
  if (!tripId || typeof lat !== 'number' || typeof lng !== 'number') return null;

  const now = Date.now();
  const prev = liveLocations.get(tripId);
  const rawSpeed = typeof speed === 'number' ? speed : null;

  const smoothedSpeed =
    rawSpeed === null
      ? prev?.smoothedSpeed ?? null
      : prev?.smoothedSpeed == null
      ? rawSpeed
      : prev.smoothedSpeed * (1 - SPEED_SMOOTHING_ALPHA) + rawSpeed * SPEED_SMOOTHING_ALPHA;

  const entry = {
    lat,
    lng,
    speed: rawSpeed,
    smoothedSpeed,
    accuracy: typeof accuracy === 'number' ? accuracy : null,
    heading: typeof heading === 'number' ? heading : prev?.heading ?? null,
    timestamp: now,
    positionTrusted:
      typeof accuracy !== 'number' ? true : accuracy <= UNUSABLE_ACCURACY_M,
  };

  liveLocations.set(tripId, entry);
  return entry;
}

/** Returns the fix for a trip, or null if missing / stale. Prunes stale entries. */
export function getLiveLocation(tripId) {
  const data = liveLocations.get(tripId);
  if (!data) return null;
  if (Date.now() - data.timestamp > LOCATION_STALE_MS) {
    liveLocations.delete(tripId);
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
      continue;
    }
    out.push([tripId, data]);
  }
  return out;
}

/** Drop a single trip's fix (called on COMPLETED / CANCELLED). */
export function clearTripLocation(tripId) {
  liveLocations.delete(tripId);
}

/** Wipe everything (called on boot and on graceful shutdown). */
export function clearLiveLocations() {
  liveLocations.clear();
}
