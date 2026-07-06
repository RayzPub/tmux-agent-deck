// Cyberpunk TMUX Agent Deck Service Worker
self.addEventListener('install', function(event) {
  // Force immediate activation
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function(event) {
  console.log('[Service Worker] Push Notification Received.');
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'TMUX Agent Alert', body: event.data.text() };
    }
  }

  const title = data.title || 'TMUX Agent Alert';
  const options = {
    body: data.body || 'Your attention is required in a session.',
    icon: '/images/icon-192.png',
    badge: '/images/icon-192.png', // A simple small version of the icon is used as badge
    vibrate: [200, 100, 200, 100, 200],
    data: {
      url: data.url || '/'
    },
    tag: 'agent-action-required', // Collapse matching notifications
    requireInteraction: true // Keep it on screen until user acts
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  console.log('[Service Worker] Notification Clicked.');
  event.notification.close();
  
  const targetUrl = event.notification.data.url || '/';
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // If a window client is already open, navigate it or focus it
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        const clientPath = new URL(client.url).pathname;
        const targetPath = new URL(targetUrl, client.url).pathname;
        if (clientPath === targetPath && 'focus' in client) {
          // Send active session name to page if applicable
          const targetParams = new URL(targetUrl, client.url).searchParams;
          const session = targetParams.get('session');
          if (session && client.postMessage) {
            client.postMessage({ action: 'attach-session', session: session });
          }
          return client.focus();
        }
      }
      // If not, open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
