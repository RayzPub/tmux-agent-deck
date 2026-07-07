require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketIo = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const pty = require('node-pty');
const { spawn } = require('child_process');
const crypto = require('crypto');
const webpush = require('web-push');

// Helper: get run-as-user configuration (drops privileges to SUDO_USER if run as root)
const getRunUser = () => {
  if (process.getuid && process.getuid() === 0) {
    // If running as root, check if we were invoked via sudo by a non-root user
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser && sudoUser !== 'root') {
      return sudoUser;
    }
  }
  return null;
};

// Wrap commands for spawn (safe execution)
const execTmux = (args, callback) => {
  const user = getRunUser();
  const finalArgs = user ? ['-u', user, 'tmux', ...args] : args;
  const cmd = user ? 'sudo' : 'tmux';

  try {
    const proc = spawn(cmd, finalArgs);
    let stdout = '', stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (err) => {
      callback(err, stdout, stderr);
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`exit ${code}`);
        err.code = code;
        callback(err, stdout, stderr);
      } else {
        callback(null, stdout, stderr);
      }
    });
  } catch (err) {
    callback(err, '', '');
  }
};

const app = express();

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const PASSWORD = process.env.PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;

let useHttps = false;
let sslOptions = null;

if (SSL_CERT_PATH && SSL_KEY_PATH) {
  try {
    if (fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)) {
      sslOptions = {
        cert: fs.readFileSync(SSL_CERT_PATH),
        key: fs.readFileSync(SSL_KEY_PATH)
      };
      useHttps = true;
      console.log(`🔒 SSL Certificates successfully loaded: cert=${SSL_CERT_PATH}, key=${SSL_KEY_PATH}`);
    } else {
      console.warn(`⚠️ WARNING: SSL certificate files configured but not found on disk.`);
      console.warn(`Expected Cert at: ${SSL_CERT_PATH}`);
      console.warn(`Expected Key at: ${SSL_KEY_PATH}`);
    }
  } catch (err) {
    console.error('❌ ERROR: Failed to load SSL certificates:', err);
  }
}

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

if (!PASSWORD || PASSWORD.length < 16) {
  console.error('FATAL: PASSWORD must be set in environment and be at least 16 characters');
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set in environment and be at least 32 characters');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

// API: Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    const token = jwt.sign({ authenticated: true }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: useHttps, // Set to true if running over HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

// API: Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// API: Check Auth status
app.get('/api/auth-status', (req, res) => {
  const decoded = verifyToken(req);
  res.json({ authenticated: !!decoded });
});

// Serve login page without authentication
app.get('/login.html', (req, res) => {
  // If already logged in, redirect to index
  if (verifyToken(req)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve static assets (CSS, JS) in public folder that are non-protected (like login page assets)
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Protect index.html and other static routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback to protect any other static files
app.use(express.static(path.join(__dirname, 'public'), {
  index: false // Prevent serving index.html automatically without requireAuth
}));

// API: Tmux Commands (Protected)
// List sessions
app.get('/api/sessions', requireAuth, (req, res) => {
  // -F formats: session_name, session_attached, session_created, session_path, @workspace_name, @agent_type
  // Output format: name|attached|created|path|workspaceName|agentType
  execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}|#{session_path}|#{@workspace_name}|#{@agent_type}'], (err, stdout, stderr) => {
    if (err) {
      // If error code is 1, it usually means tmux is running but has no sessions
      if (err.code === 1) {
        return res.json([]);
      }
      return res.status(500).json({ error: 'Failed to list tmux sessions', details: stderr });
    }
    
    const sessions = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, attached, created, sessionPath, workspaceName, agentType] = line.split('|');
      return {
        name,
        attached: attached === '1',
        created: new Date(parseInt(created) * 1000).toLocaleString(),
        path: sessionPath || '',
        workspaceName: workspaceName || '',
        agentType: agentType || ''
      };
    });
    res.json(sessions);
  });
});

// Helper to inject agent-specific local hook configurations into the workspace
const injectAgentHooks = (workspacePath, agent) => {
  if (!workspacePath) return;
  const resolvedPath = resolveWorkspacePath(workspacePath);
  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  if (agent === 'agy') {
    const agentsDir = path.join(resolvedPath, '.agents');
    const hooksFile = path.join(agentsDir, 'hooks.json');
    try {
      if (!fs.existsSync(agentsDir)) {
        fs.mkdirSync(agentsDir, { recursive: true });
      }
      
      let hooksData = {};
      if (fs.existsSync(hooksFile)) {
        try {
          hooksData = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        } catch (e) {
          hooksData = {};
        }
      }

      // Check if gate is already present
      if (!hooksData['deck-notify-gate']) {
        hooksData['deck-notify-gate'] = {
          enabled: true,
          PreToolUse: [
            {
              matcher: "ask_permission|ask_question",
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/deck-notify 'Agy 智能体请求' 'Agy 正在请求执行工具，可能需要您的确认。'",
                  timeout: 10
                }
              ]
            }
          ]
        };
        fs.writeFileSync(hooksFile, JSON.stringify(hooksData, null, 2), 'utf8');
        console.log(`[Hooks Injection] Injected agy hooks.json in ${resolvedPath}`);
      }
    } catch (err) {
      console.error('Failed to inject agy hooks:', err);
    }
  } else if (agent === 'claude') {
    const claudeDir = path.join(resolvedPath, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');
    try {
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      
      let settingsData = {};
      if (fs.existsSync(settingsFile)) {
        try {
          settingsData = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        } catch (e) {
          settingsData = {};
        }
      }

      if (!settingsData.hooks) {
        settingsData.hooks = {};
      }
      if (!settingsData.hooks.PermissionRequest) {
        settingsData.hooks.PermissionRequest = [];
      }

      const hasDeckNotify = settingsData.hooks.PermissionRequest.some(h => 
        h.hooks && h.hooks.some(inner => inner.command && inner.command.includes('deck-notify'))
      );

      if (!hasDeckNotify) {
        settingsData.hooks.PermissionRequest.push({
          hooks: [
            {
              type: "command",
              command: "/usr/local/bin/deck-notify 'Claude 权限请求' 'Claude 正在等待您的终端授权确认。'"
            }
          ]
        });
        fs.writeFileSync(settingsFile, JSON.stringify(settingsData, null, 2), 'utf8');
        console.log(`[Hooks Injection] Injected claude settings.local.json in ${resolvedPath}`);
      }
    } catch (err) {
      console.error('Failed to inject claude settings:', err);
    }
  }
};

// Create session
app.post('/api/sessions', requireAuth, (req, res) => {
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
    injectAgentHooks(resolvedWorkspacePath, agent);

    args.push('-c', resolvedPath);
  }

  // Dynamic agent paths based on user home directory
  const userHome = getHomeDir();
  if (agent === 'agy') {
    args.push(`${userHome}/.local/bin/agy --dangerously-skip-permissions; exec bash`);
  } else if (agent === 'claude') {
    // Find claude binary: try nvm versions first, then fallback paths
    let claudePath = null;
    const possiblePaths = [
      `${userHome}/.nvm/versions/node`,  // nvm managed
      `${userHome}/.local/bin/claude`,   // local install
      '/usr/local/bin/claude',           // system install
      '/usr/bin/claude'                  // system install
    ];

    // Check nvm versions for latest node with claude
    const nvmNodeDir = `${userHome}/.nvm/versions/node`;
    if (fs.existsSync(nvmNodeDir)) {
      try {
        const nodeVersions = fs.readdirSync(nvmNodeDir).filter(d => d.startsWith('v'));
        if (nodeVersions.length > 0) {
          // Sort by version and pick latest
          const latestVersion = nodeVersions.sort((a, b) => {
            const aNum = parseInt(a.replace('v', '').split('.')[0]);
            const bNum = parseInt(b.replace('v', '').split('.')[0]);
            return bNum - aNum;
          })[0];
          claudePath = `${nvmNodeDir}/${latestVersion}/bin/claude`;
        }
      } catch (e) {}
    }

    // Fallback if nvm not found
    if (!claudePath || !fs.existsSync(claudePath)) {
      for (const p of possiblePaths.slice(1)) {
        if (fs.existsSync(p)) {
          claudePath = p;
          break;
        }
      }
    }

    if (claudePath) {
      args.push(`${claudePath} --permission-mode auto; exec bash`);
    } else {
      // If claude not found, just start bash
      args.push('exec bash');
    }
  }

  execTmux(args, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to create session', details: stderr });
    }

    // Build the Tmux options configuration pipeline
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

    // Set options sequentially
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
app.delete('/api/sessions/:name', requireAuth, (req, res) => {
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

// File Explorer API (Protected)
const PROJECT_ROOT = path.resolve(__dirname);
const WORKSPACES_FILE = path.join(__dirname, 'workspaces.json');

const getHomeDir = () => {
  const runUser = getRunUser();
  if (runUser) {
    return `/home/${runUser}`;
  }
  return process.env.HOME || require('os').homedir();
};

const resolveWorkspacePath = (p) => {
  if (!p) return '';
  let resolved = p;
  if (p.startsWith('~/') || p === '~') {
    resolved = p.replace('~', getHomeDir());
  }
  return path.resolve(resolved);
};

const readWorkspaces = () => {
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading workspaces file:', err);
  }
  return [];
};

const writeWorkspaces = (workspaces) => {
  try {
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing workspaces file:', err);
    return false;
  }
};

// Safe path resolver to prevent directory traversal
const safeResolve = (workspacePath, reqPath) => {
  const root = workspacePath ? resolveWorkspacePath(workspacePath) : PROJECT_ROOT;
  const resolved = path.resolve(root, reqPath || '.');
  if (!resolved.startsWith(root)) {
    throw new Error('Access denied: Out of workspace root');
  }
  return resolved;
};

// Workspaces Endpoints
app.get('/api/workspaces', requireAuth, (req, res) => {
  res.json(readWorkspaces());
});

app.post('/api/workspaces', requireAuth, (req, res) => {
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

app.delete('/api/workspaces/:name', requireAuth, (req, res) => {
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
app.get('/api/directories', requireAuth, (req, res) => {
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
        return item.name !== '.git' && item.name !== 'node_modules' && item.name !== '.claude';
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
app.get('/api/files/list', requireAuth, (req, res) => {
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
        // Exclude common noise directories/files to keep it ultra lightweight
        return item.name !== '.git' && item.name !== 'node_modules' && item.name !== '.claude';
      })
      .map(item => {
        const itemPath = path.join(targetDir, item.name);
        const relPath = path.relative(rootDir, itemPath);
        let size = null;
        try {
          const itemStat = fs.statSync(itemPath);
          size = itemStat.isFile() ? itemStat.size : null;
        } catch (e) {
          // ignore stat errors on broken symlinks etc.
        }
        return {
          name: item.name,
          path: relPath,
          isDir: item.isDirectory(),
          size
        };
      });
      
    // Sort: directories first, then files alphabetically
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
app.get('/api/files/content', requireAuth, (req, res) => {
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
    
    // Limit file size to 2MB to keep browser editing fast
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
app.post('/api/files/save', requireAuth, (req, res) => {
  try {
    const { workspacePath, filePath, content } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }
    
    const targetPath = safeResolve(workspacePath, filePath);
    
    // Check if parent directory exists
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      return res.status(400).json({ error: 'Parent directory does not exist' });
    }
    
    // If it exists, ensure it is a file
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

// Helper for running shell commands securely (e.g. git)
const execCommand = (cmd, args, cwd, callback) => {
  const user = getRunUser();
  let finalCmd = cmd;
  let finalArgs = args;
  
  if (user) {
    finalCmd = 'sudo';
    finalArgs = ['-u', user, cmd, ...args];
  }
  
  try {
    const proc = spawn(finalCmd, finalArgs, { cwd });
    let stdout = '', stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (err) => {
      callback(err, stdout, stderr);
    });
    
    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) { // git diff and git diff --no-index can exit with 1 on differences, which is normal
        const err = new Error(`exit ${code}`);
        err.code = code;
        callback(err, stdout, stderr);
      } else {
        callback(null, stdout, stderr);
      }
    });
  } catch (err) {
    callback(err, '', '');
  }
};

// Git status endpoint
app.get('/api/git/status', requireAuth, (req, res) => {
  try {
    const workspacePath = req.query.workspacePath || '';
    const rootDir = workspacePath ? resolveWorkspacePath(workspacePath) : PROJECT_ROOT;
    
    if (!fs.existsSync(rootDir)) {
      return res.status(404).json({ error: 'Workspace directory not found' });
    }
    
    execCommand('git', ['status', '--porcelain'], rootDir, (err, stdout, stderr) => {
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
app.get('/api/git/diff', requireAuth, (req, res) => {
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

// --- PWA Push Notification System ---
const VAPID_FILE = path.join(__dirname, 'vapid.json');
let vapidKeys = null;

if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    console.log('🔑 Loaded existing VAPID keys.');
  } catch (err) {
    console.error('❌ Error reading VAPID file, generating new keys...', err);
  }
}

if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
  console.log('🔑 Generated and saved new VAPID keys.');
}

webpush.setVapidDetails(
  `https://${process.env.DOMAIN_NAME || 'outshine.cloud'}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'push_subscriptions.json');
let subscriptions = [];

if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
  try {
    subscriptions = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    console.log(`📱 Loaded ${subscriptions.length} push subscriptions.`);
  } catch (err) {
    console.error('❌ Error reading subscriptions file:', err);
    subscriptions = [];
  }
}

const saveSubscriptions = () => {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Error saving subscriptions:', err);
  }
};

const isSessionBeingViewed = (sessionName) => {
  try {
    const sockets = io.sockets.sockets;
    for (const [id, socket] of sockets) {
      if (socket.sessionName === sessionName && socket.isFocused && socket.activeSession === sessionName) {
        return true;
      }
    }
  } catch (err) {
    console.error('Error checking active sockets:', err);
  }
  return false;
};

const lastPushTimeMap = new Map();
const PUSH_THROTTLE_MS = process.env.PUSH_THROTTLE_MS !== undefined ? parseInt(process.env.PUSH_THROTTLE_MS, 10) : 30000;

const sendPushToAll = (payload) => {
  if (payload.session) {
    if (isSessionBeingViewed(payload.session)) {
      console.log(`📡 [Push Bypassed] Session ${payload.session} is currently focused and viewed in active tab.`);
      return Promise.resolve();
    }
    
    const now = Date.now();
    const lastTime = lastPushTimeMap.get(payload.session) || 0;
    if (now - lastTime < PUSH_THROTTLE_MS) {
      console.log(`📡 [Push Throttled] Session ${payload.session} sent a push too recently. Throttled. (Time since last push: ${Math.round((now - lastTime) / 1000)}s)`);
      return Promise.resolve();
    }
    lastPushTimeMap.set(payload.session, now);
  }

  const payloadString = JSON.stringify(payload);
  console.log(`📡 Sending push to ${subscriptions.length} devices...`);
  
  const promises = subscriptions.map((sub) => {
    return webpush.sendNotification(sub, payloadString)
      .catch((err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`📱 Subscription expired/gone (Status ${err.statusCode}). Removing subscription.`);
          subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
          saveSubscriptions();
        } else {
          console.error(`❌ Push notification failed for endpoint ${sub.endpoint}: ${err.message} (Status: ${err.statusCode || 'N/A'}, Body: ${err.body || 'N/A'})`);
        }
      });
  });
  
  return Promise.all(promises);
};

// Express API endpoints for Web Push
app.get('/api/push/key', requireAuth, (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/register', requireAuth, (req, res) => {
  const subscription = req.body;
  
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  
  const exists = subscriptions.some(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push(subscription);
    saveSubscriptions();
    console.log(`📱 New subscription added. Total: ${subscriptions.length}`);
  }
  
  res.json({ success: true });
});

app.post('/api/push/unregister', requireAuth, (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  
  subscriptions = subscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
  saveSubscriptions();
  console.log(`📱 Subscription removed. Total: ${subscriptions.length}`);
  res.json({ success: true });
});

app.post('/api/push/trigger', (req, res) => {
  let isAuthorized = false;
  
  // 1. Check for Bearer token in Authorization header
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
  
  // 2. Bypass authentication if request is from localhost
  const remoteAddress = req.socket.remoteAddress;
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
    isAuthorized = true;
  }
  
  // 3. Fallback: check browser cookies (requireAuth equivalent)
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
  
  sendPushToAll({ title, body, url: url || '/', session: targetSession });
  res.json({ success: true });
});


// Non-intrusive TMUX Screen Monitor (Polling via tmux capture-pane)
const notifiedPrompts = new Map();

const execPromise = (args) => {
  return new Promise((resolve, reject) => {
    execTmux(args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
};

const checkSessionsForPrompts = async () => {
  try {
    const listOutput = await execPromise(['list-sessions', '-F', '#{session_name}']);
    const sessions = listOutput.split('\n').map(s => s.trim()).filter(Boolean);
    
    for (const session of sessions) {
      try {
        const paneContent = await execPromise(['capture-pane', '-t', session, '-p']);
        const lines = paneContent.split('\n').map(l => l.trim()).filter(Boolean);
        
        // We look at the last 5 lines of the pane (where prompts/confirmations usually appear)
        const lastLines = lines.slice(-5);
        let foundMatch = null;
        
        // Common patterns for agent prompt/confirmations or permissions
        const patterns = [
          /\[y\/N\]/i,
          /\[Y\/n\]/i,
          /\[y\/n\]/i,
          /\(y\/n\)/i,
          /allow\s+.*?\?/i,
          /confirm\s+.*?\?/i,
          /please\s+authorize/i,
          /authorize\s+.*?\?/i,
          /waiting\s+for\s+(approval|input|feedback)/i,
          /escalate_admin/i,
          /permission\s+denied/i,
          /enter\s+to\s+continue/i,
          /password\s+for\s+.*?:/i
        ];
        
        for (const line of lastLines) {
          for (const pattern of patterns) {
            if (pattern.test(line)) {
              foundMatch = line;
              break;
            }
          }
          if (foundMatch) break;
        }
        
        if (foundMatch) {
          // Clean ANSI escape codes from matched line for a clean notification display
          const cleanLine = foundMatch.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          const hash = crypto.createHash('md5').update(cleanLine).digest('hex');
          const lastHash = notifiedPrompts.get(session);
          
          if (lastHash !== hash) {
            console.log(`[Push Notification Triggered] Session: ${session}, Match: "${cleanLine}"`);
            notifiedPrompts.set(session, hash);
            
            sendPushToAll({
              title: `Agent Action Required: ${session}`,
              body: cleanLine.length > 80 ? cleanLine.slice(0, 77) + '...' : cleanLine,
              url: `/?session=${session}`,
              session: session
            });
          }
        } else {
          // No prompt found in the last lines, clear the notification state
          if (notifiedPrompts.has(session)) {
            notifiedPrompts.delete(session);
          }
        }
      } catch (err) {
        // Ignored: session might have just been closed or is not capturing
      }
    }
  } catch (err) {
    // Ignored: tmux is running but has no sessions
  }
};

// Run scanning check every 5 seconds
setInterval(checkSessionsForPrompts, 5000);

// Socket.io Authentication Middleware
io.use((socket, next) => {
  // Parse cookies
  const cookieHeader = socket.handshake.headers.cookie;
  if (!cookieHeader) {
    return next(new Error('Authentication error: No cookies found'));
  }
  
  // Extract token from cookie string
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    cookies[parts[0].trim()] = parts.slice(1).join('=');
  });

  const token = cookies['token'];
  if (!token) {
    return next(new Error('Authentication error: Token not found'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

// Socket.io Terminal Connection
io.on('connection', (socket) => {
  console.log('Client connected to terminal socket:', socket.id);
  let ptyProcess = null;

  // Track client focus state to avoid duplicate notifications
  socket.isFocused = false;
  socket.activeSession = null;
  socket.sessionName = null;

  socket.on('client-focus', ({ focused, activeSession }) => {
    socket.isFocused = focused;
    socket.activeSession = activeSession;
  });

  socket.on('init-terminal', ({ sessionName, cols, rows }) => {
    socket.sessionName = sessionName;
    // Clean up existing PTY if present (e.g., during reconnection)
    if (ptyProcess) {
      console.log('Cleaning up existing PTY before re-init for socket:', socket.id);
      try {
        ptyProcess.kill();
      } catch (err) {
        console.error('Error killing existing PTY:', err);
      }
      ptyProcess = null;
    }

    if (!sessionName || !/^[a-zA-Z0-9_-]+$/.test(sessionName)) {
      console.error('Invalid sessionName requested for terminal:', sessionName);
      socket.emit('terminal-output', '\r\n\x1b[31;1mError: Invalid session name.\x1b[0m\r\n');
      return;
    }

    console.log(`Spawning pty for tmux session: ${sessionName} (${cols}x${rows})`);

    const runUser = getRunUser();
    const shell = runUser ? '/usr/bin/sudo' : 'tmux';
    const args = runUser
      ? ['-u', runUser, 'tmux', 'new-session', '-A', '-s', sessionName]
      : ['new-session', '-A', '-s', sessionName];
    const userHome = runUser ? `/home/${runUser}` : (process.env.HOME || require('os').homedir());

    try {
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: userHome,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          HOME: userHome,
          USER: runUser || process.env.USER || require('os').userInfo().username
        }
      });

      // Stream data from PTY process to Socket.io client
      ptyProcess.onData((data) => {
        socket.emit('terminal-output', data);
      });

      // Handle PTY process exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`PTY process exited with code ${exitCode}, signal ${signal}`);
        socket.emit('terminal-exit');
        ptyProcess = null;
      });
    } catch (err) {
      console.error('Failed to spawn PTY:', err);
      socket.emit('terminal-output', '\r\n\x1b[31;1mError: Failed to spawn shell process.\x1b[0m\r\n');
    }
  });

  // Write terminal input to PTY
  socket.on('terminal-input', (data) => {
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  // Handle resize events
  socket.on('resize', ({ cols, rows }) => {
    if (ptyProcess) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (err) {
        console.error('Error resizing PTY:', err);
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected from terminal socket:', socket.id);
    if (ptyProcess) {
      // Just kill the attach-session shell process. The tmux session itself survives!
      try {
        ptyProcess.kill();
      } catch (err) {
        console.error('Error killing PTY process:', err);
      }
      ptyProcess = null;
    }
  });
});

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
    console.log(`🚀 Cyberpunk Tmux Agent Deck started successfully with HTTPS!`);
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
    console.log(`🚀 Cyberpunk Tmux Agent Deck started successfully!`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
    console.log(`🔒 Password: ${'•'.repeat(PASSWORD.length)} (configured via env)`);
    console.log(`==================================================`);
  });
}
