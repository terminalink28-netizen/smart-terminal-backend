import express from 'express';
import { getSystemStats } from '../controllers/admin.controller.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// CRITICAL: We lock this route down so ONLY the Admin can view it
router.get('/dashboard', requireAuth, requireRoles(['ADMIN']), getSystemStats);

export default router;