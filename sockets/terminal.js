const pty = require('node-pty');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { getRunUser, getTmuxCommandForUser } = require('../services/tmuxService');
const { getHomeDir, getUserWorkspaceRoot, getDefaultWorkspacePath, getUserHomeDir } = require('../services/fileService');
const { JWT_SECRET, MULTI_USER_ENABLED, PROJECT_ROOT } = require('../config');

const hasFirejail = (() => {
  try {
    const { execSync } = require('child_process');
    execSync('which firejail', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
})();


const initSocket = (io) => {
  // Socket.io Authentication Middleware
  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) {
      return next(new Error('Authentication error: No cookies found'));
    }
    
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

    socket.isFocused = false;
    socket.activeSession = null;
    socket.sessionName = null;

    socket.on('client-focus', ({ focused, activeSession }) => {
      socket.isFocused = focused;
      socket.activeSession = activeSession;
    });

    socket.on('init-terminal', ({ sessionName, cols, rows }) => {
      socket.sessionName = sessionName;
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

      let physicalSession = sessionName;
      if (MULTI_USER_ENABLED && socket.user && socket.user.username) {
        physicalSession = `u_${socket.user.username}_${sessionName}`;
      }

      console.log(`Spawning pty for tmux session: ${physicalSession} (${cols}x${rows})`);

      const runUser = getRunUser();
      const tmuxArgs = ['new-session', '-A', '-s', physicalSession];
      const isNonAdmin = MULTI_USER_ENABLED && socket.user && socket.user.role !== 'admin';
      if (isNonAdmin && hasFirejail) {
        const username = socket.user.username;
        const userWorkspace = path.join(PROJECT_ROOT, 'workspaces', username);
        const userData = path.join(PROJECT_ROOT, 'user_data', username);
        const projectBin = path.join(PROJECT_ROOT, 'bin');
        const sysHome = getHomeDir();
        const nvmPath = path.join(sysHome, '.nvm');
        const localBin = path.join(sysHome, '.local', 'bin');
        const kimiCodeDir = path.join(sysHome, '.kimi-code');

        let fjArgs = [
          'firejail',
          '--noprofile',
          '--noroot',
          `--whitelist=${userWorkspace}`,
          `--whitelist=${userData}`,
          `--whitelist=${projectBin}`,
          `--read-only=${projectBin}`
        ];

        if (fs.existsSync(nvmPath)) {
          fjArgs.push(`--whitelist=${nvmPath}`);
          fjArgs.push(`--read-only=${nvmPath}`);
        }
        if (fs.existsSync(localBin)) {
          fjArgs.push(`--whitelist=${localBin}`);
          fjArgs.push(`--read-only=${localBin}`);
        }
        if (fs.existsSync(kimiCodeDir)) {
          fjArgs.push(`--whitelist=${kimiCodeDir}`);
          fjArgs.push(`--read-only=${kimiCodeDir}`);
        }

        tmuxArgs.push(`exec ${fjArgs.join(' ')} bash`);
      }
      const { cmd: shell, args } = getTmuxCommandForUser(socket.user ? socket.user.username : null, tmuxArgs);
      const workspacePath = getDefaultWorkspacePath(socket.user ? socket.user.username : null);
      const userHome = getUserHomeDir(socket.user ? socket.user.username : null);

      const ptyEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        HOME: userHome,
        USER: runUser || process.env.USER || require('os').userInfo().username,
        SKIP_SUDO_HINT: '1'
      };

      if (MULTI_USER_ENABLED && socket.user && socket.user.username) {
        const db = require('../services/dbService');
        const users = db.getUsers();
        const userObj = users[socket.user.username.toLowerCase()];
        const keys = userObj ? (userObj.apiKeys || {}) : {};

        // Load system defaults as fallback
        const { getSystemDefaultKeys } = require('../services/fileService');
        const defaultKeys = getSystemDefaultKeys();
        const defaultCodexKey = defaultKeys.codex || defaultKeys.claude;

        // Codex / OpenAI
        const codexKey = keys.codex || defaultCodexKey;
        if (codexKey) ptyEnv.OPENAI_API_KEY = codexKey;
        const codexBaseUrl = keys.codexBaseUrl || defaultKeys.codexBaseUrl;
        if (codexBaseUrl) {
          ptyEnv.OPENAI_BASE_URL = codexBaseUrl;
          ptyEnv.OPENAI_API_BASE = codexBaseUrl;
        }
        const codexModel = keys.codexModel || defaultKeys.codexModel;
        if (codexModel) {
          ptyEnv.OPENAI_MODEL = codexModel;
          ptyEnv.CODEX_MODEL = codexModel;
        }
      }

      try {
        ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: workspacePath,
          env: ptyEnv
        });

        ptyProcess.onData((data) => {
          socket.emit('terminal-output', data);
        });

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

    socket.on('terminal-input', (data) => {
      if (ptyProcess) {
        ptyProcess.write(data);
      }
    });

    socket.on('resize', ({ cols, rows }) => {
      if (ptyProcess) {
        try {
          ptyProcess.resize(cols, rows);
        } catch (err) {
          console.error('Error resizing PTY:', err);
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected from terminal socket:', socket.id);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch (err) {
          console.error('Error killing PTY process:', err);
        }
        ptyProcess = null;
      }
    });
  });
};

module.exports = { initSocket };
