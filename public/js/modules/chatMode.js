/**
 * Cyberpunk TMUX Agent Deck - CDS Interaction Physics & Dual-Theme Chat Mode Module
 * Incorporates open-claude-ui Scroll Pinning, 7-Stop Fade Mask, CSS Grid 0fr->1fr Accordions,
 * Borderless Assistant Prose, 20px Dual-Ring Composer, and Slash Command Engine.
 */

import { state } from './state.js';
import { fitTerminal, attachSession, isTouchDevice } from './terminal.js';
import { stopVoiceInput } from './voice.js';

const sessionViewModes = new Map();
const sessionHistoryCache = new Map(); // sessionName -> { messages, lastUpdated, pendingAction, agentType }
const expandedAccordions = new Set();  // Set of `${sessionName}::${accordionKey}` to persist user toggle across polls
let currentPollTimer = null;
let activePollSession = null;

// Scroll Pinning Physics State (open-claude-ui 150ms cooldown + 40px bottom tolerance)
const SCROLL_COOL_DOWN_MS = 150;
let lastUserScrollAt = 0;
let programmaticScroll = false;
let isScrollPinned = true;

// Slash Commands Registry for Composer Popover
const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '清空当前智能体对话上下文' },
  { cmd: '/compact', desc: '压缩上下文历史并释放 Token 空间' },
  { cmd: '/status', desc: '查看当前会话与模型状态' },
  { cmd: '/cost', desc: '查看当前会话 Token 消耗统计' },
  { cmd: '/help', desc: '显示智能体内置帮助指令' }
];
let slashPopoverOpen = false;
let slashActiveIndex = 0;
let filteredSlashCommands = [...SLASH_COMMANDS];

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

  // 2. Inject 999px Segmented Control Switcher directly into terminalPanel
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

    btnTerminal.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentSess = getCurrentSessionName();
      setSessionViewMode(currentSess, 'terminal');
    });

    btnChat.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentSess = getCurrentSessionName();
      setSessionViewMode(currentSess, 'chat');
    });
  }

  // 3. Inject CDS Chat Container directly into terminalPanel
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

      <!-- Messages Stream (With 7-Stop Non-Linear Fade Mask & Scroll Pinning) -->
      <div class="agent-chat-messages" id="agentChatMessages">
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #64748b; font-size: 11px;">
          <span>载入中...</span>
        </div>
      </div>

      <!-- Floating Jump-to-Bottom Pill -->
      <button class="chat-jump-bottom-btn" id="chatJumpBottomBtn" type="button" title="回到底部最新消息">
        <i data-lucide="arrow-down"></i>
        <span>回到底部</span>
      </button>

      <!-- 20px Dual-Ring Composer Engine -->
      <div class="agent-chat-composer">
        <div class="chat-composer-shell">
          <!-- Slash Command Floating Popover -->
          <div class="chat-slash-popover hidden" id="chatSlashPopover"></div>

          <div class="chat-input-row">
            <textarea 
              class="chat-textarea" 
              id="chatComposerTextarea" 
              rows="1"
              placeholder="输入消息，或输入 / 呼出快捷指令..."
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              enterkeyhint="send"
            ></textarea>
            <div class="chat-composer-toolbar">
              <div class="chat-composer-tools-left">
                <button class="chat-ghost-pill-btn" id="chatSlashTriggerBtn" type="button" title="快捷指令 (/)">
                  <i data-lucide="slash"></i>
                  <span>指令</span>
                </button>
                <button class="chat-ghost-pill-btn" id="chatQuickClearBtn" type="button" title="发送 /clear 清空当前对话上下文">
                  <i data-lucide="eraser"></i>
                  <span>清空上下文</span>
                </button>
              </div>
              <div class="chat-composer-actions">
                <button class="chat-icon-btn" id="chatInterruptBtn" type="button" title="停止执行 (Ctrl+C)">
                  <i data-lucide="square" style="width: 14px; height: 14px;"></i>
                </button>
                <button class="chat-send-btn" id="chatSendMsgBtn" type="button" title="发送 (Enter)">
                  <i data-lucide="arrow-up" style="width: 15px; height: 15px;"></i>
                </button>
              </div>
            </div>
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
    bindScrollPinningEvents();
    bindComposerEvents();
    bindGlobalDecisionShortcuts();
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }

  const currentSess = getCurrentSessionName();
  if (currentSess) {
    applySessionViewMode(currentSess);
  }
}

/**
 * Bind open-claude-ui Scroll Pinning & 7-Stop Non-Linear Fade Mask Sensor
 */
function bindScrollPinningEvents() {
  const msgContainer = document.getElementById('agentChatMessages');
  const jumpBtn = document.getElementById('chatJumpBottomBtn');
  if (!msgContainer) return;

  const markUserManualScroll = () => {
    lastUserScrollAt = performance.now();
  };

  ['wheel', 'touchmove', 'pointerdown'].forEach(evt => {
    msgContainer.addEventListener(evt, markUserManualScroll, { passive: true });
  });

  msgContainer.addEventListener('scroll', () => {
    updateScrollFadeMask(msgContainer);

    if (programmaticScroll) {
      programmaticScroll = false;
      return;
    }

    const distanceFromBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
    isScrollPinned = distanceFromBottom <= 45;

    if (jumpBtn) {
      if (distanceFromBottom > 120) {
        jumpBtn.classList.add('visible');
      } else {
        jumpBtn.classList.remove('visible');
      }
    }
  }, { passive: true });

  if (jumpBtn) {
    jumpBtn.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToChatBottom(true);
    });
  }
}

/**
 * Update 7-Stop Non-Linear Alpha Mask CSS Variables on Scroll
 */
function updateScrollFadeMask(el) {
  if (!el) return;
  const scrollTop = el.scrollTop;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

  const topFade = scrollTop > 4 ? '24px' : '0px';
  const bottomFade = distanceFromBottom > 4 ? '24px' : '0px';

  el.style.setProperty('--cds-scroll-fade-top', topFade);
  el.style.setProperty('--cds-scroll-fade-bottom', bottomFade);
}

/**
 * Scroll chat stream to bottom respecting programmatic flag
 */
export function scrollToChatBottom(smooth = false) {
  const msgContainer = document.getElementById('agentChatMessages');
  const jumpBtn = document.getElementById('chatJumpBottomBtn');
  if (!msgContainer) return;

  programmaticScroll = true;
  isScrollPinned = true;
  if (jumpBtn) jumpBtn.classList.remove('visible');

  msgContainer.scrollTo({
    top: msgContainer.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto'
  });
  updateScrollFadeMask(msgContainer);
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

  const isSupported = await checkSessionSupport(currentSess);

  const activeSessNow = getCurrentSessionName();
  if (activeSessNow && activeSessNow !== currentSess) {
    return;
  }

  if (!isSupported) {
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

  if (switcher) switcher.style.display = 'inline-flex';
  sessionViewModes.set(currentSess, targetMode);

  if (targetMode === 'chat') {
    terminalContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    btnChat.classList.add('active');
    btnTerminal.classList.remove('active');

    if (mobileControls) {
      mobileControls.classList.add('hidden');
      mobileControls.style.display = 'none';
    }
    if (workspaceMain) {
      workspaceMain.classList.remove('has-mobile-controls');
    }

    isScrollPinned = true;
    loadAndRenderChatHistory(currentSess, true);
    startChatPolling(currentSess);
  } else {
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
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

/**
 * Render and manage the `/` Slash Command Popover with Roving Focus
 */
function updateSlashPopover(queryText) {
  const popover = document.getElementById('chatSlashPopover');
  if (!popover) return;

  if (queryText === null || !queryText.startsWith('/')) {
    slashPopoverOpen = false;
    popover.classList.add('hidden');
    return;
  }

  const prefix = queryText.trim().toLowerCase();
  filteredSlashCommands = SLASH_COMMANDS.filter(item => item.cmd.startsWith(prefix));

  if (filteredSlashCommands.length === 0) {
    slashPopoverOpen = false;
    popover.classList.add('hidden');
    return;
  }

  slashPopoverOpen = true;
  if (slashActiveIndex >= filteredSlashCommands.length) {
    slashActiveIndex = 0;
  }

  popover.innerHTML = `
    <div class="chat-slash-popover-title">// 快捷指令 (↑↓ 选择 · Enter 确认)</div>
    ${filteredSlashCommands.map((item, idx) => `
      <button type="button" class="chat-slash-item ${idx === slashActiveIndex ? 'active' : ''}" data-cmd="${escapeHtml(item.cmd)}">
        <span class="chat-slash-cmd">${escapeHtml(item.cmd)}</span>
        <span class="chat-slash-desc">${escapeHtml(item.desc)}</span>
      </button>
    `).join('')}
  `;
  popover.classList.remove('hidden');

  popover.querySelectorAll('.chat-slash-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = btn.dataset.cmd;
      if (cmd) executeOrFillSlashCommand(cmd);
    });
  });
}

function executeOrFillSlashCommand(cmd) {
  const textarea = document.getElementById('chatComposerTextarea');
  updateSlashPopover(null);
  if (!textarea) return;
  textarea.value = cmd;
  sendChatMessage(cmd);
}

/**
 * Bind composer input, CJK IME Guard, and Slash Command Popover
 */
function bindComposerEvents() {
  const textarea = document.getElementById('chatComposerTextarea');
  const sendBtn = document.getElementById('chatSendMsgBtn');
  const interruptBtn = document.getElementById('chatInterruptBtn');
  const slashTriggerBtn = document.getElementById('chatSlashTriggerBtn');
  const quickClearBtn = document.getElementById('chatQuickClearBtn');

  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      // 1. Strict CJK IME Composition Guard (open-claude-ui 3.3.2)
      if (e.isComposing || e.keyCode === 229) return;

      // 2. Roving Focus inside Slash Popover if open
      if (slashPopoverOpen && filteredSlashCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashActiveIndex = (slashActiveIndex + 1) % filteredSlashCommands.length;
          updateSlashPopover(textarea.value);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashActiveIndex = (slashActiveIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
          updateSlashPopover(textarea.value);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const chosen = filteredSlashCommands[slashActiveIndex];
          if (chosen) {
            executeOrFillSlashCommand(chosen.cmd);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          updateSlashPopover(null);
          return;
        }
      }

      // 3. Standard Enter to send
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';

      const val = textarea.value;
      if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
        updateSlashPopover(val);
      } else {
        updateSlashPopover(null);
      }
    });

    textarea.addEventListener('blur', () => {
      setTimeout(() => updateSlashPopover(null), 180);
    });
  }

  if (slashTriggerBtn && textarea) {
    slashTriggerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (slashPopoverOpen) {
        updateSlashPopover(null);
      } else {
        if (!textarea.value.startsWith('/')) {
          textarea.value = '/';
        }
        slashActiveIndex = 0;
        updateSlashPopover(textarea.value);
        textarea.focus();
      }
    });
  }

  if (quickClearBtn) {
    quickClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendChatMessage('/clear');
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

  // Delegate clicks on starter tips, accordions, and code copy buttons within agentChatMessages
  const msgContainer = document.getElementById('agentChatMessages');
  if (msgContainer && !msgContainer.dataset.delegatedBound) {
    msgContainer.dataset.delegatedBound = 'true';
    msgContainer.addEventListener('click', (e) => {
      // 1. Starter tips shuffle
      const shuffleBtn = e.target.closest('#btnShuffleStarterTips');
      if (shuffleBtn) {
        e.preventDefault();
        e.stopPropagation();
        shuffleStarterTips();
        return;
      }

      // 2. Starter pill click
      const pill = e.target.closest('.chat-starter-pill:not(.shuffle)');
      if (pill && pill.dataset.prompt) {
        e.preventDefault();
        e.stopPropagation();
        const ta = document.getElementById('chatComposerTextarea');
        if (ta) {
          ta.value = pill.dataset.prompt;
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
          if (!isTouchDevice()) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }
        }
        return;
      }

      // 3. CSS Grid 0fr -> 1fr Accordion toggle
      const accHeader = e.target.closest('.cds-accordion-header');
      if (accHeader) {
        const acc = accHeader.closest('.cds-accordion');
        if (acc) {
          const isExpanded = acc.classList.toggle('expanded');
          const key = acc.dataset.accKey;
          if (key) {
            if (isExpanded) expandedAccordions.add(key);
            else expandedAccordions.delete(key);
          }
        }
        return;
      }

      // 4. Code Block Copy Button (2.5s Checkmark Decay State Machine)
      const copyBtn = e.target.closest('.chat-code-copy-btn');
      if (copyBtn) {
        const wrapper = copyBtn.closest('.chat-code-wrapper');
        const codeEl = wrapper ? wrapper.querySelector('pre code') : null;
        if (codeEl) {
          const rawCode = codeEl.textContent || '';
          navigator.clipboard?.writeText(rawCode).then(() => {
            copyBtn.classList.add('copied');
            const labelSpan = copyBtn.querySelector('span');
            if (labelSpan) labelSpan.textContent = '✓ 已复制';
            setTimeout(() => {
              copyBtn.classList.remove('copied');
              if (labelSpan) labelSpan.textContent = '复制';
            }, 2500);
          }).catch(() => {});
        }
      }
    });
  }
}

/**
 * Global keyboard shortcuts for active Decision / Permission Cards on PC
 */
function bindGlobalDecisionShortcuts() {
  document.addEventListener('keydown', (e) => {
    const chatContainer = document.getElementById('agentChatContainer');
    if (!chatContainer || chatContainer.classList.contains('hidden')) return;

    // Ignore if user is typing in an input or textarea
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'textarea' || activeTag === 'input' || activeTag === 'select') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const permCard = document.getElementById('chatActiveDecisionCard');
    if (permCard && permCard.style.pointerEvents !== 'none') {
      const key = e.key.toLowerCase();
      if (key === 'y' || key === '1') {
        const btn = document.getElementById('btnApproveAction');
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
      } else if (key === '3') {
        const btn = document.getElementById('btnAutoModeAction');
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
      } else if (key === 'n' || key === '4' || key === 'escape') {
        const btn = document.getElementById('btnRejectAction');
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
      }
      return;
    }

    const qCard = document.getElementById('chatActiveQuestionCard');
    if (qCard && qCard.style.pointerEvents !== 'none') {
      if (e.key === 'Escape') {
        const btnCancel = document.getElementById('btnCancelQuestion');
        if (btnCancel) {
          e.preventDefault();
          btnCancel.click();
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const totalQ = parseInt(qCard.dataset.totalQ, 10) || 1;
        if (totalQ === 1) {
          const optBtn = qCard.querySelector(`.chat-opt-btn[data-num="${e.key}"]`);
          if (optBtn && !optBtn.disabled) {
            e.preventDefault();
            optBtn.click();
          }
        }
      }
    }
  });
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
    cached.socket.emit('terminal-input', text, { exitCopyMode: true });
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
  updateSlashPopover(null);

  const currentSess = getCurrentSessionName();
  if (!currentSess) return;

  // 1. Optimistic append & pin scroll to bottom
  isScrollPinned = true;
  appendUserMessageToUI(text);

  // 2. Clear input
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
  }

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

  if (isSessionSwitch) {
    isScrollPinned = true;
    const cachedData = sessionHistoryCache.get(sessionName);
    if (cachedData) {
      renderMessages(sessionName, cachedData, true);
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

    if (getCurrentSessionName() !== sessionName) {
      return;
    }

    const previousCache = sessionHistoryCache.get(sessionName);
    if (previousCache && previousCache.lastUpdated === data.lastUpdated && !isSessionSwitch) {
      return; // No changes
    }

    sessionHistoryCache.set(sessionName, data);
    renderMessages(sessionName, data, isSessionSwitch);
  } catch (err) {
    console.warn('[ChatMode] Failed to fetch chat history for', sessionName, err.message);
  }
}

/**
 * Wrap <pre><code> blocks in Markdown HTML with a CDS Code Sandbox Header & Copy Button
 */
function enhanceMarkdownCodeBlocks(rawHtml) {
  if (!rawHtml || !rawHtml.includes('<pre>')) return rawHtml;
  return rawHtml.replace(/<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (match, lang, codeContent) => {
    const displayLang = lang ? escapeHtml(lang) : 'code';
    return `
      <div class="chat-code-wrapper">
        <div class="chat-code-header">
          <span>${displayLang}</span>
          <button type="button" class="chat-code-copy-btn" title="复制代码">
            <i data-lucide="copy"></i>
            <span>复制</span>
          </button>
        </div>
        <pre><code class="${lang ? 'language-' + escapeHtml(lang) : ''}">${codeContent}</code></pre>
      </div>
    `;
  });
}

/**
 * Render message list strictly for a given session with Scroll Pinning & Accordion Persistence
 */
function renderMessages(sessionName, data, forceScrollBottom = false) {
  const currentSess = getCurrentSessionName();
  if (sessionName && currentSess && currentSess !== sessionName) return;

  const container = document.getElementById('agentChatMessages');
  const agentNameEl = document.getElementById('chatAgentName');
  if (!container) return;

  // Capture previous scroll position before DOM update so we never hijack an unpinned reader
  const prevScrollTop = container.scrollTop;
  const userRecentlyScrolled = (performance.now() - lastUserScrollAt) <= SCROLL_COOL_DOWN_MS;

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
          <i data-lucide="sparkles" style="width: 26px; height: 26px; color: var(--accent-primary, var(--neon-cyan)); opacity: 0.85;"></i>
        </div>
        <div class="chat-empty-title">会话「${escapeHtml(displaySession)}」已就绪</div>
        <div class="chat-empty-desc">
          在下方输入需求，或点击灵感胶囊快速填入：
        </div>
        <div class="chat-starter-pills" id="chatStarterPills">
          ${renderStarterPillsHtml()}
        </div>
      </div>
    `;
    updateStatusBadge('就绪', 'ready');
    if (window.lucide) window.lucide.createIcons();
    updateScrollFadeMask(container);
    return;
  }

  let html = '';
  let hasRenderedActiveQuestion = false;

  messages.forEach((msg, msgIdx) => {
    const isUser = msg.role === 'user';
    const isLastMsg = msgIdx === messages.length - 1;
    let bodyHtml = '';

    // 1. CSS Grid 0fr -> 1fr Thinking Accordion
    if (msg.thinking) {
      const accKey = `${displaySession}::${msg.id || msgIdx}::thinking`;
      const isExpanded = expandedAccordions.has(accKey);
      const isActivelyThinking = isLastMsg && !msg.content && (!msg.tools || msg.tools.length === 0);

      bodyHtml += `
        <div class="cds-accordion ${isExpanded || isActivelyThinking ? 'expanded' : ''}" data-acc-key="${escapeHtml(accKey)}">
          <div class="cds-accordion-header">
            <div class="cds-accordion-header-left">
              ${isActivelyThinking ? `
                <span class="cds-quiet-dots">
                  <span class="cds-quiet-dot"></span>
                  <span class="cds-quiet-dot"></span>
                  <span class="cds-quiet-dot"></span>
                </span>
                <span class="cds-shimmer-text cds-accordion-title">正在深入思考...</span>
              ` : `
                <i data-lucide="sparkles" style="width: 13px; height: 13px;"></i>
                <span class="cds-accordion-title">思考过程</span>
              `}
            </div>
            <span class="cds-accordion-chevron">
              <i data-lucide="chevron-down"></i>
            </span>
          </div>
          <div class="cds-accordion-grid">
            <div class="cds-accordion-inner">
              <div class="cds-accordion-content">${escapeHtml(msg.thinking)}</div>
            </div>
          </div>
        </div>
      `;
    }

    // 2. Tool Executions & Question Cards
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
        const accKey = `${displaySession}::${msg.id || msgIdx}::tools`;
        const isExpanded = expandedAccordions.has(accKey);

        const structuredToolsHtml = otherTools.map(t => {
          const inputSummary = t.input
            ? (t.input.command || t.input.file_path || t.input.filePath || t.input.pattern || JSON.stringify(t.input))
            : '';
          return `
            <div class="cds-tool-item">
              <div class="cds-tool-item-head">
                <i data-lucide="wrench" style="width: 11px; height: 11px;"></i>
                <span>${escapeHtml(t.name)}</span>
              </div>
              ${inputSummary ? `<div class="cds-tool-item-args">${escapeHtml(String(inputSummary))}</div>` : ''}
            </div>
          `;
        }).join('');

        bodyHtml += `
          <div class="cds-accordion ${isExpanded ? 'expanded' : ''}" data-acc-key="${escapeHtml(accKey)}">
            <div class="cds-accordion-header">
              <div class="cds-accordion-header-left">
                <i data-lucide="terminal" style="width: 13px; height: 13px;"></i>
                <span class="cds-accordion-title">已调用 ${otherTools.length} 项工具: ${escapeHtml(toolNames)}</span>
              </div>
              <span class="cds-accordion-chevron">
                <i data-lucide="chevron-down"></i>
              </span>
            </div>
            <div class="cds-accordion-grid">
              <div class="cds-accordion-inner">
                <div class="cds-accordion-content">${structuredToolsHtml}</div>
              </div>
            </div>
          </div>
        `;
      }
    }

    // 3. Markdown / Assistant Prose Content
    if (msg.content) {
      const isQuestionFallback = hasAskQuestionTool && msg.content.includes('智能体发起提问');
      if (!isQuestionFallback) {
        if (!isUser && window.marked) {
          try {
            const parsedHtml = window.marked.parse(msg.content);
            bodyHtml += `<div class="chat-prose-body">${enhanceMarkdownCodeBlocks(parsedHtml)}</div>`;
          } catch (e) {
            bodyHtml += `<div>${escapeHtml(msg.content)}</div>`;
          }
        } else {
          bodyHtml += `<div>${escapeHtml(msg.content)}</div>`;
        }
      }
    }

    html += `
      <div class="chat-msg-row ${isUser ? 'user' : 'assistant'}" id="${escapeHtml(msg.id || ('msg-' + msgIdx))}">
        <div class="chat-bubble-wrap">
          <div class="chat-bubble">
            ${bodyHtml}
          </div>
        </div>
      </div>
    `;
  });

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

  // Apply open-claude-ui Scroll Pinning Physics:
  // Only auto-scroll to bottom if pinned (or forced on session switch) AND user hasn't scrolled in last 150ms
  if (forceScrollBottom || (isScrollPinned && !userRecentlyScrolled)) {
    scrollToChatBottom(false);
  } else {
    programmaticScroll = true;
    container.scrollTop = prevScrollTop;
    updateScrollFadeMask(container);
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const jumpBtn = document.getElementById('chatJumpBottomBtn');
    if (jumpBtn && distanceFromBottom > 120) {
      jumpBtn.classList.add('visible');
    }
  }
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
            <span>取消</span>
            <kbd class="chat-kbd">Esc</kbd>
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
 * Render interactive Tool Permission Approval card (3-Action MCP Decision Array)
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
          <span class="chat-decision-title">智能体请求工具执行授权</span>
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
        <button class="chat-action-btn approve" id="btnApproveAction" title="允许本次执行 (快捷键 1 或 Y)">
          <i data-lucide="check"></i>
          <span>单次批准</span>
          <kbd class="chat-kbd">Y</kbd>
        </button>
        ${canAutoMode ? `
          <button class="chat-action-btn auto-mode" id="btnAutoModeAction" title="切换到自动模式，后续相同操作免确认 (快捷键 3)">
            <i data-lucide="zap"></i>
            <span>始终允许</span>
            <kbd class="chat-kbd">3</kbd>
          </button>
        ` : ''}
        <button class="chat-action-btn reject" id="btnRejectAction" title="拒绝执行此操作 (快捷键 4 或 N)">
          <i data-lucide="x"></i>
          <span>拒绝</span>
          <kbd class="chat-kbd">N</kbd>
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
          <span>批准</span>
          <kbd class="chat-kbd">Y</kbd>
        </button>
        <button class="chat-action-btn reject" id="btnRejectAction">
          <i data-lucide="x"></i>
          <span>拒绝</span>
          <kbd class="chat-kbd">N</kbd>
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
      const selectedAnswers = new Map();

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

          const sortedKeys = Array.from({ length: totalQ }, (_, i) => selectedAnswers.get(String(i)) || '1');
          let delay = 0;
          sortedKeys.forEach(key => {
            setTimeout(() => {
              sendRawToTmux(key);
            }, delay);
            delay += 250;
          });

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
  scrollToChatBottom(true);
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
