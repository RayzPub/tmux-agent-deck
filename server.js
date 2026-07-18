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

// Helper to get HTML file path (prefer public/dist/ if build exists, otherwise public/)
const getHtmlPath = (filename) => {
  const distPath = path.join(PROJECT_ROOT, 'public', 'dist', filename);
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  return path.join(PROJECT_ROOT, 'public', filename);
};

const app = express();

// Trust proxy headers from CDN/reverse proxy if running on HTTP
if (!useHttps) {
  app.set('trust proxy', true);
}

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

// Middleware to control caching for HTML pages and API endpoints
app.use((req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  const cleanPath = req.path.replace(/\/$/, '');

  if (cleanPath.startsWith('/api')) {
    // API responses must never be stored or cached anywhere (critical for CDN security and real-time state)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (
    ext === '.html' ||
    cleanPath === '' ||
    cleanPath === '/welcome' ||
    cleanPath === '/login' ||
    cleanPath === '/register'
  ) {
    // HTML pages allow协商缓存 (revalidation using ETag/304), but must check with origin on every load
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Initialize IM Bot
imBot.init(app, execTmux, getRunUser, requireAuth);

// Serve login page without authentication
app.get(['/login', '/login.html'], (req, res) => {
  // If already logged in, redirect to index
  const decoded = verifyToken(req);
  if (decoded) {
    if (MULTI_USER_ENABLED && (!decoded.username || !decoded.role || !decoded.isMultiUser)) {
      res.clearCookie('token');
    } else {
      return res.redirect('/');
    }
  }
  res.sendFile(getHtmlPath('login.html'));
});

// Helper to set cache headers on static files (JS, CSS, HTML)
const setStaticCacheHeaders = (res, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.js' || ext === '.css') {
    // All versioned third-party vendor resources placed under a "/vendor/" directory get 1 year strong caching
    if (filePath.split(path.sep).includes('vendor')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // Custom assets & page layouts require revalidation (allows fast 304 if unchanged)
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
};

const codeStaticOptions = {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders
};

const docsStaticOptions = {
  maxAge: '7d', // Cache documentation/images for 7 days
  etag: true,
  lastModified: true
};

app.use('/dist', express.static(path.join(PROJECT_ROOT, 'public', 'dist'), {
  maxAge: '1y',
  immutable: true,
  etag: true,
  lastModified: true
}));

app.use('/css', express.static(path.join(PROJECT_ROOT, 'public', 'css'), codeStaticOptions));
app.use('/js', express.static(path.join(PROJECT_ROOT, 'public', 'js'), codeStaticOptions));
app.use('/images', express.static(path.join(PROJECT_ROOT, 'public', 'images'), docsStaticOptions));
app.use('/docs', express.static(path.join(PROJECT_ROOT, 'docs'), docsStaticOptions));

// Serve welcome page without authentication
app.get('/welcome', (req, res) => {
  res.sendFile(getHtmlPath('welcome.html'));
});

// Serve register page
app.get(['/register', '/register.html'], (req, res) => {
  res.sendFile(getHtmlPath('register.html'));
});

// Protect index.html and other static routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(getHtmlPath('index.html'));
});
app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(getHtmlPath('index.html'));
});

// Fallback to protect any other static files
app.use(express.static(path.join(PROJECT_ROOT, 'public'), {
  index: false, // Prevent serving index.html automatically without requireAuth
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders
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
    console.log(`👤 Username: admin`);
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
    console.log(`👤 Username: admin`);
    console.log(`🔒 Password: ${'•'.repeat(PASSWORD.length)} (configured via env)`);
    console.log(`==================================================`);
  });
}
