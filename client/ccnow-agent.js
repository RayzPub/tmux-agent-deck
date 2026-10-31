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
          deviceInfo: getLocalDeviceInfo(this.credentials.customName)
        });
      } else if (this.credentials.deviceId && this.credentials.deviceSecret) {
        console.log(`🛡️ Authenticating device ${this.credentials.deviceId}...`);
        this.send({
          action: 'auth',
          deviceId: this.credentials.deviceId,
          deviceSecret: this.credentials.deviceSecret
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
    this.pingTimer = setInterval(() => {
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
      return;
    }

    // 1. Tmux List Sessions RPC
    if (action === 'tmux:list_sessions') {
      this.handleListSessions(msg.reqId);
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
}

/**
 * Print help manual
 */
function printHelp() {
  console.log(`
ccnow-agent - Ultra-lightweight edge daemon for ccnow (tmux-agent-deck)

Usage:
  curl -fsSL https://<server>/agent.js | node - connect --server <url> --token <token> [--name <name>]
      Pair and connect this device to the ccnow Web Control Plane

  npx ccnow-agent start [--server <url>]
      Start daemon using saved credentials from ~/.ccnow/device.json

  npx ccnow-agent status
      Show currently paired device details

  npx ccnow-agent unpair
      Remove local pairing configuration
`);
}

// Main execution entrypoint
const parsed = parseArgs(process.argv.slice(2));

switch (parsed.command) {
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
