/**
 * Cyberpunk TMUX Agent Deck - Clean & Decisive Agent Chat Mode Module
 * Fully isolated, per-session state, optimized for non-programmers & mobile.
 */

import { state } from './state.js';
import { fitTerminal, attachSession } from './terminal.js';
import { stopVoiceInput } from './voice.js';

const sessionViewModes = new Map();
const sessionHistoryCache = new Map(); // sessionName -> { messages, lastUpdated, pendingAction, agentType }
let currentPollTimer = null;
let activePollSession = null;

/**
 * Helper to safely resolve current active session name
 */
export function getCurrentSessionName(passedName) {
  if (passedName) return passedName;
  if (state.currentSession) return state.currentSession;
  if (state.activeTabId && state.tabs && state.tabs.some(t => t.id === state.activeTabId && t.type === 'terminal')) {
    return state.activeTabId;
  }
  if (state.tabs) {
    const activeTerminalTab = state.tabs.find(t => t.type === 'terminal');
    if (activeTerminalTab) return activeTerminalTab.id;
  }
  return null;
}

/**
 * Initialize the Chat Mode extension
 */
export function initChatMode() {
  const terminalPanel = document.getElementById('terminalPanel');
  if (!terminalPanel) {
    console.warn('[ChatMode] #terminalPanel not found, skipping init.');
    return;
  }

  // 1. Inject CSS if not loaded
  if (!document.getElementById('chatModeStylesheet')) {
    const link = document.createElement('link');
    link.id = 'chatModeStylesheet';
    link.rel = 'stylesheet';
    link.href = '/css/chat-mode.css';
    document.head.appendChild(link);
  }

  // 2. Inject floating mode switcher directly into terminalPanel
  if (!document.getElementById('deckModeSwitcher')) {
    const switcher = document.createElement('div');
    switcher.id = 'deckModeSwitcher';
    switcher.className = 'deck-mode-switcher';
    switcher.style.display = 'none'; // Initially hidden until session support is verified
    switcher.innerHTML = `
      <button class="deck-mode-btn active" id="modeBtnTerminal" title="经典字符终端">
        <i data-lucide="terminal"></i>
        <span>终端</span>
      </button>
      <button class="deck-mode-btn" id="modeBtnChat" title="智能体对话模式">
        <i data-lucide="message-square-code"></i>
        <span>对话</span>
      </button>
    `;

    terminalPanel.appendChild(switcher);

    const btnTerminal = document.getElementById('modeBtnTerminal');
    const btnChat = document.getElementById('modeBtnChat');

    const handleTerminalClick = (e) => {
      e.stopPropagation();
      const currentSess = getCurrentSessionName();
      console.log('[ChatMode] Clicked Terminal Mode button. Target session:', currentSess);
      setSessionViewMode(currentSess, 'terminal');
    };

    const handleChatClick = (e) => {
      e.stopPropagation();
      const currentSess = getCurrentSessionName();
      console.log('[ChatMode] Clicked Chat Mode button. Target session:', currentSess);
      setSessionViewMode(currentSess, 'chat');
    };

    btnTerminal.addEventListener('click', handleTerminalClick);
    btnChat.addEventListener('click', handleChatClick);
  }

  // 3. Inject Clean Chat Container directly into terminalPanel
  if (!document.getElementById('agentChatContainer')) {
    const chatContainer = document.createElement('div');
    chatContainer.id = 'agentChatContainer';
    chatContainer.className = 'agent-chat-container hidden';
    chatContainer.innerHTML = `
      <!-- Minimalist Status Bar -->
      <div class="agent-chat-statusbar">
        <span class="agent-status-dot" id="chatStatusDot"></span>
        <span class="agent-status-name" id="chatAgentName">智能体</span>
        <span class="agent-status-sub" id="chatStatusText">就绪</span>
      </div>

      <!-- Messages Stream (Native Touch Scrolling) -->
      <div class="agent-chat-messages" id="agentChatMessages">
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #64748b; font-size: 11px;">
          <span>载入中...</span>
        </div>
      </div>

      <!-- Clean Decisive Composer -->
      <div class="agent-chat-composer">
        <div class="chat-input-row">
          <textarea 
            class="chat-textarea" 
            id="chatComposerTextarea" 
            rows="1"
          ></textarea>
          <div class="chat-composer-actions">
            <button class="chat-icon-btn" id="chatInterruptBtn" title="停止执行 (Ctrl+C)">
              <i data-lucide="square" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="chat-send-btn" id="chatSendMsgBtn" title="发送 (Enter)">
              <i data-lucide="arrow-up" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
        </div>
      </div>
    `;

    // Critical for Mobile: prevent terminal touch gesture listeners from intercepting scrolling
    ['touchstart', 'touchmove', 'touchend'].forEach(evt => {
      chatContainer.addEventListener(evt, (e) => {
        e.stopPropagation();
      }, { passive: true });
    });

    terminalPanel.appendChild(chatContainer);
    bindComposerEvents();
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }

  console.log('[ChatMode] Decisive ChatMode initialized.');

  const currentSess = getCurrentSessionName();
  if (currentSess) {
    applySessionViewMode(currentSess);
  }
}

/**
 * Switch view mode for a specific session
 */
export function setSessionViewMode(sessionName, mode) {
  stopVoiceInput();
  const currentSess = getCurrentSessionName(sessionName);
  if (currentSess) {
    sessionViewModes.set(currentSess, mode);
    try {
      localStorage.setItem(`deck_mode_${currentSess}`, mode);
    } catch (e) {}
  }
  try {
    localStorage.setItem('deck_global_mode_pref', mode);
  } catch (e) {}
  applySessionViewMode(currentSess, mode);
}

const sessionSupportCache = new Map(); // sessionName -> boolean

/**
 * Check if a session supports Claude Code Agent Chat Mode
 */
export async function checkSessionSupport(sessionName) {
  if (!sessionName) return false;
  if (sessionSupportCache.has(sessionName)) {
    return sessionSupportCache.get(sessionName);
  }
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chat-history`);
    if (res.ok) {
      const data = await res.json();
      const isSupp = data.supported === true;
      sessionSupportCache.set(sessionName, isSupp);
      return isSupp;
    }
  } catch (e) {}
  sessionSupportCache.set(sessionName, false);
  return false;
}

/**
 * Apply the current session's view mode to the UI
 */
export async function applySessionViewMode(sessionName, forceMode) {
  const terminalContainer = document.getElementById('terminal-container');
  const chatContainer = document.getElementById('agentChatContainer');
  const btnTerminal = document.getElementById('modeBtnTerminal');
  const btnChat = document.getElementById('modeBtnChat');
  const switcher = document.getElementById('deckModeSwitcher');
  const mobileControls = document.querySelector('.mobile-bottom-controls');
  const workspaceMain = document.querySelector('.terminal-workspace');

  if (!terminalContainer || !chatContainer || !btnTerminal || !btnChat) return;

  const currentSess = getCurrentSessionName(sessionName);

  if (!currentSess) {
    if (switcher) switcher.style.display = 'none';
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    stopChatPolling();
    return;
  }

  // Determine target mode: prioritize forceMode -> per-session memory/localStorage -> global preference -> default 'terminal'
  let targetMode = forceMode;
  if (!targetMode) {
    targetMode = sessionViewModes.get(currentSess);
    if (!targetMode) {
      try {
        targetMode = localStorage.getItem(`deck_mode_${currentSess}`);
      } catch (e) {}
    }
    if (!targetMode) {
      try {
        targetMode = localStorage.getItem('deck_global_mode_pref');
      } catch (e) {}
      if (!targetMode) {
        targetMode = 'terminal';
      }
    }
  }

  const workspaceTabs = document.getElementById('workspaceTabs');

  // Optimistically switch to chat UI if user preferred chat mode and session is not confirmed unsupported
  const cachedSupport = sessionSupportCache.get(currentSess);
  if (targetMode === 'chat' && cachedSupport !== false) {
    terminalContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    btnChat.classList.add('active');
    btnTerminal.classList.remove('active');
    if (switcher) switcher.style.display = 'inline-flex';
    if (workspaceTabs) workspaceTabs.classList.add('hidden');
    if (mobileControls) {
      mobileControls.classList.add('hidden');
      mobileControls.style.display = 'none';
    }
    if (workspaceMain) {
      workspaceMain.classList.remove('has-mobile-controls');
    }
  } else if (cachedSupport !== true && switcher) {
    switcher.style.display = 'none';
  }

  // 1. Verify if this terminal session supports Agent Chat Mode (Claude Code only for now)
  const isSupported = await checkSessionSupport(currentSess);

  // Guard against tab switching mid-fetch: only proceed if currentSess is still active
  const activeSessNow = getCurrentSessionName();
  if (activeSessNow && activeSessNow !== currentSess) {
    return;
  }

  if (!isSupported) {
    // Hide the mode switcher entirely for non-Claude terminals (pure terminal experience)
    if (switcher) switcher.style.display = 'none';
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    btnTerminal.classList.add('active');
    btnChat.classList.remove('active');

    if (workspaceTabs && state.tabs && state.tabs.length > 0) {
      workspaceTabs.classList.remove('hidden');
    }

    if (mobileControls) {
      mobileControls.classList.remove('hidden');
      mobileControls.style.display = '';
    }
    if (workspaceMain) {
      workspaceMain.classList.add('has-mobile-controls');
    }

    stopChatPolling();
    fitTerminal();
    return;
  }

  // Show mode switcher for supported Claude Code sessions
  if (switcher) switcher.style.display = 'inline-flex';

  sessionViewModes.set(currentSess, targetMode);

  console.log('[ChatMode] Applying mode:', targetMode, 'for session:', currentSess);

  if (targetMode === 'chat') {
    terminalContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    btnChat.classList.add('active');
    btnTerminal.classList.remove('active');

    if (workspaceTabs) {
      workspaceTabs.classList.add('hidden');
    }

    // Hide original mobile bottom controls (input bar + helper keyboard) to eliminate double-inputs
    if (mobileControls) {
      mobileControls.classList.add('hidden');
      mobileControls.style.display = 'none';
    }
    if (workspaceMain) {
      workspaceMain.classList.remove('has-mobile-controls');
    }

    loadAndRenderChatHistory(currentSess, true);
    startChatPolling(currentSess);
  } else {
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    btnTerminal.classList.add('active');
    btnChat.classList.remove('active');

    if (workspaceTabs && state.tabs && state.tabs.length > 0) {
      workspaceTabs.classList.remove('hidden');
    }

    // Restore mobile bottom controls in classic terminal mode
    if (mobileControls) {
      mobileControls.classList.remove('hidden');
      mobileControls.style.display = '';
    }
    if (workspaceMain) {
      workspaceMain.classList.add('has-mobile-controls');
    }

    stopChatPolling();
    fitTerminal();
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

/**
 * Bind composer input and buttons
 */
function bindComposerEvents() {
  const textarea = document.getElementById('chatComposerTextarea');
  const sendBtn = document.getElementById('chatSendMsgBtn');
  const interruptBtn = document.getElementById('chatInterruptBtn');

  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        sendChatMessage();
      }
    });

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendChatMessage();
    });
  }

  if (interruptBtn) {
    interruptBtn.addEventListener('click', () => {
      sendRawToTmux('\x03');
      updateStatusBadge('已中断当前任务', 'waiting');
    });
  }
}

/**
 * Send raw characters to current tmux session stdin
 */
export function sendRawToTmux(text) {
  const currentSess = getCurrentSessionName();
  if (!currentSess) return;
  let cached = state.sessionCache.get(currentSess);
  if (!cached || !cached.socket) {
    if (typeof attachSession === 'function') {
      attachSession(currentSess);
      cached = state.sessionCache.get(currentSess);
    }
  }
  if (cached && cached.socket) {
    cached.socket.emit('terminal-input', text);
  } else {
    console.warn('[ChatMode] Unable to send to tmux: session socket not found for', currentSess);
  }
}

/**
 * Send user message to the agent
 */
function sendChatMessage() {
  const textarea = document.getElementById('chatComposerTextarea');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;

  stopVoiceInput();

  const currentSess = getCurrentSessionName();
  if (!currentSess) return;

  // 1. Optimistic append
  appendUserMessageToUI(text);

  // 2. Clear input
  textarea.value = '';
  textarea.style.height = 'auto';

  // 3. Pipe to tmux: terminal raw mode requires \r (Carriage Return / Enter) to submit
  sendRawToTmux(text + '\r');

  // 4. Update status indicator
  updateStatusBadge('思考与执行中...', 'working');

  // 5. Trigger quick update
  setTimeout(() => {
    if (getCurrentSessionName() === currentSess) {
      loadAndRenderChatHistory(currentSess, false);
    }
  }, 1200);
}

/**
 * Fetch and render chat history strictly for the requested session
 */
export async function loadAndRenderChatHistory(sessionName, isSessionSwitch = false) {
  if (!sessionName) return;

  // If switching sessions, clear view immediately to prevent cross-session flash
  if (isSessionSwitch) {
    const cachedData = sessionHistoryCache.get(sessionName);
    if (cachedData) {
      renderMessages(sessionName, cachedData);
    } else {
      const container = document.getElementById('agentChatMessages');
      if (container) {
        container.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #64748b; font-size: 11px;">
            <span>正在读取会话记录...</span>
          </div>
        `;
      }
    }
  }

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chat-history`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Guard: ignore response if user already switched away from this session
    if (getCurrentSessionName() !== sessionName) {
      return;
    }

    const previousCache = sessionHistoryCache.get(sessionName);
    if (previousCache && previousCache.lastUpdated === data.lastUpdated && !isSessionSwitch) {
      return; // No changes
    }

    sessionHistoryCache.set(sessionName, data);
    renderMessages(sessionName, data);
  } catch (err) {
    console.warn('[ChatMode] Failed to fetch chat history for', sessionName, err.message);
  }
}

/**
 * Render message list strictly for a given session
 */
function renderMessages(sessionName, data) {
  const currentSess = getCurrentSessionName();
  if (sessionName && currentSess && currentSess !== sessionName) return;

  const container = document.getElementById('agentChatMessages');
  const agentNameEl = document.getElementById('chatAgentName');
  if (!container) return;

  const displaySession = sessionName || currentSess || '主会话';
  const agentLabel = (data && data.agentType) ? data.agentType.toUpperCase() : 'TMUX 智能体';
  if (agentNameEl) {
    agentNameEl.textContent = `${agentLabel} · ${displaySession}`;
  }

  const messages = (data && data.messages) ? data.messages : [];

  if (messages.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #64748b; text-align: center; padding: 20px;">
        <i data-lucide="terminal" style="width: 32px; height: 32px; margin-bottom: 10px; color: var(--neon-cyan); opacity: 0.6;"></i>
        <div style="font-size: 13px; color: #fff; font-weight: 600; margin-bottom: 4px;">会话「${escapeHtml(displaySession)}」已就绪</div>
        <div style="font-size: 11px; max-width: 320px; line-height: 1.5; color: #94a3b8;">
          在下方输入框发送需求即可与当前终端直接交互。如需查看原始字符流，可随时点击右上角切回「终端」。
        </div>
      </div>
    `;
    updateStatusBadge('就绪', 'ready');
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  let html = '';
  for (const msg of messages) {
    const isUser = msg.role === 'user';
    let bodyHtml = '';

    // Thinking process (clean, minimal)
    if (msg.thinking) {
      bodyHtml += `
        <details class="chat-accordion">
          <summary>▶ 思考过程</summary>
          <div class="chat-accordion-content">${escapeHtml(msg.thinking)}</div>
        </details>
      `;
    }

    // Tool executions
    if (msg.tools && msg.tools.length > 0) {
      const toolNames = msg.tools.map(t => t.name).join(', ');
      bodyHtml += `
        <details class="chat-accordion">
          <summary>▶ 工具执行: ${escapeHtml(toolNames)}</summary>
          <div class="chat-accordion-content">${escapeHtml(JSON.stringify(msg.tools, null, 2))}</div>
        </details>
      `;
    }

    // Markdown / Content
    if (msg.content) {
      if (!isUser && window.marked) {
        try {
          bodyHtml += `<div>${window.marked.parse(msg.content)}</div>`;
        } catch (e) {
          bodyHtml += `<div>${escapeHtml(msg.content)}</div>`;
        }
      } else {
        bodyHtml += `<div>${escapeHtml(msg.content)}</div>`;
      }
    }

    html += `
      <div class="chat-msg-row ${isUser ? 'user' : 'assistant'}" id="${msg.id}">
        <div class="chat-bubble-wrap">
          <div class="chat-bubble">
            ${bodyHtml}
          </div>
        </div>
      </div>
    `;
  }

  // Pending action card (approval/rejection)
  if (data.pendingAction && data.pendingAction.type === 'yn') {
    html += `
      <div class="chat-decision-card" id="chatActiveDecisionCard">
        <span class="chat-decision-title">⚠️ 智能体请求确认操作</span>
        <div class="chat-decision-actions">
          <button class="chat-action-btn approve" id="btnApproveAction">
            <span>批准 (y)</span>
          </button>
          <button class="chat-action-btn reject" id="btnRejectAction">
            <span>拒绝 (n)</span>
          </button>
        </div>
      </div>
    `;
    updateStatusBadge('等待确认', 'waiting');
  } else {
    updateStatusBadge('就绪', 'ready');
  }

  container.innerHTML = html;

  const btnApprove = document.getElementById('btnApproveAction');
  const btnReject = document.getElementById('btnRejectAction');
  if (btnApprove) {
    btnApprove.addEventListener('click', () => {
      sendRawToTmux('y\r');
      btnApprove.disabled = true;
      btnApprove.textContent = '已批准';
      updateStatusBadge('执行中...', 'working');
    });
  }
  if (btnReject) {
    btnReject.addEventListener('click', () => {
      sendRawToTmux('n\r');
      btnReject.disabled = true;
      btnReject.textContent = '已拒绝';
      updateStatusBadge('就绪', 'ready');
    });
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }

  container.scrollTop = container.scrollHeight;
}

/**
 * Optimistically append user message
 */
function appendUserMessageToUI(text) {
  const container = document.getElementById('agentChatMessages');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'chat-msg-row user';
  row.innerHTML = `
    <div class="chat-bubble-wrap">
      <div class="chat-bubble">${escapeHtml(text)}</div>
    </div>
  `;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

/**
 * Update minimalist top status badge
 */
function updateStatusBadge(text, stateType) {
  const dot = document.getElementById('chatStatusDot');
  const statusText = document.getElementById('chatStatusText');
  if (!dot || !statusText) return;

  statusText.textContent = text;
  dot.className = 'agent-status-dot ' + (stateType || 'ready');
}

/**
 * Polling controller for active session
 */
function startChatPolling(sessionName) {
  stopChatPolling();
  if (!sessionName) return;
  activePollSession = sessionName;
  currentPollTimer = setInterval(() => {
    if (getCurrentSessionName() === sessionName) {
      loadAndRenderChatHistory(sessionName, false);
    } else {
      stopChatPolling();
    }
  }, 2000);
}

function stopChatPolling() {
  if (currentPollTimer) {
    clearInterval(currentPollTimer);
    currentPollTimer = null;
  }
  activePollSession = null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[m]);
}
