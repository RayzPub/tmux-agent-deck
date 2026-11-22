const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');

const { PASSWORD, JWT_SECRET, useHttps, PROJECT_ROOT, MULTI_USER_ENABLED, IM_BOT_ENABLED } = require('../config');
const { requireAuth, requireAdmin, verifyToken } = require('../middlewares/auth');
const { resolveWorkspacePath, safeResolve, getDefaultWorkspacePath, updateUserKeysFile, syncAllUserKeysFiles, ensureClaudeSettings, ensureCodexConfig } = require('../services/fileService');

// Multer memory storage configuration for file upload (supports up to 20 files, 50MB each)
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20
  }
});
const { getPublicKey, registerSubscription, unregisterSubscription, sendPushToAll } = require('../services/pushService');
const db = require('../services/dbService');
const iconService = require('../services/iconService');
const llmGatewayService = require('../services/llmGatewayService');
const projectService = require('../services/projectService');
const deviceService = require('../services/deviceService');
const containerService = require('../services/containerService');
const { requireDeviceOwnership } = require('../middlewares/deviceGuard');

// Global middleware to guard device access across all API endpoints
router.use(requireDeviceOwnership);

const NO_ONLINE_DEVICE_MSG = '当前没有在线设备，请先在「设备管理」中启动云电脑或连接我的电脑';

// Resolve target deviceId for unified compute routing (never executes locally on control plane)
function resolveComputeDeviceId(req) {
  const explicit = req.query.deviceId || (req.body && req.body.deviceId);
  if (explicit && explicit !== 'cloud') return explicit;
  const username = req.user ? req.user.username : (MULTI_USER_ENABLED ? null : 'admin');
  return deviceService.resolveDefaultDeviceId(username);
}

// Shell escape utility for safe command interpolation
const shellescape = (s) => {
  if (s == null) return "''";
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
};


// API: Login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Single-user mode compatibility
  if (!MULTI_USER_ENABLED) {
    if (password === PASSWORD) {
      const token = jwt.sign({ username: 'admin', role: 'admin', isMultiUser: false }, JWT_SECRET, { expiresIn: '7d' });
      res.cookie('token', token, {
        httpOnly: true,
        secure: req.secure || useHttps,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });
      return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Multi-user login
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const users = db.getUsers();
  const user = users[username.toLowerCase()];
  if (!user || !db.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ username: user.username, role: user.role, isMultiUser: true }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: req.secure || useHttps,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
  res.json({ success: true });
});

// API: Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// API: Check Auth status
router.get('/auth-status', (req, res) => {
  const decoded = verifyToken(req);

  // Not authenticated
  if (!decoded) {
    return res.json({
      authenticated: false,
      multiUserEnabled: MULTI_USER_ENABLED,
      username: null,
      role: null
    });
  }

  // Multi-user mode: only accept tokens with username and role
  if (MULTI_USER_ENABLED) {
    if (!decoded.username || !decoded.role || !decoded.isMultiUser) {
      res.clearCookie('token');
      return res.json({
        authenticated: false,
        multiUserEnabled: MULTI_USER_ENABLED,
        username: null,
        role: null
      });
    }
  }

  // Valid token
  res.json({
    authenticated: true,
    multiUserEnabled: MULTI_USER_ENABLED,
    imBotEnabled: IM_BOT_ENABLED,
    username: decoded.username || 'admin',
    role: decoded.role || 'admin'
  });
});

// API: Register with invite code
router.post('/auth/register', (req, res) => {
  if (!MULTI_USER_ENABLED) {
    return res.status(400).json({ error: 'Registration is not enabled in single-user mode' });
  }

  const { code, username, password } = req.body;
  if (!code || !username || !password) {
    return res.status(400).json({ error: 'Code, username and password are required' });
  }

  if (!/^[a-zA-Z0-9_-]{3,15}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username. Use 3-15 alphanumeric characters.' });
  }

  const result = db.registerUserWithInviteCode({ code, username, password });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ success: true, message: 'Account registered successfully!' });
});

// API: Get invite codes (Admin only)
router.get('/admin/invite-codes', requireAdmin, (req, res) => {
  res.json(db.getCodes());
});

// API: Generate new invite code (Admin only)
router.post('/admin/invite-codes', requireAdmin, (req, res) => {
  const { note } = req.body;
  const codes = db.getCodes();
  
  // Generate random 8-character code
  const code = 'INV-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
  
  const newInvite = {
    code,
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
    status: 'pending',
    usedBy: null,
    usedAt: null,
    note: note || ''
  };

  codes.push(newInvite);
  db.saveCodes(codes);
  res.json({ success: true, invite: newInvite });
});

// API: Delete invite code (Admin only)
router.delete('/admin/invite-codes/:code', requireAdmin, (req, res) => {
  const { code } = req.params;
  let codes = db.getCodes();
  const filtered = codes.filter(c => c.code !== code);
  if (filtered.length === codes.length) {
    return res.status(404).json({ error: 'Invite code not found' });
  }
  db.saveCodes(filtered);
  res.json({ success: true });
});

// API: Get global settings (Authenticated users)
router.get('/settings', requireAuth, (req, res) => {
  res.json(db.getSettings());
});

// Helper to mask sensitive keys
const maskKey = (key) => {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return key.substring(0, 6) + '••••••••';
};

// API: Get user API keys (Authenticated users)
router.get('/user/keys', requireAuth, (req, res) => {
  const users = db.getUsers();
  const usernameKey = (req.user && req.user.username ? req.user.username : 'admin').toLowerCase();
  const userObj = users[usernameKey] || (!MULTI_USER_ENABLED ? {} : null);
  if (!userObj) {
    return res.status(404).json({ error: 'User not found' });
  }
  const keys = userObj.apiKeys || {};
  res.json({
    agy: maskKey(keys.agy),
    claude: maskKey(keys.claude),
    codex: maskKey(keys.codex),
    kimi: maskKey(keys.kimi),
    claudeBaseUrl: keys.claudeBaseUrl || '',
    codexBaseUrl: keys.codexBaseUrl || '',
    kimiBaseUrl: keys.kimiBaseUrl || '',
    claudeModel: keys.claudeModel || '',
    codexModel: keys.codexModel || '',
    kimiModel: keys.kimiModel || ''
  });
});

// API: Update user API keys (Authenticated users)
router.post('/user/keys', requireAuth, (req, res) => {
  const { agy, claude, codex, kimi, claudeBaseUrl, codexBaseUrl, kimiBaseUrl, claudeModel, codexModel, kimiModel } = req.body;
  const users = db.getUsers();
  const usernameKey = (req.user && req.user.username ? req.user.username : 'admin').toLowerCase();
  if (!users[usernameKey] && !MULTI_USER_ENABLED) {
    users[usernameKey] = {
      username: req.user.username || 'admin',
      role: 'admin',
      createdAt: new Date().toISOString(),
      apiKeys: {}
    };
  }
  const userObj = users[usernameKey];
  if (!userObj) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (!userObj.apiKeys) {
    userObj.apiKeys = {};
  }
  
  const updateKey = (existing, incoming) => {
    if (incoming === undefined) return existing;
    if (incoming === '') return ''; // Delete/clear key
    if (incoming.includes('•')) return existing; // Masked value, do not overwrite
    return incoming.trim();
  };

  const updateUrl = (existing, incoming) => {
    if (incoming === undefined) return existing;
    return incoming.trim();
  };

  userObj.apiKeys.agy = updateKey(userObj.apiKeys.agy, agy);
  userObj.apiKeys.claude = updateKey(userObj.apiKeys.claude, claude);
  userObj.apiKeys.codex = updateKey(userObj.apiKeys.codex, codex);
  userObj.apiKeys.kimi = updateKey(userObj.apiKeys.kimi, kimi);
  userObj.apiKeys.claudeBaseUrl = updateUrl(userObj.apiKeys.claudeBaseUrl, claudeBaseUrl);
  userObj.apiKeys.codexBaseUrl = updateUrl(userObj.apiKeys.codexBaseUrl, codexBaseUrl);
  userObj.apiKeys.kimiBaseUrl = updateUrl(userObj.apiKeys.kimiBaseUrl, kimiBaseUrl);
  userObj.apiKeys.claudeModel = updateUrl(userObj.apiKeys.claudeModel, claudeModel);
  userObj.apiKeys.codexModel = updateUrl(userObj.apiKeys.codexModel, codexModel);
  userObj.apiKeys.kimiModel = updateUrl(userObj.apiKeys.kimiModel, kimiModel);

  db.saveUsers(users);

  // Write keys to the user's private .api_keys configuration file in their home directory
  updateUserKeysFile(req.user.username, userObj.apiKeys);

  res.json({ success: true });
});

// API: Get app icon themes (Authenticated users)
router.get('/app-icons', requireAuth, (req, res) => {
  const themes = iconService.getThemes();
  const activeTheme = iconService.getActiveTheme();
  res.json({
    themes,
    activeTheme
  });
});

// API: Get admin settings (Admin only)
router.get('/admin/settings', requireAdmin, (req, res) => {
  res.json(db.getSettings());
});

// API: Update admin settings (Admin only)
router.post('/admin/settings', requireAdmin, (req, res) => {
  const { enabledAgents, appIcon, claudeOAuthMode } = req.body;
  const current = db.getSettings();

  if (enabledAgents !== undefined) {
    if (!Array.isArray(enabledAgents)) {
      return res.status(400).json({ error: 'enabledAgents must be an array' });
    }
    current.enabledAgents = enabledAgents;
  }

  if (claudeOAuthMode !== undefined) {
    current.claudeOAuthMode = !!claudeOAuthMode;
  }

  if (appIcon !== undefined) {
    if (typeof appIcon !== 'string') {
      return res.status(400).json({ error: 'appIcon must be a string' });
    }
    try {
      iconService.setActiveTheme(appIcon);
      current.appIcon = appIcon;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else {
    db.saveSettings(current);
  }

  if (claudeOAuthMode !== undefined) {
    syncAllUserKeysFiles();
  }

  res.json({ success: true, settings: current });
});

// API: Get LLM Gateway status & config (Admin only)
router.get('/admin/llm-gateway', requireAdmin, (req, res) => {
  res.json(llmGatewayService.getGatewayStatus());
});

// API: Get Raw LLM Gateway configuration JSON (Admin only)
router.get('/admin/llm-gateway/raw', requireAdmin, (req, res) => {
  try {
    const config = llmGatewayService.loadConfig();
    res.json({ success: true, config, raw: JSON.stringify(config, null, 2) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load LLM gateway config: ' + err.message });
  }
});

// API: Save Raw LLM Gateway configuration JSON (Admin only)
router.post('/admin/llm-gateway/raw', requireAdmin, (req, res) => {
  try {
    let newConfig = req.body.config;
    if (typeof req.body.raw === 'string') {
      try {
        newConfig = JSON.parse(req.body.raw);
      } catch (parseErr) {
        return res.status(400).json({ error: 'JSON 语法错误: ' + parseErr.message });
      }
    }
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
      return res.status(400).json({ error: '配置必须是一个有效的 JSON 对象' });
    }
    const ok = llmGatewayService.saveConfig(newConfig);
    if (!ok) {
      return res.status(500).json({ error: '保存配置文件失败' });
    }
    res.json({ success: true, message: 'LLM 网关配置已保存并生效', config: newConfig });
  } catch (err) {
    res.status(500).json({ error: '保存失败: ' + err.message });
  }
});

// API: Update LLM Gateway config (Admin only)
router.post('/admin/llm-gateway', requireAdmin, (req, res) => {
  const { enabled, allowExternalAccess, virtualKey, allowLocalhostWithoutKey, injectToTerminal, providers } = req.body;
  const current = llmGatewayService.loadConfig();

  if (enabled !== undefined) current.enabled = !!enabled;
  if (allowExternalAccess !== undefined) current.allowExternalAccess = !!allowExternalAccess;
  if (virtualKey !== undefined) current.virtualKey = String(virtualKey).trim();
  if (allowLocalhostWithoutKey !== undefined) current.allowLocalhostWithoutKey = !!allowLocalhostWithoutKey;
  if (injectToTerminal !== undefined) current.injectToTerminal = !!injectToTerminal;

  if (providers && typeof providers === 'object') {
    for (const [pName, pConfig] of Object.entries(providers)) {
      if (!current.providers[pName]) {
        current.providers[pName] = { enabled: true, baseUrl: '', keys: [] };
      }
      if (pConfig.enabled !== undefined) current.providers[pName].enabled = !!pConfig.enabled;
      if (pConfig.baseUrl !== undefined) current.providers[pName].baseUrl = String(pConfig.baseUrl).trim();
      if (Array.isArray(pConfig.keys)) {
        current.providers[pName].keys = pConfig.keys.map(k => String(k).trim()).filter(Boolean);
      }
    }
  }

  const ok = llmGatewayService.saveConfig(current);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to save LLM gateway configuration' });
  }

  res.json({ success: true, status: llmGatewayService.getGatewayStatus() });
});

// API: Test LLM Gateway Provider (Admin only)
router.post('/admin/llm-gateway/test', requireAdmin, async (req, res) => {
  const { provider } = req.body;
  if (!provider) {
    return res.status(400).json({ error: 'Provider name required (anthropic, openai, gemini)' });
  }

  const config = llmGatewayService.loadConfig();
  const key = llmGatewayService.getNextKey(provider, config);
  if (!key) {
    return res.status(400).json({ error: `No available API keys found for provider '${provider}'` });
  }

  const pConfig = config.providers[provider] || {};
  const isAnthropic = !!(pConfig.endpoints?.anthropic || provider === 'anthropic' || provider === 'kimi');
  const baseUrl = (pConfig.endpoints?.anthropic || pConfig.endpoints?.openai || pConfig.baseUrl || '').trim();

  try {
    if (isAnthropic) {
      const endpoint = (pConfig.endpoints?.anthropic || baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
      const testRes = await fetch(`${endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: pConfig.models?.anthropic?.[0] || 'glm-5.3-flash',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      return res.json({
        ok: testRes.ok,
        status: testRes.status,
        statusText: testRes.statusText,
        maskedKey: llmGatewayService.maskKey(key)
      });
    } else {
      const endpoint = (pConfig.endpoints?.openai || baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const testRes = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: pConfig.models?.openai?.[0] || 'glm-5.3-flash',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      return res.json({
        ok: testRes.ok,
        status: testRes.status,
        statusText: testRes.statusText,
        maskedKey: llmGatewayService.maskKey(key)
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message, maskedKey: llmGatewayService.maskKey(key) });
  }
});

// Get dynamically available models (flat: provider + model) from LLM Gateway configuration
router.get('/llm-models', requireAuth, (req, res) => {
  try {
    const llmGatewayService = require('../services/llmGatewayService');
    const config = llmGatewayService.loadConfig();
    const providers = config.providers || {};
    const globalSettings = db.getSettings();
    const claudeOAuthMode = !!globalSettings.claudeOAuthMode;

    const buildFlatList = (protocol) => {
      const defaultModel = protocol === 'anthropic'
        ? (config.defaults?.anthropicModel || 'glm-5.3-flash')
        : (config.defaults?.openaiModel || 'glm-5.3-flash');

      const defaultGatewayItem = {
        id: 'default',
        provider: (protocol === 'anthropic' && claudeOAuthMode) ? 'gateway_default' : 'default',
        providerName: '网关默认',
        model: defaultModel,
        modelName: `默认 (${defaultModel})`,
        displayName: `网关默认 · ${defaultModel}`,
        desc: '跟随系统全局网关默认'
      };

      const oauthItem = {
        id: 'oauth',
        provider: 'oauth',
        providerName: 'Anthropic 官方',
        model: '',
        modelName: 'OAuth 官方直连',
        displayName: 'Anthropic · OAuth 直连',
        desc: '使用 Claude OAuth 登录态，不注入 Base URL'
      };

      const list = protocol === 'anthropic'
        ? (claudeOAuthMode ? [oauthItem, defaultGatewayItem] : [defaultGatewayItem, oauthItem])
        : [defaultGatewayItem];

      for (const [pId, prov] of Object.entries(providers)) {
        if (!prov || !prov.enabled) continue;
        const models = (prov.models && prov.models[protocol]) || [];
        const provName = prov.name || pId;

        for (const m of models) {
          if (!m || typeof m !== 'string') continue;
          const clean = m.trim();
          if (clean.includes('*')) continue;

          let modelTitle = clean;
          let desc = '支持模型';
          if (clean === 'k3-256k') {
            modelTitle = 'Kimi K3 (256k)';
            desc = '超长上下文 (256k) 深度推理';
          } else if (clean === 'glm-5.3-flash') {
            modelTitle = 'GLM-5.3-Flash';
            desc = '高并发低延迟响应';
          } else if (clean === 'glm-5') {
            modelTitle = 'GLM-5';
            desc = '旗舰级大模型代码生成';
          }

          list.push({
            id: `${pId}_${clean}`,
            provider: pId,
            providerName: provName,
            model: clean,
            modelName: modelTitle,
            displayName: `${provName} · ${modelTitle}`,
            desc
          });
        }
      }
      return list;
    };

    res.json({
      claude: buildFlatList('anthropic'),
      codex: buildFlatList('openai')
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get models: ' + err.message });
  }
});

// API: Tmux Commands (Protected — Unified Device Tunnel)
// List sessions
router.get('/sessions', requireAuth, (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.json([]);
  deviceService.getRemoteSessions(targetDeviceId).then((sessions) => {
    const mapped = (sessions || []).map(s => {
      const agentType = s.agentType || '';
      const sessionMode = s.sessionMode || (agentType === 'default' ? 'terminal_only' : 'hybrid');
      return {
        name: s.name,
        attached: Boolean(s.attached),
        created: s.created ? new Date(s.created).toLocaleString() : 'N/A',
        path: s.path || '',
        workspace: s.workspaceName || s.workspace || s.name,
        workspaceName: s.workspaceName || s.workspace || '',
        agentType,
        agentModel: s.agentModel || '',
        sessionMode,
        isRemote: true,
        deviceId: targetDeviceId
      };
    });
    res.json(mapped);
  }).catch(err => {
    console.error('[API] Error getting device sessions:', err);
    res.json([]);
  });
});

// Create session
router.post('/sessions', requireAuth, async (req, res) => {
  const { name, agent, workspacePath, workspaceName, modelProvider, modelName, modelLabel, sessionMode } = req.body;
  const targetMode = sessionMode || (agent === 'default' ? 'terminal_only' : 'hybrid');

  // Validate allowed agents uniformly across all devices
  const settings = db.getSettings();
  const allowedAgents = settings.enabledAgents || ['default', 'agy', 'claude', 'codex', 'kimi'];
  const reqAgent = agent || 'default';
  if (!allowedAgents.includes(reqAgent)) {
    return res.status(403).json({ error: `智能体环境 '${reqAgent}' 已被禁用。` });
  }

  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) {
    return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  }

  const rawName = (typeof name === 'string' && name.trim()) ? name.trim() : (reqAgent !== 'default' ? reqAgent : 'shell');
  try {
    const result = await deviceService.remoteTmuxNewSession(targetDeviceId, {
      sessionName: rawName,
      workspace: workspacePath || '~',
      workspaceName: workspaceName || '',
      sessionMode: targetMode,
      agentType: reqAgent,
      agentModel: modelLabel || (modelProvider && modelProvider !== 'default' ? modelProvider : '') || modelName || '',
      modelName: modelName || ''
    });
    if (result && result.error) {
      return res.status(400).json({ error: result.error });
    }
    const createdName = result?.sessionName || rawName;
    return res.json({
      success: true,
      session: createdName,
      name: createdName,
      originalName: rawName,
      renamed: createdName !== rawName,
      sessionMode: targetMode
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Kill session
router.delete('/sessions/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteTmuxKillSession(targetDeviceId, name);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Workspaces Endpoints (Unified Device Tunnel)
router.get('/workspaces', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.json([]);
  try {
    const result = await deviceService.remoteFsWorkspaces(targetDeviceId);
    if (result && result.workspaces && result.workspaces.length > 0) {
      return res.json(result.workspaces);
    }
    return res.json([{ name: 'Home (~)', path: '~', isDefault: true }]);
  } catch (e) {
    return res.json([{ name: 'Home (~)', path: '~', isDefault: true }]);
  }
});

router.post('/workspaces', requireAuth, async (req, res) => {
  const { name, path: wsPath } = req.body;
  if (!name) return res.status(400).json({ error: 'Workspace name is required.' });
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteFsAddWorkspace(targetDeviceId, name, wsPath);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json({ success: true, workspace: result.workspace });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/workspaces/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteFsRemoveWorkspace(targetDeviceId, name);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// API: Get workspace project progression data
router.get('/workspaces/:name/project-progress', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const progress = await projectService.getProjectProgress(name, req.user.username);
    res.json(progress);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch project progress' });
  }
});

// API: Update workspace project mission
router.post('/workspaces/:name/project-mission', requireAuth, (req, res) => {
  try {
    const { name } = req.params;
    const { mission, clearTasks } = req.body;
    const workspaces = readWorkspaces(req.user.username);
    const matchedWs = workspaces.find(w => 
      (w.name && w.name.toLowerCase() === name.toLowerCase()) ||
      (w.path && (w.path === name || resolveWorkspacePath(w.path, req.user.username) === path.resolve(name)))
    );
    let wsPath;
    if (matchedWs) {
      wsPath = resolveWorkspacePath(matchedWs.path, req.user.username);
    } else {
      const candidate = resolveWorkspacePath(name, req.user.username);
      if (candidate && fs.existsSync(candidate)) {
        wsPath = candidate;
      } else {
        return res.status(404).json({ error: `Workspace "${name}" not found` });
      }
    }
    const updated = projectService.writeProjectMetadata(wsPath, mission, { clearTasks: !!clearTasks });
    res.json({ success: true, mission: updated.mission, updatedAt: updated.updatedAt, tasksCleared: !!clearTasks });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update project mission' });
  }
});

// API: Update workspace project tasks list (Roadmap / Kanban)
router.post('/workspaces/:name/project-tasks', requireAuth, (req, res) => {
  try {
    const { name } = req.params;
    const { tasks, mission } = req.body;
    const workspaces = readWorkspaces(req.user.username);
    const matchedWs = workspaces.find(w => 
      (w.name && w.name.toLowerCase() === name.toLowerCase()) ||
      (w.path && (w.path === name || resolveWorkspacePath(w.path, req.user.username) === path.resolve(name)))
    );
    let wsPath;
    if (matchedWs) {
      wsPath = resolveWorkspacePath(matchedWs.path, req.user.username);
    } else {
      const candidate = resolveWorkspacePath(name, req.user.username);
      if (candidate && fs.existsSync(candidate)) {
        wsPath = candidate;
      } else {
        return res.status(404).json({ error: `Workspace "${name}" not found` });
      }
    }
    const updated = projectService.writeProjectTasks(wsPath, tasks, mission !== undefined ? mission : null);
    res.json({ success: true, tasks: updated.tasks, mission: updated.mission, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update project tasks' });
  }
});

// API: Dispatch task / prompt directly to an agent session in this workspace
router.post('/workspaces/:name/dispatch-task', requireAuth, async (req, res) => {
  try {
    const { sessionName, promptText, clearHistory } = req.body;
    if (!sessionName || !promptText) {
      return res.status(400).json({ error: 'Session name and promptText are required' });
    }
    const targetDeviceId = resolveComputeDeviceId(req);
    if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
    const result = await deviceService.remoteTmuxSendKeys(targetDeviceId, {
      sessionName,
      text: promptText,
      clearHistory: !!clearHistory
    });
    if (result && result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to dispatch task' });
  }
});

// API: Global / Filtered Task Board (Session-as-Task Kanban View)
router.get('/task-board', requireAuth, async (req, res) => {
  try {
    const workspace = req.query.workspace || '';
    const targetDeviceId = resolveComputeDeviceId(req);
    let remoteSessions = [];

    if (targetDeviceId) {
      try {
        remoteSessions = await deviceService.getRemoteSessions(targetDeviceId);
      } catch (e) {
        remoteSessions = [];
      }
    }

    const board = await projectService.getGlobalTaskBoard(req.user.username, {
      workspace,
      deviceId: targetDeviceId || 'none',
      remoteSessions
    });
    res.json(board);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load task board' });
  }
});

// API: Create or update a backlog Todo card on the Task Board
router.post('/task-board/todos', requireAuth, (req, res) => {
  try {
    const { id, title, description, workspaceName, workspacePath, agentType, priority } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: '任务标题不能为空' });
    }
    const result = projectService.upsertTodoItem(req.user.username, {
      id,
      title: String(title).trim(),
      description: String(description || '').trim(),
      workspaceName: String(workspaceName || '').trim(),
      workspacePath: String(workspacePath || '').trim(),
      agentType: String(agentType || 'agy').trim(),
      priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium'
    });
    res.json({ success: true, todo: result.todo, todos: result.todos });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save todo item' });
  }
});

// API: Delete a backlog Todo card
router.delete('/task-board/todos/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const todos = projectService.deleteTodoItem(req.user.username, id);
    res.json({ success: true, todos });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete todo item' });
  }
});

// API: Update custom metadata (e.g. customTitle) for a session card
router.post('/task-board/card-meta', requireAuth, (req, res) => {
  try {
    const { sessionName, customTitle } = req.body || {};
    if (!sessionName || !String(sessionName).trim()) {
      return res.status(400).json({ error: 'sessionName is required' });
    }
    const meta = projectService.updateCardMeta(req.user.username, String(sessionName).trim(), {
      customTitle: customTitle !== undefined ? String(customTitle).trim() : undefined
    });
    res.json({ success: true, meta });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update card metadata' });
  }
});

// API: Quick dispatch instruction directly to a session card
router.post('/task-board/dispatch', requireAuth, async (req, res) => {
  try {
    const { sessionName, promptText, clearHistory } = req.body || {};
    if (!sessionName || !promptText || !String(promptText).trim()) {
      return res.status(400).json({ error: 'sessionName and promptText are required' });
    }
    const targetDeviceId = resolveComputeDeviceId(req);
    if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
    const result = await deviceService.remoteTmuxSendKeys(targetDeviceId, {
      sessionName,
      text: promptText,
      clearHistory: !!clearHistory
    });
    if (result && result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to dispatch to session' });
  }
});

// List subdirectories only (for workspace directory picker)
router.get('/directories', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteDirectories(targetDeviceId, req.query.path);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json({
      currentPath: result.currentPath || req.query.path,
      parentPath: result.currentPath && result.currentPath !== '/' ? path.dirname(result.currentPath) : null,
      directories: result.directories || []
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// List files/folders in a path
router.get('/files/list', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteFsList(targetDeviceId, req.query.workspacePath, req.query.path);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json(result.items || []);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Read file contents
router.get('/files/content', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteFsRead(targetDeviceId, req.query.workspacePath, req.query.path);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json({
      path: result.path || req.query.path,
      content: result.content,
      size: result.size
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Save file contents
router.post('/files/save', requireAuth, async (req, res) => {
  const { workspacePath, filePath, content } = req.body;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteFsWrite(targetDeviceId, workspacePath, filePath, content);
    if (result && result.error) return res.status(400).json({ error: result.error });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Upload files (supports images, markdown, text, code, etc.)
router.post('/files/upload', requireAuth, (req, res) => {
  fileUpload.array('files', 20)(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '上传失败：单个文件不能超过 50MB' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '上传失败：单次最多同时上传 20 个文件' });
      return res.status(400).json({ error: `上传失败: ${err.message}` });
    }
    try {
      const workspacePath = req.body.workspacePath || '';
      const targetDeviceId = resolveComputeDeviceId(req);
      if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '未选择任何待上传文件' });
      }
      const targetDirRel = req.body.targetDir || '';
      const uploadedFiles = [];
      for (const file of req.files) {
        const originalName = file.originalname || 'uploaded_file';
        const cleanName = path.basename(originalName).replace(/[\x00-\x1f\x80-\x9f]/g, '').trim();
        if (!cleanName || cleanName === '.' || cleanName === '..') continue;
        const relFile = targetDirRel ? path.join(targetDirRel, cleanName) : cleanName;
        const uploadRes = await deviceService.remoteUploadFile(
          targetDeviceId,
          workspacePath,
          relFile,
          file.buffer.toString('base64')
        );
        if (uploadRes && !uploadRes.error) {
          uploadedFiles.push({ name: cleanName, path: relFile, size: file.size });
        }
      }
      return res.json({
        success: true,
        message: `成功上传 ${uploadedFiles.length} 个文件`,
        files: uploadedFiles
      });
    } catch (uploadErr) {
      console.error('[API] File upload error:', uploadErr);
      res.status(500).json({ error: uploadErr.message });
    }
  });
});

// Store temporary share links in memory
// Format: token => { workspacePath, relFileName, expiresAt, createdBy }
const tempShareLinks = new Map();

// Helper to clean up expired links periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, share] of tempShareLinks.entries()) {
    if (now > share.expiresAt) {
      tempShareLinks.delete(token);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// API: Create a secure, temporary share link for an HTML preview (requires authentication)
router.post('/share/create', requireAuth, (req, res) => {
  try {
    const { workspacePath, filePath, durationHours } = req.body;
    
    if (!filePath || !workspacePath) {
      return res.status(400).json({ error: 'filePath 和 workspacePath 不能为空' });
    }

    const duration = parseFloat(durationHours);
    if (isNaN(duration) || duration < 0.1 || duration > 168) {
      return res.status(400).json({ error: '无效的分享时长，范围必须在 0.1 到 168 小时之间' });
    }

    // Security: Validate file path and ownership before creating the link
    const absolutePath = safeResolve(workspacePath, filePath, req.user.username);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return res.status(400).json({ error: '文件不存在，无法生成分享链接' });
    }

    // DoS Prevention: Check limit of active sharing links in memory
    if (tempShareLinks.size >= 500) {
      // Proactive prune
      const now = Date.now();
      for (const [t, s] of tempShareLinks.entries()) {
        if (now > s.expiresAt) tempShareLinks.delete(t);
      }
      if (tempShareLinks.size >= 500) {
        return res.status(429).json({ error: '系统当前分享链接数量过多，请稍后再试' });
      }
    }

    // Generate high-entropy secure token (64-char hex)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + duration * 60 * 60 * 1000;

    tempShareLinks.set(token, {
      workspacePath,
      relFileName: filePath,
      expiresAt,
      createdBy: req.user.username
    });

    const filename = path.basename(filePath);
    res.json({
      success: true,
      token,
      expiresAt,
      filename,
      sharePath: `/api/public-preview/${token}/${encodeURIComponent(filename)}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Route: Public preview of HTML files and their sub-resources (No authentication required)
// Security features:
// - Verifies token validity and expiration.
// - Restricts access strictly to files in the parent directory of the shared HTML file.
// - Sanitizes paths defensively.
// - Disables caching for the shared dynamic page content.
router.get(/^\/public-preview\/([^/]+)(?:\/(.*))?$/, (req, res) => {
  try {
    const token = req.params[0];
    let subPath = req.params[1] || '';
    
    try { subPath = decodeURIComponent(subPath); } catch (e) { /* already decoded */ }

    const share = tempShareLinks.get(token);
    if (!share) {
      return res.status(404).send('分享页面不存在或已失效。');
    }

    if (Date.now() > share.expiresAt) {
      tempShareLinks.delete(token); // Prune immediately on access
      return res.status(410).send('分享链接已过期。');
    }

    const relParentDir = path.dirname(share.relFileName);
    const targetRelPath = subPath ? path.join(relParentDir, subPath) : share.relFileName;

    // Security check: Ensure requested subPath does not traverse out of the shared HTML's directory
    const relDiff = path.relative(relParentDir, targetRelPath);
    const isSubPathSafe = relDiff === '' || (!relDiff.startsWith('..') && !path.isAbsolute(relDiff));
    if (!isSubPathSafe) {
      return res.status(403).send('无权访问此共享范围之外的路径。');
    }

    // Resolve the path on disk using standard safeResolve validation rules
    let targetPath = safeResolve(share.workspacePath, targetRelPath, share.createdBy);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      targetPath = path.join(targetPath, 'index.html');
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return res.status(404).send('文件不存在。');
    }

    // Security: Set headers to disable downstream/CDN caching to ensure immediate revocation on expiry
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.sendFile(targetPath);
  } catch (err) {
    res.status(400).send(`发生错误: ${err.message}`);
  }
});

// Serve workspace files for the HTML preview iframe.
// The URL path mirrors the on-disk relative path, so relative references
// (images, CSS, JS) inside a previewed HTML file resolve naturally.
// :token is base64url(workspacePath), or '~' for the default workspace.
// Regex route for Express 5 compatibility (string wildcards changed semantics).
router.get(/^\/preview\/([^/]+)(?:\/(.*))?$/, requireAuth, (req, res) => {
  try {
    const token = req.params[0];
    let relPath = req.params[1] || '';
    // Decode defensively: Express versions differ on whether regex captures
    // arrive decoded. decodeURIComponent is a no-op for plain names and throws
    // on a bare '%', in which case the value was already decoded.
    try { relPath = decodeURIComponent(relPath); } catch (e) { /* already decoded */ }

    let workspacePath = '';
    if (token !== '~') {
      const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
      workspacePath = Buffer.from(b64, 'base64').toString('utf8');
    }

    let targetPath = safeResolve(workspacePath, relPath, req.user.username);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      targetPath = path.join(targetPath, 'index.html');
    }
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.sendFile(targetPath);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Git status endpoint
router.get('/git/status', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.json({ isGit: false, files: [] });
  try {
    const result = await deviceService.remoteGitStatus(targetDeviceId, req.query.workspacePath);
    if (result && result.isGit) {
      return res.json({
        isGit: true,
        branch: result.branch || '',
        files: result.files || []
      });
    }
    return res.json({ isGit: false, files: [] });
  } catch (e) {
    return res.json({ isGit: false, files: [] });
  }
});

// Git diff endpoint
router.get('/git/diff', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.json({ diff: '' });
  try {
    const result = await deviceService.remoteGitDiff(targetDeviceId, req.query.workspacePath, req.query.path);
    return res.json({ diff: result?.diff || '' });
  } catch (e) {
    return res.json({ diff: '' });
  }
});

// Express API endpoints for Web Push
router.get('/push/key', requireAuth, (req, res) => {
  res.json({ publicKey: getPublicKey() });
});

router.post('/push/register', requireAuth, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  registerSubscription(subscription, req.user.username);
  res.json({ success: true });
});

router.post('/push/unregister', requireAuth, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  unregisterSubscription(subscription, req.user.username);
  res.json({ success: true });
});

router.post('/push/trigger', (req, res) => {
  let isAuthorized = false;
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiToken = authHeader.substring(7);
    if (apiToken === PASSWORD) {
      isAuthorized = true;
    } else {
      try {
        jwt.verify(apiToken, JWT_SECRET);
        isAuthorized = true;
      } catch (err) {
        // Token invalid
      }
    }
  }
  
  const remoteAddress = req.socket.remoteAddress;
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
    isAuthorized = true;
  }
  
  if (!isAuthorized) {
    const decoded = verifyToken(req);
    if (decoded) {
      isAuthorized = true;
    }
  }
  
  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token or trigger locally.' });
  }

  const { title, body, url, session } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }
  
  let targetSession = session;
  if (!targetSession && url) {
    const match = url.match(/[?&]session=([^&]+)/);
    if (match) targetSession = match[1];
  }
  
  let username = null;
  const decoded = verifyToken(req);
  if (decoded) {
    username = decoded.username;
  }

  const io = req.app.get('io');
  sendPushToAll(io, { title, body, url: url || '/', session: targetSession }, username);
  res.json({ success: true });
});

// Store temporary scan-to-login tokens
const tempLoginTokens = new Map();

// API: Get server network IPs for mobile scanning
router.get('/system/network-ips', requireAuth, (req, res) => {
  try {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    const ips = [];
    for (const interfaceName of Object.keys(networkInterfaces)) {
      for (const intf of networkInterfaces[interfaceName]) {
        // Only return IPv4 and skip internal loopback addresses
        if (intf.family === 'IPv4' && !intf.internal) {
          ips.push({
            name: interfaceName,
            address: intf.address
          });
        }
      }
    }
    res.json({ success: true, ips });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve network interfaces', details: err.message });
  }
});

// API: Generate short-lived temp token for mobile login
router.post('/system/temp-login-token', requireAuth, (req, res) => {
  try {
    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('hex');
    const expiresIn = 60; // 60 seconds
    const expiresAt = Date.now() + expiresIn * 1000;
    
    // Store in map with user info for multi-user mode
    tempLoginTokens.set(token, {
      expiresAt,
      username: req.user.username,
      role: req.user.role
    });
    
    // Periodically clean up expired tokens to prevent leak
    if (tempLoginTokens.size > 100) {
      const now = Date.now();
      for (const [key, value] of tempLoginTokens.entries()) {
        if (now > value.expiresAt) {
          tempLoginTokens.delete(key);
        }
      }
    }
    
    res.json({ success: true, token, expiresIn });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate login token', details: err.message });
  }
});

// API: Login using short-lived temp token (No Auth required for this endpoint)
router.get('/login-by-token', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect('/login?error=scan_invalid');
  }

  const tokenData = tempLoginTokens.get(token);
  if (!tokenData) {
    return res.redirect('/login?error=scan_invalid');
  }

  // Delete immediately (one-time use)
  tempLoginTokens.delete(token);

  if (Date.now() > tokenData.expiresAt) {
    return res.redirect('/login?error=scan_expired');
  }

  // Generate standard JWT cookie with user context
  const jwtPayload = MULTI_USER_ENABLED
    ? { username: tokenData.username, role: tokenData.role, isMultiUser: true }
    : { username: 'admin', role: 'admin', isMultiUser: false };
  const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', jwtToken, {
    httpOnly: true,
    secure: req.secure || useHttps,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  // Redirect to main deck
  res.redirect('/');
});

// API: Get structured chat history for a session (Unified Device Tunnel)
router.get('/sessions/:name/chat-history', requireAuth, async (req, res) => {
  const { name } = req.params;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) {
    return res.json({ sessionName: name, sessionMode: 'hybrid', supported: true, lastUpdated: Date.now(), messages: [] });
  }
  try {
    const result = await deviceService.remoteChatHistory(targetDeviceId, name);
    return res.json({
      sessionName: name,
      agentType: result?.agentType || '',
      agentSessionId: result?.agentSessionId || null,
      sessionMode: result?.sessionMode || 'hybrid',
      supported: result?.supported !== false,
      hasHistory: result?.hasHistory !== undefined ? result.hasHistory : (Array.isArray(result?.messages) && result.messages.length > 0),
      pendingAction: result?.pendingAction || null,
      isGenerating: Boolean(result?.isGenerating),
      statusText: result?.statusText || (result?.isGenerating ? 'OAR 智能体思考中...' : '就绪'),
      activeModel: result?.activeModel || null,
      usage: result?.usage || null,
      contextUsage: result?.contextUsage || null,
      oarCapabilities: result?.oarCapabilities || null,
      lastUpdated: result?.lastUpdated || Date.now(),
      messages: result?.messages || []
    });
  } catch (e) {
    return res.json({ sessionName: name, sessionMode: 'hybrid', supported: true, lastUpdated: Date.now(), messages: [] });
  }
});

// API: Clear conversation context for a session
router.post('/sessions/:name/clear-context', requireAuth, async (req, res) => {
  const { name } = req.params;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    await deviceService.sendDeviceRpc(targetDeviceId, 'agent:clear_context', { sessionName: name });
  } catch (e) {}
  return res.json({ success: true, message: 'Context cleared' });
});

// API: Probe available OAR built-in runtimes and capabilities
router.get('/oar/runtimes', requireAuth, async (req, res) => {
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.json({ success: true, runtimes: [] });
  try {
    const result = await deviceService.remoteOarRuntimes(targetDeviceId);
    if (result && result.error) return res.status(502).json({ error: result.error });
    return res.json({ success: true, runtimes: result?.runtimes || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Send user message to OAR Pure Chat Session
router.post('/sessions/:name/oar-message', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { content, images } = req.body;
  const hasText = Boolean(content && String(content).trim());
  const rawImages = Array.isArray(images) ? images : [];
  if (!hasText && rawImages.length === 0) {
    return res.status(400).json({ error: 'Message content or images required' });
  }
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteOarMessage(targetDeviceId, name, {
      content: content || '',
      images: rawImages
    });
    if (result && result.error && !result.accepted) {
      return res.status(502).json({ error: result.error });
    }
    return res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Trigger OAR native manual context compaction (/compact)
router.post('/sessions/:name/oar-compact', requireAuth, async (req, res) => {
  const { name } = req.params;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteOarCompact(targetDeviceId, name);
    if (result && result.error) return res.status(502).json({ error: result.error });
    return res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Abort generation in OAR Pure Chat Session
router.post('/sessions/:name/oar-abort', requireAuth, async (req, res) => {
  const { name } = req.params;
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
  try {
    const result = await deviceService.remoteOarAbort(targetDeviceId, name);
    if (result && result.error) return res.status(502).json({ error: result.error });
    return res.json({ success: true, aborted: Boolean(result?.aborted) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload attachments for Chat Mode
router.post('/sessions/:session/chat-upload', requireAuth, (req, res) => {
  fileUpload.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '上传失败：单个文件不能超过 50MB' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '上传失败：单次最多上传 10 个文件' });
      return res.status(400).json({ error: `上传失败: ${err.message}` });
    }
    const sessionName = req.params.session;
    const targetDeviceId = resolveComputeDeviceId(req);
    if (!targetDeviceId) return res.status(400).json({ error: NO_ONLINE_DEVICE_MSG });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '未选择任何待上传文件' });
    }
    const filesPayload = req.files.map(f => ({
      originalName: f.originalname || 'upload',
      mimeType: f.mimetype || 'application/octet-stream',
      bufferBase64: f.buffer.toString('base64')
    }));
    deviceService.remoteChatUpload(targetDeviceId, sessionName, filesPayload).then(result => {
      if (result && result.error) return res.status(400).json({ error: result.error });
      return res.json({
        success: true,
        message: `成功保存 ${(result.files || []).length} 个文件至工作区临时目录`,
        files: result.files || []
      });
    }).catch(uploadErr => {
      return res.status(500).json({ error: uploadErr.message });
    });
  });
});

// Serve uploaded chat attachments securely via device RPC
router.get('/sessions/:session/chat-attachments/:filename', requireAuth, async (req, res) => {
  const sessionName = req.params.session;
  const filename = path.basename(req.params.filename);
  const targetDeviceId = resolveComputeDeviceId(req);
  if (!targetDeviceId) return res.status(404).send('No online device');
  try {
    const result = await deviceService.remoteChatAttachment(targetDeviceId, sessionName, filename);
    if (!result || result.error || !result.bufferBase64) {
      return res.status(404).send(result?.error || 'Attachment not found');
    }
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.send(Buffer.from(result.bufferBase64, 'base64'));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ==========================================
// Multi-Device Agent Remote Control APIs
// ==========================================

// API: Generate a one-time pair token and startup command for adding a local device
router.post('/devices/pair-token', requireAuth, (req, res) => {
  const user = req.user.username;
  const pairData = deviceService.createPairToken(user);
  const host = process.env.DOMAIN_NAME || req.get('host');
  const protocol = req.protocol;
  const serverUrl = `${protocol}://${host}`;

  const command = `curl -fsSL ${serverUrl}/agent.js | node - connect --server ${serverUrl} --token ${pairData.token}`;

  res.json({
    success: true,
    token: pairData.token,
    expireAt: pairData.expireAt,
    ttlSeconds: pairData.ttlSeconds,
    serverUrl,
    command
  });
});

// API: List all devices bound to the current logged-in user
router.get('/devices', requireAuth, (req, res) => {
  const user = req.user.username;
  const devices = deviceService.getUserDevices(user);
  res.json({
    success: true,
    devices
  });
});

// API: Unbind / Remove a device
router.delete('/devices/:deviceId', requireAuth, (req, res) => {
  const user = req.user.username;
  const { deviceId } = req.params;
  const existing = deviceService.getDeviceById(deviceId);
  if (!existing || existing.userId !== user) {
    return res.status(404).json({ success: false, error: 'Device not found or not owned by you' });
  }
  if (existing.deviceKind === 'host-admin' && req.query.force !== 'true') {
    return res.status(400).json({
      success: false,
      error: 'Host Admin device is protected from accidental unbinding. Pass ?force=true to remove.'
    });
  }
  const removed = deviceService.removeDevice(user, deviceId);
  if (!removed) {
    return res.status(404).json({ success: false, error: 'Device not found or not owned by you' });
  }
  res.json({ success: true, message: 'Device successfully removed' });
});

// API: Dispatch Agent task / prompt to a remote device
router.post('/devices/:deviceId/agent/chat', requireAuth, (req, res) => {
  const user = req.user.username;
  const { deviceId } = req.params;
  const { sessionId, prompt, agentType, workDir } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'Prompt cannot be empty' });
  }

  const sId = sessionId || `remote_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const result = deviceService.dispatchAgentChat(deviceId, user, {
    sessionId: sId,
    prompt,
    agentType,
    workDir
  });

  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json({
    success: true,
    sessionId: sId,
    message: 'Task successfully dispatched to remote device'
  });
});

// API: Interrupt Agent task on a remote device
router.post('/devices/:deviceId/agent/interrupt', requireAuth, (req, res) => {
  const user = req.user.username;
  const { deviceId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'sessionId is required' });
  }

  const result = deviceService.dispatchAgentInterrupt(deviceId, user, { sessionId });
  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json({ success: true, message: 'Interrupt signal dispatched' });
});

// API: Trigger remote agent update / self-reload on edge device
router.post('/devices/:deviceId/update', requireAuth, async (req, res) => {
  const user = req.user.username;
  const { deviceId } = req.params;
  const device = deviceService.getDeviceById(deviceId);
  if (!device || device.userId !== user) {
    return res.status(404).json({ success: false, error: 'Device not found or not owned by you' });
  }

  const host = process.env.DOMAIN_NAME || req.get('host');
  const protocol = req.protocol;
  const serverUrl = `${protocol}://${host}`;

  try {
    const result = await deviceService.remoteSystemUpdate(deviceId, serverUrl);
    if (result && result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Helper for forwarding authenticated remote device RPCs
function registerDeviceRpcRoute(method, routePath, rpcHandler) {
  router[method](routePath, requireAuth, async (req, res) => {
    const user = req.user.username;
    const { deviceId } = req.params;
    const device = deviceService.getDeviceById(deviceId);
    if (!device || device.userId !== user) {
      return res.status(404).json({ success: false, error: 'Device not found or not owned by you' });
    }
    try {
      const result = await rpcHandler(deviceId, req);
      if (result && result.error) {
        return res.status(400).json({ success: false, error: result.error });
      }
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

registerDeviceRpcRoute('post', '/devices/:deviceId/fs/create-file', (id, req) =>
  deviceService.remoteFsCreateFile(id, req.body.workspacePath, req.body.filePath));
registerDeviceRpcRoute('post', '/devices/:deviceId/fs/create-dir', (id, req) =>
  deviceService.remoteFsCreateDir(id, req.body.workspacePath, req.body.dirPath));
registerDeviceRpcRoute('post', '/devices/:deviceId/fs/delete', (id, req) =>
  deviceService.remoteFsDelete(id, req.body.workspacePath, req.body.targetPath));
registerDeviceRpcRoute('post', '/devices/:deviceId/fs/rename', (id, req) =>
  deviceService.remoteFsRename(id, req.body.workspacePath, req.body.oldPath, req.body.newPath));

registerDeviceRpcRoute('post', '/devices/:deviceId/git/stage', (id, req) =>
  deviceService.remoteGitStage(id, req.body.workspacePath, req.body.files));
registerDeviceRpcRoute('post', '/devices/:deviceId/git/unstage', (id, req) =>
  deviceService.remoteGitUnstage(id, req.body.workspacePath, req.body.files));
registerDeviceRpcRoute('post', '/devices/:deviceId/git/commit', (id, req) =>
  deviceService.remoteGitCommit(id, req.body.workspacePath, req.body.message));
registerDeviceRpcRoute('get', '/devices/:deviceId/git/branches', (id, req) =>
  deviceService.remoteGitBranches(id, req.query.workspacePath));
registerDeviceRpcRoute('post', '/devices/:deviceId/git/checkout', (id, req) =>
  deviceService.remoteGitCheckout(id, req.body.workspacePath, req.body.branch));

// ==========================================
// Docker Sandbox Isolation Lifecycle APIs
// ==========================================

// API: Get current user's Docker sandbox status
router.get('/sandbox/status', requireAuth, async (req, res) => {
  try {
    const status = await containerService.getSandboxStatus(req.user.username);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Provision or wake current user's isolated Docker sandbox container
router.post('/sandbox/start', requireAuth, async (req, res) => {
  try {
    const result = await containerService.ensureUserSandbox(req.user.username, {
      name: req.body?.name
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Sleep / stop current user's Docker sandbox container to free host RAM
router.post('/sandbox/stop', requireAuth, async (req, res) => {
  try {
    const result = await containerService.stopUserSandbox(req.user.username);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Admin overview of all managed Docker sandboxes
router.get('/admin/sandboxes', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin privileges required' });
  }
  try {
    const result = await containerService.listSandboxes();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
