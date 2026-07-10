const jwt = require('jsonwebtoken');
const { JWT_SECRET, useHttps } = require('../config');

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
  if (!decoded) {
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }
  req.user = decoded;
  next();
};

module.exports = {
  verifyToken,
  requireAuth
};
