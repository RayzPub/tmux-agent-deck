/**
 * Device Manager Module
 * Handles multi-device interconnect, pairing tokens, and remote agent direct control console.
 */

let currentSocket = null;
let currentPairCommand = '';
let activeControlDeviceId = null;
let activeControlDeviceName = '';
let activeSessionId = null;

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
            ${d.isOnline ? `
              <button class="device-btn-primary control-device-btn" data-device-id="${d.deviceId}" data-device-name="${escapeHtml(d.name || d.hostname)}" title="向该设备上的 Agent 下发任务">
                <i data-lucide="bot"></i>
                <span>远程控制</span>
              </button>
            ` : ''}
            <button class="device-btn-danger remove-device-btn" data-device-id="${d.deviceId}" title="解除绑定">
              <i data-lucide="trash-2"></i>
              <span>解绑</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) window.lucide.createIcons();

    // Bind control buttons
    container.querySelectorAll('.control-device-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const devId = e.currentTarget.getAttribute('data-device-id');
        const devName = e.currentTarget.getAttribute('data-device-name');
        openRemoteConsole(devId, devName);
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
 * Open Remote Agent Direct Control Console
 */
export function openRemoteConsole(deviceId, deviceName) {
  activeControlDeviceId = deviceId;
  activeControlDeviceName = deviceName || deviceId;

  // Close device manager modal first
  closeDeviceModal();

  const consoleModal = document.getElementById('remoteAgentConsoleModal');
  const titleEl = document.getElementById('remoteConsoleTitle');
  const textarea = document.getElementById('remoteAgentPromptInput');

  if (titleEl) {
    titleEl.textContent = `远程控制: ${activeControlDeviceName}`;
  }

  if (consoleModal) {
    consoleModal.classList.remove('hidden');
  }

  if (textarea) {
    textarea.value = '';
    textarea.focus();
  }
}

/**
 * Close Remote Agent Console
 */
export function closeRemoteConsole() {
  const consoleModal = document.getElementById('remoteAgentConsoleModal');
  if (consoleModal) {
    consoleModal.classList.add('hidden');
  }
}

/**
 * Send Prompt to Remote Agent
 */
async function sendRemoteAgentPrompt() {
  const textarea = document.getElementById('remoteAgentPromptInput');
  const streamContainer = document.getElementById('remoteConsoleStream');
  const sendBtn = document.getElementById('remoteAgentSendBtn');
  const interruptBtn = document.getElementById('remoteAgentInterruptBtn');

  if (!textarea || !activeControlDeviceId) return;
  const prompt = textarea.value.trim();
  if (!prompt) return;

  // Clear welcome placeholder if any
  const welcome = streamContainer.querySelector('.remote-console-welcome');
  if (welcome) welcome.remove();

  // Create User message element
  const userMsgEl = document.createElement('div');
  userMsgEl.className = 'remote-msg-user';
  userMsgEl.textContent = prompt;
  streamContainer.appendChild(userMsgEl);

  // Create Agent message element (with running cursor)
  const agentMsgEl = document.createElement('div');
  agentMsgEl.className = 'remote-msg-agent running';
  agentMsgEl.textContent = '正在与远程本地设备建立任务并唤醒 Agent...';
  streamContainer.appendChild(agentMsgEl);

  // Scroll to bottom
  streamContainer.scrollTop = streamContainer.scrollHeight;

  // Switch button states
  textarea.value = '';
  sendBtn.disabled = true;
  interruptBtn.classList.remove('hidden');

  activeSessionId = `remote_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  let hasReceivedFirstChunk = false;

  // Listen to streaming replies
  if (currentSocket) {
    const eventName = `device:agent_event:${activeSessionId}`;
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
        sendBtn.disabled = false;
        interruptBtn.classList.add('hidden');
        textarea.focus();
      } else if (data.action === 'agent:error') {
        agentMsgEl.classList.remove('running');
        agentMsgEl.textContent += `\n[错误] ${data.error || '执行异常'}`;
        agentMsgEl.style.color = '#ef4444';
        currentSocket.off(eventName, handleEvent);
        sendBtn.disabled = false;
        interruptBtn.classList.add('hidden');
        textarea.focus();
      }
    };

    currentSocket.on(eventName, handleEvent);
  }

  try {
    const res = await fetch(`/api/devices/${activeControlDeviceId}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: activeSessionId,
        prompt
      })
    });

    const result = await res.json();
    if (!result.success) {
      agentMsgEl.classList.remove('running');
      agentMsgEl.textContent = `❌ 下发任务失败: ${result.error || '未知错误'}`;
      agentMsgEl.style.color = '#ef4444';
      sendBtn.disabled = false;
      interruptBtn.classList.add('hidden');
    }
  } catch (err) {
    agentMsgEl.classList.remove('running');
    agentMsgEl.textContent = `❌ 网络错误: ${err.message}`;
    agentMsgEl.style.color = '#ef4444';
    sendBtn.disabled = false;
    interruptBtn.classList.add('hidden');
  }
}

/**
 * Interrupt current active task on remote device
 */
async function interruptRemoteAgentTask() {
  if (!activeControlDeviceId || !activeSessionId) return;
  try {
    await fetch(`/api/devices/${activeControlDeviceId}/agent/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeSessionId })
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

  // Remote Console Elements
  const closeConsoleBtn = document.getElementById('closeRemoteConsoleModalBtn');
  const consoleModal = document.getElementById('remoteAgentConsoleModal');
  const sendBtn = document.getElementById('remoteAgentSendBtn');
  const interruptBtn = document.getElementById('remoteAgentInterruptBtn');
  const promptInput = document.getElementById('remoteAgentPromptInput');

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

  if (closeConsoleBtn) {
    closeConsoleBtn.addEventListener('click', closeRemoteConsole);
  }

  if (consoleModal) {
    consoleModal.addEventListener('click', (e) => {
      if (e.target === consoleModal) closeRemoteConsole();
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', sendRemoteAgentPrompt);
  }

  if (interruptBtn) {
    interruptBtn.addEventListener('click', interruptRemoteAgentTask);
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
        if (!e.shiftKey) {
          e.preventDefault();
          sendRemoteAgentPrompt();
        }
      }
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
      if (modal && !modal.classList.contains('hidden')) {
        loadDeviceList();
      }
      if (activeControlDeviceId && payload.deviceId === activeControlDeviceId) {
        const badge = document.getElementById('remoteConsoleStatusBadge');
        if (badge) {
          badge.className = `device-status-pill ${payload.isOnline ? 'online' : 'offline'}`;
          badge.textContent = payload.isOnline ? '在线' : '离线';
        }
      }
    });
  }
}
