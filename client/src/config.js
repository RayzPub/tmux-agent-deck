const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// Client Version (kept as literal string for self-update version regex detection)
const CLIENT_VERSION = '1.7.3';

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

const commandCache = new Map();

function hasCommand(cmd) {
  if (commandCache.has(cmd)) {
    return commandCache.get(cmd);
  }
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    commandCache.set(cmd, true);
    return true;
  } catch (e) {
    commandCache.set(cmd, false);
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

/**
 * Inject Control Plane LLM Gateway loopback env + scoped virtual key (`sk-ccnow-<deviceId>.<deviceSecret>`)
 * for managed host-admin agents when CCNOW_MANAGED_LLM_GATEWAY=1.
 * Keeps Terminal/Tmux sessions and OAR Pure Chat sessions 100% aligned without storing secrets in systemd unit files.
 */
function applyManagedGatewayEnv({ server, deviceId, deviceSecret }) {
  if (process.env.CCNOW_MANAGED_LLM_GATEWAY !== '1') return;
  if (!server || !deviceId || !deviceSecret) return;

  const baseUrl = String(server).trim().replace(/\/+$/, '');
  const virtualKey = `sk-ccnow-${deviceId}.${deviceSecret}`;
  const claudeOAuthMode = process.env.CCNOW_CLAUDE_OAUTH_MODE === '1';

  const envMap = {
    OPENAI_BASE_URL: `${baseUrl}/v1`,
    OPENAI_API_BASE: `${baseUrl}/v1`,
    OPENAI_API_KEY: virtualKey,
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1'
  };

  if (claudeOAuthMode) {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    envMap.ANTHROPIC_BASE_URL = baseUrl;
    envMap.ANTHROPIC_API_KEY = virtualKey;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  for (const [k, v] of Object.entries(envMap)) {
    process.env[k] = v;
  }

  // Sync into running tmux server global environment so new tmux panes/sessions inherit the exact gateway env
  if (hasCommand('tmux')) {
    for (const [k, v] of Object.entries(envMap)) {
      try {
        execFileSync('tmux', tmuxArgs(['set-environment', '-g', k, v]), { stdio: 'ignore' });
      } catch (_) {}
    }
    if (claudeOAuthMode) {
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
        try {
          execFileSync('tmux', tmuxArgs(['set-environment', '-gu', k]), { stdio: 'ignore' });
        } catch (_) {}
      }
    } else {
      try {
        execFileSync('tmux', tmuxArgs(['set-environment', '-gu', 'ANTHROPIC_AUTH_TOKEN']), { stdio: 'ignore' });
      } catch (_) {}
    }
  }

  console.log(`🔐 [ccnow-agent] Managed LLM Gateway active (${baseUrl}, Claude: ${claudeOAuthMode ? 'OAuth Direct' : 'Scoped Virtual Key'}, Codex: Scoped Virtual Key)`);
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
  safeResolve,
  applyManagedGatewayEnv
};
