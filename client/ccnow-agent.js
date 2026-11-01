#!/usr/bin/env node

/**
 * ccnow-agent: Ultra-lightweight edge daemon for ccnow (tmux-agent-deck)
 * Connects your local machine to the ccnow Web Control Plane via WebSocket.
 * Supports Remote Tmux, Full PTY Terminal, and Edge Agent execution.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Client Version
const CLIENT_VERSION = '1.3.0';

// Configuration directory & file
const CONFIG_DIR = path.join(os.homedir(), '.ccnow');
const CONFIG_FILE = path.join(CONFIG_DIR, 'device.json');

// Ensure native or installed WebSocket
let WSClient = typeof WebSocket !== 'undefined' ? WebSocket : null;
if (!WSClient) {
  try {
    WSClient = require('ws');
  } catch (e) {
    console.error('❌ Error: Global WebSocket not available in this Node.js version.');
    console.error('Please run with Node.js >= 21 or run: npm install -g ws');
    process.exit(1);
  }
}

// Active agent child processes: sessionId -> childProcess
const runningTasks = new Map();

// Active interactive PTY / terminal sessions: termId -> { child, write, resize, kill }
const activeTerminals = new Map();

/**
 * Read stored device configuration
 */
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('⚠️ Failed to read config file:', err.message);
  }
  return null;
}

/**
 * Save device configuration
 */
function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Failed to save config file:', err.message);
  }
}

/**
 * Parse CLI arguments
 */
function parseArgs(args) {
  const result = { command: args[0] || 'help', options: {} };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=');
      const key = parts[0];
      const val = parts.length > 1 ? parts[1] : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
      result.options[key] = val;
    }
  }
  return result;
}

/**
 * Check if a command is installed on host
 */
function hasCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Collect local device system info
 */
function getLocalDeviceInfo(customName) {
  const hasClaude = hasCommand('claude');
  const hasCodex = hasCommand('codex');
  const hasTmux = hasCommand('tmux');

  const agentTypes = [];
  if (hasClaude) agentTypes.push('claude-code');
  if (hasCodex) agentTypes.push('codex-cli');
  if (hasTmux) agentTypes.push('tmux');
  agentTypes.push('local-terminal');

  return {
    version: CLIENT_VERSION,
    name: customName || os.hostname(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    agentTypes,
    hasClaude,
    hasCodex,
    hasTmux
  };
}

/**
 * Convert HTTP/HTTPS server URL to WebSocket WS/WSS URL
 */
function toWsUrl(serverUrl) {
  let base = serverUrl.trim().replace(/\/+$/, '');
  if (base.startsWith('https://')) {
    base = 'wss://' + base.substring(8);
  } else if (base.startsWith('http://')) {
    base = 'ws://' + base.substring(7);
  } else if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
    base = 'wss://' + base;
  }
  return `${base}/device-tunnel`;
}

/**
 * Main Agent Client Class
 */
class AgentClient {
  constructor(serverUrl, credentials = {}) {
    this.serverUrl = serverUrl;
    this.credentials = credentials; // { token } or { deviceId, deviceSecret }
    this.ws = null;
    this.pingTimer = null;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.isStopped = false;
  }

  start() {
    this.isStopped = false;
    this.connect();
  }

  stop() {
    this.isStopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    // Cleanup active terminals
    for (const [termId, term] of activeTerminals.entries()) {
      try { term.kill(); } catch (e) {}
    }
    activeTerminals.clear();
  }

  connect() {
    if (this.isStopped) return;

    const wsUrl = toWsUrl(this.serverUrl);
    console.log(`🔌 Connecting to ccnow Control Plane at ${wsUrl}...`);

    try {
      this.ws = new WSClient(wsUrl);
    } catch (err) {
      console.error(`❌ Connection failed:`, err.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log(`✨ Connected to ${wsUrl}! Sending handshake...`);
      this.reconnectAttempts = 0;

      if (this.credentials.token) {
        console.log(`🔑 Performing initial pairing with token ${this.credentials.token.substring(0, 8)}...`);
        this.send({
          action: 'pair',
          token: this.credentials.token,
          version: CLIENT_VERSION,
          deviceInfo: getLocalDeviceInfo(this.credentials.customName)
        });
      } else if (this.credentials.deviceId && this.credentials.deviceSecret) {
        console.log(`🛡️ Authenticating device ${this.credentials.deviceId} (v${CLIENT_VERSION})...`);
        this.send({
          action: 'auth',
          deviceId: this.credentials.deviceId,
          deviceSecret: this.credentials.deviceSecret,
          version: CLIENT_VERSION,
          deviceInfo: getLocalDeviceInfo()
        });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        const msg = JSON.parse(raw);
        this.handleMessage(msg);
      } catch (e) {
        console.error('⚠️ Malformed message received:', e.message);
      }
    };

    this.ws.onclose = (event) => {
      console.warn(`⚠️ Connection closed (code: ${event.code || 'unknown'}, reason: ${event.reason || 'none'})`);
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.isStopped) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('❌ WebSocket error:', err.message || err);
    };
  }

  scheduleReconnect() {
    if (this.isReconnecting || this.isStopped) return;
    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);

    setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) { // OPEN
      this.ws.send(JSON.stringify(obj));
    }
  }

  startHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      // If we haven't received pong for > 45 seconds, socket is stale/broken
      if (Date.now() - this.lastPong > 45000) {
        console.warn('⚠️ Heartbeat pong timed out. Forcing reconnect...');
        try { this.ws.close(); } catch (e) {}
        this.scheduleReconnect();
        return;
      }
      this.send({ action: 'ping' });
    }, 20000);
  }

  handleMessage(msg) {
    const { action } = msg;

    // Pairing Success
    if (action === 'pair_success') {
      console.log('🎉 ==========================================');
      console.log('✅ Device successfully paired with ccnow!');
      console.log(`📱 Device ID:   ${msg.deviceId}`);
      console.log(`💻 Device Name: ${msg.device?.name || 'Local Device'}`);
      console.log('==========================================');

      saveConfig({
        server: this.serverUrl,
        deviceId: msg.deviceId,
        deviceSecret: msg.deviceSecret,
        name: msg.device?.name || 'Local Device'
      });

      this.credentials = {
        deviceId: msg.deviceId,
        deviceSecret: msg.deviceSecret
      };

      this.startHeartbeat();
      return;
    }

    if (action === 'pair_failed') {
      console.error(`❌ Pairing failed: ${msg.error}`);
      this.stop();
      process.exit(1);
    }

    // Auth Success
    if (action === 'auth_success') {
      console.log(`✅ Authenticated successfully as ${msg.deviceId}! Online and ready.`);
      this.startHeartbeat();
      return;
    }

    if (action === 'auth_failed') {
      console.error(`❌ Authentication failed: ${msg.error}`);
      this.stop();
      process.exit(1);
    }

    // Heartbeat reply
    if (action === 'pong') {
      this.lastPong = Date.now();
      return;
    }

    // Remote System Update & Self-Reload
    if (action === 'system:update') {
      this.handleSystemUpdate(msg.reqId, msg);
      return;
    }

    // 1. Tmux List Sessions RPC
    if (action === 'tmux:list_sessions') {
      this.handleListSessions(msg.reqId);
      return;
    }

    if (action === 'tmux:new_session') {
      this.handleNewSession(msg.reqId, msg);
      return;
    }

    if (action === 'tmux:kill_session') {
      this.handleKillSession(msg.reqId, msg.sessionName);
      return;
    }

    // 1.1 Remote Filesystem Workspaces Query
    if (action === 'fs:workspaces') {
      this.handleFsWorkspaces(msg.reqId);
      return;
    }

    // 1.2 Remote Filesystem List Directory
    if (action === 'fs:list') {
      this.handleFsList(msg.reqId, msg.workspacePath, msg.relativePath);
      return;
    }

    // 1.3 Remote Filesystem Read File
    if (action === 'fs:read') {
      this.handleFsRead(msg.reqId, msg.workspacePath, msg.filePath);
      return;
    }

    // 1.4 Remote Filesystem Write File
    if (action === 'fs:write') {
      this.handleFsWrite(msg.reqId, msg.workspacePath, msg.filePath, msg.content);
      return;
    }

    // 1.5 Remote Directories Picker
    if (action === 'fs:directories') {
      this.handleDirectories(msg.reqId, msg.targetPath);
      return;
    }

    // 1.6 Remote Upload File
    if (action === 'fs:upload_file') {
      this.handleUploadFile(msg.reqId, msg);
      return;
    }

    // 1.6.1 Remote Filesystem Extended Operations (Create / Delete / Rename)
    if (action === 'fs:create_file') {
      this.handleFsCreateFile(msg.reqId, msg.workspacePath, msg.filePath);
      return;
    }
    if (action === 'fs:create_dir') {
      this.handleFsCreateDir(msg.reqId, msg.workspacePath, msg.dirPath);
      return;
    }
    if (action === 'fs:delete') {
      this.handleFsDelete(msg.reqId, msg.workspacePath, msg.targetPath);
      return;
    }
    if (action === 'fs:rename') {
      this.handleFsRename(msg.reqId, msg.workspacePath, msg.oldPath, msg.newPath);
      return;
    }

    // 1.7 Remote Git Operations
    if (action === 'git:status') {
      this.handleGitStatus(msg.reqId, msg.workspacePath);
      return;
    }

    if (action === 'git:diff') {
      this.handleGitDiff(msg.reqId, msg.workspacePath, msg.filePath);
      return;
    }

    if (action === 'git:stage') {
      this.handleGitStage(msg.reqId, msg.workspacePath, msg.files);
      return;
    }

    if (action === 'git:unstage') {
      this.handleGitUnstage(msg.reqId, msg.workspacePath, msg.files);
      return;
    }

    if (action === 'git:commit') {
      this.handleGitCommit(msg.reqId, msg.workspacePath, msg.message);
      return;
    }

    if (action === 'git:branches') {
      this.handleGitBranches(msg.reqId, msg.workspacePath);
      return;
    }

    if (action === 'git:checkout') {
      this.handleGitCheckout(msg.reqId, msg.workspacePath, msg.branch);
      return;
    }

    // 1.8 Remote Agent Chat History & Context
    if (action === 'agent:chat_history') {
      this.handleChatHistory(msg.reqId, msg.sessionName);
      return;
    }

    if (action === 'agent:clear_context') {
      this.handleClearContext(msg.reqId, msg.sessionName);
      return;
    }

    // 2. Interactive Terminal Open
    if (action === 'term:open') {
      this.handleOpenTerminal(msg);
      return;
    }

    // 3. Interactive Terminal Input
    if (action === 'term:input') {
      const term = activeTerminals.get(msg.termId);
      if (term && term.write) {
        term.write(msg.data);
      }
      return;
    }

    // 4. Interactive Terminal Resize
    if (action === 'term:resize') {
      const term = activeTerminals.get(msg.termId);
      if (term && term.resize) {
        term.resize(msg.cols, msg.rows);
      }
      return;
    }

    // 5. Interactive Terminal Close
    if (action === 'term:close') {
      const term = activeTerminals.get(msg.termId);
      if (term) {
        term.kill();
        activeTerminals.delete(msg.termId);
      }
      return;
    }

    // 6. Agent Chat Task
    if (action === 'agent:chat') {
      this.executeAgentTask(msg);
      return;
    }

    // 7. Agent Interrupt Task
    if (action === 'agent:interrupt') {
      const { sessionId } = msg;
      if (sessionId && runningTasks.has(sessionId)) {
        console.log(`🛑 Interrupting task for session ${sessionId}...`);
        const proc = runningTasks.get(sessionId);
        try {
          proc.kill('SIGINT');
        } catch (e) {}
      }
      return;
    }

    console.log(`[ccnow-agent] Received action: ${action}`);
  }

  /**
   * Handle Tmux / Terminal Sessions Query
   */
  handleListSessions(reqId) {
    const hasTmux = hasCommand('tmux');
    let sessions = [];

    if (hasTmux) {
      try {
        const out = execSync('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_created}|#{?session_attached,1,0}"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const lines = out.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 1 && parts[0]) {
            sessions.push({
              name: parts[0],
              windows: parseInt(parts[1], 10) || 1,
              created: parseInt(parts[2], 10) * 1000 || Date.now(),
              attached: parts[3] === '1',
              isRemote: true
            });
          }
        }
      } catch (e) {
        // Tmux server might not be running yet, auto-ensure default session
        try {
          execSync('tmux new-session -d -s main', { stdio: 'ignore' });
          sessions.push({
            name: 'main',
            windows: 1,
            created: Date.now(),
            attached: false,
            isRemote: true
          });
        } catch (err) {}
      }
    }

    if (sessions.length === 0) {
      sessions.push({
        name: 'default',
        windows: 1,
        created: Date.now(),
        attached: true,
        isRemote: true
      });
    }

    this.send({
      action: 'tmux:sessions_list',
      reqId,
      sessions
    });
  }

  /**
   * Resolve a workspace base directory on local host
   */
  resolveBaseDir(wsPath) {
    if (!wsPath || wsPath === '~') return os.homedir();
    if (wsPath.startsWith('~/')) return path.join(os.homedir(), wsPath.substring(2));
    if (path.isAbsolute(wsPath) && fs.existsSync(wsPath)) return wsPath;
    return process.cwd();
  }

  handleFsWorkspaces(reqId) {
    const list = [
      { name: 'Home (~)', path: os.homedir(), isDefault: true },
      { name: 'Current Working Dir', path: process.cwd() }
    ];
    this.send({ action: 'fs:workspaces_result', reqId, workspaces: list });
  }

  handleFsList(reqId, workspacePath, relativePath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const targetDir = relativePath ? path.resolve(baseDir, relativePath) : baseDir;

      if (!fs.existsSync(targetDir)) {
        return this.send({ action: 'fs:list_result', reqId, error: 'Directory not found' });
      }

      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return this.send({ action: 'fs:list_result', reqId, error: 'Target is not a directory' });
      }

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const items = entries
        .filter(e => e.name !== '.git' && e.name !== 'node_modules' && !e.name.startsWith('.DS_Store'))
        .map(e => {
          const fullPath = path.join(targetDir, e.name);
          const relPath = path.relative(baseDir, fullPath);
          let size = null;
          let mtime = null;
          try {
            const s = fs.statSync(fullPath);
            size = s.size;
            mtime = s.mtime.toISOString();
          } catch (err) {}

          return {
            name: e.name,
            path: relPath,
            isDirectory: e.isDirectory(),
            size,
            mtime
          };
        });

      this.send({
        action: 'fs:list_result',
        reqId,
        rootDir: baseDir,
        items
      });
    } catch (err) {
      this.send({ action: 'fs:list_result', reqId, error: err.message });
    }
  }

  handleFsRead(reqId, workspacePath, filePath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const targetPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);

      if (!fs.existsSync(targetPath)) {
        return this.send({ action: 'fs:read_result', reqId, error: 'File not found' });
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) {
        return this.send({ action: 'fs:read_result', reqId, error: 'Path is not a file' });
      }

      if (stat.size > 2 * 1024 * 1024) {
        return this.send({ action: 'fs:read_result', reqId, error: 'File is too large (>2MB)' });
      }

      const content = fs.readFileSync(targetPath, 'utf8');
      this.send({
        action: 'fs:read_result',
        reqId,
        path: filePath,
        content,
        size: stat.size
      });
    } catch (err) {
      this.send({ action: 'fs:read_result', reqId, error: err.message });
    }
  }

  handleFsWrite(reqId, workspacePath, filePath, content) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const targetPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
      const parentDir = path.dirname(targetPath);

      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(targetPath, content || '', 'utf8');
      this.send({ action: 'fs:write_result', reqId, success: true });
    } catch (err) {
      this.send({ action: 'fs:write_result', reqId, error: err.message });
    }
  }

  handleNewSession(reqId, msg) {
    const { sessionName, workspace, agent } = msg;
    const hasTmux = hasCommand('tmux');
    if (hasTmux && sessionName) {
      try {
        const targetDir = this.resolveBaseDir(workspace);
        const cleanName = sessionName.replace(/"/g, '');
        execSync(`tmux new-session -d -s "${cleanName}" -c "${targetDir.replace(/"/g, '')}"`, { stdio: 'ignore' });

        // If an agent CLI is chosen (e.g. claude, codex, agy), auto-launch it in the tmux pane
        if (agent && agent !== 'default' && agent !== 'terminal') {
          const agentCmd = String(agent).replace(/"/g, '');
          try {
            execSync(`tmux send-keys -t "${cleanName}" "${agentCmd}" C-m`, { stdio: 'ignore' });
          } catch (e) {}
        }

        this.send({ action: 'tmux:new_session_result', reqId, success: true });
        return;
      } catch (e) {
        this.send({ action: 'tmux:new_session_result', reqId, error: e.message });
        return;
      }
    }
    this.send({ action: 'tmux:new_session_result', reqId, success: true });
  }

  handleKillSession(reqId, sessionName) {
    const hasTmux = hasCommand('tmux');
    if (hasTmux && sessionName) {
      try {
        execSync(`tmux kill-session -t "${sessionName.replace(/"/g, '')}"`, { stdio: 'ignore' });
      } catch (e) {}
    }
    this.send({ action: 'tmux:kill_session_result', reqId, success: true });
  }

  handleFsCreateFile(reqId, workspacePath, filePath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const targetPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, '', 'utf8');
      }
      this.send({ action: 'fs:create_file_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'fs:create_file_result', reqId, error: e.message });
    }
  }

  handleFsCreateDir(reqId, workspacePath, dirPath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const targetPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(baseDir, dirPath);
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }
      this.send({ action: 'fs:create_dir_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'fs:create_dir_result', reqId, error: e.message });
    }
  }

  handleFsDelete(reqId, workspacePath, targetPath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
      this.send({ action: 'fs:delete_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'fs:delete_result', reqId, error: e.message });
    }
  }

  handleFsRename(reqId, workspacePath, oldPath, newPath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const src = path.isAbsolute(oldPath) ? oldPath : path.resolve(baseDir, oldPath);
      const dst = path.isAbsolute(newPath) ? newPath : path.resolve(baseDir, newPath);
      const dstParent = path.dirname(dst);
      if (!fs.existsSync(dstParent)) {
        fs.mkdirSync(dstParent, { recursive: true });
      }
      fs.renameSync(src, dst);
      this.send({ action: 'fs:rename_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'fs:rename_result', reqId, error: e.message });
    }
  }

  handleGitStage(reqId, workspacePath, files) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const fileArgs = Array.isArray(files) && files.length > 0
        ? files.map(f => `"${String(f).replace(/"/g, '')}"`).join(' ')
        : '.';
      execSync(`git add ${fileArgs}`, { cwd: baseDir, stdio: 'ignore' });
      this.send({ action: 'git:stage_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'git:stage_result', reqId, error: e.message });
    }
  }

  handleGitUnstage(reqId, workspacePath, files) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const fileArgs = Array.isArray(files) && files.length > 0
        ? files.map(f => `"${String(f).replace(/"/g, '')}"`).join(' ')
        : '.';
      execSync(`git reset HEAD ${fileArgs}`, { cwd: baseDir, stdio: 'ignore' });
      this.send({ action: 'git:unstage_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'git:unstage_result', reqId, error: e.message });
    }
  }

  handleGitCommit(reqId, workspacePath, message) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const cleanMsg = (message || 'Commit from ccnow').replace(/"/g, '\\"');
      execSync(`git commit -m "${cleanMsg}"`, { cwd: baseDir, stdio: 'ignore' });
      this.send({ action: 'git:commit_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'git:commit_result', reqId, error: e.message });
    }
  }

  handleGitBranches(reqId, workspacePath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const out = execSync('git branch 2>/dev/null || echo ""', { cwd: baseDir, encoding: 'utf8' });
      const lines = out.split('\n').filter(Boolean);
      let currentBranch = '';
      const branches = [];
      for (const line of lines) {
        const isCurrent = line.startsWith('*');
        const bName = line.replace(/^\*?\s+/, '').trim();
        if (bName) {
          branches.push(bName);
          if (isCurrent) currentBranch = bName;
        }
      }
      this.send({ action: 'git:branches_result', reqId, currentBranch, branches });
    } catch (e) {
      this.send({ action: 'git:branches_result', reqId, currentBranch: '', branches: [] });
    }
  }

  handleGitCheckout(reqId, workspacePath, branch) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const cleanBranch = String(branch).replace(/[^a-zA-Z0-9_\-\.\/]/g, '');
      execSync(`git checkout "${cleanBranch}"`, { cwd: baseDir, stdio: 'ignore' });
      this.send({ action: 'git:checkout_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'git:checkout_result', reqId, error: e.message });
    }
  }

  handleClearContext(reqId, sessionName) {
    const hasTmux = hasCommand('tmux');
    if (hasTmux && sessionName) {
      try {
        const cleanName = sessionName.replace(/"/g, '');
        execSync(`tmux send-keys -t "${cleanName}" "/clear" C-m`, { stdio: 'ignore' });
      } catch (e) {}
    }
    if (reqId) {
      this.send({ action: 'agent:clear_context_result', reqId, success: true });
    }
  }

  extractUserText(rawContent, event) {
    if (!rawContent) return '';
    if (typeof rawContent === 'string') {
      if (rawContent.includes('<local-command-caveat>')) return '';
      if (rawContent.includes('<command-name>')) {
        const match = rawContent.match(/<command-message>(.*?)<\/command-message>/s) ||
                      rawContent.match(/<command-name>(.*?)<\/command-name>/s);
        if (match && match[1]) {
          const cmd = match[1].trim();
          if (cmd === 'clear' || cmd === '/clear') return '';
          return cmd;
        }
      }
      return rawContent.trim();
    }

    if (Array.isArray(rawContent)) {
      const textPieces = [];
      for (const item of rawContent) {
        if (typeof item === 'string') {
          const cleaned = this.extractUserText(item, event);
          if (cleaned) textPieces.push(cleaned);
        } else if (item && typeof item === 'object') {
          if (item.type === 'text' && item.text) {
            const cleaned = this.extractUserText(item.text, event);
            if (cleaned) textPieces.push(cleaned);
          } else if (item.type === 'tool_result') {
            if (event && event.toolUseResult && event.toolUseResult.answers) {
              const ansList = Object.entries(event.toolUseResult.answers)
                .map(([q, a]) => `**${q}**\n↳ ${a}`)
                .join('\n\n');
              textPieces.push(`📋 **已回答智能体提问：**\n\n${ansList}`);
            } else if (typeof item.content === 'string' && item.content.startsWith('Your questions have been answered:')) {
              const cleanContent = item.content.replace(/^Your questions have been answered:\s*/, '').replace(/\.\s*You can now continue with these answers in mind\./, '');
              textPieces.push(`📋 **已回答智能体提问：**\n\n${cleanContent}`);
            } else if ((event && event.toolDenialKind === 'user-rejected') || (typeof item.content === 'string' && item.content.includes("user doesn't want to proceed"))) {
              textPieces.push(`🛑 **已拒绝此工具执行操作**`);
            }
          }
        }
      }
      return textPieces.join('\n\n').trim();
    }

    if (typeof rawContent === 'object') {
      if (rawContent.type === 'text' && rawContent.text) {
        return this.extractUserText(rawContent.text, event);
      }
      if (rawContent.text && typeof rawContent.text === 'string') {
        return this.extractUserText(rawContent.text, event);
      }
    }

    return '';
  }

  parseClaudeJsonlContent(content) {
    const lines = content.split('\n').filter(Boolean);
    const parsedEvents = [];
    for (const line of lines) {
      try {
        parsedEvents.push(JSON.parse(line));
      } catch (e) {}
    }

    const messages = [];
    const toolResults = new Set();

    for (const event of parsedEvents) {
      if (event.commandRun && (event.commandRun.command === 'clear' || event.commandRun.command === '/clear')) {
        messages.length = 0;
        toolResults.clear();
        continue;
      }
      if (event.type === 'user' && event.message && typeof event.message.content === 'string' && event.message.content.includes('<command-name>/clear')) {
        messages.length = 0;
        toolResults.clear();
        continue;
      }

      // User message
      if (event.type === 'user' && event.message && event.message.content) {
        if (event.isMeta) continue;

        if (Array.isArray(event.message.content)) {
          for (const item of event.message.content) {
            if (item && item.type === 'tool_result' && item.tool_use_id) {
              toolResults.add(item.tool_use_id);
            }
          }
        }

        const cleanText = this.extractUserText(event.message.content, event);
        if (!cleanText) continue;

        messages.push({
          id: event.uuid || `user-${messages.length}`,
          role: 'user',
          timestamp: event.timestamp || new Date().toISOString(),
          content: cleanText
        });
      }

      // Assistant message
      if (event.type === 'assistant' && event.message && event.message.content) {
        const contentList = Array.isArray(event.message.content)
          ? event.message.content
          : [{ type: 'text', text: String(event.message.content) }];

        let textParts = [];
        let thinkingParts = [];
        let tools = [];

        for (const part of contentList) {
          if (part.type === 'text' && part.text) {
            textParts.push(part.text);
          } else if (part.type === 'thinking' && part.thinking) {
            thinkingParts.push(part.thinking);
          } else if (part.type === 'tool_use') {
            const isAskQ = part.name === 'AskUserQuestion';
            const tInfo = {
              id: part.id,
              name: part.name || 'tool',
              input: part.input || {},
              isAskQuestion: isAskQ,
              questions: (isAskQ && part.input && part.input.questions) ? part.input.questions : []
            };
            tools.push(tInfo);
          }
        }

        const combinedText = textParts.join('\n\n').trim();
        const combinedThinking = thinkingParts.join('\n\n').trim();

        if (combinedText || combinedThinking || tools.length > 0) {
          messages.push({
            id: event.uuid || `assistant-${messages.length}`,
            role: 'assistant',
            timestamp: event.timestamp || new Date().toISOString(),
            content: combinedText,
            thinking: combinedThinking || null,
            tools: tools.length > 0 ? tools : null
          });
        }
      }
    }

    return messages;
  }

  handleChatHistory(reqId, sessionName) {
    try {
      const hasTmux = hasCommand('tmux');
      let sessionCwd = process.cwd();
      if (hasTmux && sessionName) {
        try {
          const out = execSync(`tmux display-message -p -t "${sessionName.replace(/"/g, '')}" "#{session_path}" 2>/dev/null`, { encoding: 'utf8' }).trim();
          if (out && fs.existsSync(out)) {
            sessionCwd = out;
          }
        } catch (e) {}
      }

      // Convert sessionCwd to project slug
      const slug = path.resolve(sessionCwd).replace(/\/+$/, '').replace(/\//g, '-');
      const baseClaudeDir = path.join(os.homedir(), '.claude', 'projects');
      const targetProjDir = path.join(baseClaudeDir, slug);

      let targetJsonlFile = null;
      let targetMtime = 0;

      if (fs.existsSync(targetProjDir)) {
        const files = fs.readdirSync(targetProjDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const fullPath = path.join(targetProjDir, file);
          try {
            const st = fs.statSync(fullPath);
            if (st.mtimeMs > targetMtime) {
              targetMtime = st.mtimeMs;
              targetJsonlFile = fullPath;
            }
          } catch (e) {}
        }
      }

      // Fallback: search all project directories under ~/.claude/projects/
      if (!targetJsonlFile && fs.existsSync(baseClaudeDir)) {
        try {
          const subdirs = fs.readdirSync(baseClaudeDir, { withFileTypes: true }).filter(d => d.isDirectory());
          for (const sub of subdirs) {
            const subPath = path.join(baseClaudeDir, sub.name);
            const files = fs.readdirSync(subPath).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
              const fullPath = path.join(subPath, file);
              try {
                const st = fs.statSync(fullPath);
                if (st.mtimeMs > targetMtime) {
                  targetMtime = st.mtimeMs;
                  targetJsonlFile = fullPath;
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      if (targetJsonlFile && fs.existsSync(targetJsonlFile)) {
        const content = fs.readFileSync(targetJsonlFile, 'utf8');
        const messages = this.parseClaudeJsonlContent(content);
        return this.send({
          action: 'agent:chat_history_result',
          reqId,
          sessionName,
          sessionMode: 'hybrid',
          supported: true,
          lastUpdated: targetMtime || Date.now(),
          messages
        });
      }

      // Return default ready state with supported flag true
      return this.send({
        action: 'agent:chat_history_result',
        reqId,
        sessionName,
        sessionMode: 'hybrid',
        supported: true,
        lastUpdated: Date.now(),
        messages: []
      });
    } catch (e) {
      console.warn('⚠️ [ccnow-agent] Failed to parse chat history:', e.message);
      this.send({
        action: 'agent:chat_history_result',
        reqId,
        sessionName,
        sessionMode: 'hybrid',
        supported: true,
        lastUpdated: Date.now(),
        messages: []
      });
    }
  }

  handleDirectories(reqId, targetPath) {
    try {
      const baseDir = this.resolveBaseDir(targetPath);
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(baseDir, e.name) }));
      this.send({ action: 'fs:directories_result', reqId, currentPath: baseDir, directories: dirs });
    } catch (e) {
      this.send({ action: 'fs:directories_result', reqId, error: e.message });
    }
  }

  handleUploadFile(reqId, msg) {
    try {
      const { workspacePath, filename, bufferBase64 } = msg;
      const baseDir = this.resolveBaseDir(workspacePath);
      const targetPath = path.join(baseDir, filename);
      const buf = Buffer.from(bufferBase64, 'base64');
      fs.writeFileSync(targetPath, buf);
      this.send({ action: 'fs:upload_file_result', reqId, success: true });
    } catch (e) {
      this.send({ action: 'fs:upload_file_result', reqId, error: e.message });
    }
  }

  handleGitStatus(reqId, workspacePath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const branch = execSync('git branch --show-current 2>/dev/null || echo ""', { cwd: baseDir, encoding: 'utf8' }).trim();
      const statusOut = execSync('git status --porcelain 2>/dev/null || echo ""', { cwd: baseDir, encoding: 'utf8' });
      const files = statusOut.split('\n').filter(Boolean).map(line => ({
        status: line.substring(0, 2).trim(),
        path: line.substring(3).trim()
      }));
      this.send({
        action: 'git:status_result',
        reqId,
        branch,
        clean: files.length === 0,
        files
      });
    } catch (e) {
      this.send({ action: 'git:status_result', reqId, branch: '', clean: true, files: [] });
    }
  }

  handleGitDiff(reqId, workspacePath, filePath) {
    try {
      const baseDir = this.resolveBaseDir(workspacePath);
      const fileArg = filePath ? ` -- "${filePath.replace(/"/g, '')}"` : '';
      const diff = execSync(`git diff HEAD${fileArg} 2>/dev/null || git diff${fileArg} 2>/dev/null || echo ""`, { cwd: baseDir, encoding: 'utf8' });
      this.send({ action: 'git:diff_result', reqId, diff });
    } catch (e) {
      this.send({ action: 'git:diff_result', reqId, diff: '' });
    }
  }



  /**
   * Spawn a real PTY or Shell session for web terminal relay
   */
  handleOpenTerminal(msg) {
    const { termId, sessionName, cols = 80, rows = 24 } = msg;

    // Clean up existing term if same termId
    if (activeTerminals.has(termId)) {
      try { activeTerminals.get(termId).kill(); } catch (e) {}
      activeTerminals.delete(termId);
    }

    console.log(`🖥️ [Terminal PTY] Spawning session '${sessionName}' for termId: ${termId} (${cols}x${rows})`);

    const hasTmux = hasCommand('tmux');
    const hasPython = hasCommand('python3');
    const userShell = process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');

    // Determine target command to execute
    let targetCmd = userShell;
    let targetArgs = [];

    if (hasTmux && sessionName) {
      targetCmd = 'tmux';
      targetArgs = ['new-session', '-A', '-s', sessionName];
    }

    let ptyHandler = null;

    // Method 1: node-pty (if installed locally)
    try {
      const nodePty = require('node-pty');
      const ptyProcess = nodePty.spawn(targetCmd, targetArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
      });

      ptyProcess.onData((data) => {
        this.send({ action: 'term:output', termId, data });
      });

      ptyProcess.onExit(() => {
        activeTerminals.delete(termId);
        this.send({ action: 'term:exit', termId });
      });

      ptyHandler = {
        write: (d) => ptyProcess.write(d),
        resize: (c, r) => ptyProcess.resize(c, r),
        kill: () => ptyProcess.kill()
      };
    } catch (e) {
      // node-pty not available, fallback to Method 2 or 3
    }

    // Method 2: Python 3 POSIX PTY Bridge (100% native on macOS & Linux)
    if (!ptyHandler && hasPython) {
      const fullCmdList = [targetCmd, ...targetArgs];
      const pyScript = `import pty, os, sys
pty.spawn(${JSON.stringify(fullCmdList)})
`;
      const pyProcess = spawn('python3', ['-c', pyScript], {
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
      });

      pyProcess.stdout.on('data', (chunk) => {
        this.send({ action: 'term:output', termId, data: chunk.toString() });
      });

      pyProcess.stderr.on('data', (chunk) => {
        this.send({ action: 'term:output', termId, data: chunk.toString() });
      });

      pyProcess.on('close', () => {
        activeTerminals.delete(termId);
        this.send({ action: 'term:exit', termId });
      });

      ptyHandler = {
        write: (d) => {
          if (pyProcess.stdin.writable) {
            pyProcess.stdin.write(d);
          }
        },
        resize: () => {},
        kill: () => {
          try { pyProcess.kill('SIGTERM'); } catch (err) {}
        }
      };
    }

    // Method 3: Standard ChildProcess Spawn Fallback
    if (!ptyHandler) {
      const shProcess = spawn(targetCmd, targetArgs, {
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' }
      });

      shProcess.stdout.on('data', (chunk) => {
        this.send({ action: 'term:output', termId, data: chunk.toString() });
      });

      shProcess.stderr.on('data', (chunk) => {
        this.send({ action: 'term:output', termId, data: chunk.toString() });
      });

      shProcess.on('close', () => {
        activeTerminals.delete(termId);
        this.send({ action: 'term:exit', termId });
      });

      ptyHandler = {
        write: (d) => {
          if (shProcess.stdin.writable) shProcess.stdin.write(d);
        },
        resize: () => {},
        kill: () => {
          try { shProcess.kill('SIGKILL'); } catch (err) {}
        }
      };
    }

    activeTerminals.set(termId, ptyHandler);
  }

  /**
   * Execute an Agent task locally and stream outputs back
   */
  executeAgentTask(msg) {
    const { sessionId, prompt, agentType, workDir } = msg;
    const targetDir = workDir && fs.existsSync(workDir) ? workDir : process.cwd();

    console.log(`🤖 [Agent Task] Session: ${sessionId} | Type: ${agentType || 'claude-code'}`);

    let cmd = 'claude';
    let args = ['--print', prompt];

    const hasClaude = hasCommand('claude');
    if (!hasClaude) {
      cmd = 'bash';
      args = ['-c', `echo "🤖 [ccnow-agent on ${os.hostname()}] Claude Code is not installed in PATH. (Install with: npm i -g @anthropic-ai/claude-code)\n\nRunning prompt as test command:"; echo "Prompt received: ${prompt.replace(/"/g, '\\"')}"`];
    }

    this.send({
      action: 'agent:stream',
      sessionId,
      delta: `[ccnow-agent on ${os.hostname()}] Executing task with ${hasClaude ? 'Claude Code' : 'Local Shell'}...\n`
    });

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: targetDir,
        env: { ...process.env, FORCE_COLOR: '1' }
      });
    } catch (err) {
      this.send({
        action: 'agent:error',
        sessionId,
        error: `Failed to spawn agent process: ${err.message}`
      });
      return;
    }

    runningTasks.set(sessionId, child);

    child.stdout.on('data', (data) => {
      this.send({
        action: 'agent:stream',
        sessionId,
        delta: data.toString()
      });
    });

    child.stderr.on('data', (data) => {
      this.send({
        action: 'agent:stream',
        sessionId,
        delta: data.toString()
      });
    });

    child.on('close', (code) => {
      runningTasks.delete(sessionId);
      this.send({
        action: 'agent:done',
        sessionId,
        exitCode: code,
        status: code === 0 ? 'success' : 'failed'
      });
    });

    child.on('error', (err) => {
      runningTasks.delete(sessionId);
      this.send({
        action: 'agent:error',
        sessionId,
        error: err.message
      });
    });
  }

  /**
   * Handle remote system update triggered by control plane
   */
  async handleSystemUpdate(reqId, msg) {
    const serverUrl = msg.serverUrl || this.serverUrl;
    console.log(`🔄 Remote system update requested from ${serverUrl}...`);

    try {
      const updateResult = await downloadAndApplyUpdate(serverUrl);
      this.send({
        reqId,
        action: 'system:update_success',
        oldVersion: CLIENT_VERSION,
        newVersion: updateResult.version,
        targetPath: updateResult.path,
        message: 'Agent script updated successfully. Initiating auto-restart...'
      });

      console.log(`✨ Agent updated to ${updateResult.version}. Restarting daemon in 1s...`);
      setTimeout(() => {
        restartSelf();
      }, 1000);
    } catch (err) {
      console.error('❌ Remote system update failed:', err.message);
      this.send({
        reqId,
        action: 'system:update_error',
        error: err.message
      });
    }
  }
}

/**
 * Simple HTTP / HTTPS GET requester with redirection support
 */
function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + targetUrl));
    }
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');
    const agent = isHttps ? new lib.Agent({ rejectUnauthorized: false }) : undefined;

    const req = lib.get(targetUrl, {
      timeout: 15000,
      agent,
      headers: { 'User-Agent': `ccnow-agent/${CLIENT_VERSION}` }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return fetchUrl(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Server returned HTTP ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => resolve(rawData));
    });

    req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

/**
 * Download latest ccnow-agent from server and update local file
 */
async function downloadAndApplyUpdate(serverUrl) {
  const cleanServer = serverUrl.trim().replace(/\/+$/, '');
  const agentUrl = `${cleanServer}/agent.js`;
  const code = await fetchUrl(agentUrl);

  if (!code.includes('ccnow-agent') || (!code.startsWith('#!') && !code.includes('CLIENT_VERSION'))) {
    throw new Error('Downloaded file does not appear to be a valid ccnow-agent script.');
  }

  const match = code.match(/CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
  const newVersion = match ? match[1] : 'unknown';

  let targetPath = process.argv[1];
  if (!targetPath || targetPath === '-' || targetPath.includes('[eval]') || !fs.existsSync(targetPath)) {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    targetPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  }

  const tmpPath = targetPath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, code, { mode: 0o755 });
  fs.renameSync(tmpPath, targetPath);

  return {
    path: targetPath,
    version: newVersion
  };
}

/**
 * Restart current process safely
 */
function restartSelf() {
  let targetPath = process.argv[1];
  if (!targetPath || targetPath === '-' || targetPath.includes('[eval]') || !fs.existsSync(targetPath)) {
    targetPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  }

  const child = spawn(process.execPath, [targetPath, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'inherit'
  });
  child.unref();
  process.exit(0);
}

/**
 * Handle system background service (LaunchAgent / Systemd)
 */
function handleServiceCommand(action, options) {
  const platform = os.platform();
  const config = readConfig();

  // Ensure executable script exists at ~/.ccnow/ccnow-agent.js
  const scriptPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (action === 'install') {
    if (!config || !config.deviceId || !config.deviceSecret) {
      console.error('❌ Error: Device is not paired yet. Please run `connect` first before installing service.');
      process.exit(1);
    }

    // Copy current script to ~/.ccnow/ccnow-agent.js if running from another location
    try {
      const currentScript = process.argv[1];
      if (currentScript && fs.existsSync(currentScript) && currentScript !== scriptPath) {
        fs.copyFileSync(currentScript, scriptPath);
        fs.chmodSync(scriptPath, 0o755);
      }
    } catch (e) {}

    if (platform === 'darwin') {
      const launchDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });
      const plistPath = path.join(launchDir, 'com.ccnow.agent.plist');

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ccnow.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(CONFIG_DIR, 'agent.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(CONFIG_DIR, 'agent-err.log')}</string>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
</dict>
</plist>`;

      fs.writeFileSync(plistPath, plistContent, 'utf8');
      console.log(`✅ macOS LaunchAgent created: ${plistPath}`);
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
        execSync(`launchctl load -w "${plistPath}"`);
        console.log('🚀 Service started and set to run on login via launchd!');
        console.log(`📜 Logs: tail -f ~/.ccnow/agent.log`);
      } catch (err) {
        console.error('⚠️ Failed to load launchd service:', err.message);
      }
    } else if (platform === 'linux') {
      const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      if (!fs.existsSync(unitDir)) fs.mkdirSync(unitDir, { recursive: true });
      const servicePath = path.join(unitDir, 'ccnow-agent.service');

      const serviceContent = `[Unit]
Description=ccnow Edge Agent Daemon
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${scriptPath} start
Restart=always
RestartSec=5
StandardOutput=append:${path.join(CONFIG_DIR, 'agent.log')}
StandardError=append:${path.join(CONFIG_DIR, 'agent-err.log')}
WorkingDirectory=${os.homedir()}

[Install]
WantedBy=default.target
`;
      fs.writeFileSync(servicePath, serviceContent, 'utf8');
      console.log(`✅ systemd user service created: ${servicePath}`);
      try {
        execSync('systemctl --user daemon-reload');
        execSync('systemctl --user enable --now ccnow-agent.service');
        console.log('🚀 Service started and enabled via systemd user unit!');
        console.log(`📜 Status: systemctl --user status ccnow-agent.service`);
      } catch (err) {
        console.error('⚠️ Failed to enable systemd service:', err.message);
      }
    } else {
      console.log('ℹ️ Service auto-install currently supports macOS (launchd) and Linux (systemd).');
      console.log(`You can run ccnow-agent in background using: nohup node "${scriptPath}" start > ~/.ccnow/agent.log 2>&1 &`);
    }
    return;
  }

  if (action === 'uninstall') {
    if (platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ccnow.agent.plist');
      try { execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`); } catch (e) {}
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      console.log('✅ macOS LaunchAgent stopped and removed.');
    } else if (platform === 'linux') {
      const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'ccnow-agent.service');
      try {
        execSync('systemctl --user stop ccnow-agent.service 2>/dev/null || true');
        execSync('systemctl --user disable ccnow-agent.service 2>/dev/null || true');
      } catch (e) {}
      if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
      try { execSync('systemctl --user daemon-reload'); } catch (e) {}
      console.log('✅ systemd user service stopped and removed.');
    }
    return;
  }

  if (action === 'status') {
    if (platform === 'darwin') {
      try {
        const out = execSync('launchctl list | grep com.ccnow.agent || true', { encoding: 'utf8' });
        if (out.trim()) {
          console.log('🟢 ccnow-agent service is registered in launchd:\n' + out);
        } else {
          console.log('⚪ ccnow-agent service is not currently running in launchd.');
        }
      } catch (e) {
        console.log('⚠️ Could not check launchctl status.');
      }
    } else if (platform === 'linux') {
      try {
        execSync('systemctl --user status ccnow-agent.service', { stdio: 'inherit' });
      } catch (e) {
        // systemctl status exits non-zero if inactive/failed
      }
    }
    return;
  }

  if (action === 'restart') {
    if (platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ccnow.agent.plist');
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
        execSync(`launchctl load -w "${plistPath}"`);
        console.log('🔄 macOS LaunchAgent service restarted.');
      } catch (e) {
        console.error('❌ Failed to restart service:', e.message);
      }
    } else if (platform === 'linux') {
      try {
        execSync('systemctl --user restart ccnow-agent.service');
        console.log('🔄 systemd user service restarted.');
      } catch (e) {
        console.error('❌ Failed to restart service:', e.message);
      }
    }
    return;
  }

  console.log(`Unknown service action: ${action}. Available: install, uninstall, status, restart`);
}

/**
 * Print help manual
 */
function printHelp() {
  console.log(`
ccnow-agent (v${CLIENT_VERSION}) - Ultra-lightweight edge daemon for ccnow (tmux-agent-deck)

Usage:
  curl -fsSL https://<server>/agent.js | node - connect --server <url> --token <token> [--name <name>]
      Pair and connect this device to the ccnow Web Control Plane

  npx ccnow-agent start [--server <url>]
      Start daemon in foreground using saved credentials from ~/.ccnow/device.json

  npx ccnow-agent update [--server <url>]
      Download latest ccnow-agent from server and apply self-update

  npx ccnow-agent service <install|uninstall|status|restart>
      Manage background daemon service via macOS LaunchAgent or Linux systemd user unit

  npx ccnow-agent status
      Show currently paired device details

  npx ccnow-agent version
      Show client daemon version

  npx ccnow-agent unpair
      Remove local pairing configuration
`);
}

// Main execution entrypoint
const parsed = parseArgs(process.argv.slice(2));

switch (parsed.command) {
  case 'version':
  case '-v':
  case '--version': {
    console.log(`ccnow-agent v${CLIENT_VERSION}`);
    break;
  }

  case 'update': {
    const config = readConfig();
    const server = parsed.options.server || config?.server;
    if (!server) {
      console.error('❌ Error: No server URL specified. Provide --server <url> or pair first.');
      process.exit(1);
    }
    console.log(`⬇️ Checking for updates and downloading from ${server}...`);
    downloadAndApplyUpdate(server).then((res) => {
      console.log(`🎉 Update applied successfully!`);
      console.log(`📁 Target:  ${res.path}`);
      console.log(`🏷️ Version: ${CLIENT_VERSION} ➔ ${res.version}`);
      process.exit(0);
    }).catch((err) => {
      console.error(`❌ Update failed: ${err.message}`);
      process.exit(1);
    });
    break;
  }

  case 'service': {
    const subcommand = parsed.options._subcommand || process.argv[3] || 'status';
    handleServiceCommand(subcommand, parsed.options);
    break;
  }

  case 'connect': {
    const server = parsed.options.server;
    const token = parsed.options.token;
    const name = parsed.options.name;

    if (!server || !token) {
      console.error('❌ Error: Both --server and --token are required for connect.');
      printHelp();
      process.exit(1);
    }

    console.log(`🚀 Starting ccnow-agent pairing...`);
    const client = new AgentClient(server, { token, customName: name });
    client.start();

    process.on('SIGINT', () => {
      console.log('\n👋 Disconnecting ccnow-agent...');
      client.stop();
      process.exit(0);
    });
    break;
  }

  case 'start': {
    const config = readConfig();
    const server = parsed.options.server || config?.server;
    if (!config || !config.deviceId || !config.deviceSecret || !server) {
      console.error('❌ Error: No valid device credentials found in ~/.ccnow/device.json');
      console.error('Please run `npx ccnow-agent connect --server <url> --token <token>` first.');
      process.exit(1);
    }

    console.log(`🚀 Starting ccnow-agent (Device: ${config.name || config.deviceId})...`);
    const client = new AgentClient(server, {
      deviceId: config.deviceId,
      deviceSecret: config.deviceSecret
    });
    client.start();

    process.on('SIGINT', () => {
      console.log('\n👋 Disconnecting ccnow-agent...');
      client.stop();
      process.exit(0);
    });
    break;
  }

  case 'status': {
    const config = readConfig();
    if (!config) {
      console.log('ℹ️ No device configuration found. Device is not paired yet.');
    } else {
      console.log('📱 Paired Device Info:');
      console.log(`  Name:      ${config.name || 'N/A'}`);
      console.log(`  Device ID: ${config.deviceId}`);
      console.log(`  Server:    ${config.server}`);
      console.log(`  Config:    ${CONFIG_FILE}`);
    }
    break;
  }

  case 'unpair': {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      console.log('✅ Local device configuration removed.');
    } else {
      console.log('ℹ️ No configuration file found.');
    }
    break;
  }

  case 'help':
  default:
    printHelp();
    break;
}
