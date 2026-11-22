const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { CONFIG_DIR, readConfig } = require('./config');

function handleServiceCommand(action) {
  const platform = os.platform();
  const config = readConfig();
  const scriptPath = path.join(CONFIG_DIR, 'ccnow-agent.js');

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (action === 'install') {
    if (!config || !config.deviceId || !config.deviceSecret) {
      console.error('❌ Error: Device is not paired yet. Please run `connect` first before installing service.');
      process.exit(1);
    }

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
        console.log(out.trim() ? '🟢 ccnow-agent service is registered in launchd:\n' + out : '⚪ ccnow-agent service is not currently running in launchd.');
      } catch (e) {
        console.log('⚠️ Could not check launchctl status.');
      }
    } else if (platform === 'linux') {
      try {
        execSync('systemctl --user status ccnow-agent.service', { stdio: 'inherit' });
      } catch (e) {}
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

module.exports = { handleServiceCommand };
