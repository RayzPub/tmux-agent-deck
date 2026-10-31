const { WebSocketServer } = require('ws');
const url = require('url');
const deviceService = require('../services/deviceService');

/**
 * Initialize Device Gateway WebSocket tunnel on HTTP/HTTPS servers
 * @param {Array<http.Server|https.Server>} servers - HTTP / HTTPS servers to attach to
 * @param {SocketIO.Server} io - Socket.io instance for notifying web browsers
 */
function initDeviceGateway(servers, io) {
  const wss = new WebSocketServer({ noServer: true });

  const serverList = Array.isArray(servers) ? servers.filter(Boolean) : [servers].filter(Boolean);

  for (const server of serverList) {
    server.on('upgrade', (request, socket, head) => {
      try {
        const parsedUrl = new URL(request.url, 'http://localhost');
        const pathname = parsedUrl.pathname;
        if (pathname === '/device-tunnel' || pathname === '/device-tunnel/') {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        }
      } catch (err) {
        console.error('[DeviceGateway] Error during upgrade:', err);
      }
    });
  }

  // Periodic heartbeat cleanup for stale connections (every 30 seconds)
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [deviceId, conn] of require('../services/deviceService').__getActiveConnections?.() || []) {
      if (now - conn.lastPing > 60000) { // 60s timeout
        console.warn(`[DeviceGateway] Device ${deviceId} heartbeat timed out. Closing.`);
        try {
          conn.ws.close(4008, 'Ping timeout');
        } catch (e) {}
        deviceService.unregisterConnection(deviceId, io);
      }
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, request) => {
    let boundDeviceId = null;
    let isAuthenticated = false;

    console.log(`[DeviceGateway] New raw connection from ${request.socket.remoteAddress}`);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.warn('[DeviceGateway] Invalid JSON received:', err.message);
        ws.send(JSON.stringify({ action: 'error', error: 'Malformed JSON payload' }));
        return;
      }

      const { action } = msg;

      // 1. Initial Pairing
      if (action === 'pair') {
        const { token, deviceInfo } = msg;
        const username = deviceService.verifyAndConsumePairToken(token);
        if (!username) {
          ws.send(JSON.stringify({
            action: 'pair_failed',
            error: 'Invalid or expired pair token'
          }));
          setTimeout(() => ws.close(4003, 'Pair token invalid'), 500);
          return;
        }

        const registration = deviceService.registerDevice(username, deviceInfo);
        boundDeviceId = registration.deviceId;
        isAuthenticated = true;

        deviceService.registerConnection(boundDeviceId, ws, registration.device, io);

        ws.send(JSON.stringify({
          action: 'pair_success',
          deviceId: registration.deviceId,
          deviceSecret: registration.deviceSecret,
          device: {
            name: registration.device.name,
            userId: registration.device.userId
          },
          message: 'Device successfully paired and connected'
        }));
        return;
      }

      // 2. Auth with existing credentials
      if (action === 'auth') {
        const { deviceId, deviceSecret } = msg;
        const deviceRecord = deviceService.authenticateDevice(deviceId, deviceSecret);
        if (!deviceRecord) {
          ws.send(JSON.stringify({
            action: 'auth_failed',
            error: 'Invalid device ID or secret'
          }));
          setTimeout(() => ws.close(4003, 'Auth failed'), 500);
          return;
        }

        boundDeviceId = deviceId;
        isAuthenticated = true;

        deviceService.registerConnection(boundDeviceId, ws, deviceRecord, io);

        ws.send(JSON.stringify({
          action: 'auth_success',
          deviceId,
          device: {
            name: deviceRecord.name,
            userId: deviceRecord.userId
          }
        }));
        return;
      }

      // Guard: following actions require authentication
      if (!isAuthenticated || !boundDeviceId) {
        ws.send(JSON.stringify({
          action: 'error',
          error: 'Unauthorized: Please authenticate or pair first'
        }));
        return;
      }

      // 3. Heartbeat Ping
      if (action === 'ping') {
        deviceService.recordDevicePing(boundDeviceId);
        ws.send(JSON.stringify({
          action: 'pong',
          timestamp: Date.now()
        }));
        return;
      }

      // 4. Agent streaming responses from client
      if (action === 'agent:stream' || action === 'agent:tool_call' || action === 'agent:done' || action === 'agent:error') {
        const { sessionId } = msg;
        if (sessionId) {
          // Notify internal subscribers (e.g. active HTTP/SSE or Socket.io listeners)
          deviceService.emitAgentEvent(sessionId, msg);

          // Also broadcast directly to Socket.io Web clients
          if (io) {
            io.emit(`device:agent_event:${sessionId}`, {
              ...msg,
              deviceId: boundDeviceId
            });
          }
        }
        return;
      }

      // 5. Remote Terminal PTY Output & Exit
      if (action === 'term:output') {
        deviceService.handleRemoteTerminalOutput(boundDeviceId, msg.termId, msg.data);
        return;
      }

      if (action === 'term:exit') {
        deviceService.handleRemoteTerminalExit(boundDeviceId, msg.termId);
        return;
      }

      // 6. Generic Device RPC Response matching by reqId
      if (msg.reqId) {
        deviceService.resolveDeviceRpc(msg.reqId, msg);
        return;
      }

      // Unknown action
      console.warn(`[DeviceGateway] Unknown action '${action}' from device ${boundDeviceId}`);
    });

    ws.on('close', (code, reason) => {
      console.log(`[DeviceGateway] Connection closed for device ${boundDeviceId} (code: ${code}, reason: ${reason})`);
      if (boundDeviceId) {
        deviceService.unregisterConnection(boundDeviceId, io);
      }
    });

    ws.on('error', (err) => {
      console.error(`[DeviceGateway] Socket error on device ${boundDeviceId}:`, err.message);
      if (boundDeviceId) {
        deviceService.unregisterConnection(boundDeviceId, io);
      }
    });
  });

  console.log('✅ Device Gateway WebSocket tunnel initialized at /device-tunnel');
  return wss;
}

module.exports = {
  initDeviceGateway
};
