import express from 'express';
import { 
  getSystemStats,
  // Make sure you have these functions in your admin.controller.js!
  createUser,
  updateUser,
  deleteUser,
  createVan,
  updateVan,
  deleteVan,
  getAuditLogs
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

// ─── Fleet / Vans Management ───
router.post('/vans', createVan);
router.patch('/vans/:id', updateVan);
router.delete('/vans/:id', deleteVan);

// ─── Audit Trail ───
router.get('/audit-logs', getAuditLogs);

export default router;