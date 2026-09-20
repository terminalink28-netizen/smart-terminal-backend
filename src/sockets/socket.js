// src/sockets/socket.js
import { Server } from 'socket.io';
import {
  getLiveLocationsSnapshot,
  recordLocation,
  clearLiveLocations,
} from '../liveLocations.js';

let io = null;

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://smart-terminal-frontend.vercel.app',
];

export function initializeSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  });

  io.on('connection', (socket) => {
    // ── Public map subscribers ────────────────────────────────────────────
    // The tracking page calls this on mount AND on every reconnect, so it
    // always receives a fresh snapshot of every live van position without
    // waiting for the next GPS ping.
    socket.on('subscribe_to_map', () => {
      socket.join('map');
      socket.emit('initial_locations', getLiveLocationsSnapshot());
    // Relays a driver's seat count to everyone watching the public map.
// Previously nothing listened for this event at all — the driver's
// emit went out into the void, which is why seat counts never updated
// on the public tracking page no matter how often the driver tapped +/-.
socket.on('seat_update', (payload = {}) => {
  const { tripId, availableSeats, totalSeats } = payload;
  if (!tripId || typeof availableSeats !== 'number') return;
  io.to('map').emit('seat_update_broadcast', { tripId, availableSeats, totalSeats });
});

    // ── Driver apps ───────────────────────────────────────────────────────
    // The driver's phone joins `driver:<userId>` after login so the backend
    // can push `start_tracking` / `stop_tracking` to exactly one device.
    socket.on('register_driver', ({ userId } = {}) => {
      if (!userId) return;
      socket.join(`driver:${userId}`);
    });

    // Socket-based GPS streaming (alternative to POST /api/trips/location —
    // the driver app can use either, both funnel into the same store).
    socket.on('driver_location', (payload = {}) => {
      const { tripId, lat, lng, speed, accuracy, heading } = payload;
      if (!tripId || typeof lat !== 'number' || typeof lng !== 'number') return;
      const entry = recordLocation(tripId, { lat, lng, speed, accuracy, heading });
      if (!entry) return;
      io.to('map').emit('van_moved', { tripId, ...entry });
    });

    socket.on('disconnect', () => {
      // Rooms are per-socket by default; nothing to clean up.
    });
  });

  return io;
}

export function getIo() {
  return io;
}

export { clearLiveLocations };
