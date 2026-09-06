const express = require('express');
const http = require('http');
const assert = require('assert');
const llmGatewayService = require('../services/llmGatewayService');
const llmGatewayRoutes = require('../routes/llmGateway');

async function runTests() {
  console.log('🧪 Starting LLM Gateway unit tests...');

  // 1. Start a mock upstream server (simulating Anthropic and OpenAI)
  const mockUpstreamApp = express();
  mockUpstreamApp.use(express.json());

  let lastReceivedHeaders = null;
  let lastReceivedBody = null;

  mockUpstreamApp.post('/v1/messages', (req, res) => {
    lastReceivedHeaders = req.headers;
    lastReceivedBody = req.body;
    // Simulate streaming SSE response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('anthropic-version', '2023-06-01');
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123"}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello world!"}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });

  mockUpstreamApp.post('/chat/completions', (req, res) => {
    lastReceivedHeaders = req.headers;
    lastReceivedBody = req.body;
    res.json({
      id: 'chatcmpl-123',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'Mock OpenAI response' } }]
    });
  });

  const mockServer = http.createServer(mockUpstreamApp);
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const mockPort = mockServer.address().port;
  console.log(`✅ Mock upstream server running on port ${mockPort}`);

  // 2. Configure gateway to point to mock upstream
  const config = JSON.parse(JSON.stringify(llmGatewayService.loadConfig()));
  const origConfig = JSON.parse(JSON.stringify(config));

  if (config.providers.tencent) {
    config.providers.tencent.endpoints = {
      anthropic: `http://127.0.0.1:${mockPort}`,
      openai: `http://127.0.0.1:${mockPort}`
    };
    config.providers.tencent.keys = ['sk-mock-tencent-key-1', 'sk-mock-tencent-key-2'];
  }
  if (config.providers.kimi) {
    config.providers.kimi.endpoints = {
      anthropic: `http://127.0.0.1:${mockPort}`,
      openai: `http://127.0.0.1:${mockPort}`
    };
    config.providers.kimi.keys = ['sk-mock-kimi-key'];
  }
  llmGatewayService.saveConfig(config);

  // 3. Spin up test gateway server
  const testApp = express();
  testApp.use(express.json({ limit: '50mb' }));
  testApp.use('/v1', llmGatewayRoutes);

  const testServer = http.createServer(testApp);
  await new Promise(r => testServer.listen(0, '127.0.0.1', r));
  const gatewayPort = testServer.address().port;
  console.log(`✅ Gateway server running on port ${gatewayPort}`);

  try {
    // Test 4: Anthropic Streaming + Prompt Cache Header & Body Preservation
    console.log('Testing Anthropic /v1/messages streaming & prompt caching...');
    const claudeRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'test caching' }]
      })
    });

    assert.strictEqual(claudeRes.status, 200, 'Claude endpoint should return 200');
    assert.strictEqual(claudeRes.headers.get('content-type'), 'text/event-stream');
    const streamBody = await claudeRes.text();
    assert(streamBody.includes('Hello world!'), 'Stream content should be received');

    // Verify upstream received injected real key and preserved prompt cache parameters
    assert.strictEqual(lastReceivedHeaders['x-api-key'], 'sk-mock-tencent-key-1');
    assert.strictEqual(lastReceivedHeaders['anthropic-beta'], 'prompt-caching-2024-07-31');
    assert.deepStrictEqual(lastReceivedBody.system[0].cache_control, { type: 'ephemeral' }, 'cache_control must be preserved');
    console.log('✅ Anthropic streaming & Prompt Cache verified!');

    // Test 5: Key Rotation on next request
    await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'test' }] })
    });
    assert.strictEqual(lastReceivedHeaders['x-api-key'], 'sk-mock-tencent-key-2', 'Key should rotate round-robin');
    console.log('✅ Key pool round-robin rotation verified!');

    // Test 6: OpenAI /v1/chat/completions
    console.log('Testing OpenAI /v1/chat/completions...');
    const openaiRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-deck-local'
      },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'test' }] })
    });
    assert.strictEqual(openaiRes.status, 200);
    const openaiJson = await openaiRes.json();
    assert.strictEqual(openaiJson.choices[0].message.content, 'Mock OpenAI response');
    assert.strictEqual(lastReceivedHeaders['authorization'], 'Bearer sk-mock-tencent-key-1');
    console.log('✅ OpenAI endpoint verified!');

    // Test 7: Kimi Model Routing
    console.log('Testing Kimi model routing (k3-256k)...');
    const kimiRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-deck-local'
      },
      body: JSON.stringify({ model: 'k3-256k', messages: [{ role: 'user', content: 'test kimi' }] })
    });
    assert.strictEqual(kimiRes.status, 200);
    assert.strictEqual(lastReceivedHeaders['x-api-key'], 'sk-mock-kimi-key', 'Should route to Kimi key for k3-256k');
    console.log('✅ Kimi model routing verified!');

    // Test 8: Strict enforcement - Undeclared model must NOT be routed automatically (returns 400)
    console.log('Testing undeclared model rejection...');
    const rejectRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-deck-local'
      },
      body: JSON.stringify({ model: 'undeclared-random-model', messages: [{ role: 'user', content: 'test' }] })
    });
    assert.strictEqual(rejectRes.status, 400, 'Undeclared model should be rejected with HTTP 400');
    const rejectJson = await rejectRes.json();
    assert.strictEqual(rejectJson.error.type, 'model_not_declared');
    assert(rejectJson.error.message.includes('not declared'));
    console.log('✅ Undeclared model rejection verified!');

    console.log('🎉 ALL 8 TESTS PASSED FLAWLESSLY!');
  } finally {
    // Restore config
    llmGatewayService.saveConfig(origConfig);

    mockServer.close();
    testServer.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
