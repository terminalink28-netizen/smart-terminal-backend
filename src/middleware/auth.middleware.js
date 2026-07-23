import jwt from 'jsonwebtoken';

/**
 * Bearer-token auth is now the primary and effectively sole auth path.
 * The cookie fallback is kept only for local dev convenience (same-origin
 * localhost testing) — in production, cross-site cookie delivery through
 * the Vercel proxy has proven unreliable, so every protected route must
 * work correctly via the Authorization header alone.
 */
export const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log('[Auth] Received Authorization header:', authHeader ? 'present' : 'missing');
  
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || req.cookies?.token;

  if (!token) {
    console.warn('[Auth] No token found (header or cookie)');
    return res.status(401).json({ error: 'Authentication required.' });
  }

  // Log a preview of the token (first 20 chars) to see if it's the one we expect
  console.log('[Auth] Token preview:', token.substring(0, 20) + '...');

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    console.log('[Auth] Token verified for user:', decoded.id || decoded.email);
    next();
  } catch (error) {
    // Log the exact verification error
    console.error('[Auth] JWT verification failed:', error.name, error.message);
    // If the error is 'jwt expired', we could send a specific response
    return res.status(401).json({ 
      error: 'Invalid or expired token.',
      details: error.message // optionally include for debugging (remove in production)
    });
  }
};

// Use this strictly after requireAuth
export const requireRoles = (allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role?.toUpperCase();
    const authorizedRoles = allowedRoles.map((role) => role.toUpperCase());

    if (!userRole || !authorizedRoles.includes(userRole)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
    }

    next();
  };
};

// Usage Example in your routes file:
// router.post('/trips/scan', requireAuth, requireRoles(['DISPATCHER', 'ADMIN']), handleQrScan);