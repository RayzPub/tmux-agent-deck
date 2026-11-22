const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Client Version (kept as literal string for self-update version regex detection)
const CLIENT_VERSION = '1.7.0';

// Configuration directory & files (supports env override for managed host/container agents)
const CONFIG_DIR = process.env.CCNOW_CONFIG_DIR || path.join(os.homedir(), '.ccnow');
const CONFIG_FILE = path.join(CONFIG_DIR, 'device.json');
const WORKSPACES_FILE = path.join(CONFIG_DIR, 'workspaces.json');
const TMUX_SOCKET = process.env.CCNOW_TMUX_SOCKET || '';

function tmuxArgs(args) {
  return TMUX_SOCKET ? ['-S', TMUX_SOCKET, ...args] : args;
}

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

function parseArgs(args) {
  const result = { command: args[0] || 'help', options: {} };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=');
      const key = parts[0];
      const val = parts.length > 1
        ? parts[1]
        : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
      result.options[key] = val;
    }
  }
  return result;
}

function hasCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

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

function resolveBaseDir(wsPath) {
  if (!wsPath || wsPath === '~') return os.homedir();
  if (wsPath.startsWith('~/')) return path.join(os.homedir(), wsPath.substring(2));
  if (path.isAbsolute(wsPath) && fs.existsSync(wsPath)) return wsPath;
  return process.cwd();
}

/**
 * Safely resolve a relative path within a workspace root, preventing sibling-directory traversal.
 */
function safeResolve(workspacePath, reqPath) {
  const resolvedRoot = path.resolve(workspacePath);
  const target = path.isAbsolute(reqPath)
    ? path.resolve(reqPath)
    : path.resolve(resolvedRoot, reqPath || '');
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Access denied: path escapes workspace root');
  }
  return target;
}

module.exports = {
  CLIENT_VERSION,
  CONFIG_DIR,
  CONFIG_FILE,
  WORKSPACES_FILE,
  TMUX_SOCKET,
  tmuxArgs,
  readConfig,
  saveConfig,
  parseArgs,
  hasCommand,
  getLocalDeviceInfo,
  toWsUrl,
  resolveBaseDir,
  safeResolve
};
