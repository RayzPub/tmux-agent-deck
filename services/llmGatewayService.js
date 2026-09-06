const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { PROJECT_ROOT } = require('../config');

const CONFIG_FILE = path.join(PROJECT_ROOT, 'data', 'llm_gateway.json');

// In-memory runtime state for round-robin and health tracking
const runtimeState = {
  pointers: {}, // provider -> current index
  keyHealth: new Map(), // keyString -> { failures: 0, cooldownUntil: 0, lastError: null, lastUsed: 0, successes: 0 }
  stats: {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retriedRequests: 0,
    startTime: Date.now()
  }
};

const DEFAULT_CONFIG = {
  enabled: true,
  allowExternalAccess: false,
  virtualKey: 'sk-deck-local',
  allowLocalhostWithoutKey: true,
  injectToTerminal: true,
  providers: {
    tencent: {
      name: '腾讯云 LKEAP',
      enabled: true,
      keys: [],
      endpoints: {
        anthropic: 'https://api.lkeap.cloud.tencent.com/plan/anthropic',
        openai: 'https://api.lkeap.cloud.tencent.com/plan/v3'
      },
      models: {
        anthropic: ['claude-*'],
        openai: ['glm-5', 'deepseek-*', 'gpt-*']
      }
    },
    kimi: {
      name: 'Moonshot Kimi',
      enabled: true,
      keys: [],
      endpoints: {
        anthropic: 'https://api.kimi.com/coding',
        openai: 'https://api.moonshot.cn/v1'
      },
      models: {
        anthropic: ['k3-256k', 'k3', 'kimi*'],
        openai: ['moonshot-*', 'kimi*']
      }
    }
  },
  defaults: {
    anthropic: 'tencent',
    openai: 'tencent'
  }
};

/**
 * Load gateway config from data/llm_gateway.json, initializing if missing
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        providers: {
          ...DEFAULT_CONFIG.providers,
          ...(parsed.providers || {})
        },
        defaults: {
          ...DEFAULT_CONFIG.defaults,
          ...(parsed.defaults || {})
        }
      };
    }
  } catch (err) {
    console.error('⚠️ [LLM-Gateway] Failed to read config file, using defaults:', err.message);
  }

  // Create default config file if it doesn't exist
  saveConfig(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

/**
 * Save gateway configuration to data/llm_gateway.json
 */
function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('❌ [LLM-Gateway] Failed to save config file:', err.message);
    return false;
  }
}

/**
 * Match a model name against a wildcard pattern (e.g. "k3*", "claude-*", "*")
 */
function matchModelPattern(pattern, modelName) {
  if (!pattern || !modelName) return false;
  const p = pattern.toLowerCase().trim();
  const m = modelName.toLowerCase().trim();
  if (p === '*' || p === m) return true;
  if (p.endsWith('*')) return m.startsWith(p.slice(0, -1));
  if (p.startsWith('*')) return m.endsWith(p.slice(1));
  return false;
}

/**
 * Resolve endpoint URL for a given provider and protocol
 */
function getEndpointForProtocol(provider, protocol) {
  if (!provider) return null;
  if (provider.endpoints && provider.endpoints[protocol]) {
    return provider.endpoints[protocol].trim().replace(/\/+$/, '');
  }
  // Legacy backward compatibility
  if (provider.baseUrl) {
    return provider.baseUrl.trim().replace(/\/+$/, '');
  }
  if (protocol === 'anthropic') return 'https://api.anthropic.com';
  if (protocol === 'openai') return 'https://api.openai.com/v1';
  return null;
}

/**
 * Resolve target provider & endpoint based on protocol, requested model, and providerOverride
 */
function resolveProvider({ config, protocol, model, providerOverride }) {
  const providers = config.providers || {};

  // 1. Explicit override if requested (e.g. /v1/kimi/messages, /v1/tencent/...)
  if (providerOverride && providers[providerOverride] && providers[providerOverride].enabled) {
    const prov = providers[providerOverride];
    const endpoint = getEndpointForProtocol(prov, protocol);
    if (endpoint) {
      return { providerId: providerOverride, providerConfig: prov, endpointUrl: endpoint };
    }
  }

  // 2. Model-based matching against each provider's explicit model list
  if (model) {
    for (const [pId, prov] of Object.entries(providers)) {
      if (!prov || !prov.enabled) continue;
      const supportedModels = (prov.models && prov.models[protocol]) || [];
      const isMatch = supportedModels.some(pattern => matchModelPattern(pattern, model));
      if (isMatch) {
        const endpoint = getEndpointForProtocol(prov, protocol);
        if (endpoint) {
          return { providerId: pId, providerConfig: prov, endpointUrl: endpoint };
        }
      }
    }
    // Strict enforcement: if model is specified but not declared in any provider, do not route!
    return null;
  }

  // 3. Fallback to protocol default provider ONLY when no model was specified in the request
  const defaultProvId = (config.defaults && config.defaults[protocol]) || 'tencent';
  if (providers[defaultProvId] && providers[defaultProvId].enabled) {
    const prov = providers[defaultProvId];
    const endpoint = getEndpointForProtocol(prov, protocol);
    if (endpoint) {
      return { providerId: defaultProvId, providerConfig: prov, endpointUrl: endpoint };
    }
  }

  return null;
}

/**
 * Get available keys for a provider (config keys + system environment fallbacks)
 */
function getProviderKeys(providerName, config) {
  const provider = (config.providers && config.providers[providerName]) || {};
  let keys = Array.isArray(provider.keys)
    ? provider.keys.map(k => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)
    : [];

  if (keys.length === 0) {
    // Attempt fallback from env or system default keys
    let fallbackKey = null;
    if (providerName === 'tencent' || providerName === 'anthropic') {
      fallbackKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    } else if (providerName === 'kimi') {
      fallbackKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
    } else if (providerName === 'openai') {
      fallbackKey = process.env.OPENAI_API_KEY;
    }

    if (!fallbackKey) {
      try {
        const { getSystemDefaultKeys } = require('./fileService');
        const defaultKeys = getSystemDefaultKeys();
        if ((providerName === 'tencent' || providerName === 'anthropic') && defaultKeys.claude) {
          fallbackKey = defaultKeys.claude;
        }
        if (providerName === 'kimi' && defaultKeys.kimi) {
          fallbackKey = defaultKeys.kimi;
        }
        if (providerName === 'openai' && defaultKeys.codex) {
          fallbackKey = defaultKeys.codex;
        }
      } catch (e) {}
    }

    if (fallbackKey && typeof fallbackKey === 'string') {
      keys.push(fallbackKey.trim());
    }
  }

  return keys;
}

/**
 * Key health tracking and round-robin selection
 */
function getNextKey(providerName, config, excludedKeys = new Set()) {
  const keys = getProviderKeys(providerName, config);
  if (!keys || keys.length === 0) {
    return null;
  }

  const now = Date.now();
  let candidates = keys.filter(k => !excludedKeys.has(k));
  let healthyCandidates = candidates.filter(k => {
    const health = runtimeState.keyHealth.get(k);
    return !health || health.cooldownUntil <= now;
  });

  if (healthyCandidates.length === 0) {
    healthyCandidates = candidates;
  }
  if (healthyCandidates.length === 0) {
    return null;
  }

  if (runtimeState.pointers[providerName] === undefined) {
    runtimeState.pointers[providerName] = 0;
  }

  const selectedIndex = runtimeState.pointers[providerName] % healthyCandidates.length;
  runtimeState.pointers[providerName] = (selectedIndex + 1) % healthyCandidates.length;

  const selectedKey = healthyCandidates[selectedIndex];

  const health = runtimeState.keyHealth.get(selectedKey) || {
    failures: 0,
    cooldownUntil: 0,
    lastError: null,
    lastUsed: 0,
    successes: 0
  };
  health.lastUsed = now;
  runtimeState.keyHealth.set(selectedKey, health);

  return selectedKey;
}

/**
 * Record upstream response status for key health and cooldown
 */
function recordKeyResult(key, statusCode, statusText = '') {
  if (!key) return;
  const health = runtimeState.keyHealth.get(key) || {
    failures: 0,
    cooldownUntil: 0,
    lastError: null,
    lastUsed: 0,
    successes: 0
  };

  const now = Date.now();
  if (statusCode >= 200 && statusCode < 300) {
    health.successes += 1;
    health.failures = 0;
    health.cooldownUntil = 0;
    health.lastError = null;
  } else if (statusCode === 429) {
    health.failures += 1;
    health.cooldownUntil = now + 60 * 1000;
    health.lastError = `429 Too Many Requests (${statusText})`;
    console.warn(`⚠️ [LLM-Gateway] Key ${maskKey(key)} hit 429 rate limit. Cooling down for 60s.`);
  } else if (statusCode === 401 || statusCode === 403) {
    health.failures += 1;
    health.cooldownUntil = now + 10 * 60 * 1000;
    health.lastError = `${statusCode} Auth Failed (${statusText})`;
    console.warn(`❌ [LLM-Gateway] Key ${maskKey(key)} failed auth (${statusCode}). Cooling down for 10m.`);
  } else if (statusCode >= 500) {
    health.failures += 1;
    health.cooldownUntil = now + 15 * 1000;
    health.lastError = `${statusCode} Upstream Error`;
  }

  runtimeState.keyHealth.set(key, health);
}

/**
 * Helper to mask sensitive keys in logs and admin UI
 */
function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

/**
 * Security: Check if client is allowed to access the gateway
 */
function authenticateClient(req, config) {
  if (!config.enabled) {
    return { ok: false, status: 503, error: 'LLM Gateway is currently disabled' };
  }

  const rawIp = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || '';
  const isLocalhost =
    rawIp === '127.0.0.1' ||
    rawIp === '::1' ||
    rawIp === '::ffff:127.0.0.1';

  // Strategy A: Localhost loopback only
  if (!config.allowExternalAccess && !isLocalhost) {
    return {
      ok: false,
      status: 403,
      error: `Access Denied: LLM Gateway is restricted to local loopback (127.0.0.1). External IP '${rawIp}' is rejected.`
    };
  }

  // Localhost zero-config bypass
  if (isLocalhost && config.allowLocalhostWithoutKey) {
    return { ok: true, client: 'localhost' };
  }

  // Header token extraction
  const authHeader = req.headers['authorization'] || '';
  const xApiKey = req.headers['x-api-key'] || '';
  let clientKey = '';

  if (authHeader.startsWith('Bearer ')) {
    clientKey = authHeader.slice(7).trim();
  } else if (xApiKey) {
    clientKey = xApiKey.trim();
  }

  const vKey = config.virtualKey || 'sk-deck-local';
  if (clientKey === vKey) {
    return { ok: true, client: 'virtualKey' };
  }

  return { ok: false, status: 401, error: 'Invalid API key or Authorization header' };
}

/**
 * Core Proxy Handler: Forward request to upstream provider with streaming, retry & prompt cache preservation
 */
async function forwardRequest({ req, res, protocol, subPath, providerOverride, providerName }) {
  runtimeState.stats.totalRequests += 1;
  const config = loadConfig();

  // 1. Authenticate client
  const auth = authenticateClient(req, config);
  if (!auth.ok) {
    runtimeState.stats.failedRequests += 1;
    return res.status(auth.status).json({
      error: { message: auth.error, type: 'gateway_auth_error' }
    });
  }

  // 2. Resolve protocol
  const targetProtocol = (
    protocol ||
    (subPath && (subPath.includes('messages') || subPath.includes('complete')) ? 'anthropic' : 'openai')
  ).toLowerCase();

  const body = req.body || {};
  const model = typeof body.model === 'string' ? body.model : '';

  // 3. Resolve target provider and endpoint
  const target = resolveProvider({
    config,
    protocol: targetProtocol,
    model,
    providerOverride: providerOverride || (providerName && !['anthropic', 'openai'].includes(providerName) ? providerName : null)
  });

  if (!target) {
    runtimeState.stats.failedRequests += 1;
    const allowed = [];
    for (const prov of Object.values(config.providers || {})) {
      if (prov.enabled && prov.models && Array.isArray(prov.models[targetProtocol])) {
        allowed.push(...prov.models[targetProtocol]);
      }
    }
    return res.status(400).json({
      error: {
        message: model
          ? `Model '${model}' is not declared for protocol '${targetProtocol}'. Declared models: [${allowed.join(', ')}]`
          : `No enabled provider found for protocol '${targetProtocol}'.`,
        type: 'model_not_declared',
        param: 'model',
        code: 'model_not_supported'
      }
    });
  }

  const { providerId, endpointUrl } = target;
  const cleanSubPath = subPath.startsWith('/') ? subPath : `/${subPath}`;
  const targetUrl = `${endpointUrl}${cleanSubPath}`;

  // 4. Prepare body and headers
  const isPostOrPut = ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase());
  let requestBody = null;
  if (isPostOrPut && req.body) {
    requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  const excludedKeys = new Set();
  const maxAttempts = Math.min(getProviderKeys(providerId, config).length || 1, 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const upstreamKey = getNextKey(providerId, config, excludedKeys);
    if (!upstreamKey) {
      break;
    }
    excludedKeys.add(upstreamKey);

    if (attempt > 1) {
      runtimeState.stats.retriedRequests += 1;
      console.log(`🔄 [LLM-Gateway] Retrying (${attempt}/${maxAttempts}) with next key for provider '${providerId}'`);
    }

    // Build headers to send upstream
    const HOP_BY_HOP = new Set([
      'host',
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'content-length',
      'accept-encoding',
      'authorization',
      'x-api-key'
    ]);

    const upstreamHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      upstreamHeaders[key] = value;
    }

    // Inject upstream credentials based on protocol
    if (targetProtocol === 'anthropic') {
      upstreamHeaders['x-api-key'] = upstreamKey;
      if (!upstreamHeaders['anthropic-version']) {
        upstreamHeaders['anthropic-version'] = '2023-06-01';
      }
    } else {
      // OpenAI / Compatible
      upstreamHeaders['Authorization'] = `Bearer ${upstreamKey}`;
    }

    if (isPostOrPut && !upstreamHeaders['content-type']) {
      upstreamHeaders['content-type'] = 'application/json';
    }

    const abortController = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    res.on('close', onResClose);

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body: isPostOrPut ? requestBody : undefined,
        signal: abortController.signal
      });

      // Record key health status
      recordKeyResult(upstreamKey, upstreamRes.status, upstreamRes.statusText);

      // Retry on 429 or 5xx if more keys available
      if ((upstreamRes.status === 429 || upstreamRes.status >= 500) && attempt < maxAttempts) {
        lastError = `Status ${upstreamRes.status}: ${upstreamRes.statusText}`;
        continue;
      }

      // Relay response status and headers
      res.status(upstreamRes.status);
      upstreamRes.headers.forEach((val, name) => {
        const lower = name.toLowerCase();
        if (!['content-encoding', 'transfer-encoding', 'connection'].includes(lower)) {
          res.setHeader(name, val);
        }
      });

      // Stream response body
      if (upstreamRes.body) {
        const nodeStream = Readable.fromWeb(upstreamRes.body);
        nodeStream.pipe(res);
      } else {
        res.end();
      }

      runtimeState.stats.successfulRequests += 1;
      return;
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        return; // Client disconnected
      }
      recordKeyResult(upstreamKey, 500, fetchErr.message);
      lastError = fetchErr.message;
      console.warn(`⚠️ [LLM-Gateway] Provider '${providerId}' attempt ${attempt} error:`, fetchErr.message);
    } finally {
      res.removeListener('close', onResClose);
    }
  }

  // If all attempts failed
  runtimeState.stats.failedRequests += 1;
  return res.status(502).json({
    error: {
      message: `LLM Gateway: Failed to reach upstream provider '${providerId}' (${targetProtocol}) after ${maxAttempts} attempts. ${lastError || 'No available keys.'}`,
      type: 'gateway_upstream_error'
    }
  });
}

/**
 * Get full gateway status and diagnostic info for Admin panel
 */
function getGatewayStatus() {
  const config = loadConfig();
  const providerStats = {};

  for (const [name, p] of Object.entries(config.providers || {})) {
    const rawKeys = getProviderKeys(name, config);
    const masked = rawKeys.map(k => {
      const health = runtimeState.keyHealth.get(k) || {};
      return {
        masked: maskKey(k),
        successes: health.successes || 0,
        failures: health.failures || 0,
        inCooldown: (health.cooldownUntil || 0) > Date.now(),
        lastUsed: health.lastUsed ? new Date(health.lastUsed).toISOString() : null,
        lastError: health.lastError || null
      };
    });

    providerStats[name] = {
      name: p.name || name,
      enabled: !!p.enabled,
      endpoints: p.endpoints || { [p.protocol || 'anthropic']: p.baseUrl },
      models: p.models || {},
      keyCount: rawKeys.length,
      keys: masked
    };
  }

  return {
    enabled: config.enabled,
    allowExternalAccess: !!config.allowExternalAccess,
    virtualKey: config.virtualKey,
    allowLocalhostWithoutKey: config.allowLocalhostWithoutKey,
    injectToTerminal: config.injectToTerminal,
    defaults: config.defaults || {},
    stats: {
      ...runtimeState.stats,
      uptimeSeconds: Math.floor((Date.now() - runtimeState.stats.startTime) / 1000)
    },
    providers: providerStats
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  getProviderKeys,
  getNextKey,
  recordKeyResult,
  resolveProvider,
  matchModelPattern,
  forwardRequest,
  getGatewayStatus,
  maskKey
};
