const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { PROJECT_ROOT, MULTI_USER_ENABLED, IM_BOT_ENABLED } = require('../config');
const { getDb, atomicWriteJSON } = require('./sqliteService');
const imBot = require('../im-bot');

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const LEGACY_VAPID_FILE = path.join(PROJECT_ROOT, 'vapid.json');
let vapidKeys = null;

if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    console.log('🔑 Loaded existing VAPID keys.');
  } catch (err) {
    console.error('❌ Error reading data/vapid.json, checking fallback...', err);
  }
}

if (!vapidKeys && fs.existsSync(LEGACY_VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(LEGACY_VAPID_FILE, 'utf8'));
    atomicWriteJSON(VAPID_FILE, vapidKeys, { mode: 0o600 });
    console.log('🔑 Loaded VAPID keys from legacy root vapid.json and synced to data/vapid.json.');
  } catch (err) {
    console.error('❌ Error reading legacy vapid.json, generating new keys...', err);
  }
}

if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  atomicWriteJSON(VAPID_FILE, vapidKeys, { mode: 0o600 });
  console.log('🔑 Generated and saved new VAPID keys to data/vapid.json.');
}

webpush.setVapidDetails(
  `https://${process.env.DOMAIN_NAME || 'outshine.cloud'}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

function getSubscriptions(targetUsername = null) {
  try {
    const db = getDb();
    let rows;
    if (targetUsername) {
      rows = db.prepare('SELECT subscription_json, web_username FROM push_subscriptions WHERE web_username = ?').all(targetUsername);
    } else {
      rows = db.prepare('SELECT subscription_json, web_username FROM push_subscriptions').all();
    }
    return rows.map(r => {
      try {
        const sub = JSON.parse(r.subscription_json);
        return { ...sub, webUsername: r.web_username || sub.webUsername || 'admin' };
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.error('❌ Error reading push subscriptions from SQLite:', err);
    return [];
  }
}

function removeSubscriptionByEndpoint(endpoint) {
  try {
    const db = getDb();
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  } catch (err) {
    console.error('❌ Error removing push subscription from SQLite:', err);
  }
}

const isSessionBeingViewed = (io, sessionName) => {
  try {
    if (!io) return false;
    const sockets = io.sockets.sockets;
    for (const [id, socket] of sockets) {
      if (socket.sessionName === sessionName && socket.isFocused && socket.activeSession === sessionName) {
        return true;
      }
    }
  } catch (err) {
    console.error('Error checking active sockets:', err);
  }
  return false;
};

const lastPushTimeMap = new Map();
const PUSH_THROTTLE_MS = process.env.PUSH_THROTTLE_MS !== undefined ? parseInt(process.env.PUSH_THROTTLE_MS, 10) : 30000;

const sendPushToAll = (io, payload, targetUsername = null) => {
  if (payload.session) {
    if (isSessionBeingViewed(io, payload.session)) {
      console.log(`📡 [Push Bypassed] Session ${payload.session} is currently focused and viewed in active tab.`);
      return Promise.resolve();
    }

    const now = Date.now();
    const lastTime = lastPushTimeMap.get(payload.session) || 0;
    if (now - lastTime < PUSH_THROTTLE_MS) {
      console.log(`📡 [Push Throttled] Session ${payload.session} sent a push too recently. Throttled. (Time since last push: ${Math.round((now - lastTime) / 1000)}s)`);
      return Promise.resolve();
    }
    lastPushTimeMap.set(payload.session, now);
  }

  // Notify IM Bot (Telegram, WeChat, etc.) only when enabled
  if (IM_BOT_ENABLED) {
    imBot.notify(payload).catch(err => console.error('[IM Bot] Notification error:', err));
  }

  // Determine target user in multi-user mode
  let userToMatch = targetUsername;
  if (MULTI_USER_ENABLED && payload.session && payload.session.startsWith('u_')) {
    const parts = payload.session.split('_');
    if (parts.length >= 3) {
      userToMatch = parts[1];
    }
  }

  const targetSubs = MULTI_USER_ENABLED
    ? getSubscriptions(userToMatch || 'admin')
    : getSubscriptions();

  const payloadString = JSON.stringify(payload);
  console.log(`📡 Sending push to ${targetSubs.length} devices (target: ${userToMatch || 'all'})...`);

  const promises = targetSubs.map((sub) => {
    return webpush.sendNotification(sub, payloadString)
      .catch((err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`📱 Subscription expired/gone (Status ${err.statusCode}). Removing subscription.`);
          removeSubscriptionByEndpoint(sub.endpoint);
        } else {
          console.error(`❌ Push notification failed for endpoint ${sub.endpoint}: ${err.message} (Status: ${err.statusCode || 'N/A'}, Body: ${err.body || 'N/A'})`);
        }
      });
  });

  return Promise.all(promises);
};

const getPublicKey = () => vapidKeys.publicKey;

const registerSubscription = (subscription, username) => {
  if (!subscription || !subscription.endpoint) return;
  try {
    const db = getDb();
    const webUsername = username || 'admin';
    const subWithUser = { ...subscription, webUsername };
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, web_username, subscription_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        web_username = excluded.web_username,
        subscription_json = excluded.subscription_json
    `).run(subscription.endpoint, webUsername, JSON.stringify(subWithUser), new Date().toISOString());
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions').get().cnt;
    console.log(`📱 Subscription saved for ${webUsername}. Total: ${count}`);
  } catch (err) {
    console.error('❌ Error saving push subscription to SQLite:', err);
  }
};

const unregisterSubscription = (subscription, username) => {
  if (!subscription || !subscription.endpoint) return;
  const matchUser = username || 'admin';
  removeSubscriptionByEndpoint(subscription.endpoint);
  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions').get().cnt;
    console.log(`📱 Subscription removed for ${matchUser}. Total: ${count}`);
  } catch (_) {}
};

module.exports = {
  sendPushToAll,
  getPublicKey,
  registerSubscription,
  unregisterSubscription
};
