const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { CONFIG_DIR, readConfig } = require('./config');

const MAC_LABEL = 'com.ccnow.agent';
const LINUX_UNIT = 'ccnow-agent.service';

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getScriptDisplayPath() {
  const defaultDir = path.join(os.homedir(), '.ccnow');
  if (path.resolve(CONFIG_DIR) === path.resolve(defaultDir)) {
    return '~/.ccnow/ccnow-agent.js';
  }
  return path.join(CONFIG_DIR, 'ccnow-agent.js');
}

function getLogDisplayPath() {
  const defaultDir = path.join(os.homedir(), '.ccnow');
  if (path.resolve(CONFIG_DIR) === path.resolve(defaultDir)) {
    return '~/.ccnow/agent.log';
  }
  return path.join(CONFIG_DIR, 'agent.log');
}

function buildServiceEnv() {
  const home = os.homedir();
  const platform = os.platform();
  const nodeBinDir = path.dirname(process.execPath);

  const rawParts = [
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    nodeBinDir,
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'] : ['/usr/local/bin', '/usr/local/sbin']),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];

  const seen = new Set();
  const mergedPath = [];
  for (const dir of rawParts) {
    if (!dir) continue;
    if (!seen.has(dir)) {
      seen.add(dir);
      mergedPath.push(dir);
    }
  }

  const env = {
    HOME: home,
    PATH: mergedPath.join(':'),
    SHELL: process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    LANG: process.env.LANG || 'en_US.UTF-8',
    CCNOW_SERVICE_MANAGED: '1'
  };

  if (process.env.CCNOW_CONFIG_DIR) {
    env.CCNOW_CONFIG_DIR = process.env.CCNOW_CONFIG_DIR;
  }

  return env;
}

function getMacDomainTarget() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : Number(execSync('id -u', { encoding: 'utf8' }).trim());
  return `gui/${uid}`;
}

function getMacPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function getLinuxServicePath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', LINUX_UNIT);
}

function stopMacService(plistPath) {
  const domain = getMacDomainTarget();
  try {
    execSync(`launchctl bootout "${domain}/${MAC_LABEL}" 2>/dev/null || true`, { stdio: 'ignore' });
  } catch (_) {}
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { stdio: 'ignore' });
  } catch (_) {}
}

function startMacService(plistPath) {
  const domain = getMacDomainTarget();
  try {
    execSync(`launchctl bootstrap "${domain}" "${plistPath}"`, { stdio: 'pipe' });
    try {
      execSync(`launchctl kickstart -k "${domain}/${MAC_LABEL}"`, { stdio: 'ignore' });
    } catch (_) {}
    return;
  } catch (_) {
    // Fallback for older macOS or edge cases where bootstrap rejects an already-registered domain
    execSync(`launchctl load -w "${plistPath}"`, { stdio: 'pipe' });
  }
}

function printCommonCommands(platform) {
  const scriptCmd = `node ${getScriptDisplayPath()}`;
  const logPath = getLogDisplayPath();

  console.log('');
  console.log('📋 常用管理命令 (可直接复制执行):');
  console.log(`   查看状态:  ${scriptCmd} service status`);
  console.log(`   查看日志:  tail -f ${logPath}`);
  console.log(`   重启服务:  ${scriptCmd} service restart`);
  console.log(`   停止服务:  ${scriptCmd} service stop`);
  console.log(`   启动服务:  ${scriptCmd} service start`);
  console.log(`   卸载服务:  ${scriptCmd} service uninstall`);
  if (platform === 'linux') {
    console.log('');
    console.log('💡 Linux 服务器提示: 如需退出 SSH 后仍保持后台常驻，可执行:');
    console.log('   loginctl enable-linger $USER');
  }
  console.log('');
}

function handleServiceCommand(action) {
  const platform = os.platform();
  const config = readConfig();
  const scriptPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  const logPath = path.join(CONFIG_DIR, 'agent.log');
  const errLogPath = path.join(CONFIG_DIR, 'agent-err.log');

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (action === 'install') {
    if (!config || !config.deviceId || !config.deviceSecret) {
      console.error('❌ Error: Device is not paired yet. Please run `connect` first before installing service.');
      return { ok: false, supported: true, platform, error: 'not_paired' };
    }

    try {
      const currentScript = process.argv[1];
      if (currentScript && currentScript !== '-' && !currentScript.includes('[eval]') && fs.existsSync(currentScript)) {
        if (path.resolve(currentScript) !== path.resolve(scriptPath)) {
          fs.copyFileSync(currentScript, scriptPath);
          fs.chmodSync(scriptPath, 0o755);
        }
      }
    } catch (_) {}

    if (!fs.existsSync(scriptPath)) {
      console.error(`❌ Error: Agent script not found at ${scriptPath}.`);
      return { ok: false, supported: true, platform, error: 'script_missing' };
    }

    const serviceEnv = buildServiceEnv();

    if (platform === 'darwin') {
      const launchDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      if (!fs.existsSync(launchDir)) fs.mkdirSync(launchDir, { recursive: true });
      const plistPath = getMacPlistPath();

      const envEntries = Object.entries(serviceEnv)
        .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
        .join('\n');

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLogPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(os.homedir())}</string>
</dict>
</plist>
`;

      fs.writeFileSync(plistPath, plistContent, 'utf8');
      try {
        stopMacService(plistPath);
        startMacService(plistPath);
        console.log(`✅ 已安装并启动后台常驻服务 (macOS launchd，已设为登录自启)`);
        console.log(`   配置文件: ${plistPath}`);
        console.log(`   设备名称: ${config.name || os.hostname()} (${config.deviceId})`);
        printCommonCommands(platform);
        return { ok: true, supported: true, platform, servicePath: plistPath };
      } catch (err) {
        console.error('⚠️ Failed to load launchd service:', err.message);
        return { ok: false, supported: true, platform, error: err.message };
      }
    }

    if (platform === 'linux') {
      const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      if (!fs.existsSync(unitDir)) fs.mkdirSync(unitDir, { recursive: true });
      const servicePath = getLinuxServicePath();

      const envLines = Object.entries(serviceEnv)
        .map(([k, v]) => `Environment="${k}=${systemdEscape(v)}"`)
        .join('\n');

      const serviceContent = `[Unit]
Description=ccnow Edge Agent Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${os.homedir()}
${envLines}
ExecStart=${process.execPath} ${scriptPath} start
KillMode=process
Restart=always
RestartSec=3
StandardOutput=append:${logPath}
StandardError=append:${errLogPath}

[Install]
WantedBy=default.target
`;
      fs.writeFileSync(servicePath, serviceContent, 'utf8');
      try {
        execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
        execSync(`systemctl --user enable --now ${LINUX_UNIT}`, { stdio: 'pipe' });
        execSync(`systemctl --user restart ${LINUX_UNIT}`, { stdio: 'pipe' });
        console.log(`✅ 已安装并启动后台常驻服务 (Linux systemd --user，已设为开机自启)`);
        console.log(`   服务文件: ${servicePath}`);
        console.log(`   设备名称: ${config.name || os.hostname()} (${config.deviceId})`);
        printCommonCommands(platform);
        return { ok: true, supported: true, platform, servicePath };
      } catch (err) {
        console.error('⚠️ Failed to enable systemd user service:', err.message);
        return { ok: false, supported: true, platform, error: err.message };
      }
    }

    console.log(`ℹ️ 当前系统 (${platform}) 暂不支持自动注册后台常驻服务（目前支持 macOS 与 Linux）。`);
    return { ok: false, supported: false, platform, error: 'unsupported_platform' };
  }

  if (action === 'start') {
    if (platform === 'darwin') {
      const plistPath = getMacPlistPath();
      if (!fs.existsSync(plistPath)) {
        console.error(`⚠️ 尚未安装后台服务，请先执行: node ${getScriptDisplayPath()} service install`);
        return { ok: false, supported: true, platform };
      }
      try {
        stopMacService(plistPath);
        startMacService(plistPath);
        console.log('🚀 ccnow-agent 后台服务已启动 (macOS launchd)');
        return { ok: true, supported: true, platform };
      } catch (err) {
        console.error('❌ 启动失败:', err.message);
        return { ok: false, supported: true, platform, error: err.message };
      }
    }
    if (platform === 'linux') {
      try {
        execSync(`systemctl --user start ${LINUX_UNIT}`, { stdio: 'pipe' });
        console.log('🚀 ccnow-agent 后台服务已启动 (systemd --user)');
        return { ok: true, supported: true, platform };
      } catch (err) {
        console.error('❌ 启动失败:', err.message);
        return { ok: false, supported: true, platform, error: err.message };
      }
    }
    console.log(`ℹ️ 当前系统 (${platform}) 暂不支持 service start。`);
    return { ok: false, supported: false, platform };
  }

  if (action === 'stop') {
    if (platform === 'darwin') {
      const plistPath = getMacPlistPath();
      stopMacService(plistPath);
      console.log('🛑 ccnow-agent 后台服务已停止 (如需恢复可执行 service start)');
      return { ok: true, supported: true, platform };
    }
    if (platform === 'linux') {
      try {
        execSync(`systemctl --user stop ${LINUX_UNIT}`, { stdio: 'pipe' });
        console.log('🛑 ccnow-agent 后台服务已停止 (如需恢复可执行 service start)');
        return { ok: true, supported: true, platform };
      } catch (err) {
        console.error('❌ 停止失败:', err.message);
        return { ok: false, supported: true, platform, error: err.message };
      }
    }
    console.log(`ℹ️ 当前系统 (${platform}) 暂不支持 service stop。`);
    return { ok: false, supported: false, platform };
  }

  if (action === 'restart') {
    if (platform === 'darwin') {
      const plistPath = getMacPlistPath();
      if (!fs.existsSync(plistPath)) {
        console.error(`⚠️ 尚未安装后台服务，请先执行: node ${getScriptDisplayPath()} service install`);
        return { ok: false, supported: true, platform };
      }
      try {
        const domain = getMacDomainTarget();
        try {
          execSync(`launchctl kickstart -k "${domain}/${MAC_LABEL}"`, { stdio: 'pipe' });
        } catch (_) {
          stopMacService(plistPath);
          startMacService(plistPath);
        }
        console.log('🔄 ccnow-agent 后台服务已重启 (macOS launchd)');
        return { ok: true, supported: true, platform };
      } catch (e) {
        console.error('❌ 重启失败:', e.message);
        return { ok: false, supported: true, platform, error: e.message };
      }
    }
    if (platform === 'linux') {
      try {
        execSync(`systemctl --user restart ${LINUX_UNIT}`, { stdio: 'pipe' });
        console.log('🔄 ccnow-agent 后台服务已重启 (systemd --user)');
        return { ok: true, supported: true, platform };
      } catch (e) {
        console.error('❌ 重启失败:', e.message);
        return { ok: false, supported: true, platform, error: e.message };
      }
    }
    console.log(`ℹ️ 当前系统 (${platform}) 暂不支持 service restart。`);
    return { ok: false, supported: false, platform };
  }

  if (action === 'status') {
    if (platform === 'darwin') {
      const plistPath = getMacPlistPath();
      const installed = fs.existsSync(plistPath);
      try {
        const out = execSync(`launchctl list | grep ${MAC_LABEL} || true`, { encoding: 'utf8' }).trim();
        if (out) {
          const parts = out.split(/\s+/);
          const pid = parts[0] && parts[0] !== '-' ? parts[0] : null;
          if (pid) {
            console.log(`🟢 ccnow-agent 后台服务运行中 (PID: ${pid})`);
          } else {
            console.log(`🟡 ccnow-agent 已注册在 launchd，但当前未运行 (${out})`);
          }
          if (config) {
            console.log(`   设备名称: ${config.name || os.hostname()} (${config.deviceId})`);
            console.log(`   控制面:   ${config.server}`);
          }
          console.log(`   日志文件: ${getLogDisplayPath()}`);
        } else {
          console.log(installed
            ? `⚪ ccnow-agent 后台服务已安装但当前已停止 (运行 \`node ${getScriptDisplayPath()} service start\` 启动)`
            : `⚪ ccnow-agent 后台服务尚未安装 (运行 \`node ${getScriptDisplayPath()} service install\` 安装)`);
        }
        return { ok: true, supported: true, platform };
      } catch (e) {
        console.log('⚠️ 无法查询 launchctl 状态:', e.message);
        return { ok: false, supported: true, platform, error: e.message };
      }
    }
    if (platform === 'linux') {
      try {
        execSync(`systemctl --user status ${LINUX_UNIT} --no-pager`, { stdio: 'inherit' });
      } catch (_) {}
      return { ok: true, supported: true, platform };
    }
    console.log(`ℹ️ 当前系统 (${platform}) 暂不支持 service status。`);
    return { ok: false, supported: false, platform };
  }

  if (action === 'logs') {
    if (!fs.existsSync(logPath)) {
      console.log(`ℹ️ 日志文件尚不存在: ${logPath}`);
      return { ok: false, supported: true, platform };
    }
    console.log(`📜 实时追踪日志 (${getLogDisplayPath()})，按 Ctrl+C 退出查看...`);
    const child = spawn('tail', ['-n', '50', '-f', logPath], { stdio: 'inherit' });
    child.on('error', () => {
      console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-50).join('\n'));
    });
    return { ok: true, supported: true, platform, streaming: true };
  }

  if (action === 'uninstall') {
    if (platform === 'darwin') {
      const plistPath = getMacPlistPath();
      stopMacService(plistPath);
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      console.log('✅ 已停止并卸载 macOS LaunchAgent 后台服务。');
      console.log(`   (本地配对凭证保留在 ${path.join(CONFIG_DIR, 'device.json')}，如需重新启用后台服务可执行: node ${getScriptDisplayPath()} service install)`);
      return { ok: true, supported: true, platform };
    }
    if (platform === 'linux') {
      const servicePath = getLinuxServicePath();
      try {
        execSync(`systemctl --user stop ${LINUX_UNIT} 2>/dev/null || true`, { stdio: 'ignore' });
        execSync(`systemctl --user disable ${LINUX_UNIT} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch (_) {}
      if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
      try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch (_) {}
      console.log('✅ 已停止并卸载 Linux systemd 用户级后台服务。');
      console.log(`   (本地配对凭证保留在 ${path.join(CONFIG_DIR, 'device.json')}，如需重新启用后台服务可执行: node ${getScriptDisplayPath()} service install)`);
      return { ok: true, supported: true, platform };
    }
    console.log(`ℹ️ 当前系统 (${platform}) 暂不支持 service uninstall。`);
    return { ok: false, supported: false, platform };
  }

  console.log(`Unknown service action: ${action}. Available: install, start, stop, restart, status, logs, uninstall`);
  return { ok: false, supported: true, platform, error: 'unknown_action' };
}

module.exports = { handleServiceCommand, printCommonCommands };
