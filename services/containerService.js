const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  PROJECT_ROOT,
  PORT,
  DOCKER_SANDBOX_ENABLED,
  DOCKER_SANDBOX_IMAGE,
  DOCKER_SANDBOX_MEMORY,
  DOCKER_SANDBOX_CPUS,
  DOCKER_SANDBOX_PIDS_LIMIT,
  DOCKER_SANDBOX_IDLE_MINUTES
} = require('../config');
const { safeResolve } = require('./fileService');
const { getRunUser } = require('./tmuxService');
const deviceService = require('./deviceService');

// Track last activity timestamp per username (ms)
const lastActivityMap = new Map();
let idleReaperTimer = null;

/**
 * Sanitize username for Docker container naming (lowercase alphanumeric, hyphen, underscore)
 */
function sanitizeUsername(username) {
  if (!username || typeof username !== 'string') {
    throw new Error('Invalid username');
  }
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean) {
    throw new Error('Username contains no valid characters');
  }
  return clean;
}

function getContainerName(username) {
  return `ccnow-sandbox-${sanitizeUsername(username)}`;
}

/**
 * Execute docker CLI safely via execFile (no shell interpolation)
 */
function runDocker(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const isRoot = !process.getuid || process.getuid() === 0;
    const cmd = isRoot ? 'docker' : 'docker';
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // If non-root process hasn't picked up docker group yet, retry with sudo -n docker
        if (!isRoot && /permission denied/i.test(stderr || err.message)) {
          execFile('sudo', ['-n', 'docker', ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err2, stdout2, stderr2) => {
            if (err2) {
              const e = new Error((stderr2 || err2.message || '').trim());
              e.code = err2.code;
              return reject(e);
            }
            return resolve({ stdout: (stdout2 || '').trim(), stderr: (stderr2 || '').trim() });
          });
          return;
        }
        const e = new Error((stderr || err.message || '').trim());
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

/**
 * Check if Docker daemon is reachable and the sandbox image is present
 */
async function isDockerAvailable() {
  if (!DOCKER_SANDBOX_ENABLED) {
    return { available: false, imageReady: false, reason: 'DOCKER_SANDBOX_ENABLED is false' };
  }
  try {
    const info = await runDocker(['info', '--format', '{{.ServerVersion}}'], 5000);
    let imageReady = false;
    try {
      await runDocker(['image', 'inspect', DOCKER_SANDBOX_IMAGE], 5000);
      imageReady = true;
    } catch (_) {
      imageReady = false;
    }
    return {
      available: true,
      serverVersion: info.stdout,
      image: DOCKER_SANDBOX_IMAGE,
      imageReady
    };
  } catch (err) {
    return {
      available: false,
      imageReady: false,
      reason: err.message
    };
  }
}

/**
 * Resolve and prepare host directories for a user's Docker sandbox using safeResolve.
 * Stores sandbox home/credentials under data/sandboxes/<user> (on real host disk, never shadowed by tmpfs).
 */
function prepareUserSandboxDirs(username) {
  const safeUser = sanitizeUsername(username);
  const workspacesRoot = path.join(PROJECT_ROOT, 'workspaces');
  const sandboxesRoot = path.join(PROJECT_ROOT, 'data', 'sandboxes');

  if (!fs.existsSync(workspacesRoot)) fs.mkdirSync(workspacesRoot, { recursive: true });
  if (!fs.existsSync(sandboxesRoot)) fs.mkdirSync(sandboxesRoot, { recursive: true });

  const workspaceDir = safeResolve(workspacesRoot, safeUser);
  const sandboxDataDir = safeResolve(sandboxesRoot, safeUser);
  const sandboxHomeDir = safeResolve(sandboxDataDir, 'home');
  const credsFile = safeResolve(sandboxDataDir, 'sandbox_device.json');

  for (const dir of [workspaceDir, sandboxDataDir, sandboxHomeDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
  }

  // Ensure UID 1000 (host ubuntu / container node) owns the mounted directories
  const isRoot = !process.getuid || process.getuid() === 0;
  if (isRoot) {
    const runUser = getRunUser() || 'ubuntu';
    try {
      const uid = parseInt(require('child_process').execFileSync('id', ['-u', runUser], { encoding: 'utf8' }).trim(), 10);
      const gid = parseInt(require('child_process').execFileSync('id', ['-g', runUser], { encoding: 'utf8' }).trim(), 10);
      if (!Number.isNaN(uid) && !Number.isNaN(gid)) {
        fs.chownSync(workspaceDir, uid, gid);
        fs.chownSync(sandboxDataDir, uid, gid);
        fs.chownSync(sandboxHomeDir, uid, gid);
      }
    } catch (err) {
      console.warn(`[ContainerService] Could not chown sandbox dirs for ${safeUser}:`, err.message);
    }
  }

  return { safeUser, workspaceDir, sandboxDataDir, sandboxHomeDir, credsFile };
}

/**
 * Provision Claude Code & Codex CLI configs inside the sandbox home so both CLIs
 * route cleanly through the Control Plane LLM Proxy using the container's scoped virtual key
 * (never writing plaintext upstream API keys to disk).
 */
function syncSandboxAgentConfigs(sandboxHomeDir, serverUrl, virtualKey) {
  let defaultOpenAiModel = 'glm-5.3-flash';
  try {
    const gwConfig = require('./llmGatewayService').loadConfig();
    if (gwConfig && gwConfig.defaults && gwConfig.defaults.openaiModel) {
      defaultOpenAiModel = gwConfig.defaults.openaiModel;
    }
  } catch (_) {}

  // 1. Codex CLI: ~/.codex/config.toml (Codex ignores OPENAI_BASE_URL env, requires config.toml)
  try {
    const codexDir = safeResolve(sandboxHomeDir, '.codex');
    if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true, mode: 0o755 });
    const codexTomlPath = safeResolve(codexDir, 'config.toml');
    const tomlContent = `model_provider = "deck_gateway"
model = "${defaultOpenAiModel}"
check_for_update_on_startup = false

[model_providers.deck_gateway]
name = "deck_gateway"
base_url = "${serverUrl}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"

[projects."/workspace"]
trust_level = "trusted"

[projects."/home/node"]
trust_level = "trusted"
`;
    fs.writeFileSync(codexTomlPath, tomlContent, 'utf8');
  } catch (err) {
    console.warn(`[ContainerService] Failed to sync sandbox Codex config:`, err.message);
  }

  // 2. Claude Code: purge conflicting env overrides in ~/.claude/settings.json
  try {
    const claudeDir = safeResolve(sandboxHomeDir, '.claude');
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true, mode: 0o755 });
    const claudeSettingsPath = safeResolve(claudeDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) || {};
      } catch (_) {
        settings = {};
      }
    }
    if (settings.env && typeof settings.env === 'object') {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_MODEL;
      delete settings.env.ANTHROPIC_API_KEY;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }
    delete settings.model;
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[ContainerService] Failed to sync sandbox Claude config:`, err.message);
  }

  // 3. Claude Code: pre-approve /workspace, /home/node and scoped virtual key suffix in ~/.claude.json
  try {
    const claudeJsonPath = safeResolve(sandboxHomeDir, '.claude.json');
    let claudeJson = {};
    if (fs.existsSync(claudeJsonPath)) {
      try {
        claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) || {};
      } catch (_) {
        claudeJson = {};
      }
    }
    claudeJson.hasCompletedOnboarding = true;
    if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
      claudeJson.projects = {};
    }
    for (const trustDir of ['/workspace', '/home/node']) {
      if (!claudeJson.projects[trustDir] || typeof claudeJson.projects[trustDir] !== 'object') {
        claudeJson.projects[trustDir] = {};
      }
      claudeJson.projects[trustDir].hasTrustDialogAccepted = true;
      claudeJson.projects[trustDir].hasCompletedProjectOnboarding = true;
    }
    if (virtualKey && typeof virtualKey === 'string' && virtualKey.trim().length >= 3) {
      const suffix = virtualKey.trim().slice(-20);
      if (!claudeJson.customApiKeyResponses || typeof claudeJson.customApiKeyResponses !== 'object') {
        claudeJson.customApiKeyResponses = { approved: [], rejected: [] };
      }
      if (!Array.isArray(claudeJson.customApiKeyResponses.approved)) {
        claudeJson.customApiKeyResponses.approved = [];
      }
      if (!Array.isArray(claudeJson.customApiKeyResponses.rejected)) {
        claudeJson.customApiKeyResponses.rejected = [];
      }
      if (!claudeJson.customApiKeyResponses.approved.includes(suffix)) {
        claudeJson.customApiKeyResponses.approved.push(suffix);
      }
      claudeJson.customApiKeyResponses.rejected = claudeJson.customApiKeyResponses.rejected.filter(r => r !== suffix);
    }
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[ContainerService] Failed to sync sandbox ~/.claude.json:`, err.message);
  }

  // Ensure UID 1000 (host ubuntu / container node) owns .codex, .claude, and .claude.json
  const isRoot = !process.getuid || process.getuid() === 0;
  if (isRoot) {
    const runUser = getRunUser() || 'ubuntu';
    try {
      require('child_process').execFileSync('chown', ['-R', `${runUser}:${runUser}`, sandboxHomeDir]);
    } catch (_) {}
  }
}

/**
 * Inspect local Docker image ID; returns null if image is missing
 */
async function getImageId(imageName) {
  try {
    const { stdout } = await runDocker(['image', 'inspect', '--format', '{{.Id}}', imageName], 5000);
    return stdout || null;
  } catch (_) {
    return null;
  }
}

/**
 * Inspect a Docker container state; returns null if container does not exist
 */
async function inspectContainer(containerName) {
  try {
    const { stdout } = await runDocker(
      ['inspect', '--format', '{{.State.Status}}|{{.State.Running}}|{{.State.StartedAt}}|{{.Id}}|{{.Image}}', containerName],
      5000
    );
    const [status, running, startedAt, id, imageId] = stdout.split('|');
    return {
      exists: true,
      id: (id || '').slice(0, 12),
      imageId: imageId || null,
      status: status || 'unknown',
      running: running === 'true',
      startedAt: startedAt || null
    };
  } catch (err) {
    if (/no such object|not found/i.test(err.message)) {
      return null;
    }
    throw err;
  }
}

/**
 * Touch last activity timestamp for a user's sandbox
 */
function touchSandboxActivity(username) {
  if (!username) return;
  try {
    const safeUser = sanitizeUsername(username);
    lastActivityMap.set(safeUser, Date.now());
  } catch (_) {}
}

/**
 * Wait until a device comes online in deviceService (up to timeoutMs)
 */
async function waitForDeviceOnline(deviceId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (deviceService.isDeviceOnline(deviceId)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return deviceService.isDeviceOnline(deviceId);
}

/**
 * Idempotently create and/or start a user's isolated Docker sandbox container
 */
async function ensureUserSandbox(username, options = {}) {
  const dockerCheck = await isDockerAvailable();
  if (!dockerCheck.available) {
    throw new Error(`Docker is not available: ${dockerCheck.reason}`);
  }
  if (!dockerCheck.imageReady) {
    throw new Error(`Sandbox image "${DOCKER_SANDBOX_IMAGE}" not built yet`);
  }

  const { safeUser, workspaceDir, sandboxHomeDir, credsFile } = prepareUserSandboxDirs(username);
  const containerName = getContainerName(safeUser);
  const displayName = options.name || `云电脑 (${safeUser})`;

  // Ensure managed device record in deviceService
  const managed = deviceService.ensureManagedDevice(username, {
    deviceKind: 'docker-sandbox',
    containerName,
    name: displayName,
    hostname: `ccnow-${safeUser}`
  });

  let deviceSecret = managed.deviceSecret;
  if (!deviceSecret && fs.existsSync(credsFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (saved.deviceId === managed.deviceId && saved.deviceSecret) {
        deviceSecret = saved.deviceSecret;
      }
    } catch (_) {}
  }

  if (!deviceSecret) {
    // Secret missing on disk; rotate cleanly so container can authenticate
    deviceSecret = deviceService.rotateManagedDeviceSecret(managed.deviceId);
  }

  fs.writeFileSync(
    credsFile,
    JSON.stringify({ deviceId: managed.deviceId, deviceSecret, containerName }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );

  let existing = await inspectContainer(containerName);
  const latestImageId = await getImageId(DOCKER_SANDBOX_IMAGE);
  const imageOutdated = Boolean(existing && latestImageId && existing.imageId && existing.imageId !== latestImageId);
  const agentScriptHostPath = path.join(PROJECT_ROOT, 'client', 'ccnow-agent.js');
  const oarRuntimeHostPath = path.join(PROJECT_ROOT, 'client', 'oar-runtime.js');
  const controlPort = options.port || PORT || 80;
  const serverUrl = `http://host.docker.internal:${controlPort}`;
  const virtualKey = `sk-ccnow-${managed.deviceId}.${deviceSecret}`;

  // Sync Claude Code & Codex CLI gateway configs into sandbox home before start/run
  syncSandboxAgentConfigs(sandboxHomeDir, serverUrl, virtualKey);

  // Recreate container automatically if explicitly requested or if a stopped container is using an outdated image
  if (existing && (options.recreate === true || (!existing.running && imageOutdated))) {
    console.log(`[ContainerService] Recreating sandbox ${containerName} (recreate=${Boolean(options.recreate)}, imageOutdated=${imageOutdated})`);
    await runDocker(['rm', '-f', containerName], 15000);
    existing = null;
  }

  if (existing && existing.running) {
    touchSandboxActivity(safeUser);
    const isOnline = await waitForDeviceOnline(managed.deviceId, options.waitMs ?? 3000);
    return {
      success: true,
      action: 'already_running',
      containerName,
      containerId: existing.id,
      deviceId: managed.deviceId,
      isOnline,
      imageOutdated,
      status: existing.status,
      limits: {
        memory: DOCKER_SANDBOX_MEMORY,
        cpus: DOCKER_SANDBOX_CPUS,
        pidsLimit: DOCKER_SANDBOX_PIDS_LIMIT
      }
    };
  }

  if (existing && !existing.running) {
    await runDocker(['start', containerName], 15000);
    touchSandboxActivity(safeUser);
    const isOnline = await waitForDeviceOnline(managed.deviceId, options.waitMs ?? 8000);
    return {
      success: true,
      action: 'started',
      containerName,
      containerId: existing.id,
      deviceId: managed.deviceId,
      isOnline,
      imageOutdated: false,
      status: 'running',
      limits: {
        memory: DOCKER_SANDBOX_MEMORY,
        cpus: DOCKER_SANDBOX_CPUS,
        pidsLimit: DOCKER_SANDBOX_PIDS_LIMIT
      }
    };
  }

  // Read default gateway models so Claude Code & Codex inside the sandbox default to declared proxy models
  let defaultAnthropicModel = '';
  let defaultOpenaiModel = '';
  try {
    const llmGatewayService = require('./llmGatewayService');
    const gwConfig = llmGatewayService.loadConfig();
    if (gwConfig && gwConfig.enabled && gwConfig.defaults) {
      defaultAnthropicModel = String(gwConfig.defaults.anthropicModel || '').trim();
      defaultOpenaiModel = String(gwConfig.defaults.openaiModel || '').trim();
    }
  } catch (_) {}

  // Create fresh hardened container
  const runArgs = [
    'run', '-d',
    '--name', containerName,
    '--hostname', `ccnow-${safeUser}`,
    '--restart', 'unless-stopped',
    '--label', 'ccnow.managed=true',
    '--label', `ccnow.user=${safeUser}`,
    '--label', `ccnow.deviceId=${managed.deviceId}`,
    '--memory', String(DOCKER_SANDBOX_MEMORY),
    '--cpus', String(DOCKER_SANDBOX_CPUS),
    '--pids-limit', String(DOCKER_SANDBOX_PIDS_LIMIT),
    '--security-opt', 'no-new-privileges:true',
    '--cap-drop', 'ALL',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${workspaceDir}:/workspace`,
    '-v', `${sandboxHomeDir}:/home/node`,
    '-v', `${agentScriptHostPath}:/opt/ccnow/ccnow-agent.js:ro`,
    '-v', `${oarRuntimeHostPath}:/opt/ccnow/oar-runtime.js:ro`,
    '-e', `CCNOW_SERVER_URL=${serverUrl}`,
    '-e', `CCNOW_DEVICE_ID=${managed.deviceId}`,
    '-e', `CCNOW_DEVICE_SECRET=${deviceSecret}`,
    '-e', `CCNOW_DEVICE_NAME=${displayName}`,
    '-e', 'CCNOW_DEFAULT_WORKSPACE=/workspace',
    '-e', 'CCNOW_DEFAULT_WORKSPACE_NAME=workspace',
    '-e', `ANTHROPIC_BASE_URL=${serverUrl}`,
    '-e', `ANTHROPIC_API_KEY=${virtualKey}`,
    '-e', `OPENAI_BASE_URL=${serverUrl}/v1`,
    '-e', `OPENAI_API_BASE=${serverUrl}/v1`,
    '-e', `OPENAI_API_KEY=${virtualKey}`,
    '-e', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1',
    '-e', 'COLORTERM=truecolor'
  ];

  if (defaultAnthropicModel) {
    runArgs.push(
      '-e', `CCNOW_DEFAULT_ANTHROPIC_MODEL=${defaultAnthropicModel}`,
      '-e', `ANTHROPIC_MODEL=${defaultAnthropicModel}`,
      '-e', `ANTHROPIC_SMALL_FAST_MODEL=${defaultAnthropicModel}`,
      '-e', `ANTHROPIC_DEFAULT_SONNET_MODEL=${defaultAnthropicModel}`,
      '-e', `ANTHROPIC_DEFAULT_OPUS_MODEL=${defaultAnthropicModel}`,
      '-e', `ANTHROPIC_DEFAULT_HAIKU_MODEL=${defaultAnthropicModel}`
    );
  }
  if (defaultOpenaiModel) {
    runArgs.push(
      '-e', `CCNOW_DEFAULT_OPENAI_MODEL=${defaultOpenaiModel}`,
      '-e', `OPENAI_MODEL=${defaultOpenaiModel}`,
      '-e', `CODEX_MODEL=${defaultOpenaiModel}`
    );
  }
  runArgs.push(DOCKER_SANDBOX_IMAGE);

  const { stdout: containerId } = await runDocker(runArgs, 30000);
  touchSandboxActivity(safeUser);
  const isOnline = await waitForDeviceOnline(managed.deviceId, options.waitMs ?? 10000);

  console.log(`[ContainerService] Created & started sandbox ${containerName} (${containerId.slice(0, 12)}) for ${safeUser}, online=${isOnline}`);

  return {
    success: true,
    action: 'created',
    containerName,
    containerId: containerId.slice(0, 12),
    deviceId: managed.deviceId,
    isOnline,
    imageOutdated: false,
    status: 'running',
    limits: {
      memory: DOCKER_SANDBOX_MEMORY,
      cpus: DOCKER_SANDBOX_CPUS,
      pidsLimit: DOCKER_SANDBOX_PIDS_LIMIT
    }
  };
}

/**
 * Gracefully stop a user's Docker sandbox container to free host RAM (preserves volumes)
 */
async function stopUserSandbox(username) {
  const safeUser = sanitizeUsername(username);
  const containerName = getContainerName(safeUser);
  const existing = await inspectContainer(containerName);
  if (!existing) {
    return { success: true, action: 'not_found', containerName, status: 'absent' };
  }
  if (!existing.running) {
    return { success: true, action: 'already_stopped', containerName, status: existing.status };
  }
  await runDocker(['stop', '-t', '5', containerName], 15000);
  console.log(`[ContainerService] Stopped sandbox ${containerName} for ${safeUser}`);
  return { success: true, action: 'stopped', containerName, status: 'exited' };
}

/**
 * Remove a user's Docker sandbox container (volumes on host remain intact)
 */
async function removeUserSandbox(username) {
  const safeUser = sanitizeUsername(username);
  const containerName = getContainerName(safeUser);
  const existing = await inspectContainer(containerName);
  if (!existing) {
    return { success: true, action: 'not_found', containerName };
  }
  await runDocker(['rm', '-f', containerName], 15000);
  lastActivityMap.delete(safeUser);
  console.log(`[ContainerService] Removed sandbox container ${containerName} for ${safeUser}`);
  return { success: true, action: 'removed', containerName };
}

/**
 * Get current sandbox status for a user
 */
async function getSandboxStatus(username) {
  const safeUser = sanitizeUsername(username);
  const containerName = getContainerName(safeUser);
  const docker = await isDockerAvailable();

  const devices = deviceService.getUserDevices(username);
  const sandboxDev = devices.find(d => d.deviceKind === 'docker-sandbox' && d.containerName === containerName) || null;
  const container = docker.available ? await inspectContainer(containerName) : null;
  const latestImageId = (docker.available && docker.imageReady) ? await getImageId(DOCKER_SANDBOX_IMAGE) : null;
  const imageOutdated = Boolean(container && latestImageId && container.imageId && container.imageId !== latestImageId);
  const lastActivity = lastActivityMap.get(safeUser) || null;

  return {
    dockerAvailable: docker.available,
    imageReady: docker.imageReady,
    image: DOCKER_SANDBOX_IMAGE,
    imageOutdated,
    containerName,
    exists: Boolean(container),
    running: Boolean(container && container.running),
    status: container ? container.status : 'absent',
    startedAt: container ? container.startedAt : null,
    deviceId: sandboxDev ? sandboxDev.deviceId : null,
    isOnline: sandboxDev ? sandboxDev.isOnline : false,
    lastActivityAt: lastActivity,
    idleTimeoutMinutes: DOCKER_SANDBOX_IDLE_MINUTES,
    limits: {
      memory: DOCKER_SANDBOX_MEMORY,
      cpus: DOCKER_SANDBOX_CPUS,
      pidsLimit: DOCKER_SANDBOX_PIDS_LIMIT
    }
  };
}

/**
 * List all managed ccnow sandbox containers (for admin monitoring)
 */
async function listSandboxes() {
  const docker = await isDockerAvailable();
  if (!docker.available) {
    return { dockerAvailable: false, reason: docker.reason, sandboxes: [] };
  }
  const { stdout } = await runDocker(
    [
      'ps', '-a',
      '--filter', 'label=ccnow.managed=true',
      '--format', '{{.Names}}|{{.State}}|{{.Status}}|{{.Label "ccnow.user"}}|{{.Label "ccnow.deviceId"}}'
    ],
    10000
  );
  if (!stdout) {
    return { dockerAvailable: true, imageReady: docker.imageReady, sandboxes: [] };
  }
  const sandboxes = stdout.split('\n').filter(Boolean).map(line => {
    const [containerName, state, statusText, user, deviceId] = line.split('|');
    return {
      containerName,
      state,
      statusText,
      user,
      deviceId,
      isOnline: deviceId ? deviceService.isDeviceOnline(deviceId) : false,
      lastActivityAt: user ? (lastActivityMap.get(user) || null) : null
    };
  });
  return { dockerAvailable: true, imageReady: docker.imageReady, sandboxes };
}

/**
 * Start background idle reaper to auto-stop inactive user sandboxes and conserve host RAM
 */
function startIdleReaper() {
  if (idleReaperTimer || !DOCKER_SANDBOX_ENABLED || DOCKER_SANDBOX_IDLE_MINUTES <= 0) {
    return;
  }
  const checkIntervalMs = 2 * 60 * 1000; // Every 2 minutes
  const idleLimitMs = DOCKER_SANDBOX_IDLE_MINUTES * 60 * 1000;

  idleReaperTimer = setInterval(async () => {
    try {
      const { dockerAvailable, sandboxes } = await listSandboxes();
      if (!dockerAvailable || !sandboxes.length) return;

      const now = Date.now();
      for (const sb of sandboxes) {
        if (sb.state !== 'running' || !sb.user) continue;
        if (sb.deviceId && deviceService.hasActiveDeviceStreams(sb.deviceId)) {
          touchSandboxActivity(sb.user);
          continue;
        }
        const lastActive = lastActivityMap.get(sb.user);
        if (!lastActive) {
          // Initialize activity timestamp on first observation after server boot
          lastActivityMap.set(sb.user, now);
          continue;
        }
        if (now - lastActive > idleLimitMs) {
          console.log(`[ContainerService] Idle reaper stopping inactive sandbox ${sb.containerName} (idle > ${DOCKER_SANDBOX_IDLE_MINUTES}m)`);
          await stopUserSandbox(sb.user).catch(err =>
            console.warn(`[ContainerService] Failed to stop idle sandbox ${sb.containerName}:`, err.message)
          );
        }
      }
    } catch (err) {
      console.warn('[ContainerService] Idle reaper tick error:', err.message);
    }
  }, checkIntervalMs);

  console.log(`🐳 [ContainerService] Idle reaper active (auto-sleep after ${DOCKER_SANDBOX_IDLE_MINUTES}m idle)`);
}

module.exports = {
  isDockerAvailable,
  ensureUserSandbox,
  stopUserSandbox,
  removeUserSandbox,
  getSandboxStatus,
  listSandboxes,
  touchSandboxActivity,
  startIdleReaper,
  getContainerName
};
