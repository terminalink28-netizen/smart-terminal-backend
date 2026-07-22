import jwt from 'jsonwebtoken';

export const requireAuth = (req, res, next) => {
  // FIX 1: Optional chaining prevents fatal server crashes
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; 
    next();
  } catch (error) {
    // Helpful for backend debugging without exposing secrets to the frontend
    console.error('[Auth Error]:', error.message); 
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

// Use this strictly after requireAuth
export const requireRoles = (allowedRoles) => {
  return (req, res, next) => {
    // FIX 2: Normalize casing to prevent strict-equality mismatches
    const userRole = req.user?.role?.toUpperCase();
    const authorizedRoles = allowedRoles.map(role => role.toUpperCase());

    if (!userRole || !authorizedRoles.includes(userRole)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
    }
    
    next();
  };
};

// Usage Example in your routes file:
// router.post('/trips/scan', requireAuth, requireRoles(['DISPATCHER', 'ADMIN']), handleQrScan);