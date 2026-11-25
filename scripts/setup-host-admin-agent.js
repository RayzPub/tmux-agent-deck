#!/usr/bin/env node
/**
 * Idempotently register the current host machine as an independent systemd-managed
 * ccnow-agent device for `admin`. Decoupled from server.js restarts!
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { PROJECT_ROOT, PORT } = require('../config');
const deviceService = require('../services/deviceService');
const db = require('../services/dbService');
const { ensureCodexConfig } = require('../services/fileService');

function resolveRunUser() {
  if (process.env.CCNOW_HOST_USER) {
    return process.env.CCNOW_HOST_USER;
  }
  if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
    return process.env.SUDO_USER;
  }
  // If deployed under /root or running directly as root without /home/ubuntu, run as root
  if (PROJECT_ROOT === '/root' || PROJECT_ROOT.startsWith('/root/') || !fs.existsSync('/home/ubuntu')) {
    return 'root';
  }
  return 'ubuntu';
}

function resolveUserHome(username) {
  if (username === 'root') return '/root';
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    const line = passwd.split('\n').find(l => l.startsWith(`${username}:`));
    if (line) {
      const homeDir = line.split(':')[5];
      if (homeDir) return homeDir;
    }
  } catch (_) {}
  return `/home/${username}`;
}

if (process.getuid && process.getuid() !== 0) {
  console.error('❌ This script must be run with root privileges to configure systemd and SQLite.');
  console.error('   Run: sudo "$(which node)" scripts/setup-host-admin-agent.js');
  process.exit(1);
}

const RUN_USER = resolveRunUser();
const USER_HOME = resolveUserHome(RUN_USER);
const CONFIG_DIR = path.join(USER_HOME, '.ccnow-host-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'device.json');
const WORKSPACES_FILE = path.join(CONFIG_DIR, 'workspaces.json');
const rawTmuxSocket = process.env.CCNOW_TMUX_SOCKET;
const TMUX_SOCKET = (rawTmuxSocket === 'default' || rawTmuxSocket === 'none')
  ? ''
  : (rawTmuxSocket || path.join(PROJECT_ROOT, 'user_data', 'admin', 'tmux.sock'));
const SERVICE_NAME = 'ccnow-host-agent.service';
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const NODE_BIN = process.execPath;
const AGENT_SCRIPT = path.join(PROJECT_ROOT, 'client', 'ccnow-agent.js');
const SERVER_URL = `http://127.0.0.1:${PORT || 80}`;

function syncHostCliGatewayConfig(claudeOAuthMode) {
  // 1. Align Codex CLI (~/.codex/config.toml) with local LLM Gateway (no plaintext key written)
  try {
    ensureCodexConfig(USER_HOME, `${SERVER_URL}/v1`, true);
  } catch (err) {
    console.warn('⚠️ Failed to sync host Codex config.toml:', err.message);
  }

  // 2. Purge conflicting ANTHROPIC_BASE_URL / ANTHROPIC_MODEL from ~/.claude/settings.json
  //    so scoped virtual key env injected by ccnow-agent takes precedence
  if (!claudeOAuthMode) {
    try {
      const claudeSettingsPath = path.join(USER_HOME, '.claude', 'settings.json');
      if (fs.existsSync(claudeSettingsPath)) {
        const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
        let dirty = false;
        if (settings.env && typeof settings.env === 'object') {
          for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
            if (key in settings.env) {
              delete settings.env[key];
              dirty = true;
            }
          }
        }
        if ('model' in settings) {
          delete settings.model;
          dirty = true;
        }
        if (dirty) {
          fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
          if (process.getuid && process.getuid() === 0) {
            execSync(`chown ${RUN_USER}:${RUN_USER} "${claudeSettingsPath}"`);
          }
          console.log('🧹 Cleaned conflicting env overrides from ~/.claude/settings.json');
        }
      }
    } catch (err) {
      console.warn('⚠️ Failed to sanitize host ~/.claude/settings.json:', err.message);
    }
  }
}

function main() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const managed = deviceService.ensureManagedDevice('admin', {
    deviceKind: 'host-admin',
    name: '主服务器',
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch
  });

  let deviceSecret = managed.deviceSecret;
  if (!deviceSecret && fs.existsSync(CONFIG_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (existing.deviceId === managed.deviceId && existing.deviceSecret) {
        deviceSecret = existing.deviceSecret;
      }
    } catch (_) {}
  }

  if (!deviceSecret) {
    deviceSecret = deviceService.rotateManagedDeviceSecret(managed.deviceId);
  }

  const cfg = {
    server: SERVER_URL,
    deviceId: managed.deviceId,
    deviceSecret,
    name: managed.device.name,
    pairedAt: Date.now()
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });

  if (!fs.existsSync(WORKSPACES_FILE)) {
    const seedList = [];
    const seenPaths = new Set();
    const legacyWsFile = path.join(PROJECT_ROOT, 'workspaces.json');
    if (fs.existsSync(legacyWsFile)) {
      try {
        const legacyRaw = JSON.parse(fs.readFileSync(legacyWsFile, 'utf8'));
        const entries = Array.isArray(legacyRaw)
          ? legacyRaw
          : Object.entries(legacyRaw || {}).map(([name, wsPath]) => ({ name, path: wsPath }));
        for (const item of entries) {
          if (item && item.path && !seenPaths.has(item.path)) {
            seenPaths.add(item.path);
            seedList.push({ name: item.name || path.basename(item.path), path: item.path });
          }
        }
      } catch (_) {}
    }
    if (!seenPaths.has(PROJECT_ROOT)) {
      seedList.push({ name: 'tmux-agent-deck', path: PROJECT_ROOT });
    }
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(seedList, null, 2), 'utf8');
  }

  const settings = db.getSettings();
  const claudeOAuthMode = Boolean(settings && settings.claudeOAuthMode);
  syncHostCliGatewayConfig(claudeOAuthMode);

  // Ensure RUN_USER owns the config dir
  if (process.getuid && process.getuid() === 0) {
    execSync(`chown -R ${RUN_USER}:${RUN_USER} "${CONFIG_DIR}"`);
  }

  const oauthEnvLine = claudeOAuthMode ? 'Environment=CCNOW_CLAUDE_OAUTH_MODE=1\n' : '';
  const tmuxSocketLine = TMUX_SOCKET ? `Environment=CCNOW_TMUX_SOCKET=${TMUX_SOCKET}\n` : '';
  const unitContent = `[Unit]
Description=CCNOW Host Admin Edge Agent (Independent of server.js)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${USER_HOME}
Environment=HOME=${USER_HOME}
Environment=PATH=${path.dirname(NODE_BIN)}:${USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CCNOW_CONFIG_DIR=${CONFIG_DIR}
Environment=CCNOW_SERVER_URL=${SERVER_URL}
${tmuxSocketLine}Environment=CCNOW_MANAGED_LLM_GATEWAY=1
${oauthEnvLine}ExecStart=${NODE_BIN} ${AGENT_SCRIPT} start
KillMode=process
Restart=always
RestartSec=3
StandardOutput=append:${path.join(CONFIG_DIR, 'agent.log')}
StandardError=append:${path.join(CONFIG_DIR, 'agent-err.log')}

[Install]
WantedBy=multi-user.target
`;

  fs.writeFileSync(SERVICE_PATH, unitContent, 'utf8');
  execSync('systemctl daemon-reload');
  execSync(`systemctl enable --now ${SERVICE_NAME}`);
  execSync(`systemctl restart ${SERVICE_NAME}`);

  console.log(`✅ Host Admin Agent installed and running!`);
  console.log(`   Run User:  ${RUN_USER} (HOME=${USER_HOME})`);
  console.log(`   Device ID: ${managed.deviceId}`);
  console.log(`   Name:      ${managed.device.name}`);
  console.log(`   Server:    ${SERVER_URL}`);
  console.log(`   Tmux Sock: ${TMUX_SOCKET || '(default system socket)'}`);
  console.log(`   Unit:      ${SERVICE_NAME}`);
}

main();
