/**
 * Device Manager Module
 * Handles multi-device interconnect, pairing tokens, and remote agent device list.
 */

let currentSocket = null;
let currentPairCommand = '';

/**
 * Fetch and render bound devices
 */
export async function loadDeviceList() {
  const container = document.getElementById('deviceListContainer');
  if (!container) return;

  try {
    const res = await fetch('/api/devices');
    if (!res.ok) throw new Error('Failed to fetch devices');
    const data = await res.json();
    const devices = data.devices || [];

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
            <button class="device-btn-danger remove-device-btn" data-device-id="${d.deviceId}" title="解除绑定">
              <i data-lucide="trash-2"></i>
              <span>解绑</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) window.lucide.createIcons();

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
    await loadDeviceList();
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

  // Close dropdown if open
  const dropdown = document.getElementById('deckControlDropdownMenu');
  if (dropdown) dropdown.classList.add('hidden');
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
 * Initialize Device Manager bindings
 */
export function initDeviceManager(socket) {
  currentSocket = socket;

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

  if (closeBtn) {
    closeBtn.addEventListener('click', closeDeviceModal);
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDeviceModal();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', copyPairCommand);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshPairToken);
  }

  // Listen to device status updates in real-time
  if (socket) {
    socket.on('device:status_change', (payload) => {
      console.log('📡 [DeviceManager] Device status update:', payload);
      // If modal is visible, re-render
      if (modal && !modal.classList.contains('hidden')) {
        loadDeviceList();
      }
    });
  }
}
