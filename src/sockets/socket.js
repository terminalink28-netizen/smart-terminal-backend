import { Server } from 'socket.io';

/**
 * In-memory live tracking store.
 * Automatically cleared on server startup.
 */
export const liveLocations = new Map();

/**
 * Manual reset helper.
 */
export const clearLiveLocations = () => {
  liveLocations.clear();
  console.log('🧹 Cleared all live GPS tracking data');
};

// --- CORS FIX ---
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://smart-terminal-frontend.vercel.app' // Your live Vercel URL
];
// ----------------

// ─── GPS trust thresholds ───────────────────────────────────────────────────
// A raw phone GPS fix can be noisy or flat-out wrong. Rather than trust every
// number blindly (which is how "teleporting van" and "500 km/h van" bugs
// happen), we gate both position and speed before broadcasting them.

const MAX_TRUSTED_ACCURACY_M = 75;     // beyond this, treat the fix as unreliable
const MAX_PLAUSIBLE_SPEED_MPS = 55;     // ~198 km/h ceiling — anything above is a bad reading
const MIN_ACCURACY_FOR_SPEED_M = 50;    // speed reading needs tighter accuracy than position alone

export const initializeSockets = (httpServer) => {
  // Always start with a clean cache
  clearLiveLocations();

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins, // Updated to use the VIP list
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('subscribe_to_map', () => {
      socket.join('active_trips');

      socket.emit(
        'initial_locations',
        Array.from(liveLocations.entries())
      );

      console.log(
        `📍 Sent ${liveLocations.size} active locations to ${socket.id}`
      );
    });

    /**
     * Driver GPS Updates
     *
     * Validates the incoming fix before storing/broadcasting it:
     *  - lat/lng must be real numbers
     *  - accuracy is now forwarded (previously silently dropped)
     *  - speed is only trusted if it's non-negative, physically plausible,
     *    and the fix's accuracy is tight enough to trust a speed reading.
     *    Otherwise we forward `null` (unknown) rather than a bogus number —
     *    the frontend distinguishes "0 km/h" from "we don't know" correctly.
     */
    socket.on('driver_gps_update', (data) => {
      const { tripId, lat, lng, speed, accuracy, heading, timestamp } = data;

      if (!tripId) return;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      if (Number.isNaN(lat) || Number.isNaN(lng)) return;

      const safeAccuracy = typeof accuracy === 'number' && accuracy >= 0 ? accuracy : null;

      let trustedSpeed = null;
      if (typeof speed === 'number' && speed >= 0 && speed <= MAX_PLAUSIBLE_SPEED_MPS) {
        if (safeAccuracy === null || safeAccuracy <= MIN_ACCURACY_FOR_SPEED_M) {
          trustedSpeed = speed;
        }
      }

      // If the position itself is too imprecise, still store it (better than
      // nothing) but flag it so the client can show a "low accuracy" state
      // instead of pretending the dot is pinpoint-accurate.
      const positionTrusted = safeAccuracy === null || safeAccuracy <= MAX_TRUSTED_ACCURACY_M;

      const currentData = liveLocations.get(tripId) || {};

      const locationData = {
        ...currentData,
        lat,
        lng,
        speed: trustedSpeed,
        accuracy: safeAccuracy,
        heading: typeof heading === 'number' ? heading : null,
        positionTrusted,
        timestamp: new Date(),
      };

      liveLocations.set(tripId, locationData);

      io.to('active_trips').emit('van_moved', {
        tripId,
        ...locationData,
      });
    });

    /**
     * Live seat updates
     */
    socket.on('seat_update', (data) => {
      const { tripId, availableSeats, totalSeats } = data;

      if (!tripId) return;

      const currentData = liveLocations.get(tripId) || {};

      const updatedData = {
        ...currentData,
        availableSeats,
        totalSeats,
        timestamp: new Date(),
      };

      liveLocations.set(tripId, updatedData);

      io.to('active_trips').emit('seat_update_broadcast', {
        tripId,
        availableSeats,
        totalSeats,
      });
    });

    /**
     * Cleanup when a trip ends
     */
    socket.on('trip_completed', ({ tripId }) => {
      if (!tripId) return;

      liveLocations.delete(tripId);

      io.to('active_trips').emit('trip_removed', {
        tripId,
      });

      console.log(`✅ Removed completed trip ${tripId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🛑 Client disconnected: ${socket.id}`);
    });
  });

  return io;
};