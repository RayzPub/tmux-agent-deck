const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const { PASSWORD, JWT_SECRET, useHttps, PROJECT_ROOT } = require('../config');
const { requireAuth, verifyToken } = require('../middlewares/auth');
const { execTmux, injectAgentHooks, getRunUser } = require('../services/tmuxService');
const { resolveWorkspacePath, readWorkspaces, writeWorkspaces, safeResolve, getHomeDir } = require('../services/fileService');
const { execCommand } = require('../services/gitService');
const { getPublicKey, registerSubscription, unregisterSubscription, sendPushToAll } = require('../services/pushService');

// API: Login
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    const token = jwt.sign({ authenticated: true }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: useHttps,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

// API: Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// API: Check Auth status
router.get('/auth-status', (req, res) => {
  const decoded = verifyToken(req);
  res.json({ authenticated: !!decoded });
});

// API: Tmux Commands (Protected)
// List sessions
router.get('/sessions', requireAuth, (req, res) => {
  execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}|#{session_path}|#{@workspace_name}|#{@agent_type}'], (err, stdout, stderr) => {
    if (err) {
      if (err.code === 1) {
        return res.json([]);
      }
      return res.status(500).json({ error: 'Failed to list tmux sessions', details: stderr });
    }
    
    const sessions = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, attached, created, sessionPath, workspaceName, agentType] = line.split('|');
      return {
        name,
        attached: parseInt(attached, 10) > 0,
        created: new Date(parseInt(created) * 1000).toLocaleString(),
        path: sessionPath || '',
        workspaceName: workspaceName || '',
        agentType: agentType || ''
      };
    });
    res.json(sessions);
  });
});

// Create session
router.post('/sessions', requireAuth, (req, res) => {
  const { name, agent, workspacePath, workspaceName } = req.body;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid session name. Use alphanumeric characters, underscores, or dashes.' });
  }

  let resolvedWorkspacePath = workspacePath;
  if (workspaceName && !resolvedWorkspacePath) {
    const workspaces = readWorkspaces();
    const ws = workspaces.find(w => w.name.toLowerCase() === workspaceName.toLowerCase());
    if (ws) {
      resolvedWorkspacePath = ws.path;
    }
  }

  const args = ['new-session', '-d', '-s', name];

  if (resolvedWorkspacePath) {
    const resolvedPath = resolveWorkspacePath(resolvedWorkspacePath);
    if (!fs.existsSync(resolvedPath)) {
      try {
        fs.mkdirSync(resolvedPath, { recursive: true });
      } catch (mkdirErr) {
        return res.status(500).json({ error: 'Failed to create workspace directory', details: mkdirErr.message });
      }
    }
    
    // Inject local hooks for the target agent
    injectAgentHooks(resolvedWorkspacePath, agent, resolveWorkspacePath);

    args.push('-c', resolvedPath);
  }

  const userHome = getHomeDir();
  const binDir = path.resolve(PROJECT_ROOT, 'bin');
  if (agent === 'agy') {
    args.push(`export PATH="${binDir}:$PATH"; ${userHome}/.local/bin/agy --dangerously-skip-permissions; exec bash`);
  } else if (agent === 'claude') {
    let claudePath = null;
    const possiblePaths = [
      `${userHome}/.nvm/versions/node`,
      `${userHome}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/usr/bin/claude'
    ];

    const nvmNodeDir = `${userHome}/.nvm/versions/node`;
    if (fs.existsSync(nvmNodeDir)) {
      try {
        const nodeVersions = fs.readdirSync(nvmNodeDir).filter(d => d.startsWith('v'));
        if (nodeVersions.length > 0) {
          const latestVersion = nodeVersions.sort((a, b) => {
            const aNum = parseInt(a.replace('v', '').split('.')[0]);
            const bNum = parseInt(b.replace('v', '').split('.')[0]);
            return bNum - aNum;
          })[0];
          claudePath = `${nvmNodeDir}/${latestVersion}/bin/claude`;
        }
      } catch (e) {}
    }

    if (!claudePath || !fs.existsSync(claudePath)) {
      for (const p of possiblePaths.slice(1)) {
        if (fs.existsSync(p)) {
          claudePath = p;
          break;
        }
      }
    }

    if (claudePath) {
      args.push(`export PATH="${binDir}:$PATH"; ${claudePath} --permission-mode auto; exec bash`);
    } else {
      args.push(`export PATH="${binDir}:$PATH"; exec bash`);
    }
  } else if (agent === 'codex') {
    let codexPath = null;
    const possiblePaths = [
      `${userHome}/.local/bin/codex`,
      '/usr/local/bin/codex',
      '/usr/bin/codex'
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        codexPath = p;
        break;
      }
    }
    if (codexPath) {
      args.push(`export PATH="${binDir}:$PATH"; ${codexPath} --dangerously-bypass-hook-trust; exec bash`);
    } else {
      args.push(`export PATH="${binDir}:$PATH"; exec bash`);
    }
  }

  execTmux(args, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to create session', details: stderr });
    }

    const optionsToSet = [
      ['set-option', '-t', name, 'status', 'off'],
      ['set-option', '-t', name, 'mouse', 'on']
    ];
    if (workspaceName) {
      optionsToSet.push(['set-option', '-t', name, '@workspace_name', workspaceName]);
    }
    if (agent) {
      optionsToSet.push(['set-option', '-t', name, '@agent_type', agent]);
    }

    let chain = Promise.resolve();
    optionsToSet.forEach(optArgs => {
      chain = chain.then(() => new Promise((resolve) => {
        execTmux(optArgs, (optErr) => {
          if (optErr) {
            console.error(`Failed to set tmux option ${optArgs.join(' ')}:`, optErr);
          }
          resolve();
        });
      }));
    });

    chain.then(() => {
      res.json({ success: true, name });
    });
  });
});

// Kill session
router.delete('/sessions/:name', requireAuth, (req, res) => {
  const { name } = req.params;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid session name. Use alphanumeric characters, underscores, or dashes.' });
  }
  execTmux(['kill-session', '-t', name], (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to kill session', details: stderr });
    }
    res.json({ success: true });
  });
});

// Workspaces Endpoints
router.get('/workspaces', requireAuth, (req, res) => {
  res.json(readWorkspaces());
});

router.post('/workspaces', requireAuth, (req, res) => {
  const { name, path: wsPath } = req.body;
  if (!name || !wsPath) {
    return res.status(400).json({ error: 'Name and path are required.' });
  }

  const resolvedPath = resolveWorkspacePath(wsPath);
  if (!fs.existsSync(resolvedPath)) {
    try {
      fs.mkdirSync(resolvedPath, { recursive: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create workspace directory on disk', details: err.message });
    }
  }

  const workspaces = readWorkspaces();
  const exists = workspaces.find(w => w.name.toLowerCase() === name.toLowerCase() || resolveWorkspacePath(w.path) === resolvedPath);
  if (exists) {
    return res.status(400).json({ error: 'Workspace with this name or path already exists.' });
  }

  workspaces.push({ name, path: resolvedPath });
  writeWorkspaces(workspaces);
  res.json({ success: true, workspace: { name, path: resolvedPath } });
});

router.delete('/workspaces/:name', requireAuth, (req, res) => {
  const { name } = req.params;
  const workspaces = readWorkspaces();
  const filtered = workspaces.filter(w => w.name.toLowerCase() !== name.toLowerCase());
  if (filtered.length === workspaces.length) {
    return res.status(404).json({ error: 'Workspace not found.' });
  }
  writeWorkspaces(filtered);
  res.json({ success: true });
});

// List subdirectories only (for workspace directory picker)
router.get('/directories', requireAuth, (req, res) => {
  try {
    const rawPath = req.query.path || getHomeDir();
    const targetDir = resolveWorkspacePath(rawPath);
    
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
    
    res.json({
      currentPath: targetDir,
      parentPath: targetDir === '/' ? null : path.dirname(targetDir),
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
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath) : PROJECT_ROOT;
    const targetDir = safeResolve(workspacePath, relativePath);
    
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
    const targetPath = safeResolve(workspacePath, relativePath);
    
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
    
    const targetPath = safeResolve(workspacePath, filePath);
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

// Git status endpoint
router.get('/git/status', requireAuth, (req, res) => {
  try {
    const workspacePath = req.query.workspacePath || '';
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath) : PROJECT_ROOT;
    
    if (!fs.existsSync(rootDir)) {
      return res.status(404).json({ error: 'Workspace directory not found' });
    }
    
    execCommand('git', ['status', '--porcelain', '-u'], rootDir, (err, stdout, stderr) => {
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
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath) : PROJECT_ROOT;
    
    if (!fs.existsSync(rootDir)) {
      return res.status(404).json({ error: 'Workspace directory not found' });
    }
    
    if (filePath) {
      const targetPath = safeResolve(workspacePath, filePath);
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
  registerSubscription(subscription);
  res.json({ success: true });
});

router.post('/push/unregister', requireAuth, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  unregisterSubscription(subscription);
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
  
  const io = req.app.get('io');
  sendPushToAll(io, { title, body, url: url || '/', session: targetSession });
  res.json({ success: true });
});

module.exports = router;
