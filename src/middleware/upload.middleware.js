import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../config/cloudinary.js';

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'terminalink/driver-licenses',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    resource_type: 'auto', // 'auto' matters here — plain 'image' silently mishandles PDFs
    public_id: (req, file) => `license_${req.body.driverId || 'unknown'}_${Date.now()}`,
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error("Only JPG, PNG, or PDF files are allowed for the driver's license."));
};

const uploadLicensePhoto = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('licensePhoto'); // frontend field name must match this

// Wraps multer's callback style so upload errors return clean JSON
// instead of an unhandled exception or multer's raw error shape.
export const handleLicenseUpload = (req, res, next) => {
  uploadLicensePhoto(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};
