import { state } from './state.js';

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function updatePushBtnUI() {
  const pushToggleBtn = document.getElementById('pushToggleBtn');
  if (!pushToggleBtn) return;
  const textSpan = pushToggleBtn.querySelector('span');
  const icon = pushToggleBtn.querySelector('i, svg');
  if (state.isSubscribed) {
    if (textSpan) textSpan.textContent = '消息推送: 开启';
    if (icon) {
      icon.setAttribute('data-lucide', 'bell');
    }
    pushToggleBtn.classList.add('active');
  } else {
    if (textSpan) textSpan.textContent = '消息推送: 关闭';
    if (icon) {
      icon.setAttribute('data-lucide', 'bell');
    }
    pushToggleBtn.classList.remove('active');
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

export async function registerSubscriptionOnServer(subscription) {
  try {
    await fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    });
  } catch (err) {
    console.error('Failed to register subscription on server:', err);
  }
}

export async function unregisterSubscriptionOnServer(subscription) {
  try {
    await fetch('/api/push/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    });
  } catch (err) {
    console.error('Failed to unregister subscription on server:', err);
  }
}

export async function initPushNotifications() {
  const pushToggleBtn = document.getElementById('pushToggleBtn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push messaging is not supported in this browser.');
    if (pushToggleBtn) {
      pushToggleBtn.style.display = 'none';
    }
    return;
  }

  try {
    await navigator.serviceWorker.register('/sw.js');
    state.swRegistration = await navigator.serviceWorker.ready;
    console.log('Service Worker registered and ready:', state.swRegistration);

    const subscription = await state.swRegistration.pushManager.getSubscription();
    state.isSubscribed = !(subscription === null);
    updatePushBtnUI();

    if (state.isSubscribed) {
      await registerSubscriptionOnServer(subscription);
    }
  } catch (err) {
    console.error('Service Worker registration failed:', err);
  }
}

export async function togglePushSubscription() {
  if (!state.swRegistration) {
    if ('serviceWorker' in navigator) {
      try {
        state.swRegistration = await navigator.serviceWorker.ready;
      } catch (err) {
        console.error('Service Worker ready check failed:', err);
      }
    }
  }

  if (!state.swRegistration) {
    alert('消息推送尚未就绪或在此浏览器中不受支持。请确保您使用的是安全的网络连接（HTTPS）以及有效的 SSL 证书。');
    return;
  }
  
  if (state.isSubscribed) {
    try {
      const subscription = await state.swRegistration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        await unregisterSubscriptionOnServer(subscription);
      }
      state.isSubscribed = false;
      updatePushBtnUI();
    } catch (err) {
      console.error('Error unsubscribing:', err);
      alert('取消推送订阅失败: ' + err.message);
    }
  } else {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('通知权限已被拒绝。');
        return;
      }

      const keyRes = await fetch('/api/push/key');
      if (!keyRes.ok) {
        throw new Error('Failed to fetch VAPID public key from server');
      }
      const keyData = await keyRes.json();
      const applicationServerKey = urlB64ToUint8Array(keyData.publicKey);

      const subscription = await state.swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });

      await registerSubscriptionOnServer(subscription);
      state.isSubscribed = true;
      updatePushBtnUI();
    } catch (err) {
      console.error('Failed to subscribe the user:', err);
      alert('订阅推送失败: ' + err.message);
    }
  }
}
