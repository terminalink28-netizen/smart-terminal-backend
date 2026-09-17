import express from 'express';
import { 
  getSystemStats,
  createUser,
  updateUser,
  deleteUser,
  createVan,
  updateVan,
  deleteVan,
  getAuditLogs,
  getPendingDrivers,
  approveDriver,
  rejectDriver
} from '../controllers/admin.controller.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// Apply the auth and role middleware to ALL routes in this file
router.use(requireAuth);
router.use(requireRoles(['ADMIN']));

// ─── Dashboard Stats ───
router.get('/dashboard', getSystemStats);

// ─── Staff / Users Management ───
router.post('/users', createUser);
router.patch('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

router.get('/drivers/pending', getPendingDrivers);
router.patch('/drivers/:id/approve', approveDriver);
router.patch('/drivers/:id/reject', rejectDriver);

// ─── Fleet / Vans Management ───
router.post('/vans', createVan);
router.patch('/vans/:id', updateVan);
router.delete('/vans/:id', deleteVan);

// ─── Audit Trail ───
router.get('/audit-logs', getAuditLogs);

export default router;
