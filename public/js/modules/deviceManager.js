/**
 * Device Manager Module
 * Handles multi-device interconnect, top-left device switcher, and full workspace deck integration.
 */

import { state } from './state.js';

let currentSocket = null;
let currentPairCommand = '';
let currentDeckSessionId = null;

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
  const remotePanel = document.getElementById('remoteDeviceWorkspacePanel');
  const terminalPanel = document.getElementById('terminalPanel');
  const welcomePanel = document.getElementById('welcomePanel');
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

    if (remotePanel) remotePanel.classList.add('hidden');

    // Restore terminal or welcome panel
    if (state.currentSession) {
      if (terminalPanel) terminalPanel.classList.remove('hidden');
    } else {
      if (welcomePanel) welcomePanel.classList.remove('hidden');
    }

    console.log('[DeviceManager] Switched context to Cloud Server Host');
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

    // Hide standard terminal/welcome panels and activate remote deck panel
    if (terminalPanel) terminalPanel.classList.add('hidden');
    if (welcomePanel) welcomePanel.classList.add('hidden');
    if (remotePanel) remotePanel.classList.remove('hidden');

    // Update remote deck header elements
    const deckIcon = document.getElementById('deckRemoteHeaderIcon');
    const deckTitle = document.getElementById('deckRemoteDeviceName');
    const deckPill = document.getElementById('deckRemoteStatusPill');
    const deckMeta = document.getElementById('deckRemoteMetaTag');
    const welcomeTitle = document.getElementById('deckRemoteWelcomeTitle');
    const textarea = document.getElementById('deckRemotePromptInput');

    if (deckIcon) deckIcon.setAttribute('data-lucide', osIcon);
    if (deckTitle) deckTitle.textContent = devName;
    if (deckPill) {
      deckPill.className = `device-status-pill ${isOnline ? 'online' : 'offline'}`;
      deckPill.textContent = isOnline ? '在线' : '离线';
    }
    if (deckMeta) {
      const agents = device?.agentTypes?.length ? device.agentTypes.join(', ') : 'Agent 就绪';
      deckMeta.textContent = `${device?.platform || 'Edge'} ${device?.arch || ''} · ${agents}`;
    }
    if (welcomeTitle) {
      welcomeTitle.textContent = `已连接至远程设备: ${devName}`;
    }

    if (textarea) {
      textarea.disabled = !isOnline;
      if (!isOnline) {
        textarea.placeholder = '当前设备处于离线状态，等待重新连接中...';
      } else {
        textarea.placeholder = `给 ${devName} 上的 Agent 下发任务 (按 Enter 发送，Shift+Enter 换行)...`;
        textarea.focus();
      }
    }

    console.log(`[DeviceManager] Switched context to Remote Device: ${devName} (${deviceId})`);
  }

  if (window.lucide) window.lucide.createIcons();
  updateSwitcherDropdownItems();

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
            <button class="device-btn-primary switch-device-btn" data-device-id="${d.deviceId}" title="切换至此设备的工作区">
              <i data-lucide="external-link"></i>
              <span>切换操作</span>
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
 * Send Prompt to Remote Agent in the Main Deck Workspace Panel
 */
async function sendDeckRemotePrompt(customPrompt) {
  const textarea = document.getElementById('deckRemotePromptInput');
  const streamContainer = document.getElementById('deckRemoteStream');
  const sendBtn = document.getElementById('deckRemoteSendBtn');
  const interruptBtn = document.getElementById('deckRemoteInterruptBtn');

  if (!state.currentDeviceId || state.currentDeviceId === 'cloud') return;

  const prompt = (customPrompt || (textarea ? textarea.value : '')).trim();
  if (!prompt) return;

  // Hide welcome box on first message
  const welcome = document.getElementById('deckRemoteWelcomeBox');
  if (welcome) welcome.style.display = 'none';

  // Create User message
  const userMsgEl = document.createElement('div');
  userMsgEl.className = 'remote-msg-user';
  userMsgEl.textContent = prompt;
  streamContainer.appendChild(userMsgEl);

  // Create Agent message (with typing cursor)
  const agentMsgEl = document.createElement('div');
  agentMsgEl.className = 'remote-msg-agent running';
  agentMsgEl.textContent = '正在连接远程设备并启动本地 Agent 任务...';
  streamContainer.appendChild(agentMsgEl);

  // Scroll to bottom
  streamContainer.scrollTop = streamContainer.scrollHeight;

  // Toggle button state
  if (textarea) textarea.value = '';
  if (sendBtn) sendBtn.disabled = true;
  if (interruptBtn) interruptBtn.classList.remove('hidden');

  currentDeckSessionId = `remote_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  let hasReceivedFirstChunk = false;

  // Listen for socket events
  if (currentSocket) {
    const eventName = `device:agent_event:${currentDeckSessionId}`;
    const handleEvent = (data) => {
      if (data.action === 'agent:stream') {
        if (!hasReceivedFirstChunk) {
          agentMsgEl.textContent = '';
          hasReceivedFirstChunk = true;
        }
        agentMsgEl.textContent += data.delta;
        streamContainer.scrollTop = streamContainer.scrollHeight;
      } else if (data.action === 'agent:done') {
        agentMsgEl.classList.remove('running');
        currentSocket.off(eventName, handleEvent);
        if (sendBtn) sendBtn.disabled = false;
        if (interruptBtn) interruptBtn.classList.add('hidden');
        if (textarea) textarea.focus();
      } else if (data.action === 'agent:error') {
        agentMsgEl.classList.remove('running');
        agentMsgEl.textContent += `\n[错误] ${data.error || '执行异常'}`;
        agentMsgEl.style.color = '#ef4444';
        currentSocket.off(eventName, handleEvent);
        if (sendBtn) sendBtn.disabled = false;
        if (interruptBtn) interruptBtn.classList.add('hidden');
        if (textarea) textarea.focus();
      }
    };

    currentSocket.on(eventName, handleEvent);
  }

  try {
    const res = await fetch(`/api/devices/${state.currentDeviceId}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentDeckSessionId,
        prompt
      })
    });

    const result = await res.json();
    if (!result.success) {
      agentMsgEl.classList.remove('running');
      agentMsgEl.textContent = `❌ 下发任务失败: ${result.error || '未知错误'}`;
      agentMsgEl.style.color = '#ef4444';
      if (sendBtn) sendBtn.disabled = false;
      if (interruptBtn) interruptBtn.classList.add('hidden');
    }
  } catch (err) {
    agentMsgEl.classList.remove('running');
    agentMsgEl.textContent = `❌ 网络错误: ${err.message}`;
    agentMsgEl.style.color = '#ef4444';
    if (sendBtn) sendBtn.disabled = false;
    if (interruptBtn) interruptBtn.classList.add('hidden');
  }
}

/**
 * Interrupt current active task on remote device
 */
async function interruptDeckRemoteTask() {
  if (!state.currentDeviceId || !currentDeckSessionId) return;
  try {
    await fetch(`/api/devices/${state.currentDeviceId}/agent/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentDeckSessionId })
    });
  } catch (err) {
    console.error('[DeviceManager] Failed to interrupt task:', err);
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

  // 3. Workspace Panel Controls Binding
  const openTerminalBtn = document.getElementById('deckRemoteOpenTerminalBtn');
  const clearChatBtn = document.getElementById('deckRemoteClearChatBtn');
  const switchToCloudBtn = document.getElementById('deckSwitchToCloudBtn');

  if (openTerminalBtn) {
    openTerminalBtn.addEventListener('click', () => {
      const remotePanel = document.getElementById('remoteDeviceWorkspacePanel');
      if (remotePanel) remotePanel.classList.add('hidden');
      if (typeof window.attachSession === 'function') {
        window.attachSession('main');
      }
    });
  }
  const sendBtn = document.getElementById('deckRemoteSendBtn');
  const interruptBtn = document.getElementById('deckRemoteInterruptBtn');
  const promptInput = document.getElementById('deckRemotePromptInput');
  const streamContainer = document.getElementById('deckRemoteStream');
  const quickActions = document.getElementById('deckRemoteQuickActions');

  if (clearChatBtn && streamContainer) {
    clearChatBtn.addEventListener('click', () => {
      streamContainer.innerHTML = `
        <div class="remote-deck-welcome" id="deckRemoteWelcomeBox">
          <div class="remote-deck-welcome-icon">
            <i data-lucide="cpu"></i>
          </div>
          <div class="remote-deck-welcome-title">已连接至远程本地设备</div>
          <div class="remote-deck-welcome-desc">
            当前控制面已直连该受控端。在下方输入 Prompt 指令即可远程驱动本地 Agent（如 Claude Code CLI）执行任务。
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    });
  }

  if (switchToCloudBtn) {
    switchToCloudBtn.addEventListener('click', () => {
      switchToDevice('cloud');
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => sendDeckRemotePrompt());
  }

  if (interruptBtn) {
    interruptBtn.addEventListener('click', interruptDeckRemoteTask);
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
        if (!e.shiftKey) {
          e.preventDefault();
          sendDeckRemotePrompt();
        }
      }
    });
  }

  if (quickActions) {
    quickActions.addEventListener('click', (e) => {
      const btn = e.target.closest('.quick-action-pill');
      if (btn) {
        const prompt = btn.getAttribute('data-prompt');
        sendDeckRemotePrompt(prompt);
      }
    });
  }

  // 4. Modal Bindings
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

  // 5. Real-time Status Change via Socket.io
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
        const pill = document.getElementById('deckRemoteStatusPill');
        const textarea = document.getElementById('deckRemotePromptInput');

        if (dot) {
          dot.className = `device-switcher-dot ${payload.isOnline ? 'online' : 'offline'}`;
          dot.title = payload.isOnline ? '在线' : '离线';
        }
        if (pill) {
          pill.className = `device-status-pill ${payload.isOnline ? 'online' : 'offline'}`;
          pill.textContent = payload.isOnline ? '在线' : '离线';
        }
        if (textarea) {
          textarea.disabled = !payload.isOnline;
          if (!payload.isOnline) {
            textarea.placeholder = '当前设备处于离线状态，等待重新连接中...';
          } else {
            textarea.placeholder = '给远程设备上的 Agent 下发任务 (按 Enter 发送，Shift+Enter 换行)...';
          }
        }
      }
    });
  }
}
