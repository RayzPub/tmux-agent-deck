const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CLIENT_VERSION, CONFIG_DIR } = require('./config');

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL: ' + targetUrl));
    }
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');
    const agent = isHttps ? new lib.Agent({ rejectUnauthorized: false }) : undefined;

    const req = lib.get(targetUrl, {
      timeout: 15000,
      agent,
      headers: { 'User-Agent': `ccnow-agent/${CLIENT_VERSION}` }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return fetchUrl(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Server returned HTTP ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => resolve(rawData));
    });

    req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

async function downloadAndApplyUpdate(serverUrl) {
  const cleanServer = serverUrl.trim().replace(/\/+$/, '');
  const agentUrl = `${cleanServer}/agent.js`;
  const code = await fetchUrl(agentUrl);

  if (!code.includes('ccnow-agent') || (!code.startsWith('#!') && !code.includes('CLIENT_VERSION'))) {
    throw new Error('Downloaded file does not appear to be a valid ccnow-agent script.');
  }

  const match = code.match(/CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/);
  const newVersion = match ? match[1] : 'unknown';

  let targetPath = process.argv[1];
  if (!targetPath || targetPath === '-' || targetPath.includes('[eval]') || !fs.existsSync(targetPath)) {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    targetPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  }

  const tmpPath = targetPath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, code, { mode: 0o755 });
  fs.renameSync(tmpPath, targetPath);

  return { path: targetPath, version: newVersion };
}

function restartSelf() {
  let targetPath = process.argv[1];
  if (!targetPath || targetPath === '-' || targetPath.includes('[eval]') || !fs.existsSync(targetPath)) {
    targetPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  }

  const child = spawn(process.execPath, [targetPath, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'inherit'
  });
  child.unref();
  process.exit(0);
}

function ensureLocalAgentScript(serverUrl) {
  const scriptPath = path.join(CONFIG_DIR, 'ccnow-agent.js');
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript) && path.resolve(currentScript) !== path.resolve(scriptPath)) {
      fs.copyFileSync(currentScript, scriptPath);
      fs.chmodSync(scriptPath, 0o755);
      console.log(`💾 Agent script saved to ${scriptPath}`);
      return;
    }
    if (!fs.existsSync(scriptPath) && typeof fetch === 'function') {
      const cleanServer = serverUrl.replace(/\/+$/, '');
      fetch(`${cleanServer}/agent.js`).then(r => r.ok ? r.text() : null).then(code => {
        if (code && code.includes('ccnow-agent')) {
          fs.writeFileSync(scriptPath, code, 'utf8');
          fs.chmodSync(scriptPath, 0o755);
          console.log(`💾 Agent script downloaded to ${scriptPath} (ready for \`service install\`)`);
        }
      }).catch(() => {});
    }
  } catch (e) {}
}

async function handleSystemUpdate(send, defaultServerUrl, reqId, msg) {
  const serverUrl = msg.serverUrl || defaultServerUrl;
  console.log(`🔄 Remote system update requested from ${serverUrl}...`);

  try {
    const updateResult = await downloadAndApplyUpdate(serverUrl);
    send({
      reqId,
      action: 'system:update_success',
      oldVersion: CLIENT_VERSION,
      newVersion: updateResult.version,
      targetPath: updateResult.path,
      message: 'Agent script updated successfully. Initiating auto-restart...'
    });

    console.log(`✨ Agent updated to ${updateResult.version}. Restarting daemon in 1s...`);
    setTimeout(() => restartSelf(), 1000);
  } catch (err) {
    console.error('❌ Remote system update failed:', err.message);
    send({ reqId, action: 'system:update_error', error: err.message });
  }
}

module.exports = {
  fetchUrl,
  downloadAndApplyUpdate,
  restartSelf,
  ensureLocalAgentScript,
  handleSystemUpdate
};
