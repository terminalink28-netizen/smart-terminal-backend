// src/routes/driver.routes.js
import express from 'express';
import {
  registerDriver,
  getMyContactNumbers,
  updateMyContactNumbers,
} from '../controllers/driver.controller.js';
import { handleLicenseUpload } from '../middleware/upload.middleware.js';
import { requireAuth, requireRoles } from '../middleware/auth.middleware.js';

const router = express.Router();

// ─── Public: driver self-registration ───
router.post('/register', handleLicenseUpload, registerDriver);

// ─── Driver self-service: contact numbers ───
router.get(
  '/me/contact-numbers',
  requireAuth,
  requireRoles(['DRIVER']),
  getMyContactNumbers,
);

router.patch(
  '/me/contact-numbers',
  requireAuth,
  requireRoles(['DRIVER']),
  updateMyContactNumbers,
);

export default router;
