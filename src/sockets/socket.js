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

export const initializeSockets = (httpServer) => {
  // Always start with a clean cache
  clearLiveLocations();

  const io = new Server(httpServer, {
    cors: {
      origin: 'http://localhost:3000',
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
     */
    socket.on('driver_gps_update', (data) => {
      const { tripId, lat, lng, speed } = data;

      if (!tripId) return;

      const currentData = liveLocations.get(tripId) || {};

      const locationData = {
        ...currentData,
        lat,
        lng,
        speed,
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