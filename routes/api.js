const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { PASSWORD, JWT_SECRET, useHttps, PROJECT_ROOT, MULTI_USER_ENABLED } = require('../config');
const { requireAuth, requireAdmin, verifyToken } = require('../middlewares/auth');
const { execTmux, injectAgentHooks, getRunUser } = require('../services/tmuxService');
const { resolveWorkspacePath, readWorkspaces, writeWorkspaces, safeResolve, getHomeDir, getUserWorkspaceRoot, getUserHomeDir, getDefaultWorkspacePath, updateUserKeysFile } = require('../services/fileService');
const { execCommand } = require('../services/gitService');
const { getPublicKey, registerSubscription, unregisterSubscription, sendPushToAll } = require('../services/pushService');
const db = require('../services/dbService');

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

  const codes = db.getCodes();
  const invite = codes.find(c => c.code === code && c.status === 'pending');
  if (!invite) {
    return res.status(400).json({ error: 'Invalid or already used invite code' });
  }

  const users = db.getUsers();
  const reservedUsernames = ['default', 'admin', 'system', 'guest', 'user_data', 'workspaces'];
  if (reservedUsernames.includes(username.toLowerCase()) || users[username.toLowerCase()]) {
    return res.status(400).json({ error: 'Username already exists or is reserved.' });
  }

  // Create user
  users[username.toLowerCase()] = {
    username,
    passwordHash: db.hashPassword(password),
    role: 'user',
    createdAt: new Date().toISOString()
  };
  db.saveUsers(users);

  // Update invite code status
  invite.status = 'used';
  invite.usedBy = username;
  invite.usedAt = new Date().toISOString();
  db.saveCodes(codes);

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
  const userObj = users[req.user.username.toLowerCase()];
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
  const usernameKey = req.user.username.toLowerCase();
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

// API: Get admin settings (Admin only)
router.get('/admin/settings', requireAdmin, (req, res) => {
  res.json(db.getSettings());
});

// API: Update admin settings (Admin only)
router.post('/admin/settings', requireAdmin, (req, res) => {
  const { enabledAgents } = req.body;
  if (!Array.isArray(enabledAgents)) {
    return res.status(400).json({ error: 'enabledAgents must be an array' });
  }
  const current = db.getSettings();
  current.enabledAgents = enabledAgents;
  db.saveSettings(current);
  res.json({ success: true, settings: current });
});

// API: Tmux Commands (Protected)
// List sessions
router.get('/sessions', requireAuth, (req, res) => {
  execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}|#{session_path}|#{@workspace_name}|#{@agent_type}'], (err, stdout, stderr) => {
    if (err) {
      const errMsg = (stderr || '').toLowerCase();
      const isNoSessions = err.code === 1 || 
                           errMsg.includes('no server running') || 
                           errMsg.includes('no sessions') || 
                           errMsg.includes('no such file') || 
                           errMsg.includes('connection refused') || 
                           errMsg.includes('error connecting to') || 
                           errMsg.includes('unknown user');
      if (isNoSessions) {
        return res.json([]);
      }
      return res.status(500).json({ error: 'Failed to list tmux sessions', details: stderr });
    }
    
    const rawSessions = stdout.trim().split('\n').filter(Boolean);
    const prefix = `u_${req.user.username}_`;

    const sessions = [];
    for (const line of rawSessions) {
      const [fullName, attached, created, sessionPath, workspaceName, agentType] = line.split('|');
      
      // If MULTI_USER_ENABLED is true, filter by prefix and strip it
      if (MULTI_USER_ENABLED) {
        if (!fullName.startsWith(prefix)) {
          continue;
        }
        const shortName = fullName.substring(prefix.length);
        sessions.push({
          name: shortName,
          attached: parseInt(attached, 10) > 0,
          created: new Date(parseInt(created) * 1000).toLocaleString(),
          path: sessionPath || '',
          workspaceName: workspaceName || '',
          agentType: agentType || ''
        });
      } else {
        sessions.push({
          name: fullName,
          attached: parseInt(attached, 10) > 0,
          created: new Date(parseInt(created) * 1000).toLocaleString(),
          path: sessionPath || '',
          workspaceName: workspaceName || '',
          agentType: agentType || ''
        });
      }
    }
    res.json(sessions);
  }, req.user.username);
});

// Create session
router.post('/sessions', requireAuth, (req, res) => {
  const { name, agent, workspacePath, workspaceName } = req.body;
  
  // Validate allowed agents
  const settings = db.getSettings();
  const allowedAgents = settings.enabledAgents || ['default', 'agy', 'claude', 'codex', 'kimi'];
  const reqAgent = agent || 'default';
  if (!allowedAgents.includes(reqAgent)) {
    return res.status(403).json({ error: `智能体环境 '${reqAgent}' 已被禁用。` });
  }

  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid session name. Use alphanumeric characters, underscores, or dashes.' });
  }

  let resolvedWorkspacePath = workspacePath;
  if (workspaceName && !resolvedWorkspacePath) {
    const workspaces = readWorkspaces(req.user.username);
    const ws = workspaces.find(w => w.name.toLowerCase() === workspaceName.toLowerCase());
    if (ws) {
      resolvedWorkspacePath = ws.path;
    }
  }

  if (!resolvedWorkspacePath) {
    resolvedWorkspacePath = getDefaultWorkspacePath(req.user ? req.user.username : null);
  }

  let physicalSession = name;
  if (MULTI_USER_ENABLED) {
    physicalSession = `u_${req.user.username}_${name}`;
  }

  const args = ['new-session', '-d', '-s', physicalSession];

  // resolvedPath is the validated absolute path on disk for this session
  let resolvedPath = null;
  if (resolvedWorkspacePath) {
    resolvedPath = resolveWorkspacePath(resolvedWorkspacePath, req.user.username);
    if (!fs.existsSync(resolvedPath)) {
      try {
        fs.mkdirSync(resolvedPath, { recursive: true });
      } catch (mkdirErr) {
        return res.status(500).json({ error: 'Failed to create workspace directory', details: mkdirErr.message });
      }
    }
    
    // Inject local hooks for the target agent — use the already-resolved path
    injectAgentHooks(resolvedPath, agent, (p) => resolveWorkspacePath(p, req.user.username));

    args.push('-c', resolvedPath);
  }

  // userHome: the $HOME directory set for the session shell.
  // In multi-user mode each user gets user_data/[username]/home with
  // read-only symlinks to agent config dirs from sysHome — so agents
  // find their API keys without exposing config files in the workspace browser.
  const userHome = getUserHomeDir(req.user ? req.user.username : null);
  const sysHome = getHomeDir(); // always the system user's home (for finding binaries)
  const binDir = path.resolve(PROJECT_ROOT, 'bin');
  const nodeBinDir = path.dirname(process.execPath);

  // Shell prefix: cd into workspace and set HOME so agents write config into the right place.
  // In single-user mode HOME is already correct; in multi-user mode we point HOME at user sandbox.
  // Use shellescape to prevent command injection via workspace path.
  const workDir = resolvedPath || userHome;
  let envPrefix = `cd ${shellescape(workDir)} && export HOME=${shellescape(userHome)} && export PATH=${shellescape(binDir)}:${shellescape(nodeBinDir)}:$PATH`;

  // Inject system default fallback keys dynamically, then source user's private .api_keys
  if (MULTI_USER_ENABLED && req.user && req.user.username) {
    const { getSystemDefaultKeys } = require('../services/fileService');
    const defaultKeys = getSystemDefaultKeys();
    const shellescapeVal = (val) => "'" + String(val).replace(/'/g, "'\\''") + "'";
    
    let fallbackExports = [];
    const defaultCodexKey = defaultKeys.codex || defaultKeys.claude;
    if (defaultCodexKey) {
      fallbackExports.push(`export OPENAI_API_KEY=${shellescapeVal(defaultCodexKey)}`);
    }
    if (defaultKeys.codexBaseUrl) {
      fallbackExports.push(`export OPENAI_BASE_URL=${shellescapeVal(defaultKeys.codexBaseUrl)}`);
      fallbackExports.push(`export OPENAI_API_BASE=${shellescapeVal(defaultKeys.codexBaseUrl)}`);
    }
    if (defaultKeys.codexModel) {
      fallbackExports.push(`export OPENAI_MODEL=${shellescapeVal(defaultKeys.codexModel)}`);
      fallbackExports.push(`export CODEX_MODEL=${shellescapeVal(defaultKeys.codexModel)}`);
    }
    
    if (fallbackExports.length > 0) {
      envPrefix += ` && ${fallbackExports.join(' && ')}`;
    }
    envPrefix += ` && [ -f ${shellescape(userHome)}/.api_keys ] && . ${shellescape(userHome)}/.api_keys || true`;
  }

  const getAgentPath = (agentName) => {
    const localPath = path.join(path.dirname(process.execPath), agentName);
    if (fs.existsSync(localPath)) return localPath;
    for (const p of [`${sysHome}/.local/bin/${agentName}`, `/usr/local/bin/${agentName}`, `/usr/bin/${agentName}`]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  };

  if (agent === 'agy') {
    const agyPath = getAgentPath('agy');
    const finalAgy = agyPath || 'agy';
    args.push(`${envPrefix}; ${finalAgy} --dangerously-skip-permissions; exec bash`);
  } else if (agent === 'claude') {
    const claudePath = getAgentPath('claude');
    if (claudePath) {
      args.push(`${envPrefix}; ${claudePath} --permission-mode auto; exec bash`);
    } else {
      args.push(`${envPrefix}; exec bash`);
    }
  } else if (agent === 'codex') {
    const codexPath = getAgentPath('codex');
    if (codexPath) {
      args.push(`${envPrefix}; ${codexPath} -c check_for_update=false -c update_on_startup=false; exec bash`);
    } else {
      args.push(`${envPrefix}; exec bash`);
    }
  } else if (agent === 'kimi') {
    let kimiPath = null;
    for (const p of [`${userHome}/.kimi-code/bin/kimi`, `${sysHome}/.kimi-code/bin/kimi`, '/usr/local/bin/kimi', '/usr/bin/kimi']) {
      if (fs.existsSync(p)) { kimiPath = p; break; }
    }
    if (kimiPath) {
      args.push(`${envPrefix}; ${kimiPath}; exec bash`);
    } else {
      args.push(`${envPrefix}; exec bash`);
    }
  } else {
    // Plain bash session — still ensure correct HOME and working directory
    args.push(`${envPrefix}; exec bash`);
  }

  execTmux(args, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to create session', details: stderr });
    }

    const optionsToSet = [
      ['set-option', '-t', physicalSession, 'status', 'off'],
      ['set-option', '-t', physicalSession, 'mouse', 'on']
    ];
    if (workspaceName) {
      optionsToSet.push(['set-option', '-t', physicalSession, '@workspace_name', workspaceName]);
    }
    if (agent) {
      optionsToSet.push(['set-option', '-t', physicalSession, '@agent_type', agent]);
    }

    let chain = Promise.resolve();
    optionsToSet.forEach(optArgs => {
      chain = chain.then(() => new Promise((resolve) => {
        execTmux(optArgs, (optErr) => {
          if (optErr) {
            console.error(`Failed to set tmux option ${optArgs.join(' ')}:`, optErr);
          }
          resolve();
        }, req.user.username);
      }));
    });

    chain.then(() => {
      res.json({ success: true, name });
    });
  }, req.user.username);
});

// Kill session
router.delete('/sessions/:name', requireAuth, (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid session name. Use alphanumeric characters, underscores, or dashes.' });
  }
  let physicalSession = name;
  if (MULTI_USER_ENABLED) {
    physicalSession = `u_${req.user.username}_${name}`;
  }
  execTmux(['kill-session', '-t', physicalSession], (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to kill session', details: stderr });
    }
    res.json({ success: true });
  }, req.user.username);
});

// Workspaces Endpoints
router.get('/workspaces', requireAuth, (req, res) => {
  res.json(readWorkspaces(req.user.username));
});

router.post('/workspaces', requireAuth, (req, res) => {
  const { name, path: wsPath } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Workspace name is required.' });
  }

  let resolvedPath;
  if (MULTI_USER_ENABLED && req.user.username) {
    // In multi-user mode, path is treated as a relative sub-directory name under the user's sandbox by default.
    // If omitted, default to using the workspace name as the directory name.
    const subDir = (wsPath && wsPath.trim()) ? wsPath.trim() : name.trim();
    resolvedPath = resolveWorkspacePath(subDir, req.user.username);
  } else {
    if (!wsPath) {
      return res.status(400).json({ error: 'Path is required.' });
    }
    resolvedPath = resolveWorkspacePath(wsPath, req.user.username);
  }

  if (!fs.existsSync(resolvedPath)) {
    try {
      fs.mkdirSync(resolvedPath, { recursive: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create workspace directory on disk', details: err.message });
    }
  }

  const workspaces = readWorkspaces(req.user.username);
  const exists = workspaces.find(w => w.name.toLowerCase() === name.toLowerCase() || resolveWorkspacePath(w.path, req.user.username) === resolvedPath);
  if (exists) {
    return res.status(400).json({ error: 'Workspace with this name or path already exists.' });
  }

  workspaces.push({ name, path: resolvedPath });
  writeWorkspaces(workspaces, req.user.username);
  res.json({ success: true, workspace: { name, path: resolvedPath } });
});

router.delete('/workspaces/:name', requireAuth, (req, res) => {
  const { name } = req.params;
  const workspaces = readWorkspaces(req.user.username);
  const filtered = workspaces.filter(w => w.name.toLowerCase() !== name.toLowerCase());
  if (filtered.length === workspaces.length) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  writeWorkspaces(filtered, req.user.username);
  res.json({ success: true });
});

// List subdirectories only (for workspace directory picker)
router.get('/directories', requireAuth, (req, res) => {
  try {
    const rawPath = req.query.path || '~';
    const targetDir = resolveWorkspacePath(rawPath, req.user.username);
    
    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }

    const items = fs.readdirSync(targetDir, { withFileTypes: true });
    
    const result = items
      .filter(item => {
        if (!item.isDirectory()) return false;
        return item.name !== '.git' && item.name !== 'node_modules' && item.name !== '.claude' && item.name !== '.codex';
      })
      .map(item => {
        const itemPath = path.join(targetDir, item.name);
        return {
          name: item.name,
          path: itemPath
        };
      });
      
    result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    
    const baseLimit = (MULTI_USER_ENABLED && req.user.username !== 'admin') ? getUserWorkspaceRoot(req.user.username) : '/';
    res.json({
      currentPath: targetDir,
      parentPath: targetDir === baseLimit ? null : path.dirname(targetDir),
      directories: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List files/folders in a path
router.get('/files/list', requireAuth, (req, res) => {
  try {
    const workspacePath = req.query.workspacePath || '';
    const relativePath = req.query.path || '';
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath, req.user.username) : getDefaultWorkspacePath(req.user ? req.user.username : null);
    const targetDir = safeResolve(workspacePath, relativePath, req.user.username);
    
    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }

    const items = fs.readdirSync(targetDir, { withFileTypes: true });
    
    const result = items
      .filter(item => {
        return item.name !== '.git' && item.name !== 'node_modules' && item.name !== '.claude' && item.name !== '.codex';
      })
      .map(item => {
        const itemPath = path.join(targetDir, item.name);
        const relPath = path.relative(rootDir, itemPath);
        let size = null;
        try {
          const itemStat = fs.statSync(itemPath);
          size = itemStat.isFile() ? itemStat.size : null;
        } catch (e) {
          // ignore
        }
        return {
          name: item.name,
          path: relPath,
          isDir: item.isDirectory(),
          size
        };
      });
      
    result.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read file contents
router.get('/files/content', requireAuth, (req, res) => {
  try {
    const workspacePath = req.query.workspacePath || '';
    const relativePath = req.query.path;
    if (!relativePath) {
      return res.status(400).json({ error: 'Path is required' });
    }
    const targetPath = safeResolve(workspacePath, relativePath, req.user.username);
    
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }
    
    if (stat.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'File is too large (max 2MB for browser editing)' });
    }
    
    const content = fs.readFileSync(targetPath, 'utf8');
    res.json({
      path: relativePath,
      content,
      size: stat.size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save file contents
router.post('/files/save', requireAuth, (req, res) => {
  try {
    const { workspacePath, filePath, content } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }
    
    const targetPath = safeResolve(workspacePath, filePath, req.user.username);
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      return res.status(400).json({ error: 'Parent directory does not exist' });
    }
    
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'Target path is not a file' });
      }
    }
    
    fs.writeFileSync(targetPath, content || '', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
router.get('/git/status', requireAuth, (req, res) => {
  try {
    const workspacePath = req.query.workspacePath || '';
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath, req.user.username) : getDefaultWorkspacePath(req.user ? req.user.username : null);
    
    if (!fs.existsSync(rootDir)) {
      return res.status(404).json({ error: 'Workspace directory not found' });
    }
    
    execCommand('git', ['status', '--porcelain', '-u', '--ignored'], rootDir, (err, stdout, stderr) => {
      if (err && (stderr.includes('not a git repository') || (err.message && err.message.includes('exit 128')))) {
        return res.json({ isGit: false, files: [] });
      }
      if (err && err.code === 'ENOENT') {
        return res.status(500).json({ error: 'Git is not installed on the system' });
      }
      
      const files = [];
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const code = line.substring(0, 2);
        let filePath = line.substring(3).trim();
        
        let renameFrom = null;
        if (code.startsWith('R') || code.endsWith('R')) {
          const parts = filePath.split(' -> ');
          if (parts.length === 2) {
            renameFrom = parts[0];
            filePath = parts[1];
          }
        }
        
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }
        
        files.push({
          path: filePath,
          status: code.trim(),
          index: code[0],
          worktree: code[1],
          renameFrom
        });
      }
      
      res.json({ isGit: true, files });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Git diff endpoint
router.get('/git/diff', requireAuth, (req, res) => {
  try {
    const workspacePath = req.query.workspacePath || '';
    const filePath = req.query.path || '';
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath, req.user.username) : getDefaultWorkspacePath(req.user ? req.user.username : null);
    
    if (!fs.existsSync(rootDir)) {
      return res.status(404).json({ error: 'Workspace directory not found' });
    }
    
    if (filePath) {
      const targetPath = safeResolve(workspacePath, filePath, req.user.username);
      const relPath = path.relative(rootDir, targetPath);
      
      execCommand('git', ['status', '--porcelain', '--', relPath], rootDir, (statusErr, statusStdout) => {
        const isUntracked = statusStdout && statusStdout.trim().startsWith('??');
        
        if (isUntracked) {
          execCommand('git', ['diff', '--no-index', '--', '/dev/null', relPath], rootDir, (diffErr, diffStdout, diffStderr) => {
            res.json({ diff: diffStdout || '' });
          });
        } else {
          execCommand('git', ['diff', 'HEAD', '--', relPath], rootDir, (diffErr, diffStdout, diffStderr) => {
            res.json({ diff: diffStdout || '' });
          });
        }
      });
    } else {
      execCommand('git', ['diff', 'HEAD'], rootDir, (err, stdout, stderr) => {
        if (err && (stderr.includes('not a git repository') || (err.message && err.message.includes('exit 128')))) {
          return res.status(400).json({ error: 'Not a git repository' });
        }
        res.json({ diff: stdout || '' });
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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

module.exports = router;
