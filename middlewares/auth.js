const jwt = require('jsonwebtoken');
const { JWT_SECRET, MULTI_USER_ENABLED } = require('../config');

// Helper: Verify JWT from cookie
const verifyToken = (req) => {
  const token = req.cookies.token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
};

// Middleware: Require Auth for API and static pages
const requireAuth = (req, res, next) => {
  const decoded = verifyToken(req);

  // No token or invalid token
  if (!decoded) {
    // Clear invalid cookie
    res.clearCookie('token');
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/welcome');
  }

  // Multi-user mode: strict token validation
  if (MULTI_USER_ENABLED) {
    // Reject legacy tokens: only accept tokens with username, role, and isMultiUser flag
    if (!decoded.username || !decoded.role || !decoded.isMultiUser) {
      // Clear invalid cookie
      res.clearCookie('token');
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Token expired: please re-login' });
      }
      return res.redirect('/welcome');
    }
    req.user = {
      username: decoded.username,
      role: decoded.role
    };
  } else {
    // Single-user mode: default to admin
    req.user = {
      username: decoded.username || 'admin',
      role: decoded.role || 'admin'
    };
  }

  next();
};

// Middleware: Require Admin role (only checked if MULTI_USER_ENABLED is true)
const requireAdmin = (req, res, next) => {
  requireAuth(req, res, () => {
    if (MULTI_USER_ENABLED && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
  });
};

module.exports = {
  verifyToken,
  requireAuth,
  requireAdmin
};
