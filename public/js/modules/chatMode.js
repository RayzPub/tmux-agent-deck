/**
 * Cyberpunk TMUX Agent Deck - CDS Interaction Physics & Dual-Theme Chat Mode Module
 * Incorporates open-claude-ui Scroll Pinning, 7-Stop Fade Mask, CSS Grid 0fr->1fr Accordions,
 * Borderless Assistant Prose, 20px Dual-Ring Composer, and Slash Command Engine.
 */

import { state } from './state.js';
import { fitTerminal, attachSession, isTouchDevice, showTipToast } from './terminal.js';
import { getSessionDisplayTitle, syncSessionDisplayTitle } from './sessionUtils.js';
import { stopVoiceInput, bindChatVoiceInput } from './voice.js';
import { restorePwaViewportScroll } from './mobileInput.js';
import { buildMermaidCardHtml, renderMermaidBlocks, handleMermaidContainerClick } from './mermaidRenderer.js';
import { enhanceChatFileLinks, handleChatFileLinkClick, parseFilePathCandidate } from './chatFileLink.js';
import { toast } from './toast.js';
import { createInlineAiStatusController, renderAiStatusIconSvg, inferToolStage } from './aiStatus.js';
import { createMatrixOrb } from './matrixOrb.js';
import {
  resolveSessionAgentType,
  getAgentDisplayName,
  getAgentClearCommand,
  isClearCommandForAgent,
  filterSlashCommands
} from './slashCommands.js';

const inlineAiStatus = createInlineAiStatusController(() => document.getElementById('chatInlineAiStatus'));
let chatEmptyOrb = null;
let voiceOrbBridgeBound = false;

function destroyChatEmptyOrb() {
  if (chatEmptyOrb) {
    chatEmptyOrb.destroy();
    chatEmptyOrb = null;
  }
}

function mountChatEmptyOrb(container) {
  destroyChatEmptyOrb();
  if (!container) return;
  const slot = container.querySelector('.chat-empty-orb');
  if (!slot) return;
  chatEmptyOrb = createMatrixOrb(slot, {
    size: 156,
    dots: 13,
    state: 'idle',
    opacity: 0.72,
  });
  if (!voiceOrbBridgeBound) {
    voiceOrbBridgeBound = true;
    window.addEventListener('ccnow:voice-state', (e) => {
      if (!chatEmptyOrb) return;
      const listening = Boolean(e?.detail?.listening);
      chatEmptyOrb.setState(listening ? 'listening' : 'idle');
    });
  }
}

const sessionViewModes = new Map();
const sessionHistoryCache = new Map(); // sessionName -> { messages, lastUpdated, pendingAction, agentType }
const expandedAccordions = new Set();  // Set of `${sessionName}::${accordionKey}` to persist user toggle across polls
const renderedChatState = { sessionName: null, lastUpdated: null }; // Tracks what is currently rendered in #agentChatMessages
const MARKDOWN_CACHE_MAX = 200;
const markdownHtmlCache = new Map(); // `${workspacePath}::${content}` -> enhanced HTML string
let currentPollTimer = null;
let currentPollIntervalMs = 2000;
let activePollSession = null;

// Scroll Pinning Physics State (open-claude-ui cooldown + bottom anchor tracking)
const SCROLL_COOL_DOWN_MS = 150;
let lastUserScrollAt = 0;
let programmaticScrollUntil = 0;
let isScrollPinned = true;

// Slash Command Popover State (dynamically populated per active agent)
let slashPopoverOpen = false;
let slashActiveIndex = 0;
let filteredSlashCommands = [];
let slashBlurTimer = null;

function getActiveChatAgentType(sessionName) {
  const sess = getCurrentSessionName(sessionName);
  const cached = sess ? sessionHistoryCache.get(sess) : null;
  const sessMode = sess ? sessionModeCache.get(sess) : null;
  const hint = sessMode === 'chat_only' ? 'oar' : (cached?.agentType || '');
  return resolveSessionAgentType(sess, hint);
}

function syncChatQuickClearButton(sessionName) {
  const quickClearBtn = document.getElementById('chatQuickClearBtn');
  if (!quickClearBtn) return;
  const agentType = getActiveChatAgentType(sessionName);
  const clearCmd = getAgentClearCommand(agentType);
  quickClearBtn.title = `发送 ${clearCmd} 清空当前对话上下文`;
}

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

  // 2. Inject 999px Segmented Control Switcher directly into terminalPanel
  if (!document.getElementById('deckModeSwitcher')) {
    const switcher = document.createElement('div');
    switcher.id = 'deckModeSwitcher';
    switcher.className = 'deck-mode-switcher hidden';
    switcher.style.display = 'none'; // Initially hidden until hybrid dual-mode support is verified
    switcher.innerHTML = `
      <button class="deck-mode-btn active" id="modeBtnTerminal" title="经典字符终端">
        <i data-lucide="terminal"></i>
        <span>终端</span>
      </button>
      <button class="deck-mode-btn" id="modeBtnChat" title="切换至会话界面">
        <i data-lucide="messages-square"></i>
        <span>会话</span>
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
          <!-- Unified Composer Status Dock (AI Status & Voice HUD share identical height & spacing above composer) -->
          <div class="chat-composer-status-dock" id="chatComposerStatusDock">
            <div class="chat-inline-ai-status" id="chatInlineAiStatus" data-stage="idle" role="status" aria-live="polite">
              <div class="chat-inline-ai-status-inner">
                <span class="ai-status-icon-slot" aria-hidden="true"></span>
                <span class="ai-status-label"></span>
                <span class="ai-status-detail hidden"></span>
                <span class="ai-status-timer hidden"></span>
              </div>
            </div>
          </div>

          <!-- Slash Command Floating Popover -->
          <div class="chat-slash-popover hidden" id="chatSlashPopover"></div>

          <div class="chat-input-row">
            <!-- Uploaded Attachment Tray -->
            <div class="chat-attachment-tray hidden" id="chatAttachmentTray"></div>

            <textarea 
              class="chat-textarea" 
              id="chatComposerTextarea" 
              rows="1"
              placeholder="输入消息，可添加/粘贴图片文件，输入 / 呼出指令..."
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              enterkeyhint="send"
            ></textarea>
            <div class="chat-composer-toolbar">
              <div class="chat-composer-tools-left">
                <input type="file" id="chatFileInput" multiple style="display: none;">
                <button class="chat-ghost-pill-btn" id="chatAttachBtn" type="button" title="添加文件或图片">
                  <i data-lucide="paperclip"></i>
                  <span>附件</span>
                </button>
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
                <button class="chat-mic-btn" id="chatMicBtn" type="button" title="语音输入 (按住或点击口述消息)">
                  <i data-lucide="mic"></i>
                </button>
                <button class="chat-icon-btn chat-interrupt-btn hidden" id="chatInterruptBtn" type="button" title="停止执行 (Ctrl+C)" style="display: none;">
                  <i data-lucide="square" style="width: 12px; height: 12px; fill: currentColor;"></i>
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
    // Only mark user manual scroll if NOT currently in programmatic scrolling window
    if (performance.now() >= programmaticScrollUntil) {
      lastUserScrollAt = performance.now();
    }
  };

  ['wheel', 'touchmove', 'pointerdown'].forEach(evt => {
    msgContainer.addEventListener(evt, markUserManualScroll, { passive: true });
  });

  msgContainer.addEventListener('scroll', () => {
    updateScrollFadeMask(msgContainer);

    const isProgrammatic = performance.now() < programmaticScrollUntil;
    if (isProgrammatic) {
      isScrollPinned = true;
      if (jumpBtn) jumpBtn.classList.remove('visible');
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
    const handleJumpBottom = (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastUserScrollAt = 0;
      isScrollPinned = true;
      programmaticScrollUntil = performance.now() + 500;
      jumpBtn.classList.remove('visible');
      scrollToChatBottom(true);
    };

    jumpBtn.addEventListener('click', handleJumpBottom);
    jumpBtn.addEventListener('touchend', handleJumpBottom);
    jumpBtn.addEventListener('touchstart', (e) => {
      e.stopPropagation();
    }, { passive: true });
  }
}

/**
 * Update scroll fade mask (no-op as alpha mask haze is disabled for crisp font rendering)
 */
function updateScrollFadeMask(el) {
  // Alpha mask haze disabled: crisp font rendering and artifact-free scrolling
}

/**
 * Rock-solid JavaScript requestAnimationFrame smooth scrolling
 * Bypasses all WebKit native smooth scroll bugs, inertia stalls, and flex-container glitches
 */
function smoothScrollToBottom(container, duration = 240) {
  if (!container) return;
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const startY = container.scrollTop;
  if (reducedMotion || maxScroll <= startY) {
    container.scrollTop = maxScroll;
    updateScrollFadeMask(container);
    return;
  }

  const startTime = performance.now();

  function animate(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Snappy ease-out cubic curve (0.16, 1, 0.3, 1)
    const ease = 1 - Math.pow(1 - progress, 3);

    // Dynamically query current bounds in case items expand during scroll
    const currentMax = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = startY + (currentMax - startY) * ease;

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      container.scrollTop = container.scrollHeight;
      updateScrollFadeMask(container);
    }
  }

  requestAnimationFrame(animate);
}

/**
 * Scroll chat stream to bottom respecting programmatic flag
 */
export function scrollToChatBottom(smooth = false) {
  const msgContainer = document.getElementById('agentChatMessages');
  const jumpBtn = document.getElementById('chatJumpBottomBtn');
  if (!msgContainer) return;

  lastUserScrollAt = 0;
  isScrollPinned = true;
  programmaticScrollUntil = performance.now() + (smooth ? 450 : 120);
  if (jumpBtn) jumpBtn.classList.remove('visible');

  const maxScroll = Math.max(0, msgContainer.scrollHeight - msgContainer.clientHeight);

  if (!smooth) {
    msgContainer.scrollTop = maxScroll;
    updateScrollFadeMask(msgContainer);
  } else {
    smoothScrollToBottom(msgContainer, 240);
    // Double assurance after animation completes
    setTimeout(() => {
      if (isScrollPinned && msgContainer) {
        msgContainer.scrollTop = msgContainer.scrollHeight;
        updateScrollFadeMask(msgContainer);
      }
    }, 280);
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
export const sessionModeCache = new Map(); // sessionName -> 'chat_only' | 'hybrid' | 'terminal_only'

/**
 * Completely wipe cached chat messages and view mode preferences for a session.
 * Invoked when a session is killed, removed, or newly recreated to prevent stale message inheritance.
 */
export function clearSessionChatCache(sessionName) {
  if (!sessionName) return;
  sessionHistoryCache.delete(sessionName);
  sessionViewModes.delete(sessionName);
  sessionSupportCache.delete(sessionName);
  sessionModeCache.delete(sessionName);

  for (const key of expandedAccordions) {
    if (key.startsWith(`${sessionName}::`)) {
      expandedAccordions.delete(key);
    }
  }

  try {
    localStorage.removeItem(`deck_mode_${sessionName}`);
  } catch (e) {}

  if (activePollSession === sessionName) {
    stopChatPolling();
  }
  if (renderedChatState.sessionName === sessionName) {
    renderedChatState.sessionName = null;
    renderedChatState.lastUpdated = null;
  }
}

// Expose globally for cross-module invocations
window.clearSessionChatCache = clearSessionChatCache;

export function getSessionMode(sessionName) {
  const current = getCurrentSessionName(sessionName);
  return sessionModeCache.get(current) || 'hybrid';
}

/**
 * Check if a session supports Claude Code Agent Chat Mode
 */
export async function checkSessionSupport(sessionName) {
  if (!sessionName) return false;
  if (sessionSupportCache.has(sessionName)) {
    return sessionSupportCache.get(sessionName);
  }
  try {
    const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chat-history${devParam}`);
    if (res.ok) {
      const data = await res.json();
      if (data.sessionMode) {
        sessionModeCache.set(sessionName, data.sessionMode);
      }
      if (!data.notModified && Array.isArray(data.messages)) {
        sessionHistoryCache.set(sessionName, data);
      }
      const isSupp = data.supported === true;
      sessionSupportCache.set(sessionName, isSupp);
      return isSupp;
    }
  } catch (e) {}
  sessionSupportCache.set(sessionName, false);
  return false;
}

function setModeSwitcherVisible(switcher, visible) {
  if (!switcher) return;
  switcher.classList.toggle('hidden', !visible);
  switcher.style.display = visible ? 'inline-flex' : 'none';
}

/**
 * Apply the current session's view mode to the UI
 */
export async function applySessionViewMode(sessionName, forceMode) {
  const terminalContainer = document.getElementById('terminal-container');
  const terminalWrapper = document.querySelector('.terminal-container-wrapper');
  const chatContainer = document.getElementById('agentChatContainer');
  const btnTerminal = document.getElementById('modeBtnTerminal');
  const btnChat = document.getElementById('modeBtnChat');
  const switcher = document.getElementById('deckModeSwitcher');
  const mobileControls = document.querySelector('.mobile-bottom-controls');
  const workspaceMain = document.querySelector('.terminal-workspace');

  if (!terminalContainer || !chatContainer || !btnTerminal || !btnChat) return;

  const currentSess = getCurrentSessionName(sessionName);

  if (!currentSess) {
    setModeSwitcherVisible(switcher, false);
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    if (terminalWrapper) {
      terminalWrapper.classList.remove('hidden');
      terminalWrapper.style.display = '';
    }
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

  const sessionMeta = state.sessionListCache && state.sessionListCache.find(s => s.name === currentSess);
  if (sessionMeta && sessionMeta.sessionMode === 'chat_only') {
    sessionModeCache.set(currentSess, 'chat_only');
    sessionSupportCache.set(currentSess, true);
    targetMode = 'chat';
  } else if (sessionMeta && sessionMeta.sessionMode === 'terminal_only') {
    sessionModeCache.set(currentSess, 'terminal_only');
    targetMode = 'terminal';
  }

  const cachedSupport = sessionSupportCache.get(currentSess);
  const cachedSessMode = sessionModeCache.get(currentSess);
  const optimisticHybrid = cachedSupport === true && cachedSessMode === 'hybrid';
  setModeSwitcherVisible(switcher, optimisticHybrid);

  if (targetMode === 'chat' && cachedSupport !== false) {
    terminalContainer.classList.add('hidden');
    if (terminalWrapper) {
      terminalWrapper.classList.add('hidden');
      terminalWrapper.style.display = 'none';
    }
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
  } else if (targetMode === 'terminal' && cachedSessMode !== 'chat_only') {
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    if (terminalWrapper) {
      terminalWrapper.classList.remove('hidden');
      terminalWrapper.style.display = '';
    }
    btnTerminal.classList.add('active');
    btnChat.classList.remove('active');
    if (mobileControls) {
      mobileControls.classList.remove('hidden');
      mobileControls.style.display = '';
    }
    if (workspaceMain) {
      workspaceMain.classList.add('has-mobile-controls');
    }
  }

  const isSupported = await checkSessionSupport(currentSess);
  const sessMode = sessionModeCache.get(currentSess) || 'hybrid';

  const activeSessNow = getCurrentSessionName();
  if (activeSessNow && activeSessNow !== currentSess) {
    return;
  }

  if (sessMode === 'terminal_only' || !isSupported) {
    setModeSwitcherVisible(switcher, false);
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    if (terminalWrapper) {
      terminalWrapper.classList.remove('hidden');
      terminalWrapper.style.display = '';
    }
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
    requestAnimationFrame(() => fitTerminal());
    return;
  }

  // Only show Terminal/Chat mode switcher in dual-mode ('hybrid'); hide in single-mode ('chat_only')
  let switcherIconsDirty = false;
  if (sessMode === 'chat_only') {
    targetMode = 'chat';
    setModeSwitcherVisible(switcher, false);
  } else {
    btnTerminal.style.opacity = '1';
    btnTerminal.title = '切换至终端交互界面';
    if (btnChat.dataset.modeLabel !== 'hybrid') {
      btnChat.innerHTML = '<i data-lucide="messages-square"></i><span>会话</span>';
      btnChat.dataset.modeLabel = 'hybrid';
      switcherIconsDirty = true;
    }
    setModeSwitcherVisible(switcher, true);
  }

  sessionViewModes.set(currentSess, targetMode);

  if (targetMode === 'chat') {
    terminalContainer.classList.add('hidden');
    if (terminalWrapper) {
      terminalWrapper.classList.add('hidden');
      terminalWrapper.style.display = 'none';
    }
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
    updateSlashPopover(null);
    syncChatQuickClearButton(currentSess);
    loadAndRenderChatHistory(currentSess, true);
    startChatPolling(currentSess);
  } else {
    updateSlashPopover(null);
    chatContainer.classList.add('hidden');
    terminalContainer.classList.remove('hidden');
    if (terminalWrapper) {
      terminalWrapper.classList.remove('hidden');
      terminalWrapper.style.display = '';
    }
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
    requestAnimationFrame(() => fitTerminal());
  }

  if (switcherIconsDirty && window.lucide) {
    window.lucide.createIcons();
  }
}

/**
 * Render and manage the `/` Slash Command Popover with Roving Focus
 */
function updateSlashPopover(queryText) {
  const popover = document.getElementById('chatSlashPopover');
  const slashTriggerBtn = document.getElementById('chatSlashTriggerBtn');
  if (!popover) return;

  if (slashBlurTimer) {
    clearTimeout(slashBlurTimer);
    slashBlurTimer = null;
  }

  if (queryText === null || !queryText.startsWith('/')) {
    slashPopoverOpen = false;
    popover.classList.add('hidden');
    popover.innerHTML = '';
    if (slashTriggerBtn) {
      slashTriggerBtn.classList.remove('active');
      slashTriggerBtn.setAttribute('aria-expanded', 'false');
    }
    return;
  }

  const agentType = getActiveChatAgentType();
  const agentLabel = getAgentDisplayName(agentType);
  filteredSlashCommands = filterSlashCommands(agentType, queryText);

  if (filteredSlashCommands.length === 0) {
    slashPopoverOpen = false;
    popover.classList.add('hidden');
    popover.innerHTML = '';
    if (slashTriggerBtn) {
      slashTriggerBtn.classList.remove('active');
      slashTriggerBtn.setAttribute('aria-expanded', 'false');
    }
    return;
  }

  slashPopoverOpen = true;
  if (slashTriggerBtn) {
    slashTriggerBtn.classList.add('active');
    slashTriggerBtn.setAttribute('aria-expanded', 'true');
  }

  if (slashActiveIndex >= filteredSlashCommands.length) {
    slashActiveIndex = 0;
  }

  const shortcutHint = isTouchDevice() ? '' : ' (↑↓ 选择 · Enter 确认)';
  popover.innerHTML = `
    <div class="chat-slash-popover-title">// ${escapeHtml(agentLabel)} 快捷指令${shortcutHint}</div>
    <div class="chat-slash-list">
      ${filteredSlashCommands.map((item, idx) => `
        <button type="button" class="chat-slash-item ${idx === slashActiveIndex ? 'active' : ''}" data-cmd="${escapeHtml(item.cmd)}" data-fill-only="${item.fillOnly ? '1' : '0'}">
          <span class="chat-slash-cmd">${escapeHtml(item.cmd)}</span>
          <span class="chat-slash-desc">${escapeHtml(item.desc)}</span>
        </button>
      `).join('')}
    </div>
  `;
  popover.classList.remove('hidden');

  // Prevent clicks inside the popover from stealing focus or triggering textarea blur
  popover.onmousedown = (e) => {
    e.preventDefault();
  };

  popover.querySelectorAll('.chat-slash-item').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = btn.dataset.cmd;
      const fillOnly = btn.dataset.fillOnly === '1';
      if (cmd) executeOrFillSlashCommand(cmd, fillOnly);
    });
  });

  const activeItem = popover.querySelector('.chat-slash-item.active');
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest' });
  }
}

// Current Session Attachment Tray State
let currentAttachments = []; // Array of { id, name, originalName, relativePath, absolutePath, size, isImage, localUrl, uploading }

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function clearCurrentAttachments() {
  currentAttachments.forEach(att => {
    if (att.localUrl) {
      try { URL.revokeObjectURL(att.localUrl); } catch (e) {}
    }
  });
  currentAttachments = [];
  renderAttachmentTray();
}

function renderAttachmentTray() {
  const tray = document.getElementById('chatAttachmentTray');
  if (!tray) return;

  if (currentAttachments.length === 0) {
    tray.classList.add('hidden');
    tray.innerHTML = '';
    return;
  }

  tray.classList.remove('hidden');
  const chipsHtml = currentAttachments.map(att => {
    let iconHtml = '';
    if (att.uploading) {
      iconHtml = `<i data-lucide="loader-2" class="spin chat-attach-icon" style="width: 14px; height: 14px;"></i>`;
    } else if (att.isImage && att.localUrl) {
      iconHtml = `<img src="${att.localUrl}" class="chat-attach-thumb" alt="${escapeHtml(att.name)}">`;
    } else {
      iconHtml = `<span class="chat-attach-icon"><i data-lucide="${att.isImage ? 'image' : 'file-text'}" style="width: 14px; height: 14px;"></i></span>`;
    }

    return `
      <div class="chat-attach-chip ${att.uploading ? 'uploading' : ''}" data-id="${escapeHtml(att.id)}" title="${escapeHtml(att.name)}${att.absolutePath ? '\n' + escapeHtml(att.absolutePath) : ''}">
        ${iconHtml}
        <span class="chat-attach-name">${escapeHtml(att.name)}</span>
        <span class="chat-attach-size">${att.uploading ? '上传中...' : formatFileSize(att.size)}</span>
        <button type="button" class="chat-attach-remove-btn" data-remove-id="${escapeHtml(att.id)}" title="移除附件">
          <i data-lucide="x" style="width: 12px; height: 12px;"></i>
        </button>
      </div>
    `;
  }).join('');

  tray.innerHTML = chipsHtml;

  tray.querySelectorAll('.chat-attach-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-remove-id');
      const idx = currentAttachments.findIndex(a => a.id === id);
      if (idx !== -1) {
        if (currentAttachments[idx].localUrl) {
          try { URL.revokeObjectURL(currentAttachments[idx].localUrl); } catch (e) {}
        }
        currentAttachments.splice(idx, 1);
        renderAttachmentTray();
      }
    });
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

async function uploadAttachedFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const currentSess = getCurrentSessionName();
  if (!currentSess) {
    toast.warning('当前没有活跃的会话');
    return;
  }

  const newItems = [];
  const filesToUpload = [];

  for (const file of fileList) {
    const tempId = 'att_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const isImg = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
    let localUrl = null;
    if (isImg) {
      try {
        localUrl = URL.createObjectURL(file);
      } catch (e) {}
    }

    const item = {
      id: tempId,
      name: file.name,
      originalName: file.name,
      size: file.size,
      isImage: isImg,
      localUrl,
      uploading: true,
      relativePath: '',
      absolutePath: ''
    };

    newItems.push(item);
    filesToUpload.push({ item, file });
    currentAttachments.push(item);
  }

  renderAttachmentTray();

  try {
    const formData = new FormData();
    for (const f of filesToUpload) {
      formData.append('files', f.file);
    }

    const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSess)}/chat-upload${devParam}`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data.success && Array.isArray(data.files)) {
      data.files.forEach((serverFile, idx) => {
        if (filesToUpload[idx]) {
          const target = filesToUpload[idx].item;
          target.uploading = false;
          target.name = serverFile.name;
          target.relativePath = serverFile.relativePath;
          target.absolutePath = serverFile.absolutePath;
          target.size = serverFile.size;
          target.isImage = serverFile.isImage;
        }
      });
    }
  } catch (err) {
    console.error('[ChatMode] Upload error:', err);
    toast.error(`上传文件失败: ${err.message}`);
    newItems.forEach(item => {
      const idx = currentAttachments.indexOf(item);
      if (idx !== -1) currentAttachments.splice(idx, 1);
    });
  } finally {
    renderAttachmentTray();
  }
}

function executeOrFillSlashCommand(cmd, fillOnly = false) {
  const textarea = document.getElementById('chatComposerTextarea');
  updateSlashPopover(null);
  if (!textarea) return;
  if (fillOnly) {
    textarea.value = `${cmd} `;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return;
  }
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
  const attachBtn = document.getElementById('chatAttachBtn');
  const fileInput = document.getElementById('chatFileInput');
  const inputRow = textarea ? textarea.closest('.chat-input-row') : null;

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('mousedown', (e) => {
      // Prevent button click from stealing focus or triggering input row focus
      e.preventDefault();
    });

    attachBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        uploadAttachedFiles(Array.from(fileInput.files));
        fileInput.value = '';
      }
    });
  }

  // Support clipboard paste (screenshots and images)
  if (textarea) {
    textarea.addEventListener('paste', (e) => {
      const clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData) return;
      const items = clipboardData.items;
      if (!items) return;

      const pastedFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const ext = blob.type.split('/')[1] || 'png';
            const file = new File([blob], `screenshot_${Date.now()}.${ext}`, { type: blob.type });
            pastedFiles.push(file);
          }
        }
      }

      if (pastedFiles.length > 0) {
        e.preventDefault();
        uploadAttachedFiles(pastedFiles);
      }
    });
  }

  // Support Drag and Drop files onto composer
  const composerShell = document.querySelector('.chat-composer-shell');
  if (composerShell && inputRow) {
    ['dragenter', 'dragover'].forEach(evt => {
      composerShell.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputRow.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(evt => {
      composerShell.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputRow.classList.remove('drag-over');
      });
    });

    composerShell.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        uploadAttachedFiles(Array.from(dt.files));
      }
    });
  }

  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      // 1. Strict CJK IME Composition Guard (open-claude-ui 3.3.2)
      if (e.isComposing || e.keyCode === 229) return;

      // 2. Roving Focus inside Slash Popover if open
      if (slashPopoverOpen && filteredSlashCommands.length > 0) {
        const currentQuery = textarea.value.startsWith('/') ? textarea.value : '/';
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashActiveIndex = (slashActiveIndex + 1) % filteredSlashCommands.length;
          updateSlashPopover(currentQuery);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashActiveIndex = (slashActiveIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
          updateSlashPopover(currentQuery);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const chosen = filteredSlashCommands[slashActiveIndex];
          if (chosen) {
            executeOrFillSlashCommand(chosen.cmd, Boolean(chosen.fillOnly));
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
      const currentVal = textarea.value || '';
      const prevVal = textarea._prevValue || '';
      textarea._prevValue = currentVal;

      const maxHeight = window.innerWidth <= 768 ? 96 : 150;
      const minHeight = 24;
      const currentHeight = textarea.offsetHeight;

      let targetHeight;
      if (currentVal.length < prevVal.length) {
        textarea.style.height = `${minHeight}px`;
        targetHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      } else {
        targetHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      }

      if (Math.abs(targetHeight - currentHeight) > 1) {
        textarea.style.height = `${targetHeight}px`;
      }

      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';

      const val = textarea.value;
      if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
        updateSlashPopover(val);
      } else {
        updateSlashPopover(null);
      }
    });

    textarea.addEventListener('focus', () => {
      if (inputRow) inputRow.classList.add('is-focused');
      scrollToChatBottom(true);
      [100, 250, 400].forEach((delay) => {
        setTimeout(() => {
          scrollToChatBottom(false);
        }, delay);
      });
    });

    textarea.addEventListener('blur', () => {
      if (inputRow) inputRow.classList.remove('is-focused');
      restorePwaViewportScroll();
      if (slashBlurTimer) clearTimeout(slashBlurTimer);
      slashBlurTimer = setTimeout(() => {
        const active = document.activeElement;
        const popover = document.getElementById('chatSlashPopover');
        const triggerBtn = document.getElementById('chatSlashTriggerBtn');
        if (popover && (popover === active || popover.contains(active))) return;
        if (triggerBtn && (triggerBtn === active || triggerBtn.contains(active))) return;
        updateSlashPopover(null);
      }, 200);
    });
  }

  // Bind microphone voice input for chat
  bindChatVoiceInput();

  if (slashTriggerBtn && textarea) {
    slashTriggerBtn.addEventListener('mousedown', (e) => {
      // Prevent textarea from blurring when already focused
      e.preventDefault();
    });

    slashTriggerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (slashBlurTimer) {
        clearTimeout(slashBlurTimer);
        slashBlurTimer = null;
      }
      if (slashPopoverOpen) {
        updateSlashPopover(null);
      } else {
        // Open popover directly without forcing textarea focus (avoids popping up virtual keyboard on mobile)
        const val = textarea.value || '';
        const query = (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) ? val : '/';
        slashActiveIndex = 0;
        updateSlashPopover(query);
      }
    });
  }

  if (quickClearBtn) {
    quickClearBtn.addEventListener('mousedown', (e) => {
      // Prevent focus shift
      e.preventDefault();
    });

    quickClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearChatContext();
    });
  }

  // Dismiss slash popover when clicking anywhere outside
  document.addEventListener('pointerdown', (e) => {
    if (!slashPopoverOpen) return;
    const popover = document.getElementById('chatSlashPopover');
    const triggerBtn = document.getElementById('chatSlashTriggerBtn');
    if (popover && !popover.contains(e.target) && (!triggerBtn || !triggerBtn.contains(e.target))) {
      updateSlashPopover(null);
    }
  });

  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendChatMessage();
    });
  }

  if (interruptBtn) {
    interruptBtn.addEventListener('click', () => {
      const currentSess = getCurrentSessionName();
      const sessMode = currentSess ? (sessionModeCache.get(currentSess) || 'hybrid') : 'hybrid';
      if (sessMode === 'chat_only') {
        const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
        fetch(`/api/sessions/${encodeURIComponent(currentSess)}/oar-abort${devParam}`, { method: 'POST' }).catch(() => {});
        updateStatusBadge('已请求中止 OAR 生成', 'waiting');
      } else {
        sendRawToTmux('\x03');
        updateStatusBadge('已中断当前任务', 'waiting');
      }
    });
  }

  // Delegate clicks on accordions and code copy buttons within agentChatMessages
  const msgContainer = document.getElementById('agentChatMessages');
  if (msgContainer && !msgContainer.dataset.delegatedBound) {
    msgContainer.dataset.delegatedBound = 'true';
    msgContainer.addEventListener('click', (e) => {
      // 1. CSS Grid 0fr -> 1fr Accordion toggle
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

      // 4. Mermaid Diagram Actions (Toggle Source / Zoom Lightbox / Copy Source)
      if (handleMermaidContainerClick(e)) {
        return;
      }

      // 4.5 Highlighted File Path Click -> Open Editor / Preview Tab
      if (handleChatFileLinkClick(e)) {
        return;
      }

      // 5. Code Block Copy Button (2.5s Checkmark Decay State Machine)
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
 * Clear conversation context both in frontend UI and backend agent CLI
 */
export async function clearChatContext() {
  const currentSess = getCurrentSessionName();
  if (!currentSess) return;

  stopVoiceInput();
  updateSlashPopover(null);

  // 1. Clear input & reset attachments
  const textarea = document.getElementById('chatComposerTextarea');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
  }
  clearCurrentAttachments();

  // 2. Wipe cached messages for this session
  sessionHistoryCache.delete(currentSess);
  if (renderedChatState.sessionName === currentSess) {
    renderedChatState.sessionName = null;
    renderedChatState.lastUpdated = null;
  }

  // 3. Reset the chat messages UI container to empty clean state
  const container = document.getElementById('agentChatMessages');
  if (container) {
    container.innerHTML = `
      <div class="chat-empty-state">
        <div class="chat-empty-orb" aria-hidden="true"></div>
        <div class="chat-empty-title">上下文已清空</div>
        <div class="chat-empty-subtitle">终端与会话上下文已重置，输入消息开启全新对话</div>
      </div>
    `;
    mountChatEmptyOrb(container);
  }

  // 4. Update status indicator
  updateStatusBadge('已清空上下文', 'idle');

  // 5. Send agent-specific clear command (/clear for Claude/AGY/Kimi, /new for Codex, clear for Bash) into tmux terminal if active
  const sessMode = sessionModeCache.get(currentSess) || 'hybrid';
  if (sessMode !== 'chat_only') {
    const clearCmd = getAgentClearCommand(getActiveChatAgentType(currentSess));
    sendRawToTmux(`${clearCmd}\r`);
  }

  // 6. Request backend to clear context, unset @agent_session_id, and reset OAR session
  try {
    const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
    await fetch(`/api/sessions/${encodeURIComponent(currentSess)}/clear-context${devParam}`, {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[ChatMode] clear-context API call error:', err.message);
  }

  // 7. Re-sync chat history after agent process has created fresh state
  setTimeout(() => {
    if (getCurrentSessionName() === currentSess) {
      loadAndRenderChatHistory(currentSess, false);
    }
  }, 1000);
}

/**
 * Send user message to the agent
 */
export function sendChatMessage(overrideText) {
  const textarea = document.getElementById('chatComposerTextarea');
  let text = (typeof overrideText === 'string' ? overrideText : (textarea ? textarea.value : '')).trim();

  const attachmentsToSend = [...currentAttachments];

  if (!text && attachmentsToSend.length === 0) return;

  if (!text && attachmentsToSend.length > 0) {
    text = '请查看附带的文件/图片并进行分析：';
  }

  stopVoiceInput();
  updateSlashPopover(null);

  const currentSess = getCurrentSessionName();
  if (!currentSess) return;

  // Intercept agent-specific clear command (/clear or /new for Codex): cleanly clear context instead of rendering as user chat
  if (isClearCommandForAgent(text, getActiveChatAgentType(currentSess))) {
    clearChatContext();
    return;
  }

  const sessMode = sessionModeCache.get(currentSess) || 'hybrid';

  // Intercept /compact in OAR Pure Chat Mode to invoke native OAR session.compact()
  if (sessMode === 'chat_only' && text.toLowerCase() === '/compact') {
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
    triggerOarCompact(currentSess);
    return;
  }

  // Build full prompt text with injected file paths inside the workspace to avoid agent permission prompts
  let fullPrompt = text;
  if (attachmentsToSend.length > 0) {
    const fileEntries = attachmentsToSend.map(f => {
      return `- ${f.relativePath} (绝对路径: ${f.absolutePath})`;
    }).join('\n');
    fullPrompt = `${text}\n\n[附带文件]:\n${fileEntries}`;
  }

  // 1. Optimistic append & pin scroll to bottom
  isScrollPinned = true;
  appendUserMessageToUI(text, attachmentsToSend);

  // 2. Clear input & reset attachments
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
  }
  clearCurrentAttachments();

  // 3. Pipe to tmux or dispatch to OAR engine
  if (sessMode === 'chat_only') {
    const imagePaths = attachmentsToSend
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f.name || f.relativePath || ''))
      .map(f => ({ relativePath: f.relativePath, path: f.absolutePath }));
    sendToOarEngine(currentSess, fullPrompt, imagePaths);
  } else {
    // Pipe to tmux: terminal raw mode requires \r (Carriage Return / Enter) to submit
    sendRawToTmux(fullPrompt + '\r');
    // Immediately trigger auto-title summarization if this session is awaiting its first-prompt summary
    const sessObj = Array.isArray(state.sessionListCache)
      ? state.sessionListCache.find(s => s && s.name === currentSess)
      : null;
    if (sessObj && sessObj.autoTitle && sessObj.titleSource === 'auto_pending') {
      const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
      fetch(`/api/sessions/${encodeURIComponent(currentSess)}/auto-title${devParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text })
      })
        .then(r => r.ok ? r.json() : null)
        .then(titleData => {
          if (titleData && titleData.displayTitle) {
            syncSessionDisplayTitle(currentSess, titleData.displayTitle, titleData);
            const agentNameEl = document.getElementById('chatAgentName');
            if (agentNameEl && getCurrentSessionName() === currentSess) {
              const prefix = agentNameEl.textContent.split(' · ')[0] || 'TMUX 智能体';
              agentNameEl.textContent = `${prefix} · ${titleData.displayTitle}`;
            }
          }
        })
        .catch(() => {});
    }
  }

  // 4. Update status indicator
  updateStatusBadge('思考与执行中...', 'thinking');

  // 5. Trigger quick update
  if (sessMode !== 'chat_only') {
    setTimeout(() => {
      if (getCurrentSessionName() === currentSess) {
        loadAndRenderChatHistory(currentSess, false);
      }
    }, 1200);
  }
}

/**
 * Trigger OAR 0.128.1 native manual context compaction (/compact)
 */
async function triggerOarCompact(sessionName) {
  updateStatusBadge('正在压缩上下文...', 'compacting');
  try {
    const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/oar-compact${devParam}`, {
      method: 'POST'
    });
    const data = await res.json().catch(() => ({}));
    updateStatusBadge('上下文压缩完成', 'ready');
    if (data && data.message && !data.supported) {
      showTipToast(data.message);
    }
    loadAndRenderChatHistory(sessionName, false);
  } catch (e) {
    updateStatusBadge('上下文压缩异常', 'error');
    console.error('[OAR] Compact failed:', e);
  }
}

/**
 * Dispatch message directly to OAR Pure Chat Engine API (with fast streaming poll & deviceId routing)
 */
async function sendToOarEngine(sessionName, content, images = []) {
  updateStatusBadge('正在深度思考...', 'thinking');
  // Switch to high-frequency polling (500ms) while OAR is streaming events
  startChatPolling(sessionName, 500);

  try {
    const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud' ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}` : '';
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/oar-message${devParam}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, images })
    });
    if (res.ok) {
      const payload = await res.json().catch(() => ({}));
      if (payload && payload.displayTitle) {
        syncSessionDisplayTitle(sessionName, payload.displayTitle, payload);
      }
      loadAndRenderChatHistory(sessionName, false);
      // Only restore slow polling immediately if the turn already finished synchronously (cloud mode)
      if (!payload.streaming && !payload.isGenerating && getCurrentSessionName() === sessionName) {
        startChatPolling(sessionName, 2000);
      }
    } else {
      const err = await res.json().catch(() => ({}));
      updateStatusBadge('智能体响应异常', 'error');
      console.error('[OAR] Send message error:', err);
      loadAndRenderChatHistory(sessionName, false);
      if (getCurrentSessionName() === sessionName) {
        startChatPolling(sessionName, 2000);
      }
    }
  } catch (e) {
    updateStatusBadge('网络请求失败', 'error');
    console.error('[OAR] Send message fetch failed:', e);
    if (getCurrentSessionName() === sessionName) {
      startChatPolling(sessionName, 2000);
    }
  }
}

/**
 * Fetch and render chat history strictly for the requested session
 */
export async function loadAndRenderChatHistory(sessionName, isSessionSwitch = false) {
  if (!sessionName) return;

  const initialCached = sessionHistoryCache.get(sessionName);
  const domAlreadyMatches = Boolean(
    initialCached &&
    renderedChatState.sessionName === sessionName &&
    renderedChatState.lastUpdated !== null &&
    renderedChatState.lastUpdated === initialCached.lastUpdated
  );

  if (isSessionSwitch) {
    isScrollPinned = true;
    inlineAiStatus.reset(sessionName);
    if (domAlreadyMatches) {
      // DOM already displays this exact session & version: zero-cost instant switch!
      scrollToChatBottom(false);
    } else if (initialCached) {
      renderMessages(sessionName, initialCached, true);
    } else {
      const container = document.getElementById('agentChatMessages');
      if (container) {
        renderedChatState.sessionName = null;
        renderedChatState.lastUpdated = null;
        container.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #64748b; font-size: 11px;">
            <span>正在读取会话记录...</span>
          </div>
        `;
      }
    }
  }

  try {
    const queryParts = [];
    if (state.currentDeviceId && state.currentDeviceId !== 'cloud') {
      queryParts.push(`deviceId=${encodeURIComponent(state.currentDeviceId)}`);
    }
    if (initialCached && initialCached.lastUpdated) {
      queryParts.push(`since=${encodeURIComponent(initialCached.lastUpdated)}`);
    }
    const qs = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chat-history${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (getCurrentSessionName() !== sessionName) {
      return;
    }

    // Sync any newly summarized or renamed displayTitle from backend (including async LLM upgrades)
    if (data && data.displayTitle) {
      const titleChanged = syncSessionDisplayTitle(sessionName, data.displayTitle, data);
      if (titleChanged) {
        const agentNameEl = document.getElementById('chatAgentName');
        if (agentNameEl) {
          const curText = agentNameEl.textContent || '';
          const parts = curText.split(' · ');
          if (parts.length >= 2) {
            const modelMatch = parts.slice(1).join(' · ').match(/(\s*\([^)]+\))$/);
            const suffix = modelMatch ? modelMatch[1] : '';
            agentNameEl.textContent = `${parts[0]} · ${data.displayTitle}${suffix}`;
          }
        }
      }
    }

    const previousCache = sessionHistoryCache.get(sessionName);
    if (data && data.notModified) {
      if (previousCache && (renderedChatState.sessionName !== sessionName || renderedChatState.lastUpdated !== previousCache.lastUpdated)) {
        renderMessages(sessionName, previousCache, isSessionSwitch);
      }
      if (data.sessionMode === 'chat_only' && activePollSession === sessionName) {
        const desiredInterval = data.isGenerating ? 500 : 2000;
        if (currentPollIntervalMs !== desiredInterval) {
          startChatPolling(sessionName, desiredInterval);
        }
      }
      return;
    }

    const isUnchanged = Boolean(
      previousCache &&
      previousCache.lastUpdated === data.lastUpdated &&
      renderedChatState.sessionName === sessionName &&
      renderedChatState.lastUpdated === data.lastUpdated
    );
    if (isUnchanged) {
      return; // No changes and DOM is already up-to-date
    }

    sessionHistoryCache.set(sessionName, data);
    renderMessages(sessionName, data, isSessionSwitch);

    // Dynamically adjust polling cadence for OAR streaming sessions (500ms active -> 2000ms idle)
    if (data && data.sessionMode === 'chat_only' && activePollSession === sessionName) {
      const desiredInterval = data.isGenerating ? 500 : 2000;
      if (currentPollIntervalMs !== desiredInterval) {
        startChatPolling(sessionName, desiredInterval);
      }
    }
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
    const normalizedLang = (lang || '').trim().toLowerCase();
    if (normalizedLang === 'mermaid') {
      return buildMermaidCardHtml(codeContent);
    }
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

  const rawSessionName = sessionName || currentSess || '主会话';
  const displaySession = (data && data.displayTitle)
    ? data.displayTitle
    : getSessionDisplayTitle(rawSessionName, state.sessionListCache);
  let agentLabel = 'TMUX 智能体';
  if (data && data.agentType) {
    const t = data.agentType.toLowerCase();
    if (t === 'agy' || t === 'antigravity') {
      agentLabel = 'ANTIGRAVITY';
    } else if (t === 'claude') {
      agentLabel = 'CLAUDE CODE';
    } else {
      agentLabel = data.agentType.toUpperCase();
    }
  }
  if (agentNameEl) {
    const modelSuffix = (data && data.sessionMode === 'chat_only' && data.activeModel) ? ` (${data.activeModel})` : '';
    agentNameEl.textContent = `${agentLabel} · ${displaySession}${modelSuffix}`;
    agentNameEl.setAttribute('title', `会话 ID: ${rawSessionName}`);
  }
  syncChatQuickClearButton(sessionName || currentSess);

  const messages = (data && data.messages) ? data.messages : [];
  renderedChatState.sessionName = sessionName || currentSess || null;
  renderedChatState.lastUpdated = (data && data.lastUpdated !== undefined) ? data.lastUpdated : null;

  if (messages.length === 0) {
    const emptyDesc = (data && data.sessionMode === 'chat_only')
      ? 'OAR 纯会话模式 · 输入需求开启对话，支持图片附件与 /compact'
      : '在下方输入需求，开启智能体协作对话';
    container.innerHTML = `
      <div class="chat-empty-state">
        <div class="chat-empty-orb" aria-hidden="true"></div>
        <div class="chat-empty-title">会话「${escapeHtml(displaySession)}」已就绪</div>
        <div class="chat-empty-desc">
          ${emptyDesc}
        </div>
      </div>
    `;
    mountChatEmptyOrb(container);
    updateStatusBadge('就绪', 'ready');
    updateScrollFadeMask(container);
    return;
  }

  destroyChatEmptyOrb();

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
                <span class="cds-ai-inline-icon">${renderAiStatusIconSvg('thinking', 14)}</span>
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
          const rawFilePath = t.input && (t.input.file_path || t.input.filePath || t.input.path);
          const parsedToolFile = rawFilePath ? parseFilePathCandidate(String(rawFilePath)) : null;
          const argsHtml = inputSummary
            ? (parsedToolFile && String(inputSummary).trim() === String(rawFilePath).trim()
                ? `<div class="cds-tool-item-args"><span class="chat-file-link" data-file-path="${escapeHtml(parsedToolFile.path)}" role="button" tabindex="0" title="点击打开预览: ${escapeHtml(parsedToolFile.path)}">${escapeHtml(String(inputSummary))}</span></div>`
                : `<div class="cds-tool-item-args">${escapeHtml(String(inputSummary))}</div>`)
            : '';
          const isRunningTool = t.status === 'running';
          const statusTag = isRunningTool
            ? '<span class="cds-tool-running-tag">执行中...</span>'
            : (t.exitCode !== undefined && t.exitCode !== null
              ? `<span style="margin-left:auto;font-size:10px;opacity:0.7;font-variant-numeric:tabular-nums;">exit ${escapeHtml(String(t.exitCode))}</span>`
              : '');
          return `
            <div class="cds-tool-item${isRunningTool ? ' is-running' : ''}">
              <div class="cds-tool-item-head">
                <i data-lucide="wrench" style="width: 11px; height: 11px;"></i>
                <span>${escapeHtml(t.name)}</span>
                ${statusTag}
              </div>
              ${argsHtml}
            </div>
          `;
        }).join('');

        const runningTool = otherTools.find(t => t.status === 'running');
        bodyHtml += `
          <div class="cds-accordion ${isExpanded ? 'expanded' : ''}" data-acc-key="${escapeHtml(accKey)}">
            <div class="cds-accordion-header">
              <div class="cds-accordion-header-left">
                ${runningTool
                  ? `<span class="cds-ai-inline-icon">${renderAiStatusIconSvg(inferToolStage(runningTool.name), 13)}</span><span class="cds-shimmer-text cds-accordion-title">正在执行工具: ${escapeHtml(runningTool.name)}</span>`
                  : `<i data-lucide="terminal" style="width: 13px; height: 13px;"></i><span class="cds-accordion-title">已调用 ${otherTools.length} 项工具: ${escapeHtml(toolNames)}</span>`}
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

    // 3. Markdown / Assistant Prose Content & User Attachments
    if (msg.content) {
      const isQuestionFallback = hasAskQuestionTool && msg.content.includes('智能体发起提问');
      if (!isQuestionFallback) {
        if (isUser) {
          let userText = msg.content;
          let attachedItems = [];
          const attMatch = userText.match(/([\s\S]*?)\n\n\[(?:附带文件|附件路径)\]:\n([\s\S]*)$/);
          if (attMatch) {
            userText = attMatch[1].trim();
            const attLines = attMatch[2].split('\n').filter(Boolean);
            for (const line of attLines) {
              const fMatch = line.match(/^-\s*([^\s]+)(?:\s*\(绝对路径:\s*([^\)]+)\))?/);
              if (fMatch) {
                const rel = fMatch[1];
                const abs = fMatch[2] || rel;
                const fname = rel.split('/').pop() || 'file';
                const isImg = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(fname);
                attachedItems.push({ name: fname, relativePath: rel, absolutePath: abs, isImage: isImg });
              }
            }
          }

          let attHtml = '';
          if (attachedItems.length > 0) {
            const chips = attachedItems.map(item => {
              if (item.isImage) {
                const imgSrc = `/api/sessions/${encodeURIComponent(sessionName)}/chat-attachments/${encodeURIComponent(item.name)}`;
                return `
                  <div class="chat-bubble-att-img-wrap">
                    <img src="${imgSrc}" class="chat-bubble-att-img" alt="${escapeHtml(item.name)}" title="${escapeHtml(item.name)}" onclick="window.open(this.src, '_blank')">
                  </div>
                `;
              }
              const parsedAtt = parseFilePathCandidate(item.relativePath) || parseFilePathCandidate(item.absolutePath);
              const attPathAttr = parsedAtt ? ` data-file-path="${escapeHtml(parsedAtt.path)}" title="点击打开预览: ${escapeHtml(parsedAtt.path)}" role="button" tabindex="0"` : '';
              return `
                <div class="chat-bubble-att-item${parsedAtt ? ' clickable' : ''}"${attPathAttr}>
                  <i data-lucide="file-text" style="width: 13px; height: 13px;"></i>
                  <span class="chat-bubble-att-name">${escapeHtml(item.name)}</span>
                </div>
              `;
            }).join('');
            attHtml = `<div class="chat-bubble-attachments">${chips}</div>`;
          }

          bodyHtml += `${attHtml}${userText ? `<div>${escapeHtml(userText)}</div>` : ''}`;
        } else if (window.marked) {
          try {
            const mdCacheKey = `${state.currentWorkspacePath || ''}::${msg.content}`;
            let enhancedHtml = markdownHtmlCache.get(mdCacheKey);
            if (enhancedHtml === undefined) {
              const parsedHtml = window.marked.parse(msg.content);
              enhancedHtml = enhanceChatFileLinks(enhanceMarkdownCodeBlocks(parsedHtml));
              if (markdownHtmlCache.size >= MARKDOWN_CACHE_MAX) {
                const oldestKey = markdownHtmlCache.keys().next().value;
                markdownHtmlCache.delete(oldestKey);
              }
              markdownHtmlCache.set(mdCacheKey, enhancedHtml);
            }
            bodyHtml += `<div class="chat-prose-body">${enhancedHtml}</div>`;
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

  // Pending action card (ask_question / permission / yn) + Live Inline AI Status
  const lastMessage = messages[messages.length - 1];
  const lastRunningTool = lastMessage && lastMessage.role !== 'user' && Array.isArray(lastMessage.tools)
    ? lastMessage.tools.find(t => t.status === 'running')
    : null;
  const lastActivelyThinking = Boolean(
    lastMessage &&
    lastMessage.role !== 'user' &&
    lastMessage.thinking &&
    !lastMessage.content &&
    (!lastMessage.tools || lastMessage.tools.length === 0)
  );

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
  } else if (data.isGenerating || lastRunningTool || lastActivelyThinking) {
    if (lastRunningTool) {
      // Tool details already render inside the conversation stream; keep inline status concise (no duplicate tool name)
      const toolStage = inferToolStage(lastRunningTool.name);
      updateStatusBadge('处理中...', toolStage);
    } else if (lastActivelyThinking) {
      updateStatusBadge('思考中...', 'thinking');
    } else if (lastMessage && lastMessage.role !== 'user' && lastMessage.content) {
      updateStatusBadge('生成回复中...', 'writing');
    } else {
      updateStatusBadge('处理中...', 'thinking');
    }
  } else {
    updateStatusBadge('就绪', 'ready');
  }

  // Dedicated invisible bottom anchor for precise scrollIntoView alignment
  html += `<div id="chatBottomAnchor" class="chat-bottom-anchor" style="height: 1px; width: 100%; flex-shrink: 0; pointer-events: none; margin: 0; padding: 0;"></div>`;

  container.innerHTML = html;
  bindDecisionCardEvents(data.pendingAction);

  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Render any unrendered Mermaid diagrams asynchronously (cached ones are already inlined)
  renderMermaidBlocks(container, {
    onRendered: () => {
      if (isScrollPinned && (performance.now() - lastUserScrollAt) > SCROLL_COOL_DOWN_MS) {
        scrollToChatBottom(false);
      }
    }
  });

  // Apply open-claude-ui Scroll Pinning Physics:
  // Only auto-scroll to bottom if forced, actively in programmatic scroll window, or pinned (and user didn't scroll manually recently)
  const isProgrammatic = performance.now() < programmaticScrollUntil;
  if (forceScrollBottom || isProgrammatic || (isScrollPinned && !userRecentlyScrolled)) {
    scrollToChatBottom(false);
  } else {
    programmaticScrollUntil = performance.now() + 100;
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
function appendUserMessageToUI(text, attachments = []) {
  const container = document.getElementById('agentChatMessages');
  if (!container) return;

  const emptyState = container.querySelector('.chat-empty-state');
  if (emptyState) {
    destroyChatEmptyOrb();
    container.innerHTML = '';
  }

  let attachmentsHtml = '';
  if (attachments && attachments.length > 0) {
    const items = attachments.map(att => {
      if (att.isImage && att.localUrl) {
        return `
          <div class="chat-bubble-att-img-wrap">
            <img src="${att.localUrl}" class="chat-bubble-att-img" alt="${escapeHtml(att.name)}" title="${escapeHtml(att.name)}">
          </div>
        `;
      }
      return `
        <div class="chat-bubble-att-item">
          <i data-lucide="file-text" style="width: 13px; height: 13px;"></i>
          <span class="chat-bubble-att-name">${escapeHtml(att.name)}</span>
        </div>
      `;
    }).join('');
    attachmentsHtml = `<div class="chat-bubble-attachments">${items}</div>`;
  }

  const row = document.createElement('div');
  row.className = 'chat-msg-row user';
  row.innerHTML = `
    <div class="chat-bubble-wrap">
      <div class="chat-bubble">
        ${attachmentsHtml}
        ${text ? `<div class="chat-bubble-text">${escapeHtml(text)}</div>` : ''}
      </div>
    </div>
  `;
  container.appendChild(row);
  if (window.lucide) window.lucide.createIcons();
  scrollToChatBottom(true);
}

/**
 * Update minimalist status indicator + live inline AI status bar
 */
function updateStatusBadge(text, stateType, detail = '') {
  const dot = document.getElementById('chatStatusDot');
  const statusText = document.getElementById('chatStatusText');
  const interruptBtn = document.getElementById('chatInterruptBtn');

  const isWorking = ['working', 'thinking', 'researching', 'analyzing', 'writing', 'compacting'].includes(stateType);

  if (dot && statusText) {
    statusText.textContent = text;
    dot.className = 'agent-status-dot ' + (isWorking ? 'working' : (stateType || 'ready'));
  }

  // Update sleek inline AI status pill above composer
  inlineAiStatus.setStatus(stateType || 'ready', text, detail);

  if (interruptBtn) {
    if (isWorking) {
      interruptBtn.classList.remove('hidden');
      interruptBtn.style.display = 'inline-flex';
    } else {
      interruptBtn.classList.add('hidden');
      interruptBtn.style.display = 'none';
    }
  }
}

/**
 * Polling controller for active session
 */
function startChatPolling(sessionName, intervalMs = 2000) {
  stopChatPolling();
  if (!sessionName) return;
  activePollSession = sessionName;
  currentPollIntervalMs = intervalMs;
  currentPollTimer = setInterval(() => {
    if (getCurrentSessionName() === sessionName) {
      loadAndRenderChatHistory(sessionName, false);
    } else {
      stopChatPolling();
    }
  }, intervalMs);
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
