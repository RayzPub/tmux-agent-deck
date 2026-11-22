/**
 * Device Manager Module
 * Handles multi-device interconnect, top-left device switcher, and full workspace deck integration.
 * In this design, switching devices seamlessly transforms the entire Deck context (Workspaces,
 * Sessions, Terminal, Files, Git, Editor) without requiring isolated panels.
 */

import { state } from './state.js';

let currentSocket = null;
let currentPairCommand = '';

/**
 * Fetch devices list from server
 */
export async function fetchDevices() {
  try {
    const res = await fetch('/api/devices');
    if (!res.ok) throw new Error('Failed to fetch devices');
    const data = await res.json();
    state.remoteDevices = data.devices || [];
    return state.remoteDevices;
  } catch (err) {
    console.error('[DeviceManager] Error fetching devices:', err);
    return [];
  }
}

/**
 * Pick the best default device from the user's device list.
 * Prefers saved lastDeviceId (if online), then online host-admin -> online docker-sandbox -> online external -> any device.
 */
function pickDefaultDevice(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return 'cloud';
  try {
    const saved = localStorage.getItem('lastDeviceId');
    if (saved && saved !== 'cloud') {
      const found = devices.find(d => d.deviceId === saved);
      if (found && found.isOnline) return found.deviceId;
    }
  } catch (_) {}

  const onlineHost = devices.find(d => d.deviceKind === 'host-admin' && d.isOnline);
  if (onlineHost) return onlineHost.deviceId;
  const onlineSandbox = devices.find(d => d.deviceKind === 'docker-sandbox' && d.isOnline);
  if (onlineSandbox) return onlineSandbox.deviceId;
  const onlineAny = devices.find(d => d.isOnline);
  if (onlineAny) return onlineAny.deviceId;
  const anyHost = devices.find(d => d.deviceKind === 'host-admin');
  if (anyHost) return anyHost.deviceId;
  const anySandbox = devices.find(d => d.deviceKind === 'docker-sandbox');
  if (anySandbox) return anySandbox.deviceId;
  return devices[0].deviceId;
}

/**
 * Switch active operating device
 * @param {string} deviceId - 'dev_xxxx' (or 'cloud' fallback if no devices exist)
 * @param {object} [options] - { silent?: boolean }
 */
export function switchToDevice(deviceId, options = {}) {
  state.currentDeviceId = deviceId;
  if (deviceId && deviceId !== 'cloud') {
    try { localStorage.setItem('lastDeviceId', deviceId); } catch (_) {}
  }

  const currentIcon = document.getElementById('deviceCurrentIcon');
  const currentName = document.getElementById('deviceCurrentName');
  const currentDot = document.getElementById('deviceCurrentStatusDot');
  const dropdown = document.getElementById('deviceSwitcherDropdown');

  if (dropdown) dropdown.classList.add('hidden');

  if (deviceId === 'cloud') {
    if (currentIcon) currentIcon.setAttribute('data-lucide', 'cloud');
    if (currentName) currentName.textContent = '未连接设备';
    if (currentDot) {
      currentDot.className = 'device-switcher-dot offline';
      currentDot.title = '请先启动云电脑或连接我的电脑';
    }
  } else {
    const device = state.remoteDevices.find(d => d.deviceId === deviceId);
    const devName = device?.name || device?.hostname || '我的电脑';
    const isOnline = !!device?.isOnline;

    let osIcon = 'laptop';
    if (device?.deviceKind === 'host-admin') osIcon = 'server';
    else if (device?.deviceKind === 'docker-sandbox') osIcon = 'box';
    else if (device?.platform === 'darwin') osIcon = 'apple';
    else if (device?.platform === 'linux') osIcon = 'terminal';

    if (currentIcon) currentIcon.setAttribute('data-lucide', osIcon);
    if (currentName) currentName.textContent = devName;
    if (currentDot) {
      currentDot.className = `device-switcher-dot ${isOnline ? 'online' : 'offline'}`;
      currentDot.title = isOnline ? '在线' : '离线';
    }
    console.log(`[DeviceManager] Context switched to Device: ${devName} (${deviceId})`);
  }

  // Update top-right system dropdown banner
  const dropdownBanner = document.getElementById('deckDropdownDeviceBanner');
  const dropdownDevName = document.getElementById('deckDropdownDeviceName');
  const dropdownDevBadge = document.getElementById('deckDropdownDeviceBadge');
  if (dropdownBanner) {
    if (deviceId === 'cloud') {
      dropdownBanner.classList.add('hidden');
    } else {
      const dev = state.remoteDevices.find(d => d.deviceId === deviceId);
      if (dropdownDevName) {
        dropdownDevName.textContent = dev?.name || dev?.hostname || '我的电脑';
      }
      if (dropdownDevBadge) {
        dropdownDevBadge.textContent = getDeviceKindLabel(dev?.deviceKind);
      }
      dropdownBanner.classList.remove('hidden');
    }
  }

  if (window.lucide) window.lucide.createIcons();
  updateSwitcherDropdownItems();

  if (options.silent) return;

  // Reset current session tracking to avoid session collision between nodes
  state.currentSession = null;

  // Refresh sessions list for the newly selected device
  if (typeof window.loadSessions === 'function') {
    window.loadSessions();
  }

  // Refresh workspaces & file tree for the newly selected device
  if (typeof window.loadWorkspaces === 'function') {
    window.loadWorkspaces().then(() => {
      if (typeof window.refreshFileTree === 'function') {
        window.refreshFileTree();
      }
    });
  }
}

function getDeviceKindLabel(kind) {
  if (kind === 'host-admin') return '主服务器';
  if (kind === 'docker-sandbox') return '云电脑';
  return '我的电脑';
}

function getPlatformLabel(platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform || '未知系统';
}

/**
 * Render items in Top-Left Device Switcher dropdown
 */
export function updateSwitcherDropdownItems() {
  const container = document.getElementById('deviceDropdownList');
  if (!container) return;

  const currentId = state.currentDeviceId || 'cloud';

  let html = '';
  if (state.remoteDevices.length === 0) {
    html = `
      <div class="device-dropdown-empty" style="padding: 10px 12px; font-size: 12px; color: var(--text-muted); text-align: center;">
        暂无可用设备，请点击下方启动云电脑或连接我的电脑
      </div>
    `;
  }

  for (const d of state.remoteDevices) {
    let osIcon = 'laptop';
    let kindBadge = '';
    if (d.deviceKind === 'host-admin') {
      osIcon = 'server';
      kindBadge = '<span class="device-kind-pill host-admin">主服务器</span>';
    } else if (d.deviceKind === 'docker-sandbox') {
      osIcon = 'box';
      kindBadge = '<span class="device-kind-pill docker-sandbox">云电脑</span>';
    } else if (d.platform === 'darwin') {
      osIcon = 'apple';
    } else if (d.platform === 'linux') {
      osIcon = 'terminal';
    }

    const isOnline = !!d.isOnline;
    const isSelected = currentId === d.deviceId;

    html += `
      <div class="device-dropdown-item ${isSelected ? 'active' : ''}" data-device-id="${d.deviceId}">
        <div class="device-dropdown-item-left">
          <i data-lucide="${osIcon}"></i>
          <span class="device-dropdown-item-name">${escapeHtml(d.name || d.hostname)}</span>
          ${kindBadge}
        </div>
        <span class="device-switcher-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? '在线' : '离线'}"></span>
      </div>
    `;
  }

  container.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();

  // Bind click events on dropdown items
  container.querySelectorAll('.device-dropdown-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-device-id');
      switchToDevice(id);
    });
  });
}

/**
 * Fetch and render bound devices in management modal
 */
export async function loadDeviceList() {
  const container = document.getElementById('deviceListContainer');
  if (!container) return;

  try {
    const devices = await fetchDevices();

    if (devices.length === 0) {
      container.innerHTML = `
        <div class="device-empty-state">
          <i data-lucide="cpu" style="width: 28px; height: 28px; margin-bottom: 8px; opacity: 0.5;"></i>
          <span>暂未连接电脑，可在下方运行命令快速接入。</span>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    container.innerHTML = devices.map(d => {
      const kind = d.deviceKind || 'external';
      const kindLabel = getDeviceKindLabel(kind);
      let osIcon = 'monitor';
      if (kind === 'host-admin') {
        osIcon = 'server';
      } else if (kind === 'docker-sandbox') {
        osIcon = 'box';
      } else if (d.platform === 'darwin') {
        osIcon = 'apple';
      } else if (d.platform === 'linux') {
        osIcon = 'terminal';
      } else if (d.platform === 'win32') {
        osIcon = 'laptop';
      }

      const statusClass = d.isOnline ? 'online' : 'offline';
      const statusLabel = d.isOnline ? '在线' : '离线';
      const isCurrent = (state.currentDeviceId || 'cloud') === d.deviceId;
      const clientVersion = d.clientVersion || '1.0.0';
      const isProtected = kind === 'host-admin' || kind === 'docker-sandbox';
      const providerHint = kind === 'docker-sandbox'
        ? '云端模型'
        : kind === 'host-admin'
          ? '服务端模型'
          : '本机模型';
      const metaText = `${getPlatformLabel(d.platform)} · ${providerHint}`;

      return `
        <div class="device-card" data-device-id="${d.deviceId}" title="Agent v${escapeHtml(clientVersion)}">
          <div class="device-info-col">
            <div class="device-icon-box">
              <i data-lucide="${osIcon}"></i>
            </div>
            <div class="device-text-details">
              <div class="device-name-row">
                <span class="device-name">${escapeHtml(d.name || d.hostname)}</span>
                <span class="device-kind-pill ${kind}">${kindLabel}</span>
                <span class="device-status-pill ${statusClass}">${statusLabel}</span>
              </div>
              <div class="device-meta-sub">${escapeHtml(metaText)}</div>
            </div>
          </div>
          <div class="device-action-col">
            ${isCurrent 
              ? `<button class="device-btn-active" disabled title="当前正在使用此设备"><i data-lucide="check"></i><span>当前</span></button>` 
              : `<button class="device-btn-primary switch-device-btn" data-device-id="${d.deviceId}" title="切换到此设备"><i data-lucide="external-link"></i><span>切换</span></button>`
            }
            ${d.isOnline && kind === 'external'
              ? `<button class="device-btn-secondary update-device-btn" data-device-id="${d.deviceId}" title="升级客户端 (当前 v${escapeHtml(clientVersion)})"><i data-lucide="refresh-cw"></i><span>升级</span></button>` 
              : ''
            }
            ${!isProtected
              ? `<button class="device-btn-danger remove-device-btn" data-device-id="${d.deviceId}" title="解除绑定"><i data-lucide="trash-2"></i><span>解绑</span></button>`
              : ''
            }
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) window.lucide.createIcons();

    // Bind switch buttons
    container.querySelectorAll('.switch-device-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const devId = e.currentTarget.getAttribute('data-device-id');
        closeDeviceModal();
        switchToDevice(devId);
      });
    });

    // Bind update buttons
    container.querySelectorAll('.update-device-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const devId = e.currentTarget.getAttribute('data-device-id');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i><span>升级中...</span>`;
        if (window.lucide) window.lucide.createIcons();

        try {
          const res = await fetch(`/api/devices/${devId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const json = await res.json();
          if (json.success) {
            alert(`🎉 远程升级指令执行成功！\n客户端已完成热重启。\n版本: ${json.oldVersion || ''} ➔ ${json.newVersion || '最新'}`);
            await loadDeviceList();
          } else {
            alert(`❌ 升级失败: ${json.error || '未知错误'}`);
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (window.lucide) window.lucide.createIcons();
          }
        } catch (err) {
          alert(`❌ 升级请求失败: ${err.message}`);
          btn.disabled = false;
          btn.innerHTML = originalHtml;
          if (window.lucide) window.lucide.createIcons();
        }
      });
    });

    // Bind remove buttons
    container.querySelectorAll('.remove-device-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const devId = e.currentTarget.getAttribute('data-device-id');
        if (confirm('确认解除该设备的绑定吗？解绑后本地 Agent 将无法连入。')) {
          await deleteDevice(devId);
        }
      });
    });

  } catch (err) {
    console.error('[DeviceManager] Error loading devices:', err);
    container.innerHTML = `<div class="device-empty-state" style="color: #ef4444;">加载设备列表失败: ${err.message}</div>`;
  }
}

/**
 * Request a fresh pair token and startup command
 */
export async function refreshPairToken() {
  const cmdEl = document.getElementById('devicePairCmdText');
  const expireEl = document.getElementById('devicePairExpireText');
  if (!cmdEl) return;

  cmdEl.textContent = '正在生成命令...';

  try {
    const res = await fetch('/api/devices/pair-token', { method: 'POST' });
    if (!res.ok) throw new Error('Token generation failed');
    const data = await res.json();

    currentPairCommand = data.command;
    cmdEl.textContent = data.command;
    if (expireEl) {
      expireEl.textContent = `${Math.floor(data.ttlSeconds / 60)} 分钟内有效`;
    }
  } catch (err) {
    console.error('[DeviceManager] Error generating pair token:', err);
    cmdEl.textContent = '生成失败，请重试';
  }
}

/**
 * Delete / Unbind a device
 */
async function deleteDevice(deviceId) {
  try {
    const res = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to unbind device');
    await fetchDevices();
    updateSwitcherDropdownItems();
    await loadDeviceList();

    // If currently operating this device, switch to next best available device
    if (state.currentDeviceId === deviceId) {
      switchToDevice(pickDefaultDevice(state.remoteDevices));
    }
  } catch (err) {
    alert(`解绑失败: ${err.message}`);
  }
}

/**
 * Copy pair command to clipboard
 */
function copyPairCommand() {
  if (!currentPairCommand) return;
  navigator.clipboard.writeText(currentPairCommand).then(() => {
    const btn = document.getElementById('deviceCopyPairCmdBtn');
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = `<i data-lucide="check"></i> <span>已复制</span>`;
      if (window.lucide) window.lucide.createIcons();
      setTimeout(() => {
        btn.innerHTML = origHtml;
        if (window.lucide) window.lucide.createIcons();
      }, 2000);
    }
  }).catch(() => {
    alert('复制失败，请手动选取复制');
  });
}

/**
 * Load and render Managed Docker Sandbox control card
 */
export async function loadSandboxPanel() {
  const panel = document.getElementById('sandboxControlPanel');
  if (!panel) return;

  try {
    const res = await fetch('/api/sandbox/status');
    if (!res.ok) throw new Error('无法获取沙箱状态');
    const data = await res.json();

    if (!data.dockerAvailable) {
      panel.innerHTML = `
        <div class="sandbox-row">
          <div class="sandbox-info">
            <div class="sandbox-title-row">
              <i data-lucide="box"></i>
              <span class="sandbox-title">我的云电脑</span>
              <span class="device-status-pill offline">未启用</span>
            </div>
            <div class="device-meta-sub">当前服务器未开启云电脑服务</div>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    const isRunning = !!data.running;
    const isOnline = !!data.isOnline;
    const statusClass = isRunning && isOnline ? 'online' : 'offline';
    const statusText = isRunning ? (isOnline ? '运行中' : '启动中...') : (data.exists ? '已休眠' : '未启动');
    const limits = data.limits || {};
    const limitText = `${limits.cpus || '1'} 核 · ${String(limits.memory || '1g').toUpperCase()} 内存 · 闲置 ${data.idleTimeoutMinutes || 30} 分钟休眠`;

    panel.innerHTML = `
      <div class="sandbox-row">
        <div class="sandbox-info">
          <div class="sandbox-title-row">
            <i data-lucide="box"></i>
            <span class="sandbox-title" title="${escapeHtml(data.containerName || 'ccnow-sandbox')}">我的云电脑</span>
            <span class="device-status-pill ${statusClass}">${statusText}</span>
          </div>
          <div class="device-meta-sub">${escapeHtml(limitText)}</div>
        </div>
        <div class="sandbox-actions">
          ${isRunning
            ? `
              ${data.deviceId ? `<button class="device-btn-primary" id="sandboxEnterBtn"><i data-lucide="external-link"></i><span>进入</span></button>` : ''}
              <button class="device-btn-secondary" id="sandboxStopBtn"><i data-lucide="moon"></i><span>休眠</span></button>
            `
            : `<button class="device-btn-primary" id="sandboxStartBtn"><i data-lucide="play"></i><span>${data.exists ? '唤醒' : '启动'}</span></button>`
          }
        </div>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    const startBtn = document.getElementById('sandboxStartBtn');
    if (startBtn) {
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        startBtn.innerHTML = `<i data-lucide="loader" class="spin"></i><span>启动中...</span>`;
        if (window.lucide) window.lucide.createIcons();
        try {
          const r = await fetch('/api/sandbox/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const j = await r.json();
          if (!r.ok || !j.success) throw new Error(j.error || '启动失败');
          await fetchDevices();
          updateSwitcherDropdownItems();
          await loadDeviceList();
          await loadSandboxPanel();
        } catch (err) {
          alert(`启动云电脑失败: ${err.message}`);
          await loadSandboxPanel();
        }
      });
    }

    const stopBtn = document.getElementById('sandboxStopBtn');
    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        stopBtn.innerHTML = `<i data-lucide="loader" class="spin"></i><span>休眠中...</span>`;
        if (window.lucide) window.lucide.createIcons();
        try {
          const r = await fetch('/api/sandbox/stop', { method: 'POST' });
          const j = await r.json();
          if (!r.ok || !j.success) throw new Error(j.error || '休眠失败');
          await fetchDevices();
          updateSwitcherDropdownItems();
          await loadDeviceList();
          await loadSandboxPanel();
          if (data.deviceId && state.currentDeviceId === data.deviceId) {
            switchToDevice(pickDefaultDevice(state.remoteDevices));
          }
        } catch (err) {
          alert(`休眠云电脑失败: ${err.message}`);
          await loadSandboxPanel();
        }
      });
    }

    const enterBtn = document.getElementById('sandboxEnterBtn');
    if (enterBtn && data.deviceId) {
      enterBtn.addEventListener('click', () => {
        closeDeviceModal();
        switchToDevice(data.deviceId);
      });
    }
  } catch (err) {
    console.error('[DeviceManager] Error loading sandbox panel:', err);
    panel.innerHTML = `<div class="sandbox-loading-text" style="color: #ef4444;">加载云电脑状态失败: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Open Device Manager Modal
 */
export function openDeviceModal() {
  const modal = document.getElementById('deviceManagerModal');
  if (!modal) return;

  modal.classList.remove('hidden');
  loadSandboxPanel();
  loadDeviceList();
  refreshPairToken();

  const dropdown = document.getElementById('deckControlDropdownMenu');
  if (dropdown) dropdown.classList.add('hidden');
  const switcherDropdown = document.getElementById('deviceSwitcherDropdown');
  if (switcherDropdown) switcherDropdown.classList.add('hidden');
}

/**
 * Close Device Manager Modal
 */
export function closeDeviceModal() {
  const modal = document.getElementById('deviceManagerModal');
  if (modal) modal.classList.add('hidden');
}

/**
 * Helper to escape HTML strings
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Initialize Device Switcher and Deck Workspace Integration
 */
export async function initDeviceManager(socket) {
  currentSocket = socket;

  // 1. Initial Device Fetch & auto-select unified device (retiring legacy 'cloud' default)
  const devices = await fetchDevices();
  const initialDeviceId = pickDefaultDevice(devices);
  switchToDevice(initialDeviceId, { silent: true });

  // 2. Switcher Button and Dropdown Binding
  const switcherBtn = document.getElementById('deviceSwitcherBtn');
  const switcherDropdown = document.getElementById('deviceSwitcherDropdown');
  const pairBtn = document.getElementById('deviceDropdownPairBtn');

  // Reposition dropdown dynamically to prevent right-edge and bottom-edge viewport overflow
  // especially on iPhone Duo / Foldable landscape screens
  function repositionSwitcherDropdown() {
    if (!switcherDropdown || switcherDropdown.classList.contains('hidden')) return;

    // Reset styles to calculate natural geometry
    switcherDropdown.style.left = '0px';
    switcherDropdown.style.right = 'auto';

    const rect = switcherDropdown.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.visualViewport ? window.visualViewport.height : (window.innerHeight || document.documentElement.clientHeight);
    const padding = 10;

    if (rect.right > viewportWidth - padding) {
      const overflow = rect.right - (viewportWidth - padding);
      const container = switcherBtn ? switcherBtn.parentElement : null;
      const containerLeft = container ? container.getBoundingClientRect().left : 0;
      const clampedLeft = Math.max(-overflow, -(containerLeft - padding));
      switcherDropdown.style.left = `${clampedLeft}px`;
    }

    // Dynamically constrain dropdown height so header + device list + pair button stay 100% visible
    const triggerBottom = switcherBtn ? switcherBtn.getBoundingClientRect().bottom : rect.top;
    const availableBelow = Math.max(150, Math.floor(viewportHeight - triggerBottom - 16));
    switcherDropdown.style.setProperty('max-height', `${Math.min(360, availableBelow)}px`, 'important');
    switcherDropdown.style.setProperty('overflow-y', 'auto', 'important');

    const listEl = document.getElementById('deviceDropdownList');
    if (listEl) {
      // Reserve ~92px for dropdown header, divider, and pair action button
      const listMax = Math.max(88, Math.min(240, availableBelow - 96));
      listEl.style.setProperty('max-height', `${listMax}px`, 'important');
    }
  }

  if (switcherBtn && switcherDropdown) {
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpening = switcherDropdown.classList.contains('hidden');
      if (isOpening) {
        // Close bottom system dropup menu so the two popovers never collide
        const deckMenu = document.getElementById('deckControlDropdownMenu');
        const deckBtn = document.getElementById('deckControlToggleBtn');
        if (deckMenu) deckMenu.classList.add('hidden');
        if (deckBtn) deckBtn.classList.remove('active');
      }
      switcherDropdown.classList.toggle('hidden');
      if (isOpening) {
        repositionSwitcherDropdown();
      }
    });

    window.addEventListener('resize', () => {
      repositionSwitcherDropdown();
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(repositionSwitcherDropdown, 120);
    });

    document.addEventListener('click', (e) => {
      if (!switcherDropdown.contains(e.target) && !switcherBtn.contains(e.target)) {
        switcherDropdown.classList.add('hidden');
      }
    });
  }

  if (pairBtn) {
    pairBtn.addEventListener('click', () => {
      openDeviceModal();
    });
  }

  // 3. Modal Bindings
  const triggerBtn = document.getElementById('deviceManagerBtn');
  const closeBtn = document.getElementById('closeDeviceManagerModalBtn');
  const modal = document.getElementById('deviceManagerModal');
  const copyBtn = document.getElementById('deviceCopyPairCmdBtn');
  const refreshBtn = document.getElementById('deviceRefreshPairBtn');

  if (triggerBtn) {
    triggerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeviceModal();
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closeDeviceModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDeviceModal();
    });
  }

  if (copyBtn) copyBtn.addEventListener('click', copyPairCommand);
  if (refreshBtn) refreshBtn.addEventListener('click', refreshPairToken);

  // 4. Real-time Status Change via Socket.io
  if (socket) {
    socket.on('device:status_change', async (payload) => {
      console.log('📡 [DeviceManager] Status change received:', payload);
      await fetchDevices();
      updateSwitcherDropdownItems();

      // If viewing modal, refresh list
      if (modal && !modal.classList.contains('hidden')) {
        loadDeviceList();
      }

      // If currently operating the changed device, update active indicators
      if (state.currentDeviceId === payload.deviceId) {
        const dot = document.getElementById('deviceCurrentStatusDot');
        if (dot) {
          dot.className = `device-switcher-dot ${payload.isOnline ? 'online' : 'offline'}`;
          dot.title = payload.isOnline ? '在线' : '离线';
        }
      }
    });
  }
}
