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
 * Curated Pool of Beginner-Friendly Starter Missions (Single-Page HTML Mini-Apps)
 */
const STARTER_TIPS_POOL = [
  {
    id: 'weekly-report',
    icon: 'file-text',
    label: '周五周报排版器',
    prompt: '请在当前工作目录下帮我编写一个单文件 HTML 网页应用：周五周报与工作总结排版器。要求界面简洁现代，支持输入零散工作流水账后一键按本周完成、下周规划、风险协同进行排版，支持一键复制富文本和本地存储，所有 CSS 和 JS 均内嵌在同一个 HTML 文件中，方便我直接在浏览器中打开使用。'
  },
  {
    id: 'lunch-wheel',
    icon: 'disc',
    label: '中午吃什么转盘',
    prompt: '请在当前工作目录下帮我编写一个单文件 HTML 网页应用：中午吃什么 / 聚餐幸运大转盘。要求界面精致好看，使用纯 HTML5 Canvas 绘制丝滑旋转的大转盘，支持自定义添加/删除餐厅选项，抽中后有全屏彩色纸屑撒花庆祝动画，所有 CSS 和 JS 均内嵌在同一个 HTML 文件中。'
  },
  {
    id: 'pomodoro-timer',
    icon: 'timer',
    label: '专注番茄钟看板',
    prompt: '请在当前工作目录下帮我编写一个单文件 HTML 网页应用：极简办公专注番茄钟看板。要求界面具有暗黑极简科技感，包含 25 分钟专注 / 5 分钟休息倒计时、今日专注时长打卡统计，以及久坐放松提醒，所有 CSS 和 JS 均内嵌在同一个 HTML 文件中，开箱即用。'
  },
  {
    id: 'salary-calc',
    icon: 'calculator',
    label: '薪资个税测算器',
    prompt: '请在当前工作目录下帮我编写一个单文件 HTML 网页应用：白领薪资与五险一金个税测算器。要求界面整洁专业，输入税前月薪和社保公积金比例，动态计算出个人与公司缴纳明细、税后到手收入，并通过 CSS 进度条直观展示各项扣除比例，所有 CSS 和 JS 均内嵌在同一个 HTML 文件中。'
  },
  {
    id: 'matrix-board',
    icon: 'layout-grid',
    label: '四象限任务便签',
    prompt: '请在当前工作目录下帮我编写一个单文件 HTML 网页应用：四象限工作任务便签板。要求根据“重要-紧急”法则划分四个清晰的色彩区域，支持双击或点击新建任务卡片、拖拽移动卡片象限、勾选完成与本地 LocalStorage 自动保存，所有 CSS 和 JS 均内嵌在同一个 HTML 文件中。'
  }
];

let currentTipIndices = [0, 1, 2];

function renderStarterPillsHtml() {
  const tips = currentTipIndices.map(i => STARTER_TIPS_POOL[i]);
  const tipsHtml = tips.map(t => `
    <button class="chat-starter-pill" data-prompt="${escapeHtml(t.prompt)}" title="${escapeHtml(t.prompt)}">
      <i data-lucide="${escapeHtml(t.icon)}"></i>
      <span>${escapeHtml(t.label)}</span>
    </button>
  `).join('');

  return `
    ${tipsHtml}
    <button class="chat-starter-pill shuffle" id="btnShuffleStarterTips" title="换一批灵感">
      <i data-lucide="refresh-cw"></i>
      <span>换个灵感</span>
    </button>
  `;
}

function shuffleStarterTips() {
  const poolLen = STARTER_TIPS_POOL.length;
  const indices = [];
  while (indices.length < Math.min(3, poolLen)) {
    const r = Math.floor(Math.random() * poolLen);
    if (!indices.includes(r)) indices.push(r);
  }
  currentTipIndices = indices;
  const pillsContainer = document.getElementById('chatStarterPills');
  if (pillsContainer) {
    pillsContainer.innerHTML = renderStarterPillsHtml();
    if (window.lucide) window.lucide.createIcons();
  }
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

  // Optimistically switch to chat UI if user preferred chat mode and session is not confirmed unsupported
  const cachedSupport = sessionSupportCache.get(currentSess);
  if (targetMode === 'chat' && cachedSupport !== false) {
    terminalContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    btnChat.classList.add('active');
    btnTerminal.classList.remove('active');
    if (switcher) switcher.style.display = 'inline-flex';
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

  // Delegate clicks on starter tips within agentChatMessages
  const msgContainer = document.getElementById('agentChatMessages');
  if (msgContainer && !msgContainer.dataset.starterBound) {
    msgContainer.dataset.starterBound = 'true';
    msgContainer.addEventListener('click', (e) => {
      const shuffleBtn = e.target.closest('#btnShuffleStarterTips');
      if (shuffleBtn) {
        e.preventDefault();
        e.stopPropagation();
        shuffleStarterTips();
        return;
      }

      const pill = e.target.closest('.chat-starter-pill:not(.shuffle)');
      if (pill && pill.dataset.prompt) {
        e.preventDefault();
        e.stopPropagation();
        const textarea = document.getElementById('chatComposerTextarea');
        if (textarea) {
          textarea.value = pill.dataset.prompt;
          textarea.style.height = 'auto';
          textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
          textarea.focus();
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
      }
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
export function sendChatMessage(overrideText) {
  const textarea = document.getElementById('chatComposerTextarea');
  const text = (typeof overrideText === 'string' ? overrideText : (textarea ? textarea.value : '')).trim();
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
      <div class="chat-empty-state">
        <div class="chat-empty-icon">
          <i data-lucide="sparkles" style="width: 26px; height: 26px; color: var(--neon-cyan); opacity: 0.85;"></i>
        </div>
        <div class="chat-empty-title">会话「${escapeHtml(displaySession)}」已就绪</div>
        <div class="chat-empty-desc">
          在下方输入需求，或点击灵感快捷填入并确认发送：
        </div>
        <div class="chat-starter-pills" id="chatStarterPills">
          ${renderStarterPillsHtml()}
        </div>
      </div>
    `;
    updateStatusBadge('就绪', 'ready');
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  let html = '';
  let hasRenderedActiveQuestion = false;

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
    let hasAskQuestionTool = false;
    if (msg.tools && msg.tools.length > 0) {
      const askTools = msg.tools.filter(t => t.isAskQuestion || t.name === 'AskUserQuestion');
      const otherTools = msg.tools.filter(t => !t.isAskQuestion && t.name !== 'AskUserQuestion');

      if (askTools.length > 0) {
        hasAskQuestionTool = true;
        askTools.forEach(at => {
          const isInteractive = Boolean(
            data.pendingAction && 
            data.pendingAction.type === 'ask_question' && 
            (!data.pendingAction.toolUseId || data.pendingAction.toolUseId === at.id)
          );
          if (isInteractive) {
            hasRenderedActiveQuestion = true;
          }
          bodyHtml += renderQuestionCardHtml(at.questions || (at.input && at.input.questions) || [], isInteractive, at.id);
        });
      }

      if (otherTools.length > 0) {
        const toolNames = otherTools.map(t => t.name).join(', ');
        bodyHtml += `
          <details class="chat-accordion">
            <summary>▶ 工具执行: ${escapeHtml(toolNames)}</summary>
            <div class="chat-accordion-content">${escapeHtml(JSON.stringify(otherTools, null, 2))}</div>
          </details>
        `;
      }
    }

    // Markdown / Content
    if (msg.content) {
      // If AskUserQuestion card is already rendered, skip raw text fallback that repeats questions
      const isQuestionFallback = hasAskQuestionTool && msg.content.includes('智能体发起提问');
      if (!isQuestionFallback) {
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

  // Pending action card (ask_question / permission / yn)
  if (data.pendingAction) {
    if (data.pendingAction.type === 'ask_question') {
      if (!hasRenderedActiveQuestion) {
        html += renderQuestionCardHtml(data.pendingAction.questions || [], true, data.pendingAction.toolUseId || '');
      }
      updateStatusBadge('等待回答提问', 'waiting');
    } else if (data.pendingAction.type === 'permission') {
      html += renderPermissionCard(data.pendingAction);
      updateStatusBadge('等待权限审批', 'waiting');
    } else if (data.pendingAction.type === 'yn') {
      html += renderYnDecisionCard(data.pendingAction);
      updateStatusBadge('等待确认', 'waiting');
    } else {
      updateStatusBadge('就绪', 'ready');
    }
  } else {
    updateStatusBadge('就绪', 'ready');
  }

  container.innerHTML = html;
  bindDecisionCardEvents(data.pendingAction);

  if (window.lucide) {
    window.lucide.createIcons();
  }

  container.scrollTop = container.scrollHeight;
}

/**
 * Render Question Card (both interactive and completed history states)
 */
function renderQuestionCardHtml(questions, isInteractive = false, toolUseId = '') {
  if (!questions || questions.length === 0) return '';

  let questionsHtml = '';
  questions.forEach((q, qIdx) => {
    const headerBadge = q.header ? `<span class="chat-q-header-tag">${escapeHtml(q.header)}</span>` : '';
    
    let optionsHtml = '';
    (q.options || []).forEach((opt, oIdx) => {
      const num = oIdx + 1;
      if (isInteractive) {
        optionsHtml += `
          <button class="chat-opt-btn" data-qidx="${qIdx}" data-oidx="${oIdx}" data-num="${num}" type="button">
            <div class="chat-opt-top">
              <span class="chat-opt-num">${num}</span>
              <span class="chat-opt-label">${escapeHtml(opt.label)}</span>
            </div>
            ${opt.description ? `<div class="chat-opt-desc">${escapeHtml(opt.description)}</div>` : ''}
          </button>
        `;
      } else {
        optionsHtml += `
          <div class="chat-opt-static">
            <div class="chat-opt-top">
              <span class="chat-opt-num">${num}</span>
              <span class="chat-opt-label">${escapeHtml(opt.label)}</span>
            </div>
            ${opt.description ? `<div class="chat-opt-desc">${escapeHtml(opt.description)}</div>` : ''}
          </div>
        `;
      }
    });

    questionsHtml += `
      <div class="chat-q-block" data-qidx="${qIdx}">
        <div class="chat-q-title-row">
          ${headerBadge}
          <span class="chat-q-title">${escapeHtml(q.question)}</span>
        </div>
        <div class="chat-q-options">
          ${optionsHtml}
        </div>
      </div>
    `;
  });

  if (isInteractive) {
    return `
      <div class="chat-decision-card chat-question-card interactive" id="chatActiveQuestionCard" data-total-q="${questions.length}" data-tool-id="${escapeHtml(toolUseId)}">
        <div class="chat-decision-header">
          <div class="chat-decision-header-left">
            <i data-lucide="help-circle" class="chat-decision-icon question"></i>
            <span class="chat-decision-title">智能体向您提问（请选择回答）</span>
          </div>
          <span class="chat-q-counter">共 ${questions.length} 个问题</span>
        </div>
        <div class="chat-question-body">
          ${questionsHtml}
        </div>
        <div class="chat-decision-footer">
          <button class="chat-action-btn reject" id="btnCancelQuestion" title="取消 (Esc)">
            <i data-lucide="x"></i>
            <span>取消 (Esc)</span>
          </button>
          ${questions.length > 1 ? `
            <button class="chat-action-btn approve" id="btnSubmitAllQuestions" disabled title="请完成所有问题选择后提交">
              <i data-lucide="check"></i>
              <span>提交全部回答</span>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  } else {
    return `
      <div class="chat-decision-card chat-question-card static">
        <div class="chat-decision-header">
          <div class="chat-decision-header-left">
            <i data-lucide="help-circle" class="chat-decision-icon question"></i>
            <span class="chat-decision-title">智能体提问</span>
          </div>
          <span class="chat-q-counter">已完成</span>
        </div>
        <div class="chat-question-body">
          ${questionsHtml}
        </div>
      </div>
    `;
  }
}

/**
 * Render interactive Tool Permission Approval card
 */
function renderPermissionCard(pending) {
  const toolName = pending.toolName || '工具执行';
  const toolInput = pending.toolInput || {};
  const cmd = toolInput.command || '';
  const desc = toolInput.description || '';
  const filePath = toolInput.file_path || toolInput.filePath || '';
  const canAutoMode = pending.canAutoMode !== false;

  return `
    <div class="chat-decision-card chat-permission-card" id="chatActiveDecisionCard" data-tool-id="${escapeHtml(pending.toolUseId || '')}">
      <div class="chat-decision-header">
        <div class="chat-decision-header-left">
          <i data-lucide="shield-alert" class="chat-decision-icon warning"></i>
          <span class="chat-decision-title">⚠️ 智能体请求权限审批</span>
        </div>
        <span class="chat-perm-tool-badge">${escapeHtml(toolName)}</span>
      </div>
      
      <div class="chat-permission-details">
        ${cmd ? `
          <div class="chat-permission-field">
            <span class="chat-field-label">拟执行命令：</span>
            <pre class="chat-cmd-box"><code>${escapeHtml(cmd)}</code></pre>
          </div>
        ` : ''}
        ${filePath ? `
          <div class="chat-permission-field">
            <span class="chat-field-label">目标文件：</span>
            <code class="chat-code-val">${escapeHtml(filePath)}</code>
          </div>
        ` : ''}
        ${desc ? `
          <div class="chat-permission-field">
            <span class="chat-field-label">用途说明：</span>
            <span class="chat-field-val">${escapeHtml(desc)}</span>
          </div>
        ` : ''}
      </div>

      <div class="chat-decision-actions">
        <button class="chat-action-btn approve" id="btnApproveAction" title="允许本次执行 (1 / Yes)">
          <i data-lucide="check"></i>
          <span>批准执行 (Yes)</span>
        </button>
        ${canAutoMode ? `
          <button class="chat-action-btn auto-mode" id="btnAutoModeAction" title="切换到自动模式，后续无需频繁确认 (3)">
            <i data-lucide="zap"></i>
            <span>切换自动模式</span>
          </button>
        ` : ''}
        <button class="chat-action-btn reject" id="btnRejectAction" title="拒绝执行此操作 (4 / No)">
          <i data-lucide="x"></i>
          <span>拒绝 (No)</span>
        </button>
      </div>
    </div>
  `;
}

/**
 * Render classic (y/n) decision card
 */
function renderYnDecisionCard(pending) {
  return `
    <div class="chat-decision-card" id="chatActiveDecisionCard">
      <div class="chat-decision-header">
        <div class="chat-decision-header-left">
          <i data-lucide="alert-triangle" class="chat-decision-icon warning"></i>
          <span class="chat-decision-title">${escapeHtml(pending.hint || '智能体请求确认操作')}</span>
        </div>
      </div>
      <div class="chat-decision-actions">
        <button class="chat-action-btn approve" id="btnApproveAction">
          <i data-lucide="check"></i>
          <span>批准 (y)</span>
        </button>
        <button class="chat-action-btn reject" id="btnRejectAction">
          <i data-lucide="x"></i>
          <span>拒绝 (n)</span>
        </button>
      </div>
    </div>
  `;
}

/**
 * Bind decision card events for all modes
 */
function bindDecisionCardEvents(pending) {
  if (!pending) return;

  // 1. AskUserQuestion
  if (pending.type === 'ask_question') {
    const card = document.getElementById('chatActiveQuestionCard');
    if (!card) return;

    const totalQ = parseInt(card.dataset.totalQ, 10) || 1;
    const btnCancel = document.getElementById('btnCancelQuestion');
    const btnSubmitAll = document.getElementById('btnSubmitAllQuestions');

    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        sendRawToTmux('\x1b');
        card.style.opacity = '0.5';
        card.style.pointerEvents = 'none';
        updateStatusBadge('已取消提问', 'ready');
        setTimeout(() => {
          const currentSess = getCurrentSessionName();
          if (currentSess) loadAndRenderChatHistory(currentSess, false);
        }, 1000);
      });
    }

    if (totalQ === 1) {
      // Single question mode: direct click to answer
      card.querySelectorAll('.chat-opt-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const num = btn.dataset.num;
          if (!num) return;

          btn.classList.add('selected');
          card.querySelectorAll('.chat-opt-btn').forEach(b => {
            b.disabled = true;
          });
          card.style.opacity = '0.7';
          card.style.pointerEvents = 'none';

          sendRawToTmux(num);
          updateStatusBadge('已提交回答，执行中...', 'working');

          setTimeout(() => {
            const currentSess = getCurrentSessionName();
            if (currentSess) loadAndRenderChatHistory(currentSess, false);
          }, 1000);
        });
      });
    } else {
      // Multi-question mode: track selected option per question block
      const selectedAnswers = new Map(); // qIdx -> num

      card.querySelectorAll('.chat-opt-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const qIdx = btn.dataset.qidx;
          const num = btn.dataset.num;
          if (!qIdx || !num) return;

          const block = btn.closest('.chat-q-block');
          if (block) {
            block.querySelectorAll('.chat-opt-btn').forEach(b => b.classList.remove('selected'));
          }
          btn.classList.add('selected');
          selectedAnswers.set(qIdx, num);

          // Check if all questions are answered
          if (selectedAnswers.size >= totalQ && btnSubmitAll) {
            btnSubmitAll.disabled = false;
          }
        });
      });

      if (btnSubmitAll) {
        btnSubmitAll.addEventListener('click', (e) => {
          e.preventDefault();
          if (selectedAnswers.size < totalQ) return;

          btnSubmitAll.disabled = true;
          btnSubmitAll.textContent = '提交中...';
          card.style.opacity = '0.7';
          card.style.pointerEvents = 'none';

          // Send sequential keypresses to tmux
          const sortedKeys = Array.from({ length: totalQ }, (_, i) => selectedAnswers.get(String(i)) || '1');
          let delay = 0;
          sortedKeys.forEach(key => {
            setTimeout(() => {
              sendRawToTmux(key);
            }, delay);
            delay += 250;
          });

          // Confirm submit review screen
          setTimeout(() => {
            sendRawToTmux('1\r');
            updateStatusBadge('已提交回答，执行中...', 'working');
            setTimeout(() => {
              const currentSess = getCurrentSessionName();
              if (currentSess) loadAndRenderChatHistory(currentSess, false);
            }, 1000);
          }, delay + 100);
        });
      }
    }
    return;
  }

  // 2. Permission Approval
  if (pending.type === 'permission') {
    const btnApprove = document.getElementById('btnApproveAction');
    const btnAutoMode = document.getElementById('btnAutoModeAction');
    const btnReject = document.getElementById('btnRejectAction');
    const card = document.getElementById('chatActiveDecisionCard');

    if (btnApprove) {
      btnApprove.addEventListener('click', () => {
        sendRawToTmux('1');
        if (card) {
          card.style.opacity = '0.6';
          card.style.pointerEvents = 'none';
        }
        btnApprove.disabled = true;
        btnApprove.textContent = '已批准';
        updateStatusBadge('已批准执行，运行中...', 'working');
        setTimeout(() => {
          const currentSess = getCurrentSessionName();
          if (currentSess) loadAndRenderChatHistory(currentSess, false);
        }, 1000);
      });
    }

    if (btnAutoMode) {
      btnAutoMode.addEventListener('click', () => {
        sendRawToTmux('3');
        if (card) {
          card.style.opacity = '0.6';
          card.style.pointerEvents = 'none';
        }
        btnAutoMode.disabled = true;
        btnAutoMode.textContent = '已切换自动模式';
        updateStatusBadge('已切换为自动模式，运行中...', 'working');
        setTimeout(() => {
          const currentSess = getCurrentSessionName();
          if (currentSess) loadAndRenderChatHistory(currentSess, false);
        }, 1000);
      });
    }

    if (btnReject) {
      btnReject.addEventListener('click', () => {
        sendRawToTmux('4');
        if (card) {
          card.style.opacity = '0.6';
          card.style.pointerEvents = 'none';
        }
        btnReject.disabled = true;
        btnReject.textContent = '已拒绝';
        updateStatusBadge('已拒绝操作', 'ready');
        setTimeout(() => {
          const currentSess = getCurrentSessionName();
          if (currentSess) loadAndRenderChatHistory(currentSess, false);
        }, 1000);
      });
    }
    return;
  }

  // 3. Classic (y/n)
  if (pending.type === 'yn') {
    const btnApprove = document.getElementById('btnApproveAction');
    const btnReject = document.getElementById('btnRejectAction');
    const card = document.getElementById('chatActiveDecisionCard');

    if (btnApprove) {
      btnApprove.addEventListener('click', () => {
        sendRawToTmux('y\r');
        if (card) {
          card.style.opacity = '0.6';
          card.style.pointerEvents = 'none';
        }
        btnApprove.disabled = true;
        btnApprove.textContent = '已批准';
        updateStatusBadge('执行中...', 'working');
        setTimeout(() => {
          const currentSess = getCurrentSessionName();
          if (currentSess) loadAndRenderChatHistory(currentSess, false);
        }, 1000);
      });
    }

    if (btnReject) {
      btnReject.addEventListener('click', () => {
        sendRawToTmux('n\r');
        if (card) {
          card.style.opacity = '0.6';
          card.style.pointerEvents = 'none';
        }
        btnReject.disabled = true;
        btnReject.textContent = '已拒绝';
        updateStatusBadge('就绪', 'ready');
        setTimeout(() => {
          const currentSess = getCurrentSessionName();
          if (currentSess) loadAndRenderChatHistory(currentSess, false);
        }, 1000);
      });
    }
  }
}

/**
 * Optimistically append user message
 */
function appendUserMessageToUI(text) {
  const container = document.getElementById('agentChatMessages');
  if (!container) return;

  // Clear empty state placeholder if present
  const emptyState = container.querySelector('.chat-empty-state');
  if (emptyState) {
    container.innerHTML = '';
  }

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
