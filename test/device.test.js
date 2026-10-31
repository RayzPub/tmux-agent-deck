const http = require('http');
const assert = require('assert');
const { WebSocketServer } = require('ws');
const deviceService = require('../services/deviceService');
const { initDeviceGateway } = require('../sockets/deviceGateway');

async function runTest() {
  console.log('🧪 Starting Device Gateway & Service Test...');

  // 1. Create a dummy HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  const mockIo = {
    emit: (event, payload) => {
      console.log(`📡 [Mock Socket.io] Emit event: ${event}`, payload);
    }
  };

  initDeviceGateway([server], mockIo);

  await new Promise((resolve) => server.listen(3999, '127.0.0.1', resolve));
  console.log('✅ Mock test server listening on 127.0.0.1:3999');

  // 2. Generate Pair Token
  const pairData = deviceService.createPairToken('test_user', 60000);
  assert.ok(pairData.token.startsWith('pt_'), 'Pair token should start with pt_');
  console.log(`✅ Generated Pair Token: ${pairData.token}`);

  // 3. Connect as Edge Client
  const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');
  const ws = new WS('ws://127.0.0.1:3999/device-tunnel');

  let pairedDeviceId = null;
  let pairedSecret = null;

  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      console.log('✅ WS Client connected to /device-tunnel');
      ws.send(JSON.stringify({
        action: 'pair',
        token: pairData.token,
        deviceInfo: {
          name: 'Test MacBook',
          hostname: 'macbook.local',
          platform: 'darwin',
          arch: 'arm64'
        }
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      console.log('📩 Client received message:', msg);

      if (msg.action === 'pair_success') {
        pairedDeviceId = msg.deviceId;
        pairedSecret = msg.deviceSecret;
        assert.ok(pairedDeviceId, 'DeviceId must be present');
        assert.ok(pairedSecret, 'DeviceSecret must be present');
        console.log('✅ Pairing handshake succeeded!');
        resolve();
      }
    };

    ws.onerror = reject;
    setTimeout(() => reject(new Error('Pairing timeout')), 4000);
  });

  // 4. Test User Devices query
  const devices = deviceService.getUserDevices('test_user');
  assert.strictEqual(devices.length, 1, 'Should find 1 registered device');
  assert.strictEqual(devices[0].deviceId, pairedDeviceId);
  assert.strictEqual(devices[0].isOnline, true, 'Device should be online');
  console.log('✅ getUserDevices correctly returns online device');

  // 5. Test Heartbeat Ping
  await new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.action === 'pong') {
        console.log('✅ Received pong from server');
        resolve();
      }
    };
    ws.send(JSON.stringify({ action: 'ping' }));
    setTimeout(() => reject(new Error('Pong timeout')), 3000);
  });

  // 6. Test Agent Task Dispatch from Server -> Client -> Stream Back
  let streamReceived = false;
  let doneReceived = false;

  await new Promise((resolve, reject) => {
    const testSessionId = 'test_session_101';

    // Client listens for agent:chat and replies with agent:stream and agent:done
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.action === 'agent:chat') {
        console.log('🤖 Client received agent:chat:', msg.prompt);
        // Reply with stream
        ws.send(JSON.stringify({
          action: 'agent:stream',
          sessionId: msg.sessionId,
          delta: 'Hello from local agent!'
        }));
        // Reply with done
        setTimeout(() => {
          ws.send(JSON.stringify({
            action: 'agent:done',
            sessionId: msg.sessionId,
            status: 'success'
          }));
        }, 100);
      }
    };

    // Server subscribes to stream
    deviceService.subscribeAgentStream(testSessionId, (event) => {
      console.log('📡 Server received stream event:', event.action);
      if (event.action === 'agent:stream') {
        streamReceived = true;
      }
      if (event.action === 'agent:done') {
        doneReceived = true;
        deviceService.unsubscribeAgentStream(testSessionId);
        resolve();
      }
    });

    const dispatchResult = deviceService.dispatchAgentChat(pairedDeviceId, 'test_user', {
      sessionId: testSessionId,
      prompt: 'Echo test'
    });
    assert.strictEqual(dispatchResult.success, true, 'Dispatch should succeed');

    setTimeout(() => reject(new Error('Agent stream timeout')), 4000);
  });

  assert.ok(streamReceived, 'Stream should have been received');
  assert.ok(doneReceived, 'Done should have been received');
  console.log('✅ Agent task dispatch and stream back verified successfully!');

  // Cleanup
  ws.close();
  server.close();
  deviceService.removeDevice('test_user', pairedDeviceId);
  console.log('🎉 ALL DEVICE TESTS PASSED!');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
