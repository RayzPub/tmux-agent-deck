const pty = require('node-pty');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { getRunUser, getTmuxCommandForUser } = require('../services/tmuxService');
const { getHomeDir, getUserWorkspaceRoot, getDefaultWorkspacePath, getUserHomeDir } = require('../services/fileService');
const { JWT_SECRET, MULTI_USER_ENABLED, PROJECT_ROOT } = require('../config');



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
    let isReinitializing = false;

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
        isReinitializing = true;
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

      // 1. LLM Gateway auto-injection (Platform baseline fallback)
      try {
        const llmGatewayService = require('../services/llmGatewayService');
        const gwConfig = llmGatewayService.loadConfig();
        if (gwConfig.enabled && gwConfig.injectToTerminal) {
          const { PORT } = require('../config');
          const localPort = PORT || 3000;
          const vKey = gwConfig.virtualKey || 'sk-deck-local';

          ptyEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${localPort}`;
          ptyEnv.ANTHROPIC_API_KEY = vKey;
          ptyEnv.ANTHROPIC_AUTH_TOKEN = vKey;

          ptyEnv.OPENAI_BASE_URL = `http://127.0.0.1:${localPort}/v1`;
          ptyEnv.OPENAI_API_BASE = `http://127.0.0.1:${localPort}/v1`;
          ptyEnv.OPENAI_API_KEY = vKey;
        }
      } catch (gwErr) {
        console.warn('⚠️ Failed to inject LLM Gateway env:', gwErr.message);
      }

      // 2. User-specific / Custom Keys (Higher Priority - Overrides Gateway)
      if (MULTI_USER_ENABLED && socket.user && socket.user.username) {
        const db = require('../services/dbService');
        const users = db.getUsers();
        const userObj = users[socket.user.username.toLowerCase()];
        const keys = userObj ? (userObj.apiKeys || {}) : {};

        // Load system defaults as fallback
        const { getSystemDefaultKeys } = require('../services/fileService');
        const defaultKeys = getSystemDefaultKeys();
        const defaultCodexKey = defaultKeys.codex || defaultKeys.claude;

        // Claude / Anthropic
        if (keys.claude) {
          // User explicitly configured custom Claude Key
          ptyEnv.ANTHROPIC_API_KEY = keys.claude;
          ptyEnv.ANTHROPIC_AUTH_TOKEN = keys.claude;
          if (keys.claudeBaseUrl) {
            ptyEnv.ANTHROPIC_BASE_URL = keys.claudeBaseUrl;
          } else {
            // Unset gateway's localhost URL so Claude can connect directly to official Anthropic API
            delete ptyEnv.ANTHROPIC_BASE_URL;
          }
        } else if (!ptyEnv.ANTHROPIC_API_KEY && defaultKeys.claude) {
          ptyEnv.ANTHROPIC_API_KEY = defaultKeys.claude;
          if (defaultKeys.claudeBaseUrl) ptyEnv.ANTHROPIC_BASE_URL = defaultKeys.claudeBaseUrl;
        }

        if (keys.claudeModel || defaultKeys.claudeModel) {
          ptyEnv.ANTHROPIC_MODEL = keys.claudeModel || defaultKeys.claudeModel;
        }

        // Codex / OpenAI
        if (keys.codex) {
          // User explicitly configured custom OpenAI/Codex Key
          ptyEnv.OPENAI_API_KEY = keys.codex;
          if (keys.codexBaseUrl) {
            ptyEnv.OPENAI_BASE_URL = keys.codexBaseUrl;
            ptyEnv.OPENAI_API_BASE = keys.codexBaseUrl;
          } else {
            // Unset gateway's localhost URL so OpenAI can connect directly
            delete ptyEnv.OPENAI_BASE_URL;
            delete ptyEnv.OPENAI_API_BASE;
          }
        } else if (!ptyEnv.OPENAI_API_KEY && defaultCodexKey) {
          ptyEnv.OPENAI_API_KEY = defaultCodexKey;
          if (defaultKeys.codexBaseUrl) {
            ptyEnv.OPENAI_BASE_URL = defaultKeys.codexBaseUrl;
            ptyEnv.OPENAI_API_BASE = defaultKeys.codexBaseUrl;
          }
        }

        if (keys.codexModel || defaultKeys.codexModel) {
          const codexModel = keys.codexModel || defaultKeys.codexModel;
          ptyEnv.OPENAI_MODEL = codexModel;
          ptyEnv.CODEX_MODEL = codexModel;
        }

        // Kimi / Moonshot
        const kimiKey = keys.kimi || defaultKeys.kimi;
        if (kimiKey) {
          ptyEnv.KIMI_API_KEY = kimiKey;
          ptyEnv.MOONSHOT_API_KEY = kimiKey;
        }
        const kimiBaseUrl = keys.kimiBaseUrl || defaultKeys.kimiBaseUrl;
        if (kimiBaseUrl) {
          ptyEnv.KIMI_BASE_URL = kimiBaseUrl;
          ptyEnv.MOONSHOT_BASE_URL = kimiBaseUrl;
        }
        const kimiModel = keys.kimiModel || defaultKeys.kimiModel;
        if (kimiModel) ptyEnv.KIMI_MODEL = kimiModel;
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
          if (isReinitializing) {
            isReinitializing = false;
            return;
          }
          console.log(`PTY process exited with code ${exitCode}, signal ${signal}`);
          socket.emit('terminal-exit');
          ptyProcess = null;
        });
      } catch (err) {
        console.error('Error spawning PTY:', err);
        socket.emit('terminal-output', `\r\n\x1b[31;1mError spawning terminal process: ${err.message}\x1b[0m\r\n`);
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
