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
function unregisterConnection(deviceId, io) {
  if (!activeConnections.has(deviceId)) return;
  const conn = activeConnections.get(deviceId);
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

module.exports = {
  createPairToken,
  verifyAndConsumePairToken,
  registerDevice,
  authenticateDevice,
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
  __getActiveConnections: () => activeConnections.entries()
};
