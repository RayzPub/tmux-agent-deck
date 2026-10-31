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
 * Switch active operating device
 * @param {string} deviceId - 'cloud' or 'dev_xxxx'
 */
export function switchToDevice(deviceId) {
  state.currentDeviceId = deviceId;

  const currentIcon = document.getElementById('deviceCurrentIcon');
  const currentName = document.getElementById('deviceCurrentName');
  const currentDot = document.getElementById('deviceCurrentStatusDot');
  const dropdown = document.getElementById('deviceSwitcherDropdown');

  if (dropdown) dropdown.classList.add('hidden');

  if (deviceId === 'cloud') {
    // 1. Switch back to Cloud Host
    if (currentIcon) currentIcon.setAttribute('data-lucide', 'cloud');
    if (currentName) currentName.textContent = '云端主机';
    if (currentDot) {
      currentDot.className = 'device-switcher-dot online';
      currentDot.title = '在线';
    }
    console.log('[DeviceManager] Context switched to Cloud Server Host');
  } else {
    // 2. Switch to Remote Edge Device
    const device = state.remoteDevices.find(d => d.deviceId === deviceId);
    const devName = device?.name || device?.hostname || '远程设备';
    const isOnline = !!device?.isOnline;

    let osIcon = 'laptop';
    if (device?.platform === 'darwin') osIcon = 'apple';
    else if (device?.platform === 'linux') osIcon = 'terminal';

    if (currentIcon) currentIcon.setAttribute('data-lucide', osIcon);
    if (currentName) currentName.textContent = devName;
    if (currentDot) {
      currentDot.className = `device-switcher-dot ${isOnline ? 'online' : 'offline'}`;
      currentDot.title = isOnline ? '在线' : '离线';
    }
    console.log(`[DeviceManager] Context switched to Remote Device: ${devName} (${deviceId})`);
  }

  if (window.lucide) window.lucide.createIcons();
  updateSwitcherDropdownItems();

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

/**
 * Render items in Top-Left Device Switcher dropdown
 */
export function updateSwitcherDropdownItems() {
  const container = document.getElementById('deviceDropdownList');
  if (!container) return;

  const currentId = state.currentDeviceId || 'cloud';

  let html = `
    <div class="device-dropdown-item ${currentId === 'cloud' ? 'active' : ''}" data-device-id="cloud">
      <div class="device-dropdown-item-left">
        <i data-lucide="cloud"></i>
        <span class="device-dropdown-item-name">云端主机 (Cloud Host)</span>
      </div>
      <span class="device-switcher-dot online" title="在线"></span>
    </div>
  `;

  for (const d of state.remoteDevices) {
    let osIcon = 'laptop';
    if (d.platform === 'darwin') osIcon = 'apple';
    else if (d.platform === 'linux') osIcon = 'terminal';

    const isOnline = !!d.isOnline;
    const isSelected = currentId === d.deviceId;

    html += `
      <div class="device-dropdown-item ${isSelected ? 'active' : ''}" data-device-id="${d.deviceId}">
        <div class="device-dropdown-item-left">
          <i data-lucide="${osIcon}"></i>
          <span class="device-dropdown-item-name">${escapeHtml(d.name || d.hostname)}</span>
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
          <span>暂无绑定的本地设备。请在下方运行命令添加设备。</span>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    container.innerHTML = devices.map(d => {
      let osIcon = 'monitor';
      if (d.platform === 'darwin') osIcon = 'apple';
      else if (d.platform === 'linux') osIcon = 'terminal';
      else if (d.platform === 'win32') osIcon = 'laptop';

      const agentsText = Array.isArray(d.agentTypes) && d.agentTypes.length > 0 
        ? d.agentTypes.join(', ') 
        : 'Agent 就绪';

      const statusClass = d.isOnline ? 'online' : 'offline';
      const statusLabel = d.isOnline ? '在线' : '离线';

      return `
        <div class="device-card" data-device-id="${d.deviceId}">
          <div class="device-info-col">
            <div class="device-icon-box">
              <i data-lucide="${osIcon}"></i>
            </div>
            <div class="device-text-details">
              <div class="device-name-row">
                <span class="device-name">${escapeHtml(d.name || d.hostname)}</span>
                <span class="device-status-pill ${statusClass}">${statusLabel}</span>
              </div>
              <div class="device-meta-sub">
                ${escapeHtml(d.hostname)} (${d.platform} ${d.arch || ''}) · ${agentsText}
              </div>
            </div>
          </div>
          <div class="device-action-col">
            <button class="device-btn-primary switch-device-btn" data-device-id="${d.deviceId}" title="切换控制台到此设备">
              <i data-lucide="external-link"></i>
              <span>切换设备</span>
            </button>
            <button class="device-btn-danger remove-device-btn" data-device-id="${d.deviceId}" title="解除绑定">
              <i data-lucide="trash-2"></i>
              <span>解绑</span>
            </button>
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

  cmdEl.textContent = '正在生成一次性安全凭证...';

  try {
    const res = await fetch('/api/devices/pair-token', { method: 'POST' });
    if (!res.ok) throw new Error('Token generation failed');
    const data = await res.json();

    currentPairCommand = data.command;
    cmdEl.textContent = data.command;
    if (expireEl) {
      expireEl.textContent = `命令 ${Math.floor(data.ttlSeconds / 60)} 分钟内有效`;
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

    // If currently operating this device, switch back to cloud
    if (state.currentDeviceId === deviceId) {
      switchToDevice('cloud');
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
 * Open Device Manager Modal
 */
export function openDeviceModal() {
  const modal = document.getElementById('deviceManagerModal');
  if (!modal) return;

  modal.classList.remove('hidden');
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

  // 1. Initial Device Fetch
  await fetchDevices();
  updateSwitcherDropdownItems();

  // 2. Switcher Button and Dropdown Binding
  const switcherBtn = document.getElementById('deviceSwitcherBtn');
  const switcherDropdown = document.getElementById('deviceSwitcherDropdown');
  const pairBtn = document.getElementById('deviceDropdownPairBtn');

  if (switcherBtn && switcherDropdown) {
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switcherDropdown.classList.toggle('hidden');
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
