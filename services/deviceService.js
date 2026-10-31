const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('../config');

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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

/**
 * Read all registered devices from disk
 */
function readDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[DeviceService] Error reading devices file:', err);
  }
  return [];
}

/**
 * Write devices list to disk safely
 */
function writeDevices(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[DeviceService] Error writing devices file:', err);
    return false;
  }
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
  const devices = readDevices();
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
    secretHash,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };

  devices.push(newDevice);
  writeDevices(devices);

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
  const devices = readDevices();
  const record = devices.find(d => d.deviceId === deviceId);
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
  const devices = readDevices();
  return devices.find(d => d.deviceId === deviceId) || null;
}

/**
 * Get all devices belonging to a user, augmented with online status
 */
function getUserDevices(username) {
  const devices = readDevices();
  const userDevices = devices.filter(d => d.userId === username);

  return userDevices.map(d => ({
    deviceId: d.deviceId,
    userId: d.userId,
    name: d.name,
    hostname: d.hostname,
    platform: d.platform,
    arch: d.arch,
    clientVersion: d.clientVersion || '1.0.0',
    agentTypes: d.agentTypes,
    createdAt: d.createdAt,
    lastSeen: d.lastSeen,
    isOnline: activeConnections.has(d.deviceId)
  }));
}

/**
 * Delete / Unbind a device
 */
function removeDevice(username, deviceId) {
  const devices = readDevices();
  const target = devices.find(d => d.deviceId === deviceId && d.userId === username);
  if (!target) return false;

  // If connected, close its WebSocket
  if (activeConnections.has(deviceId)) {
    const conn = activeConnections.get(deviceId);
    try {
      conn.ws.close(4001, 'Device unbound by user');
    } catch (e) {}
    activeConnections.delete(deviceId);
  }

  const filtered = devices.filter(d => d.deviceId !== deviceId);
  writeDevices(filtered);
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

  // Broadcast device status update to web clients via Socket.io
  if (io) {
    io.emit('device:status_change', {
      deviceId,
      userId: deviceRecord.userId,
      isOnline: true,
      lastSeen: Date.now()
    });
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

  if (io && conn) {
    io.emit('device:status_change', {
      deviceId,
      userId: conn.userId,
      isOnline: false,
      lastSeen: Date.now()
    });
  }
}

/**
 * Update device last seen timestamp on disk
 */
function updateDeviceLastSeen(deviceId) {
  const devices = readDevices();
  const item = devices.find(d => d.deviceId === deviceId);
  if (item) {
    item.lastSeen = Date.now();
    writeDevices(devices);
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

function remoteDirectories(deviceId, targetPath) {
  return sendDeviceRpc(deviceId, 'fs:directories', { targetPath });
}

function remoteUploadFile(deviceId, workspacePath, filename, bufferBase64) {
  return sendDeviceRpc(deviceId, 'fs:upload_file', { workspacePath, filename, bufferBase64 });
}

function remoteGitStatus(deviceId, workspacePath) {
  return sendDeviceRpc(deviceId, 'git:status', { workspacePath });
}

function remoteGitDiff(deviceId, workspacePath, filePath) {
  return sendDeviceRpc(deviceId, 'git:diff', { workspacePath, filePath });
}

function remoteChatHistory(deviceId, sessionName) {
  return sendDeviceRpc(deviceId, 'agent:chat_history', { sessionName });
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
  const devices = readDevices();
  const target = devices.find(d => d.deviceId === deviceId);
  if (!target) return false;

  if (info.version) target.clientVersion = info.version;
  if (info.name && !target.name) target.name = info.name;
  if (info.hostname) target.hostname = info.hostname;
  if (info.platform) target.platform = info.platform;
  if (info.arch) target.arch = info.arch;
  if (Array.isArray(info.agentTypes)) target.agentTypes = info.agentTypes;
  target.lastSeen = Date.now();

  writeDevices(devices);
  return true;
}

module.exports = {
  createPairToken,
  verifyAndConsumePairToken,
  registerDevice,
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
  remoteDirectories,
  remoteUploadFile,
  remoteGitStatus,
  remoteGitDiff,
  remoteChatHistory,
  remoteSystemUpdate,
  sendDeviceRpc,
  resolveDeviceRpc,
  __getActiveConnections: () => activeConnections.entries()
};
