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

const RUN_USER = process.env.SUDO_USER && process.env.SUDO_USER !== 'root' ? process.env.SUDO_USER : 'ubuntu';
const USER_HOME = `/home/${RUN_USER}`;
const CONFIG_DIR = path.join(USER_HOME, '.ccnow-host-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'device.json');
const WORKSPACES_FILE = path.join(CONFIG_DIR, 'workspaces.json');
const SERVICE_NAME = 'ccnow-host-agent.service';
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const NODE_BIN = process.execPath;
const AGENT_SCRIPT = path.join(PROJECT_ROOT, 'client', 'ccnow-agent.js');
const SERVER_URL = `http://127.0.0.1:${PORT || 80}`;

function main() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const managed = deviceService.ensureManagedDevice('admin', {
    deviceKind: 'host-admin',
    name: `Cloud-Host (${os.hostname()})`,
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
    const defaultWorkspaces = {
      'tmux-agent-deck': PROJECT_ROOT
    };
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(defaultWorkspaces, null, 2), 'utf8');
  }

  // Ensure ubuntu owns the config dir
  if (process.getuid && process.getuid() === 0) {
    execSync(`chown -R ${RUN_USER}:${RUN_USER} "${CONFIG_DIR}"`);
  }

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
ExecStart=${NODE_BIN} ${AGENT_SCRIPT} start
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
  console.log(`   Device ID: ${managed.deviceId}`);
  console.log(`   Name:      ${managed.device.name}`);
  console.log(`   Server:    ${SERVER_URL}`);
  console.log(`   Unit:      ${SERVICE_NAME}`);
}

main();
