const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { PROJECT_ROOT, JWT_SECRET, MULTI_USER_ENABLED } = require('../config');
const imBot = require('../im-bot');

const VAPID_FILE = path.join(PROJECT_ROOT, 'vapid.json');
let vapidKeys = null;

if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    console.log('🔑 Loaded existing VAPID keys.');
  } catch (err) {
    console.error('❌ Error reading VAPID file, generating new keys...', err);
  }
}

if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
  console.log('🔑 Generated and saved new VAPID keys.');
}

webpush.setVapidDetails(
  `https://${process.env.DOMAIN_NAME || 'outshine.cloud'}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const SUBSCRIPTIONS_FILE = path.join(PROJECT_ROOT, 'push_subscriptions.json');
let subscriptions = [];

if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
  try {
    subscriptions = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    console.log(`📱 Loaded ${subscriptions.length} push subscriptions.`);
  } catch (err) {
    console.error('❌ Error reading subscriptions file:', err);
    subscriptions = [];
  }
}

const saveSubscriptions = () => {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Error saving subscriptions:', err);
  }
};

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

  // Notify IM Bot (Telegram, etc.)
  imBot.notify(payload).catch(err => console.error('[IM Bot] Notification error:', err));

  // Determine target user in multi-user mode
  let userToMatch = targetUsername;
  if (MULTI_USER_ENABLED && payload.session && payload.session.startsWith('u_')) {
    const parts = payload.session.split('_');
    if (parts.length >= 3) {
      userToMatch = parts[1];
    }
  }

  let targetSubs = subscriptions;
  if (MULTI_USER_ENABLED) {
    const matchUser = userToMatch || 'admin';
    targetSubs = subscriptions.filter(sub => (sub.webUsername || 'admin') === matchUser);
  }

  const payloadString = JSON.stringify(payload);
  console.log(`📡 Sending push to ${targetSubs.length} devices (target: ${userToMatch || 'all'})...`);
  
  const promises = targetSubs.map((sub) => {
    return webpush.sendNotification(sub, payloadString)
      .catch((err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`📱 Subscription expired/gone (Status ${err.statusCode}). Removing subscription.`);
          subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
          saveSubscriptions();
        } else {
          console.error(`❌ Push notification failed for endpoint ${sub.endpoint}: ${err.message} (Status: ${err.statusCode || 'N/A'}, Body: ${err.body || 'N/A'})`);
        }
      });
  });
  
  return Promise.all(promises);
};

const getPublicKey = () => vapidKeys.publicKey;

const registerSubscription = (subscription, username) => {
  const exists = subscriptions.some(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    const subWithUser = {
      ...subscription,
      webUsername: username || 'admin'
    };
    subscriptions.push(subWithUser);
    saveSubscriptions();
    console.log(`📱 New subscription added for ${username || 'admin'}. Total: ${subscriptions.length}`);
  }
};

const unregisterSubscription = (subscription, username) => {
  const matchUser = username || 'admin';
  subscriptions = subscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
  saveSubscriptions();
  console.log(`📱 Subscription removed for ${matchUser}. Total: ${subscriptions.length}`);
};

module.exports = {
  sendPushToAll,
  getPublicKey,
  registerSubscription,
  unregisterSubscription
};
