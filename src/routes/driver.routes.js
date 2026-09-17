import express from 'express';
import { registerDriver } from '../controllers/driver.controller.js';
import { handleLicenseUpload } from '../middleware/upload.middleware.js';

const router = express.Router();

// Public — anyone can apply; admin gates access via approval
router.post('/register', handleLicenseUpload, registerDriver);

export default router;
