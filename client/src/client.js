const os = require('os');
const { CLIENT_VERSION, saveConfig, getLocalDeviceInfo, toWsUrl } = require('./config');
const fsHandlers = require('./fsHandlers');
const gitHandlers = require('./gitHandlers');
const tmuxHandlers = require('./tmuxHandlers');
const chatHandlers = require('./chatHandlers');
const { ensureLocalAgentScript, handleSystemUpdate } = require('./updater');
const { handleServiceCommand } = require('./serviceManager');
const { tryRequireOptional, installPackageSync, ensureOptionalDepsInBackground } = require('./depsManager');

// Ensure native or installed WebSocket (auto-installs 'ws' into ~/.ccnow/node_modules on Node < 21)
let WSClient = typeof WebSocket !== 'undefined' ? WebSocket : tryRequireOptional('ws');
if (!WSClient) {
  if (installPackageSync('ws')) {
    WSClient = tryRequireOptional('ws');
  }
}
if (!WSClient) {
  console.error('❌ Error: Global WebSocket not available in this Node.js version.');
  console.error('Please run with Node.js >= 21 or run: npm install -g ws');
  process.exit(1);
}

class AgentClient {
  constructor(serverUrl, credentials = {}) {
    this.serverUrl = serverUrl;
    this.credentials = credentials; // { token } or { deviceId, deviceSecret }
    this.ws = null;
    this.pingTimer = null;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.isStopped = false;
    this.send = this.send.bind(this);
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
    tmuxHandlers.cleanupAllTerminals();
    try {
      const oarMgr = chatHandlers.getDeviceOarManager();
      if (oarMgr && typeof oarMgr.shutdownAll === 'function') {
        oarMgr.shutdownAll();
      }
    } catch (_) {}
  }

  connect() {
    if (this.isStopped) return;

    const wsUrl = toWsUrl(this.serverUrl);
    console.log(`🔌 Connecting to ccnow Control Plane at ${wsUrl}...`);

    try {
      this.ws = new WSClient(wsUrl);
    } catch (err) {
      console.error('❌ Connection failed:', err.message);
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
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  startHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > 45000) {
        console.warn('⚠️ Heartbeat pong timed out. Forcing reconnect...');
        try { this.ws.close(); } catch (e) {}
        this.scheduleReconnect();
        return;
      }
      this.send({ action: 'ping' });
    }, 20000);
  }

  async handoffToBackgroundDaemon() {
    const platform = os.platform();
    const savedPath = await ensureLocalAgentScript(this.serverUrl, { forceDownload: true });

    if (platform !== 'darwin' && platform !== 'linux') {
      console.log(`ℹ️ 当前系统 (${platform}) 暂不支持自动安装后台服务，已自动切换为前台运行模式（按 Ctrl+C 退出）。`);
      this.startHeartbeat();
      ensureOptionalDepsInBackground();
      return;
    }

    if (!savedPath) {
      console.warn('⚠️ 无法下载本地脚本到 ~/.ccnow/ccnow-agent.js，已回退为前台运行模式。');
      this.startHeartbeat();
      ensureOptionalDepsInBackground();
      return;
    }

    console.log('⚙️ 正在注册系统后台常驻服务...');
    // Close temporary pairing socket before daemon starts to avoid duplicate connection churn
    this.stop();

    const result = handleServiceCommand('install');
    if (result && result.ok) {
      console.log('✨ 配置完成！后台服务已在运行，你可以放心关闭当前终端窗口。');
      process.exit(0);
      return;
    }

    console.warn('⚠️ 后台服务注册失败，已自动回退为前台保持连接（按 Ctrl+C 退出）。');
    this.credentials = {
      deviceId: this.credentials.deviceId,
      deviceSecret: this.credentials.deviceSecret,
      daemon: false
    };
    this.start();
  }

  handleMessage(msg) {
    const { action } = msg;

    switch (action) {
      case 'pair_success':
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
          deviceSecret: msg.deviceSecret,
          daemon: this.credentials.daemon
        };

        if (this.credentials.daemon) {
          this.handoffToBackgroundDaemon();
          return;
        }

        ensureLocalAgentScript(this.serverUrl).then(() => {
          const p = os.platform();
          if (p === 'darwin' || p === 'linux') {
            console.log('💡 提示: 当前为前台运行模式（关闭终端将断开）；如需转为后台常驻，按 Ctrl+C 后执行:');
            console.log('   node ~/.ccnow/ccnow-agent.js service install');
          }
        });
        this.startHeartbeat();
        ensureOptionalDepsInBackground();
        return;

      case 'pair_failed':
        console.error(`❌ Pairing failed: ${msg.error}`);
        this.stop();
        process.exit(1);
        return;

      case 'auth_success':
        console.log(`✅ Authenticated successfully as ${msg.deviceId}! Online and ready.`);
        this.startHeartbeat();
        ensureOptionalDepsInBackground();
        return;

      case 'auth_failed':
        console.error(`❌ Authentication failed: ${msg.error}`);
        this.stop();
        process.exit(1);
        return;

      case 'pong':
        this.lastPong = Date.now();
        return;

      case 'system:update':
        handleSystemUpdate(this.send, this.serverUrl, msg.reqId, msg);
        return;

      // Tmux & Terminal
      case 'tmux:list_sessions':
        tmuxHandlers.handleListSessions(this.send, msg.reqId, chatHandlers.getDeviceOarManager, msg);
        return;
      case 'tmux:new_session':
        tmuxHandlers.handleNewSession(this.send, msg.reqId, msg, chatHandlers.getDeviceOarManager);
        return;
      case 'tmux:kill_session':
        tmuxHandlers.handleKillSession(this.send, msg.reqId, msg.sessionName, chatHandlers.getDeviceOarManager);
        return;
      case 'tmux:send_keys':
        tmuxHandlers.handleSendKeys(this.send, msg.reqId, msg);
        return;
      case 'term:open':
        tmuxHandlers.handleOpenTerminal(this.send, msg);
        return;
      case 'term:input':
        tmuxHandlers.handleTerminalInput(msg);
        return;
      case 'term:resize':
        tmuxHandlers.handleTerminalResize(msg);
        return;
      case 'term:close':
        tmuxHandlers.handleTerminalClose(msg);
        return;

      // Filesystem & Workspaces
      case 'fs:workspaces':
        fsHandlers.handleFsWorkspaces(this.send, msg.reqId);
        return;
      case 'fs:add_workspace':
        fsHandlers.handleFsAddWorkspace(this.send, msg.reqId, msg);
        return;
      case 'fs:remove_workspace':
        fsHandlers.handleFsRemoveWorkspace(this.send, msg.reqId, msg);
        return;
      case 'fs:list':
        fsHandlers.handleFsList(this.send, msg.reqId, msg.workspacePath, msg.relativePath);
        return;
      case 'fs:read':
        fsHandlers.handleFsRead(this.send, msg.reqId, msg.workspacePath, msg.filePath);
        return;
      case 'fs:write':
        fsHandlers.handleFsWrite(this.send, msg.reqId, msg.workspacePath, msg.filePath, msg.content);
        return;
      case 'fs:directories':
        fsHandlers.handleDirectories(this.send, msg.reqId, msg.targetPath);
        return;
      case 'fs:upload_file':
        fsHandlers.handleUploadFile(this.send, msg.reqId, msg);
        return;
      case 'fs:create_file':
        fsHandlers.handleFsCreateFile(this.send, msg.reqId, msg.workspacePath, msg.filePath);
        return;
      case 'fs:create_dir':
        fsHandlers.handleFsCreateDir(this.send, msg.reqId, msg.workspacePath, msg.dirPath);
        return;
      case 'fs:delete':
        fsHandlers.handleFsDelete(this.send, msg.reqId, msg.workspacePath, msg.targetPath);
        return;
      case 'fs:rename':
        fsHandlers.handleFsRename(this.send, msg.reqId, msg.workspacePath, msg.oldPath, msg.newPath);
        return;

      // Git
      case 'git:status':
        gitHandlers.handleGitStatus(this.send, msg.reqId, msg.workspacePath);
        return;
      case 'git:diff':
        gitHandlers.handleGitDiff(this.send, msg.reqId, msg.workspacePath, msg.filePath);
        return;
      case 'git:stage':
        gitHandlers.handleGitStage(this.send, msg.reqId, msg.workspacePath, msg.files);
        return;
      case 'git:unstage':
        gitHandlers.handleGitUnstage(this.send, msg.reqId, msg.workspacePath, msg.files);
        return;
      case 'git:commit':
        gitHandlers.handleGitCommit(this.send, msg.reqId, msg.workspacePath, msg.message);
        return;
      case 'git:branches':
        gitHandlers.handleGitBranches(this.send, msg.reqId, msg.workspacePath);
        return;
      case 'git:checkout':
        gitHandlers.handleGitCheckout(this.send, msg.reqId, msg.workspacePath, msg.branch);
        return;

      // Agent Chat & OAR
      case 'agent:chat_history':
        chatHandlers.handleChatHistory(this.send, msg.reqId, msg.sessionName, msg.since);
        return;
      case 'agent:clear_context':
        chatHandlers.handleClearContext(this.send, msg.reqId, msg.sessionName);
        return;
      case 'agent:chat_upload':
        chatHandlers.handleChatUpload(this.send, msg.reqId, msg);
        return;
      case 'agent:chat_attachment':
        chatHandlers.handleChatAttachment(this.send, msg.reqId, msg);
        return;
      case 'agent:chat':
        chatHandlers.executeAgentTask(this.send, msg);
        return;
      case 'agent:interrupt':
        chatHandlers.interruptAgentTask(msg.sessionId);
        return;
      case 'oar:runtimes':
        chatHandlers.handleOarRuntimes(this.send, msg.reqId);
        return;
      case 'oar:list_models':
        chatHandlers.handleOarListModels(this.send, msg.reqId, msg);
        return;
      case 'oar:set_model':
        chatHandlers.handleOarSetModel(this.send, msg.reqId, msg);
        return;
      case 'oar:message':
        chatHandlers.handleOarMessage(this.send, msg.reqId, msg);
        return;
      case 'oar:compact':
        chatHandlers.handleOarCompact(this.send, msg.reqId, msg.sessionName);
        return;
      case 'oar:abort':
        chatHandlers.handleOarAbort(this.send, msg.reqId, msg.sessionName);
        return;

      default:
        console.log(`[ccnow-agent] Received action: ${action}`);
    }
  }
}

module.exports = { AgentClient };
