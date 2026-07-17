const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const { PROJECT_ROOT, PORT, HTTPS_PORT, PASSWORD, JWT_SECRET, useHttps, sslOptions, MULTI_USER_ENABLED } = require('./config');
const { requireAuth, verifyToken } = require('./middlewares/auth');
const { execTmux, getRunUser } = require('./services/tmuxService');
const { startMonitoring } = require('./services/monitorService');
const { initSocket } = require('./sockets/terminal');
const { runMigration } = require('./services/dbService');
const apiRoutes = require('./routes/api');
const imBot = require('./im-bot');

// Run data migrations on boot
runMigration();

const app = express();

// Enable Gzip compression
app.use(compression());

// Redirect HTTP to HTTPS if enabled
app.use((req, res, next) => {
  if (useHttps && !req.secure) {
    const host = req.headers.host ? req.headers.host.split(':')[0] : 'outshine.cloud';
    const redirectPort = HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`;
    return res.redirect(`https://${host}${redirectPort}${req.url}`);
  }
  next();
});

const httpServer = http.createServer(app);
const httpsServer = useHttps ? https.createServer(sslOptions, app) : null;
const io = socketIo(useHttps ? httpsServer : httpServer);

// Share io instance with express requests
app.set('io', io);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Initialize IM Bot
imBot.init(app, execTmux, getRunUser, requireAuth);

// Serve login page without authentication
app.get('/login.html', (req, res) => {
  // If already logged in, redirect to index
  const decoded = verifyToken(req);
  if (decoded) {
    if (MULTI_USER_ENABLED && (!decoded.username || !decoded.role || !decoded.isMultiUser)) {
      res.clearCookie('token');
    } else {
      return res.redirect('/');
    }
  }
  res.sendFile(path.join(PROJECT_ROOT, 'public', 'login.html'));
});

// Serve static assets (CSS, JS) in public folder that are non-protected (like login page assets)
// JS/CSS must always be fresh: files under public/ ship without a server restart, and
// ES module sub-imports (js/modules/*) cannot carry version query strings, so manual
// ?v= bumps can't bust them. maxAge 0 makes the browser revalidate every load;
// ETag/Last-Modified keep unchanged files at cheap 304s, changed files apply instantly.
const codeStaticOptions = {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }
};
const docsStaticOptions = {
  maxAge: '7d', // Cache documentation/images for 7 days
  etag: true,
  lastModified: true
};

app.use('/css', express.static(path.join(PROJECT_ROOT, 'public', 'css'), codeStaticOptions));
app.use('/js', express.static(path.join(PROJECT_ROOT, 'public', 'js'), codeStaticOptions));
app.use('/images', express.static(path.join(PROJECT_ROOT, 'public', 'images'), docsStaticOptions));
app.use('/docs', express.static(path.join(PROJECT_ROOT, 'docs'), docsStaticOptions));

// Serve welcome page without authentication
app.get('/welcome', (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'public', 'welcome.html'));
});

// Protect index.html and other static routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'public', 'index.html'));
});
app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, 'public', 'index.html'));
});

// Fallback to protect any other static files
app.use(express.static(path.join(PROJECT_ROOT, 'public'), {
  index: false // Prevent serving index.html automatically without requireAuth
}));

// Mount API routes
app.use('/api', apiRoutes);

// Start scanning checker
startMonitoring(io);

// Start Socket.io connections
initSocket(io);

// Enable mouse mode globally in tmux on startup to support mouse wheel scrolling
execTmux(['set-option', '-g', 'mouse', 'on'], (err) => {
  if (err) {
    console.error('Failed to set global tmux mouse option:', err.message);
  } else {
    console.log('✅ Global tmux mouse mode enabled by default');
  }
});

// Start Server
if (useHttps) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    const domain = process.env.DOMAIN_NAME || 'outshine.cloud';
    const displayUrl = HTTPS_PORT === 443 ? `https://${domain}` : `https://${domain}:${HTTPS_PORT}`;
    console.log(`==================================================`);
    console.log(`🚀 Cyberpunk CCNOW started successfully with HTTPS!`);
    console.log(`🔗 URL: ${displayUrl}`);
    console.log(`🔒 Password: ${'•'.repeat(PASSWORD.length)} (configured via env)`);
    console.log(`==================================================`);
  });

  // Start HTTP Redirect Server on PORT
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🔄 HTTP-to-HTTPS redirect server listening on port ${PORT}`);
  });
} else {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`🚀 Cyberpunk CCNOW started successfully!`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
    console.log(`🔒 Password: ${'•'.repeat(PASSWORD.length)} (configured via env)`);
    console.log(`==================================================`);
  });
}
