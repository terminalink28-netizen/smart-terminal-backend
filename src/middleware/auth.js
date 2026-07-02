// File: src/middleware/auth.js
import jwt from 'jsonwebtoken';

export const requireAuth = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; 
    next();
  } catch (error) {
    console.error('[Auth Error]:', error.message); 
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

export const requireRoles = (allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role?.toUpperCase();
    const authorizedRoles = allowedRoles.map(role => role.toUpperCase());

    if (!userRole || !authorizedRoles.includes(userRole)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
    }
    
    next();
  };
};