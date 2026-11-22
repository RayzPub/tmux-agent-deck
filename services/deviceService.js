const crypto = require('crypto');
const { getDb } = require('./sqliteService');

// In-memory pair tokens: token -> { username, createdAt, expireAt }
const pairTokens = new Map();

// In-memory active connections: deviceId -> { ws, userId, deviceId, meta, lastPing }
const activeConnections = new Map();

// Event listeners for agent responses: sessionId -> callback(msg)
const agentStreamListeners = new Map();

// Active remote terminals relay: termKey -> { deviceId, socket, termId }
const activeTerminals = new Map();

// Pending general RPC requests: reqId -> { resolve, timer }
const pendingRpcRequests = new Map();

function rowToDevice(row) {
  if (!row) return null;
  let agentTypes = [];
  try {
    agentTypes = JSON.parse(row.agent_types_json || '[]');
  } catch (_) {
    agentTypes = [];
  }
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    clientVersion: row.client_version || '1.0.0',
    agentTypes: Array.isArray(agentTypes) ? agentTypes : [],
    deviceKind: row.device_kind || 'external',
    containerName: row.container_name || null,
    secretHash: row.secret_hash,
    createdAt: Number(row.created_at),
    lastSeen: Number(row.last_seen)
  };
}

/**
 * Read all registered devices from SQLite
 */
function readDevices() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM devices ORDER BY created_at ASC').all();
    return rows.map(rowToDevice);
  } catch (err) {
    console.error('[DeviceService] Error reading devices from SQLite:', err);
    return [];
  }
}

/**
 * Insert a new device row into SQLite
 */
function insertDeviceRow(d) {
  const db = getDb();
  db.prepare(`
    INSERT INTO devices (
      device_id, user_id, name, hostname, platform, arch, client_version,
      agent_types_json, device_kind, container_name, secret_hash, created_at, last_seen
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.deviceId,
    d.userId,
    d.name,
    d.hostname,
    d.platform,
    d.arch,
    d.clientVersion || '1.0.0',
    JSON.stringify(Array.isArray(d.agentTypes) ? d.agentTypes : []),
    d.deviceKind || 'external',
    d.containerName || null,
    d.secretHash,
    Number(d.createdAt || Date.now()),
    Number(d.lastSeen || Date.now())
  );
}

/**
 * Hash a device secret using SHA256
 */
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/**
 * Generate a secure random token / secret
 */
function generateRandomHex(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Create a temporary one-time pairing token for a user
 * Valid for 10 minutes by default
 */
function createPairToken(username, ttlMs = 10 * 60 * 1000) {
  // Clean up expired tokens periodically
  const now = Date.now();
  for (const [t, data] of pairTokens.entries()) {
    if (data.expireAt <= now) {
      pairTokens.delete(t);
    }
  }

  const token = 'pt_' + generateRandomHex(16);
  pairTokens.set(token, {
    username,
    createdAt: now,
    expireAt: now + ttlMs
  });
  return {
    token,
    expireAt: now + ttlMs,
    ttlSeconds: Math.floor(ttlMs / 1000)
  };
}

/**
 * Verify and immediately consume a one-time pair token
 */
function verifyAndConsumePairToken(token) {
  if (!token || !pairTokens.has(token)) {
    return null;
  }
  const data = pairTokens.get(token);
  pairTokens.delete(token); // One-time use

  if (Date.now() > data.expireAt) {
    return null;
  }
  return data.username;
}

/**
 * Register a newly paired device
 */
function registerDevice(username, deviceInfo = {}) {
  const deviceId = 'dev_' + generateRandomHex(8);
  const deviceSecret = generateRandomHex(24);
  const secretHash = hashSecret(deviceSecret);

  const newDevice = {
    deviceId,
    userId: username,
    name: deviceInfo.name || deviceInfo.hostname || 'My Device',
    hostname: deviceInfo.hostname || 'unknown-host',
    platform: deviceInfo.platform || 'unknown',
    arch: deviceInfo.arch || 'unknown',
    clientVersion: deviceInfo.version || '1.0.0',
    agentTypes: deviceInfo.agentTypes || ['claude-code', 'custom-cli'],
    deviceKind: deviceInfo.deviceKind || 'external',
    containerName: deviceInfo.containerName || null,
    secretHash,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };

  insertDeviceRow(newDevice);

  return {
    deviceId,
    deviceSecret,
    device: newDevice
  };
}

/**
 * Authenticate an existing device using deviceId + deviceSecret
 */
function authenticateDevice(deviceId, deviceSecret) {
  if (!deviceId || !deviceSecret) return null;
  const record = getDeviceById(deviceId);
  if (!record) return null;

  const checkHash = hashSecret(deviceSecret);
  if (record.secretHash !== checkHash) {
    return null;
  }
  return record;
}

/**
 * Check if a device is currently online
 */
function isDeviceOnline(deviceId) {
  return activeConnections.has(deviceId);
}

/**
 * Get device record by deviceId
 */
function getDeviceById(deviceId) {
  if (!deviceId) return null;
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    return rowToDevice(row);
  } catch (err) {
    console.error('[DeviceService] Error reading device by id:', err);
    return null;
  }
}

/**
 * Get all devices belonging to a user, augmented with online status
 */
function getUserDevices(username) {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(username);
    return rows.map(row => {
      const d = rowToDevice(row);
      return {
        deviceId: d.deviceId,
        userId: d.userId,
        name: d.name,
        hostname: d.hostname,
        platform: d.platform,
        arch: d.arch,
        clientVersion: d.clientVersion || '1.0.0',
        agentTypes: d.agentTypes,
        deviceKind: d.deviceKind || 'external',
        containerName: d.containerName || null,
        createdAt: d.createdAt,
        lastSeen: d.lastSeen,
        isOnline: activeConnections.has(d.deviceId)
      };
    });
  } catch (err) {
    console.error('[DeviceService] Error reading user devices:', err);
    return [];
  }
}

/**
 * Idempotently ensure a managed device exists for a user (e.g. host-admin or docker-sandbox).
 * If created, returns the newly generated plaintext deviceSecret; otherwise deviceSecret is null.
 */
function ensureManagedDevice(username, opts = {}) {
  const db = getDb();
  const deviceKind = opts.deviceKind || 'docker-sandbox';
  let row;
  if (opts.containerName) {
    row = db.prepare(
      'SELECT * FROM devices WHERE user_id = ? AND device_kind = ? AND container_name = ? LIMIT 1'
    ).get(username, deviceKind, opts.containerName);
  } else {
    row = db.prepare(
      'SELECT * FROM devices WHERE user_id = ? AND device_kind = ? LIMIT 1'
    ).get(username, deviceKind);
  }

  if (row) {
    const existing = rowToDevice(row);
    let changed = false;
    if (opts.name && existing.name !== opts.name) {
      existing.name = opts.name;
      changed = true;
    }
    if (opts.containerName && existing.containerName !== opts.containerName) {
      existing.containerName = opts.containerName;
      changed = true;
    }
    if (changed) {
      db.prepare('UPDATE devices SET name = ?, container_name = ? WHERE device_id = ?')
        .run(existing.name, existing.containerName, existing.deviceId);
    }
    return {
      deviceId: existing.deviceId,
      deviceSecret: null,
      device: existing,
      created: false
    };
  }

  const deviceId = 'dev_' + generateRandomHex(8);
  const deviceSecret = generateRandomHex(24);
  const secretHash = hashSecret(deviceSecret);

  const newDevice = {
    deviceId,
    userId: username,
    name: opts.name || (deviceKind === 'host-admin' ? 'Cloud-Host (Admin)' : `Sandbox (${username})`),
    hostname: opts.hostname || (opts.containerName || 'ccnow-managed'),
    platform: opts.platform || 'linux',
    arch: opts.arch || process.arch,
    clientVersion: opts.version || '1.4.0',
    agentTypes: opts.agentTypes || ['claude-code', 'codex-cli', 'tmux', 'local-terminal'],
    deviceKind,
    containerName: opts.containerName || null,
    secretHash,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };

  insertDeviceRow(newDevice);

  return {
    deviceId,
    deviceSecret,
    device: newDevice,
    created: true
  };
}

/**
 * Rotate a managed device's secret and return the new plaintext secret.
 */
function rotateManagedDeviceSecret(deviceId) {
  const db = getDb();
  const existing = getDeviceById(deviceId);
  if (!existing) return null;

  const deviceSecret = generateRandomHex(24);
  const secretHash = hashSecret(deviceSecret);
  db.prepare('UPDATE devices SET secret_hash = ?, last_seen = ? WHERE device_id = ?')
    .run(secretHash, Date.now(), deviceId);
  return deviceSecret;
}

/**
 * Check if a device currently has active remote terminal streams attached.
 */
function hasActiveDeviceStreams(deviceId) {
  for (const term of activeTerminals.values()) {
    if (term.deviceId === deviceId) return true;
  }
  return false;
}

/**
 * Delete / Unbind a device
 */
function removeDevice(username, deviceId) {
  const db = getDb();
  const row = db.prepare('SELECT device_id FROM devices WHERE device_id = ? AND user_id = ?').get(deviceId, username);
  if (!row) return false;

  // If connected, close its WebSocket
  if (activeConnections.has(deviceId)) {
    const conn = activeConnections.get(deviceId);
    try {
      conn.ws.close(4001, 'Device unbound by user');
    } catch (e) {}
    activeConnections.delete(deviceId);
  }

  db.prepare('DELETE FROM devices WHERE device_id = ? AND user_id = ?').run(deviceId, username);
  return true;
}

/**
 * Register an active WebSocket connection for a device
 */
function registerConnection(deviceId, ws, deviceRecord, io) {
  // If an old connection exists, close it
  if (activeConnections.has(deviceId)) {
    const old = activeConnections.get(deviceId);
    try {
      old.ws.close(4000, 'Replaced by newer connection');
    } catch (e) {}
  }

  const connData = {
    ws,
    userId: deviceRecord.userId,
    deviceId,
    meta: deviceRecord,
    lastPing: Date.now()
  };

  activeConnections.set(deviceId, connData);

  // Update lastSeen in database
  updateDeviceLastSeen(deviceId);

  console.log(`[DeviceService] Device online: ${deviceId} (${deviceRecord.name}) for user ${deviceRecord.userId}`);

  // Broadcast device status update strictly to the owner's private room via Socket.io
  if (io && deviceRecord.userId) {
    const target = typeof io.to === 'function' ? io.to(`user:${deviceRecord.userId}`) : io;
    if (target && typeof target.emit === 'function') {
      target.emit('device:status_change', {
        deviceId,
        userId: deviceRecord.userId,
        isOnline: true,
        lastSeen: Date.now()
      });
    }
  }
}

/**
 * Unregister an active WebSocket connection
 */
function unregisterConnection(deviceId, wsOrIo, maybeIo) {
  if (!activeConnections.has(deviceId)) return;
  const conn = activeConnections.get(deviceId);

  let targetWs = null;
  let io = null;

  if (wsOrIo && typeof wsOrIo.send === 'function') {
    targetWs = wsOrIo;
    io = maybeIo;
  } else {
    io = wsOrIo;
  }

  // If a specific ws was passed, only unregister if it matches the current active socket!
  if (targetWs && conn.ws !== targetWs) {
    console.log(`[DeviceService] Ignoring close from stale connection for ${deviceId}`);
    return;
  }

  activeConnections.delete(deviceId);

  updateDeviceLastSeen(deviceId);

  console.log(`[DeviceService] Device offline: ${deviceId}`);

  // Broadcast device status update strictly to the owner's private room via Socket.io
  if (io && conn && conn.userId) {
    const target = typeof io.to === 'function' ? io.to(`user:${conn.userId}`) : io;
    if (target && typeof target.emit === 'function') {
      target.emit('device:status_change', {
        deviceId,
        userId: conn.userId,
        isOnline: false,
        lastSeen: Date.now()
      });
    }
  }
}

/**
 * Update device last seen timestamp in SQLite
 */
function updateDeviceLastSeen(deviceId) {
  try {
    const db = getDb();
    db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(Date.now(), deviceId);
  } catch (err) {
    console.error('[DeviceService] Error updating lastSeen:', err);
  }
}

/**
 * Record a ping from a device
 */
function recordDevicePing(deviceId) {
  const conn = activeConnections.get(deviceId);
  if (conn) {
    conn.lastPing = Date.now();
  }
}

/**
 * Send a message object to a connected device
 */
function sendToDevice(deviceId, messageObj) {
  const conn = activeConnections.get(deviceId);
  if (!conn || !conn.ws || conn.ws.readyState !== 1) { // 1 = OPEN
    return { success: false, error: 'Device is offline or connection not ready' };
  }

  try {
    conn.ws.send(JSON.stringify(messageObj));
    return { success: true };
  } catch (err) {
    console.error(`[DeviceService] Error sending to device ${deviceId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Dispatch Agent Chat command to a connected device
 */
function dispatchAgentChat(deviceId, userId, { sessionId, prompt, agentType, workDir }) {
  const device = getDeviceById(deviceId);
  if (!device || device.userId !== userId) {
    return { success: false, error: 'Device not found or unauthorized' };
  }

  return sendToDevice(deviceId, {
    action: 'agent:chat',
    sessionId,
    prompt,
    agentType: agentType || 'claude-code',
    workDir: workDir || ''
  });
}

/**
 * Dispatch Agent Interrupt command to a connected device
 */
function dispatchAgentInterrupt(deviceId, userId, { sessionId }) {
  const device = getDeviceById(deviceId);
  if (!device || device.userId !== userId) {
    return { success: false, error: 'Device not found or unauthorized' };
  }

  return sendToDevice(deviceId, {
    action: 'agent:interrupt',
    sessionId
  });
}

/**
 * Subscribe to agent stream/response events
 */
function subscribeAgentStream(sessionId, callback) {
  agentStreamListeners.set(sessionId, callback);
}

/**
 * Unsubscribe from agent stream/response events
 */
function unsubscribeAgentStream(sessionId) {
  agentStreamListeners.delete(sessionId);
}

/**
 * Broadcast an incoming agent message from client to subscribers
 */
function emitAgentEvent(sessionId, eventData) {
  const listener = agentStreamListeners.get(sessionId);
  if (listener) {
    try {
      listener(eventData);
    } catch (e) {
      console.error('[DeviceService] Error in agent stream listener:', e);
    }
  }
}

/**
 * Initialize a remote terminal session on an edge device
 */
function initRemoteTerminal(deviceId, socket, termId, sessionName, cols = 80, rows = 24) {
  const termKey = `${deviceId}:${termId}`;
  activeTerminals.set(termKey, { deviceId, socket, termId });

  return sendToDevice(deviceId, {
    action: 'term:open',
    termId,
    sessionName: sessionName || 'main',
    cols,
    rows
  });
}

/**
 * Send user terminal keystroke input to an edge device
 */
function sendRemoteTerminalInput(deviceId, termId, data) {
  return sendToDevice(deviceId, {
    action: 'term:input',
    termId,
    data
  });
}

/**
 * Send resize signal to an edge device terminal
 */
function sendRemoteTerminalResize(deviceId, termId, cols, rows) {
  return sendToDevice(deviceId, {
    action: 'term:resize',
    termId,
    cols,
    rows
  });
}

/**
 * Close a remote terminal session on an edge device
 */
function closeRemoteTerminal(deviceId, termId) {
  const termKey = `${deviceId}:${termId}`;
  activeTerminals.delete(termKey);

  return sendToDevice(deviceId, {
    action: 'term:close',
    termId
  });
}

/**
 * Handle incoming terminal output chunk from edge device and pipe to web socket
 */
function handleRemoteTerminalOutput(deviceId, termId, data) {
  const termKey = `${deviceId}:${termId}`;
  const term = activeTerminals.get(termKey);
  if (term && term.socket) {
    term.socket.emit('terminal-output', data);
  }
}

/**
 * Handle terminal exit event from edge device
 */
function handleRemoteTerminalExit(deviceId, termId) {
  const termKey = `${deviceId}:${termId}`;
  const term = activeTerminals.get(termKey);
  if (term && term.socket) {
    term.socket.emit('terminal-exit');
    activeTerminals.delete(termKey);
  }
}

/**
 * Send a generic RPC request to an edge device with timeout
 */
function sendDeviceRpc(deviceId, action, payload = {}, timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (!isDeviceOnline(deviceId)) {
      return resolve({ error: 'Device is offline' });
    }

    const reqId = 'rpc_' + generateRandomHex(8);
    const timer = setTimeout(() => {
      pendingRpcRequests.delete(reqId);
      resolve({ error: `Remote request (${action}) timed out` });
    }, timeoutMs);

    pendingRpcRequests.set(reqId, { resolve, timer });

    sendToDevice(deviceId, {
      action,
      reqId,
      ...payload
    });
  });
}

function resolveDeviceRpc(reqId, result) {
  const pending = pendingRpcRequests.get(reqId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRpcRequests.delete(reqId);
    pending.resolve(result);
  }
}

/**
 * Query active tmux / terminal sessions running on a remote edge device
 */
async function getRemoteSessions(deviceId) {
  const res = await sendDeviceRpc(deviceId, 'tmux:list_sessions', {}, 2500);
  if (res && Array.isArray(res.sessions)) {
    return res.sessions;
  }
  return [{ name: 'main', windows: 1, created: Date.now(), active: true, isRemote: true }];
}

function remoteTmuxNewSession(deviceId, opts) {
  return sendDeviceRpc(deviceId, 'tmux:new_session', opts);
}

function remoteTmuxKillSession(deviceId, sessionName) {
  return sendDeviceRpc(deviceId, 'tmux:kill_session', { sessionName });
}

function remoteFsList(deviceId, workspacePath, relativePath) {
  return sendDeviceRpc(deviceId, 'fs:list', { workspacePath, relativePath });
}

function remoteFsRead(deviceId, workspacePath, filePath) {
  return sendDeviceRpc(deviceId, 'fs:read', { workspacePath, filePath });
}

function remoteFsWrite(deviceId, workspacePath, filePath, content) {
  return sendDeviceRpc(deviceId, 'fs:write', { workspacePath, filePath, content });
}

function remoteFsWorkspaces(deviceId) {
  return sendDeviceRpc(deviceId, 'fs:workspaces', {});
}

function remoteFsAddWorkspace(deviceId, name, wsPath) {
  return sendDeviceRpc(deviceId, 'fs:add_workspace', { name, path: wsPath });
}

function remoteFsRemoveWorkspace(deviceId, name) {
  return sendDeviceRpc(deviceId, 'fs:remove_workspace', { name });
}

function remoteFsCreateFile(deviceId, workspacePath, filePath) {
  return sendDeviceRpc(deviceId, 'fs:create_file', { workspacePath, filePath });
}

function remoteFsCreateDir(deviceId, workspacePath, dirPath) {
  return sendDeviceRpc(deviceId, 'fs:create_dir', { workspacePath, dirPath });
}

function remoteFsDelete(deviceId, workspacePath, targetPath) {
  return sendDeviceRpc(deviceId, 'fs:delete', { workspacePath, targetPath });
}

function remoteFsRename(deviceId, workspacePath, oldPath, newPath) {
  return sendDeviceRpc(deviceId, 'fs:rename', { workspacePath, oldPath, newPath });
}

function remoteDirectories(deviceId, targetPath) {
  return sendDeviceRpc(deviceId, 'fs:directories', { targetPath });
}

function remoteUploadFile(deviceId, workspacePath, filename, bufferBase64) {
  return sendDeviceRpc(deviceId, 'fs:upload_file', { workspacePath, filename, bufferBase64 });
}

function remoteChatUpload(deviceId, sessionName, files) {
  return sendDeviceRpc(deviceId, 'agent:chat_upload', { sessionName, files }, 15000);
}

function remoteGitStatus(deviceId, workspacePath) {
  return sendDeviceRpc(deviceId, 'git:status', { workspacePath });
}

function remoteGitDiff(deviceId, workspacePath, filePath) {
  return sendDeviceRpc(deviceId, 'git:diff', { workspacePath, filePath });
}

function remoteGitStage(deviceId, workspacePath, files) {
  return sendDeviceRpc(deviceId, 'git:stage', { workspacePath, files });
}

function remoteGitUnstage(deviceId, workspacePath, files) {
  return sendDeviceRpc(deviceId, 'git:unstage', { workspacePath, files });
}

function remoteGitCommit(deviceId, workspacePath, message) {
  return sendDeviceRpc(deviceId, 'git:commit', { workspacePath, message });
}

function remoteGitBranches(deviceId, workspacePath) {
  return sendDeviceRpc(deviceId, 'git:branches', { workspacePath });
}

function remoteGitCheckout(deviceId, workspacePath, branch) {
  return sendDeviceRpc(deviceId, 'git:checkout', { workspacePath, branch });
}

function remoteChatHistory(deviceId, sessionName) {
  return sendDeviceRpc(deviceId, 'agent:chat_history', { sessionName });
}

function remoteOarRuntimes(deviceId) {
  return sendDeviceRpc(deviceId, 'oar:runtimes', {}, 15000);
}

function remoteOarMessage(deviceId, sessionName, payload = {}) {
  return sendDeviceRpc(deviceId, 'oar:message', { sessionName, ...payload }, 30000);
}

function remoteOarCompact(deviceId, sessionName) {
  return sendDeviceRpc(deviceId, 'oar:compact', { sessionName }, 65000);
}

function remoteOarAbort(deviceId, sessionName) {
  return sendDeviceRpc(deviceId, 'oar:abort', { sessionName }, 10000);
}

/**
 * Remote Trigger: System Update on Edge Device
 */
function remoteSystemUpdate(deviceId, serverUrl) {
  return sendDeviceRpc(deviceId, 'system:update', { serverUrl }, 30000);
}

/**
 * Update device metadata (version, agent types, etc.)
 */
function updateDeviceInfo(deviceId, info = {}) {
  const target = getDeviceById(deviceId);
  if (!target) return false;

  const nextVersion = info.version || target.clientVersion;
  const nextName = (info.name && !target.name) ? info.name : target.name;
  const nextHostname = info.hostname || target.hostname;
  const nextPlatform = info.platform || target.platform;
  const nextArch = info.arch || target.arch;
  const nextAgentTypes = Array.isArray(info.agentTypes) ? info.agentTypes : target.agentTypes;

  try {
    const db = getDb();
    db.prepare(`
      UPDATE devices
      SET client_version = ?, name = ?, hostname = ?, platform = ?, arch = ?, agent_types_json = ?, last_seen = ?
      WHERE device_id = ?
    `).run(
      nextVersion,
      nextName,
      nextHostname,
      nextPlatform,
      nextArch,
      JSON.stringify(nextAgentTypes),
      Date.now(),
      deviceId
    );
    return true;
  } catch (err) {
    console.error('[DeviceService] Error updating device info:', err);
    return false;
  }
}

module.exports = {
  createPairToken,
  verifyAndConsumePairToken,
  registerDevice,
  ensureManagedDevice,
  rotateManagedDeviceSecret,
  hasActiveDeviceStreams,
  authenticateDevice,
  updateDeviceInfo,
  isDeviceOnline,
  getDeviceById,
  getUserDevices,
  removeDevice,
  registerConnection,
  unregisterConnection,
  recordDevicePing,
  sendToDevice,
  dispatchAgentChat,
  dispatchAgentInterrupt,
  subscribeAgentStream,
  unsubscribeAgentStream,
  emitAgentEvent,
  initRemoteTerminal,
  sendRemoteTerminalInput,
  sendRemoteTerminalResize,
  closeRemoteTerminal,
  handleRemoteTerminalOutput,
  handleRemoteTerminalExit,
  getRemoteSessions,
  remoteTmuxNewSession,
  remoteTmuxKillSession,
  remoteFsList,
  remoteFsRead,
  remoteFsWrite,
  remoteFsWorkspaces,
  remoteFsAddWorkspace,
  remoteFsRemoveWorkspace,
  remoteFsCreateFile,
  remoteFsCreateDir,
  remoteFsDelete,
  remoteFsRename,
  remoteDirectories,
  remoteUploadFile,
  remoteChatUpload,
  remoteGitStatus,
  remoteGitDiff,
  remoteGitStage,
  remoteGitUnstage,
  remoteGitCommit,
  remoteGitBranches,
  remoteGitCheckout,
  remoteChatHistory,
  remoteOarRuntimes,
  remoteOarMessage,
  remoteOarCompact,
  remoteOarAbort,
  remoteSystemUpdate,
  sendDeviceRpc,
  resolveDeviceRpc,
  __getActiveConnections: () => activeConnections.entries()
};
