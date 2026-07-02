import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import 'dotenv/config';

import authRoutes from './src/routes/auth.routes.js';
import tripRoutes from './src/routes/trip.routes.js';
import trackingRoutes from './src/routes/tracking.routes.js';
import adminRoutes from './src/routes/admin.routes.js';

import {
  initializeSockets,
  clearLiveLocations,
} from './src/sockets/socket.js';

const app = express();
const PORT = process.env.PORT || 5000;

const httpServer = http.createServer(app);

/**
 * Clear stale memory from previous sessions
 */
clearLiveLocations();

/**
 * Start Socket.IO
 */
initializeSockets(httpServer);

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'Platform is running smoothly.',
  });
});

/**
 * Graceful shutdown
 */
const shutdown = () => {
  console.log('\n🛑 Shutting down server...');

  clearLiveLocations();

  httpServer.close(() => {
    console.log('✅ Server stopped');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log('📡 WebSocket server ready');
  console.log('🧹 Live tracking cache cleared');
});