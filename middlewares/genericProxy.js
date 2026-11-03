const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'data', 'proxy_routes.json');

// System critical routes that cannot be overridden by generic proxy
const RESERVED_PREFIXES = new Set([
  '/',
  '/api',
  '/socket.io',
  '/login',
  '/register',
  '/welcome',
  '/v1',
  '/llm/v1',
  '/dist',
  '/css',
  '/js',
  '/icons',
  '/images',
  '/docs',
  '/sw.js'
]);

// Hop-by-hop headers that must be stripped before forwarding (RFC 7230)
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

let cachedRoutes = null;
let lastConfigFileMtime = 0;
let lastEnvRoutesStr = null;

function normalizeEntry(rawPrefix, rawTarget) {
  const stripPrefix = rawPrefix.startsWith('^');
  let prefix = stripPrefix ? rawPrefix.slice(1).trim() : rawPrefix.trim();
  if (!prefix.startsWith('/')) {
    prefix = '/' + prefix;
  }
  // Remove trailing slashes (e.g. /hub/ -> /hub)
  prefix = prefix.replace(/\/+$/, '') || '/';

  // Security check 1: Reject root '/' or reserved system prefixes
  if (prefix === '/' || RESERVED_PREFIXES.has(prefix)) {
    console.warn(`🛡️ [Proxy Gateway Security] Blocked attempt to register reserved prefix "${prefix}".`);
    return null;
  }

  try {
    const targetUrl = new URL(rawTarget.trim());
    // Security check 2: Only allow http and https upstream targets
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      console.warn(`🛡️ [Proxy Gateway Security] Invalid protocol "${targetUrl.protocol}" in "${rawTarget}".`);
      return null;
    }
    return {
      prefix,
      stripPrefix,
      target: targetUrl
    };
  } catch (err) {
    console.error(`❌ [Proxy Gateway] Malformed target URL "${rawTarget}":`, err.message);
    return null;
  }
}

function loadProxyRoutes() {
  const routes = [];
  const registeredPrefixes = new Set();

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const json = JSON.parse(content);
      if (typeof json === 'object' && json !== null) {
        for (const [rawPrefix, rawTarget] of Object.entries(json)) {
          const parsed = normalizeEntry(rawPrefix, String(rawTarget));
          if (parsed && !registeredPrefixes.has(parsed.prefix)) {
            routes.push(parsed);
            registeredPrefixes.add(parsed.prefix);
          }
        }
      }
    }
  } catch (err) {
    console.error(`❌ [Proxy Gateway] Failed to read ${CONFIG_FILE}:`, err.message);
  }

  const envRoutesStr = process.env.PROXY_ROUTES || '';
  if (envRoutesStr.trim()) {
    const rawEntries = envRoutesStr.split(',').map(s => s.trim()).filter(Boolean);
    for (const entry of rawEntries) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx !== -1) {
        const rawPrefix = entry.slice(0, eqIdx);
        const rawTarget = entry.slice(eqIdx + 1);
        const parsed = normalizeEntry(rawPrefix, rawTarget);
        if (parsed && !registeredPrefixes.has(parsed.prefix)) {
          routes.push(parsed);
          registeredPrefixes.add(parsed.prefix);
        }
      }
    }
  }

  return routes;
}

function getProxyRoutes() {
  let fileMtime = 0;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fileMtime = fs.statSync(CONFIG_FILE).mtimeMs;
    }
  } catch (_) {}

  const currentEnv = process.env.PROXY_ROUTES || '';

  if (cachedRoutes === null || fileMtime !== lastConfigFileMtime || currentEnv !== lastEnvRoutesStr) {
    cachedRoutes = loadProxyRoutes();
    lastConfigFileMtime = fileMtime;
    lastEnvRoutesStr = currentEnv;
    if (cachedRoutes.length > 0) {
      console.log(`🌐 [Proxy Gateway] Active routes updated (${cachedRoutes.length} rules):`);
      cachedRoutes.forEach(r => console.log(`   ➜ ${r.prefix} => ${r.target.origin} (stripPrefix: ${r.stripPrefix})`));
    }
  }

  return cachedRoutes;
}

function matchProxyRoute(reqUrl) {
  const routes = getProxyRoutes();
  if (routes.length === 0) return null;

  for (const route of routes) {
    if (reqUrl === route.prefix || reqUrl.startsWith(route.prefix + '/') || reqUrl.startsWith(route.prefix + '?')) {
      return route;
    }
  }
  return null;
}

/**
 * Validates and securely resolves downstream target path.
 * Neutralizes Path Traversal (.. / %2e%2e / %2f) attacks.
 */
function sanitizeTargetPath(rawUrl, matched) {
  const qIdx = rawUrl.indexOf('?');
  const rawPath = qIdx !== -1 ? rawUrl.slice(0, qIdx) : rawUrl;
  const queryString = qIdx !== -1 ? rawUrl.slice(qIdx) : '';

  // Decode URI component to uncover hidden encoded traversals (%2e%2e%2f)
  let decodedRawPath = rawPath;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
  } catch (_) {
    return { error: 'Malformed URI encoding' };
  }

  // Security Check: Explicitly check for dot-dot traversal sequences in path segments
  const segments = decodedRawPath.split('/');
  if (segments.includes('..')) {
    const normalized = path.posix.normalize(decodedRawPath);
    if (!matched.stripPrefix) {
      if (normalized !== matched.prefix && !normalized.startsWith(matched.prefix + '/')) {
        return { error: 'Path traversal escaped prefix boundary' };
      }
    } else {
      const stripped = decodedRawPath.slice(matched.prefix.length);
      const strippedNormalized = path.posix.normalize('/' + stripped.replace(/^\/+/, ''));
      if (stripped.split('/').includes('..')) {
        return { error: 'Path traversal sequence detected in stripped route' };
      }
    }
  }

  let finalPath = '';
  if (matched.stripPrefix) {
    let stripped = decodedRawPath.slice(matched.prefix.length);
    if (!stripped.startsWith('/')) stripped = '/' + stripped;
    finalPath = path.posix.normalize(stripped);
  } else {
    finalPath = path.posix.normalize(decodedRawPath);
  }

  // Final sanity check: must start with / and not contain /../
  if (!finalPath.startsWith('/') || finalPath.includes('/../') || finalPath === '/..') {
    return { error: 'Invalid normalized target path' };
  }

  return { path: finalPath + queryString };
}

/**
 * Express middleware for secure generic HTTP/HTTPS reverse proxy
 */
function genericProxyMiddleware(req, res, next) {
  const matched = matchProxyRoute(req.url);
  if (!matched) {
    return next();
  }

  // Security Defense: Strict Path Sanitization against Traversal Attacks
  const sanitized = sanitizeTargetPath(req.url, matched);
  if (sanitized.error) {
    console.warn(`🛡️ [Proxy Gateway Security] Blocked suspicious request: ${req.method} ${req.url} (${sanitized.error}) from IP: ${req.socket.remoteAddress}`);
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Suspicious path traversal or malformed URL blocked by gateway security policy'
    });
  }

  const isHttps = matched.target.protocol === 'https:';
  const transport = isHttps ? https : http;

  const targetHost = matched.target.hostname;
  const targetPort = matched.target.port || (isHttps ? 443 : 80);

  // Sanitize headers: remove hop-by-hop headers
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
      forwardHeaders[key] = value;
    }
  }

  // Set standard proxy headers safely
  forwardHeaders['host'] = matched.target.host;
  forwardHeaders['x-forwarded-host'] = req.headers.host || '';
  forwardHeaders['x-forwarded-proto'] = req.protocol || (req.socket.encrypted ? 'https' : 'http');
  forwardHeaders['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${req.socket.remoteAddress}`
    : req.socket.remoteAddress || '';

  const options = {
    hostname: targetHost,
    port: targetPort,
    path: sanitized.path,
    method: req.method,
    headers: forwardHeaders,
    timeout: 30000 // 30s timeout defense against Slowloris
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => {
    console.error(`⏱️ [Proxy Gateway Timeout] ${req.method} ${sanitized.path} timed out after 30s`);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({
        error: 'Gateway Timeout',
        message: 'Upstream service took too long to respond'
      });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`❌ [Proxy Gateway Error] ${req.method} ${req.url} -> ${matched.target.origin}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Bad Gateway',
        message: `Upstream service at ${matched.target.origin} unavailable`,
        detail: err.message
      });
    }
  });

  req.pipe(proxyReq);
}

/**
 * Attach WebSocket upgrade proxy to HTTP/HTTPS server instances
 */
function attachProxyUpgrade(server) {
  if (!server) return;

  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/socket.io')) {
      return;
    }

    const matched = matchProxyRoute(req.url);
    if (!matched) {
      return;
    }

    const sanitized = sanitizeTargetPath(req.url, matched);
    if (sanitized.error) {
      console.warn(`🛡️ [Proxy Gateway Security] Blocked WS upgrade with path traversal: ${req.url}`);
      socket.destroy();
      return;
    }

    const targetPort = parseInt(matched.target.port || '80', 10);
    const targetHost = matched.target.hostname;

    const proxySocket = net.connect(targetPort, targetHost, () => {
      const rawRequest = [
        `${req.method} ${sanitized.path} HTTP/${req.httpVersion}`,
        `Host: ${matched.target.host}`,
        `Connection: Upgrade`,
        `Upgrade: ${req.headers['upgrade'] || 'websocket'}`,
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] || ''}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || '13'}`,
        `X-Forwarded-For: ${req.socket.remoteAddress}`,
        `X-Forwarded-Proto: ${req.socket.encrypted ? 'https' : 'http'}`,
        '\r\n'
      ].join('\r\n');

      proxySocket.write(rawRequest);
      if (head && head.length > 0) {
        proxySocket.write(head);
      }

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxySocket.on('error', (err) => {
      console.error(`❌ [Proxy WS Error] ${req.url} -> ${matched.target.origin}:`, err.message);
      socket.destroy();
    });

    socket.on('error', () => {
      proxySocket.destroy();
    });
  });
}

function initGenericProxy(app, servers = []) {
  getProxyRoutes();
  servers.filter(Boolean).forEach(attachProxyUpgrade);
}

module.exports = {
  genericProxyMiddleware,
  initGenericProxy,
  getProxyRoutes,
  sanitizeTargetPath
};
