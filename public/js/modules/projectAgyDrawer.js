/**
 * Project AGY Slide-out Drawer Module
 * Embeds a live AGY / Antigravity terminal session in a slide-out drawer side-by-side with the DAG canvas.
 * Supports both pure Free Dialogue Mode and a Staged Prompt Editor to prevent tedious in-terminal line deletions.
 */

import { state } from './state.js';

let drawerElement = null;
let drawerTerm = null;
let drawerFitAddon = null;
let drawerSocket = null;
let currentSessionName = null;
let drawerWorkspace = null;
let drawerMission = '';
let drawerTasks = [];
let drawerSelectedTask = null;
let onRefreshCallback = null;

/**
 * Initialize or get drawer DOM element
 */
function ensureDrawerDOM() {
  if (drawerElement && document.body.contains(drawerElement)) {
    return drawerElement;
  }

  const projectPanel = document.getElementById('projectPanel');
  if (!projectPanel) return null;

  drawerElement = document.createElement('div');
  drawerElement.id = 'projectAgyDrawer';
  drawerElement.className = 'project-agy-drawer';
  drawerElement.innerHTML = `
    <div class="drawer-header">
      <div class="drawer-title-area">
        <div class="drawer-title">
          <i data-lucide="sparkles" style="color: var(--neon-cyan, #00f0ff); width: 16px; height: 16px;"></i>
          <span>AGY 智能体协同工位</span>
        </div>
        <span class="drawer-session-badge" id="drawerSessionBadge">AGY CLI</span>
      </div>

      <div class="drawer-controls">
        <select id="drawerSessionSelect" class="drawer-session-select" title="选择协同会话"></select>
        <button id="drawerClearLineBtn" class="drawer-icon-btn" title="清空终端当前输入行 (Ctrl+U / Ctrl+C)">
          <i data-lucide="eraser" style="width: 14px; height: 14px;"></i>
        </button>
        <button id="drawerCloseBtn" class="drawer-icon-btn" title="收起抽屉 (Esc)">
          <i data-lucide="x" style="width: 15px; height: 15px;"></i>
        </button>
      </div>
    </div>

    <!-- Sub-bar: Status and Refresh Board -->
    <div class="drawer-subbar">
      <div class="drawer-status-bar ready" id="drawerStatusBar">
        <i data-lucide="info" style="width: 12px; height: 12px; flex-shrink: 0;"></i>
        <span id="drawerStatusText">💬 自由对话模式：可在终端中直接与 AGY 交流。</span>
      </div>
      <button id="drawerRefreshBoardBtn" class="drawer-tool-btn outline" title="刷新大盘读取最新 .deck/tasks.json">
        <i data-lucide="refresh-cw" style="width: 12px; height: 12px;"></i>
        <span>🔄 刷新大盘</span>
      </button>
    </div>

    <!-- Embedded Terminal Container -->
    <div class="drawer-terminal-wrapper" id="drawerTerminalWrapper">
      <div id="drawerTerminalContainer" class="drawer-terminal-inner"></div>
    </div>

    <!-- Prompt Staging / Draft Tray (Collapsed by default, opens on demand) -->
    <div class="drawer-staging-tray hidden" id="drawerStagingTray">
      <div class="staging-tray-header">
        <div class="staging-tray-title">
          <i data-lucide="file-edit" style="width: 13px; height: 13px; color: var(--neon-cyan, #00f0ff);"></i>
          <span id="stagingTrayTitleText">智能拆解指令草稿 (可随意修改、清空或追加要求)</span>
        </div>
        <div class="staging-tray-actions">
          <button id="stagingClearBtn" class="staging-action-btn" title="一键清空输入草稿">
            <i data-lucide="trash-2" style="width: 11px; height: 11px;"></i>
            <span>清空</span>
          </button>
          <button id="stagingCloseBtn" class="staging-action-btn" title="收起草稿框，回到纯净自由对话">
            <i data-lucide="x" style="width: 11px; height: 11px;"></i>
            <span>收起草稿</span>
          </button>
        </div>
      </div>
      <div class="staging-tray-body">
        <textarea id="stagingPromptTextarea" class="staging-textarea" placeholder="在此编辑发给 AGY 的指令（支持鼠标框选、全选删除、追加要求）..." rows="3"></textarea>
      </div>
      <div class="staging-tray-footer">
        <div class="staging-tip">
          <i data-lucide="keyboard" style="width: 11px; height: 11px;"></i>
          <span>按 <strong>Ctrl+Enter</strong> 快捷发送到终端执行</span>
        </div>
        <button id="stagingSendBtn" class="staging-send-btn">
          <i data-lucide="send" style="width: 12px; height: 12px;"></i>
          <span>发送到终端执行</span>
        </button>
      </div>
    </div>
  `;

  projectPanel.appendChild(drawerElement);

  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Bind close drawer button
  const closeBtn = drawerElement.querySelector('#drawerCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeAgyDrawer());
  }

  // Bind clear terminal line (Ctrl+C & Ctrl+U)
  const clearLineBtn = drawerElement.querySelector('#drawerClearLineBtn');
  if (clearLineBtn) {
    clearLineBtn.addEventListener('click', () => {
      if (drawerSocket && drawerSocket.connected) {
        // Send Ctrl+C then Ctrl+E then Ctrl+U to cancel process and erase prompt input line
        drawerSocket.emit('terminal-input', '\x03\x05\x15');
        if (drawerTerm) drawerTerm.focus();
        showDrawerStatus('🧹 已发送清空指令 (Ctrl+C / Ctrl+U)，当前行已重置。', 'ready');
      }
    });
  }

  // Bind keyboard Esc to close drawer
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isAgyDrawerOpen()) {
      // If staging tray is open, first close staging tray
      const tray = drawerElement ? drawerElement.querySelector('#drawerStagingTray') : null;
      if (tray && !tray.classList.contains('hidden')) {
        closeStagingTray();
      } else {
        closeAgyDrawer();
      }
    }
  });

  const refreshBtn = drawerElement.querySelector('#drawerRefreshBoardBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (typeof onRefreshCallback === 'function') {
        onRefreshCallback();
        showDrawerStatus('✅ 大盘数据已刷新！', 'success');
      }
    });
  }

  // Staging Tray action bindings
  const stagingClearBtn = drawerElement.querySelector('#stagingClearBtn');
  const stagingCloseBtn = drawerElement.querySelector('#stagingCloseBtn');
  const stagingSendBtn = drawerElement.querySelector('#stagingSendBtn');
  const stagingTextarea = drawerElement.querySelector('#stagingPromptTextarea');

  if (stagingClearBtn && stagingTextarea) {
    stagingClearBtn.addEventListener('click', () => {
      stagingTextarea.value = '';
      stagingTextarea.focus();
    });
  }

  if (stagingCloseBtn) {
    stagingCloseBtn.addEventListener('click', () => {
      closeStagingTray();
      showDrawerStatus('💬 已收起草稿框，当前处于纯净自由对话模式。', 'ready');
    });
  }

  const sendStagedPrompt = () => {
    if (!stagingTextarea) return;
    const text = stagingTextarea.value.trim();
    if (!text) {
      showDrawerStatus('⚠️ 草稿内容为空，请输入后再发送。', 'warning');
      return;
    }
    if (!drawerSocket || !drawerSocket.connected) {
      showDrawerStatus('❌ 终端未连接，无法发送。', 'warning');
      return;
    }

    // Send command to terminal and execute
    drawerSocket.emit('terminal-input', text + '\r');
    closeStagingTray();
    showDrawerStatus('🚀 指令已发送到 AGY 终端！执行完成后可点击【🔄 刷新大盘】。', 'success');
  };

  if (stagingSendBtn) {
    stagingSendBtn.addEventListener('click', sendStagedPrompt);
  }

  if (stagingTextarea) {
    stagingTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendStagedPrompt();
      }
    });
  }

  // Bind session select change
  const sessionSelect = drawerElement.querySelector('#drawerSessionSelect');
  if (sessionSelect) {
    sessionSelect.addEventListener('change', () => {
      const selected = sessionSelect.value;
      if (selected === '__new__') {
        const newSessionBtn = document.getElementById('newSessionBtn');
        if (newSessionBtn) newSessionBtn.click();
        return;
      }
      if (selected && selected !== currentSessionName) {
        attachDrawerSession(selected);
      }
    });
  }

  return drawerElement;
}

/**
 * Open the AGY slide-out drawer
 */
export function openAgyDrawer(options = {}) {
  const {
    workspaceIdentifier,
    mission = '',
    tasks = [],
    sessions = [],
    selectedTask = null,
    stageRefine = false,
    stageDecompose = false,
    autoFillRefine = false,
    autoFillDecompose = false,
    onRefreshBoard
  } = options;

  drawerWorkspace = workspaceIdentifier;
  drawerMission = mission;
  drawerTasks = tasks;
  drawerSelectedTask = selectedTask;
  onRefreshCallback = onRefreshBoard;

  const drawer = ensureDrawerDOM();
  if (!drawer) return;

  // Populate session select
  const sessionSelect = drawer.querySelector('#drawerSessionSelect');
  if (sessionSelect) {
    sessionSelect.innerHTML = '';
    
    // Pick the best candidate: agy/antigravity session first
    let bestCandidate = null;
    if (sessions && sessions.length > 0) {
      bestCandidate = sessions.find(s => {
        const t = (s.agentType || '').toLowerCase();
        const n = (s.name || '').toLowerCase();
        return t === 'agy' || t === 'antigravity' || n.includes('agy') || n.includes('antigravity');
      });
      if (!bestCandidate) {
        bestCandidate = sessions[0];
      }
    }

    sessions.forEach(s => {
      const isCandidate = bestCandidate && s.name === bestCandidate.name;
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = `${s.name} [${s.agentType || 'Terminal'}]`;
      if (isCandidate) opt.selected = true;
      sessionSelect.appendChild(opt);
    });

    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '➕ 启动新会话...';
    sessionSelect.appendChild(newOpt);

    const targetSession = bestCandidate ? bestCandidate.name : null;
    if (targetSession && targetSession !== currentSessionName) {
      attachDrawerSession(targetSession);
    }
  }

  drawer.classList.add('open');

  const shouldRefine = stageRefine || autoFillRefine;
  const shouldDecompose = stageDecompose || autoFillDecompose;

  // Trigger fit and draft staging after slide animation completes
  setTimeout(() => {
    fitDrawerTerminal();

    if (shouldRefine && drawerSelectedTask) {
      stageRefinePrompt();
    } else if (shouldDecompose) {
      stageDecomposePrompt();
    } else {
      closeStagingTray();
      showDrawerStatus('💬 自由对话模式：可在终端中直接与 AGY 交流；亦可点击上方按钮生成指令草稿。', 'ready');
      if (drawerTerm) drawerTerm.focus();
    }
  }, 350);
}

/**
 * Close the AGY slide-out drawer
 */
export function closeAgyDrawer() {
  if (drawerElement) {
    drawerElement.classList.remove('open');
  }
}

/**
 * Check if the drawer is open
 */
export function isAgyDrawerOpen() {
  return drawerElement && drawerElement.classList.contains('open');
}

/**
 * Open staging tray with text and title
 */
function openStagingTray(promptText, titleText) {
  if (!drawerElement) return;
  const tray = drawerElement.querySelector('#drawerStagingTray');
  const textarea = drawerElement.querySelector('#stagingPromptTextarea');
  const titleEl = drawerElement.querySelector('#stagingTrayTitleText');
  if (!tray || !textarea) return;

  if (titleEl && titleText) titleEl.textContent = titleText;
  textarea.value = promptText || '';
  tray.classList.remove('hidden');

  setTimeout(() => {
    fitDrawerTerminal();
    textarea.focus();
    textarea.select();
  }, 50);
}

/**
 * Close staging tray and refocus terminal
 */
function closeStagingTray() {
  if (!drawerElement) return;
  const tray = drawerElement.querySelector('#drawerStagingTray');
  if (tray) {
    tray.classList.add('hidden');
    setTimeout(() => {
      fitDrawerTerminal();
      if (drawerTerm) drawerTerm.focus();
    }, 50);
  }
}

/**
 * Update the selected task reference in drawer
 */
export function updateDrawerSelectedTask(task) {
  drawerSelectedTask = task;
  if (isAgyDrawerOpen() && task) {
    showDrawerStatus(`🎯 当前在画布中选中任务: [${task.id}: ${task.title}]，可点击【🔍 细化选中节点】。`, 'ready');
  }
}

/**
 * Attach xterm instance to a tmux session inside the drawer
 */
function attachDrawerSession(sessionName) {
  if (!sessionName || sessionName === '__new__') return;
  currentSessionName = sessionName;

  const container = drawerElement ? drawerElement.querySelector('#drawerTerminalContainer') : null;
  if (!container) return;

  // Update session badge
  const badge = drawerElement.querySelector('#drawerSessionBadge');
  if (badge) {
    badge.textContent = sessionName;
  }

  // Disconnect previous socket if any
  if (drawerSocket) {
    drawerSocket.disconnect();
    drawerSocket = null;
  }

  // Reset container DOM
  container.innerHTML = '';

  const isLight = document.body.classList.contains('light-minimalist');
  const termTheme = isLight ? state.themeConstants.LIGHT : state.themeConstants.DARK;

  drawerTerm = new window.Terminal({
    cursorBlink: true,
    cursorStyle: 'underline',
    theme: termTheme,
    fontFamily: '"Fira Code", Consolas, Menlo, Courier, monospace',
    fontSize: 13,
    lineHeight: 1.2
  });

  drawerFitAddon = new window.FitAddon.FitAddon();
  drawerTerm.loadAddon(drawerFitAddon);
  drawerTerm.open(container);

  // Initialize socket
  const socket = window.io();
  drawerSocket = socket;

  socket.on('connect', () => {
    let cols = drawerTerm.cols || 80;
    let rows = drawerTerm.rows || 24;
    socket.emit('init-terminal', {
      sessionName: sessionName,
      cols: cols,
      rows: rows
    });
    setTimeout(() => {
      fitDrawerTerminal();
    }, 100);
  });

  socket.on('terminal-output', (data) => {
    if (drawerTerm) {
      drawerTerm.write(data);
    }
  });

  drawerTerm.onData((data) => {
    if (drawerSocket && drawerSocket.connected) {
      drawerSocket.emit('terminal-input', data);
    }
  });

  drawerTerm.onResize(({ cols, rows }) => {
    if (drawerSocket && drawerSocket.connected) {
      drawerSocket.emit('terminal-resize', { cols, rows });
    }
  });

  // Handle window resize
  window.addEventListener('resize', fitDrawerTerminal);
}

/**
 * Fit terminal dimensions to drawer wrapper
 */
function fitDrawerTerminal() {
  if (drawerFitAddon && drawerTerm) {
    try {
      drawerFitAddon.fit();
      if (drawerSocket && drawerSocket.connected) {
        drawerSocket.emit('terminal-resize', {
          cols: drawerTerm.cols,
          rows: drawerTerm.rows
        });
      }
    } catch (e) {}
  }
}

/**
 * Stage decompose goal prompt into the draft tray (clean web editing, no terminal pollution)
 */
function stageDecomposePrompt() {
  const missionText = drawerMission ? drawerMission.trim() : '推进工作区核心功能落地';
  const prompt = `请阅读当前工作区的目录结构、Git 最近提交历史以及当前推进目标「${missionText}」，围绕此目标分析代码现状并拆解出 3~6 个切实可行的子任务，构建合理的 DAG 任务依赖拓扑（通过 dependsOn 标注前置任务），严格遵循 .deck/deck_task_spec.md 规范直接更新写入到工作区的 .deck/tasks.json 文件中（已有任务请合理保留或更新，拆解完成后给出简要说明）。`;

  openStagingTray(prompt, '🎯 拆解全局目标草稿 (可自由增删或一键清空)');
  showDrawerStatus('📝 拆解指令草稿已就绪，可在下方自由修改，确认后按 Ctrl+Enter 发送到终端。', 'ready');
}

/**
 * Stage refine node prompt into the draft tray (clean web editing, no terminal pollution)
 */
function stageRefinePrompt() {
  if (!drawerSelectedTask) {
    showDrawerStatus('💡 请先在左侧 DAG 画布中点击选中要细化的任务节点！', 'warning');
    return;
  }

  const task = drawerSelectedTask;
  const deps = Array.isArray(task.dependsOn) ? JSON.stringify(task.dependsOn) : '[]';
  const prompt = `请针对当前工作区的任务项 [${task.id}: ${task.title}] 进行更细维度的技术剖析，将其拆分为 2~3 个粒度更细的具体子任务，维护好与前置任务 (${deps}) 以及相互之间的前后依赖（dependsOn），并直接更新写入到 .deck/tasks.json 文件中。`;

  openStagingTray(prompt, `🔍 细化任务 [${task.id}: ${task.title}] 草稿`);
  showDrawerStatus(`📝 任务 [${task.id}] 的细化草稿已就绪，可在下方自由修改，确认后按 Ctrl+Enter 发送。`, 'ready');
}

/**
 * Show temporary feedback in the drawer status bar
 */
function showDrawerStatus(text, type = 'ready') {
  if (!drawerElement) return;
  const bar = drawerElement.querySelector('#drawerStatusBar');
  const textEl = drawerElement.querySelector('#drawerStatusText');
  if (bar && textEl) {
    bar.className = `drawer-status-bar ${type}`;
    textEl.textContent = text;
  }
}
