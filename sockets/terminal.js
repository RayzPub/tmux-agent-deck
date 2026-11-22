const jwt = require('jsonwebtoken');
const { JWT_SECRET, MULTI_USER_ENABLED } = require('../config');
const deviceService = require('../services/deviceService');

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

  // Unified Device Tunnel Terminal Connection (all compute goes through /device-tunnel)
  io.on('connection', (socket) => {
    console.log('Client connected to terminal socket:', socket.id);

    const activeUsername = socket.user?.username || (MULTI_USER_ENABLED ? null : 'admin');
    if (activeUsername) {
      socket.join(`user:${activeUsername}`);
    }

    socket.isFocused = false;
    socket.activeSession = null;
    socket.sessionName = null;
    socket.remoteDeviceId = null;
    socket.remoteTermId = null;

    socket.on('client-focus', ({ focused, activeSession }) => {
      socket.isFocused = focused;
      socket.activeSession = activeSession;
    });

    socket.on('init-terminal', ({ sessionName, cols, rows, deviceId }) => {
      socket.sessionName = sessionName;

      // Close previous remote terminal stream if re-initializing on the same socket
      if (socket.remoteDeviceId && socket.remoteTermId) {
        deviceService.closeRemoteTerminal(socket.remoteDeviceId, socket.remoteTermId);
        socket.remoteDeviceId = null;
        socket.remoteTermId = null;
      }

      const username = socket.user?.username || (MULTI_USER_ENABLED ? null : 'admin');
      const targetDeviceId = (deviceId && deviceId !== 'cloud')
        ? deviceId
        : deviceService.resolveDefaultDeviceId(username);

      if (!targetDeviceId) {
        socket.emit('terminal-output', '\r\n\x1b[33;1m当前没有在线设备，请先在「设备管理」中启动云电脑或连接我的电脑。\x1b[0m\r\n');
        return;
      }

      const device = deviceService.getDeviceById(targetDeviceId);
      if (!device || (username && device.userId !== username)) {
        console.warn(`[Security Alert] Access denied: User "${username}" attempted unauthorized terminal access to device "${targetDeviceId}"`);
        socket.emit('terminal-output', '\r\n\x1b[31;1mError: Device not found or not owned by you.\x1b[0m\r\n');
        return;
      }

      socket.remoteDeviceId = targetDeviceId;
      socket.remoteTermId = socket.id;
      console.log(`[Terminal] Routing socket ${socket.id} -> device ${targetDeviceId} (Session: ${sessionName})`);

      const initRes = deviceService.initRemoteTerminal(targetDeviceId, socket, socket.id, sessionName, cols || 80, rows || 24);
      if (!initRes || !initRes.success) {
        socket.emit('terminal-output', `\r\n\x1b[31;1mError connecting to device: ${initRes?.error || 'Device offline'}\x1b[0m\r\n`);
      }
    });

    socket.on('exit-copy-mode', (callback) => {
      if (socket.remoteDeviceId && socket.sessionName) {
        deviceService.remoteTmuxSendKeys(socket.remoteDeviceId, {
          sessionName: socket.sessionName,
          exitCopyMode: true
        }).then((res) => {
          if (typeof callback === 'function') callback(Boolean(res && res.success));
        }).catch(() => {
          if (typeof callback === 'function') callback(false);
        });
      } else if (typeof callback === 'function') {
        callback(false);
      }
    });

    socket.on('terminal-input', (data) => {
      if (socket.remoteDeviceId && socket.remoteTermId) {
        deviceService.sendRemoteTerminalInput(socket.remoteDeviceId, socket.remoteTermId, data);
      }
    });

    socket.on('resize', ({ cols, rows }) => {
      if (socket.remoteDeviceId && socket.remoteTermId && cols > 0 && rows > 0) {
        deviceService.sendRemoteTerminalResize(socket.remoteDeviceId, socket.remoteTermId, cols, rows);
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected from terminal socket:', socket.id);
      if (socket.remoteDeviceId && socket.remoteTermId) {
        deviceService.closeRemoteTerminal(socket.remoteDeviceId, socket.remoteTermId);
        socket.remoteDeviceId = null;
        socket.remoteTermId = null;
      }
    });
  });
};

module.exports = { initSocket };
