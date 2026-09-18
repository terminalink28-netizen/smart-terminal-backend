import express from 'express';
import { registerDriver, getAvailableVans } from '../controllers/driver.controller.js';
import { handleLicenseUpload } from '../middleware/upload.middleware.js';

const router = express.Router();

router.get('/available-vans', getAvailableVans);
router.post('/register', handleLicenseUpload, registerDriver);

export default router;
