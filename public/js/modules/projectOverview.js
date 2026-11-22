import { state } from './state.js';
import { activateTab, updateProjectTabStatus } from './tabs.js';
import { attachSession } from './terminal.js';
import { toast } from './toast.js';

let autoStatusInterval = null;
let isFetchingBoard = false;
let lastBgBadgePollAt = 0;
let boardViewMode = localStorage.getItem('deck_taskboard_view_mode') || 'kanban'; // 'kanban' | 'grid'
let selectedWorkspaceFilter = localStorage.getItem('deck_taskboard_ws_filter') || ''; // '' = all workspaces
let searchQuery = '';
let lastBoardData = null;

// Track active inline interactions so background polling never interrupts typing
let activeQuickReplySession = null;
let activeRenameSession = null;
let isModalOpen = false;

function closeSidebarOnMobile() {
  const sidebar = document.querySelector('.sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  if (window.innerWidth <= 768 && sidebar && sidebarOverlay) {
    sidebar.classList.remove('open');
    sidebar.classList.remove('collapsed');
    sidebarOverlay.classList.add('hidden');
    document.body.classList.remove('sidebar-open');
    const expandBtn = document.getElementById('sidebarExpandBtn');
    if (expandBtn) expandBtn.classList.remove('hidden');
  }
}

function getAgentInfo(agentType, agentModel) {
  const type = (agentType || '').toLowerCase();
  let brand = 'Terminal';
  let badgeClass = 'terminal';

  if (type === 'agy' || type === 'antigravity') {
    brand = 'Antigravity';
    badgeClass = 'agy';
  } else if (type === 'claude') {
    brand = 'Claude';
    badgeClass = 'claude';
  } else if (type === 'codex') {
    brand = 'Codex';
    badgeClass = 'codex';
  } else if (type === 'kimi') {
    brand = 'Kimi';
    badgeClass = 'kimi';
  } else if (agentType && type !== 'default') {
    brand = agentType.toUpperCase();
  }

  let shortModel = (agentModel || '').trim();
  if (shortModel.includes(' · ')) {
    const parts = shortModel.split(' · ');
    shortModel = parts[parts.length - 1];
  }
  shortModel = shortModel.replace(/\s*\(\d+k\)/i, '').trim();

  return {
    type,
    brand,
    model: agentModel || '',
    shortModel: shortModel || agentModel || '',
    badgeClass
  };
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const time = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!time || isNaN(time)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d`;
}

function getCleanSnippet(sess) {
  const raw = (sess.lastActivity && sess.lastActivity.text)
    ? String(sess.lastActivity.text).trim()
    : '';
  if (!raw) return '';
  if (raw === '远程节点会话已连接' || raw === '会话已就绪，等待下达指令...') return '';
  const title = (sess.taskTitle || '').trim();
  if (title && raw === title) return '';
  return raw;
}

function getStatusText(status) {
  if (status === 'waiting') return '需确认';
  if (status === 'busy') return '进行中';
  if (status === 'todo') return '待办';
  return '待命';
}

/**
 * Open or focus the Task Board tab (ALWAYS at Index 0)
 */
export function openProjectTab() {
  closeSidebarOnMobile();
  const tabId = 'tab-project-overview';
  let tab = state.tabs.find(t => t.id === tabId);
  if (!tab) {
    tab = {
      id: tabId,
      name: '任务看板',
      type: 'project',
      path: 'project'
    };
    state.tabs.unshift(tab);
  } else {
    tab.name = '任务看板';
    const idx = state.tabs.indexOf(tab);
    if (idx > 0) {
      state.tabs.splice(idx, 1);
      state.tabs.unshift(tab);
    }
  }
  activateTab(tabId);
}

/**
 * Fetch and render the streamlined Task Board
 */
export async function renderProjectOverview(options = {}) {
  const container = document.getElementById('projectPanelContainer');
  if (!container) return;

  const { silent = false } = options;
  if (silent && isFetchingBoard) return;
  isFetchingBoard = true;

  if (!silent && !container.querySelector('.tb-root')) {
    container.innerHTML = `
      <div class="loading-placeholder">
        <div class="cyber-spinner"></div>
        <span>加载中...</span>
      </div>
    `;
  }

  try {
    const params = new URLSearchParams();
    if (state.currentDeviceId && state.currentDeviceId !== 'cloud') {
      params.set('deviceId', state.currentDeviceId);
    }
    const res = await fetch(`/api/task-board${params.toString() ? `?${params.toString()}` : ''}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    lastBoardData = data;

    if (selectedWorkspaceFilter) {
      const wsExists = (data.workspaces || []).some(w => w.name === selectedWorkspaceFilter);
      if (!wsExists) {
        selectedWorkspaceFilter = '';
        localStorage.setItem('deck_taskboard_ws_filter', '');
      }
    }

    if (data.summary && data.summary.workspaceStatus) {
      updateProjectTabStatus(data.summary.workspaceStatus);
    }

    buildBoardDOM(container, data);
  } catch (err) {
    if (silent) return;
    container.innerHTML = `
      <div class="tb-empty-state">
        <i data-lucide="alert-triangle" style="width: 28px; height: 28px; color: var(--neon-pink, #ff007f);"></i>
        <span class="tb-empty-title">加载失败</span>
        <span class="tb-empty-sub">${escapeHtml(err.message)}</span>
        <button id="tbRetryBtn" class="tb-btn" style="margin-top: 6px;">
          <i data-lucide="refresh-cw" style="width: 13px; height: 13px;"></i>
          <span>重试</span>
        </button>
      </div>
    `;
    const retryBtn = container.querySelector('#tbRetryBtn');
    if (retryBtn) retryBtn.addEventListener('click', () => renderProjectOverview());
    if (window.lucide) window.lucide.createIcons();
  } finally {
    isFetchingBoard = false;
  }
}

function filterItems(data) {
  const allSessions = data.sessions || [];
  const allTodos = data.todos || [];
  const q = searchQuery.trim().toLowerCase();

  const matchesSearch = (textParts) => {
    if (!q) return true;
    return textParts.some(p => String(p || '').toLowerCase().includes(q));
  };

  const sessions = allSessions.filter(s => {
    if (selectedWorkspaceFilter && s.workspaceName !== selectedWorkspaceFilter) return false;
    return matchesSearch([
      s.taskTitle,
      s.name,
      s.workspaceName,
      s.agentType,
      s.agentModel,
      s.lastActivity?.text,
      s.lastActivity?.userPrompt
    ]);
  });

  const todos = allTodos.filter(t => {
    if (selectedWorkspaceFilter && t.workspaceName && t.workspaceName !== selectedWorkspaceFilter) return false;
    return matchesSearch([t.title, t.description, t.workspaceName, t.agentType]);
  });

  return { sessions, todos };
}

/**
 * Render a clean, noise-free Session Task Card
 * Context-aware: never repeats status in Kanban columns, never repeats workspace in By-Project groups.
 */
function renderSessionCard(sess, ctx = {}) {
  const { showStatus = false, showWorkspace = false } = ctx;
  const agent = getAgentInfo(sess.agentType, sess.agentModel);
  const status = sess.status || 'idle';
  const isWaiting = status === 'waiting';
  const snippet = getCleanSnippet(sess);
  const relTime = formatRelativeTime(sess.lastActiveAt || sess.createdTimestamp);
  const isRenaming = activeRenameSession === sess.name;
  const isReplying = activeQuickReplySession === sess.name;

  const agentTooltip = agent.shortModel ? `${agent.brand} · ${agent.shortModel}` : agent.brand;
  const cardTooltip = sess.taskTitle !== sess.name ? `${sess.taskTitle} (#${sess.name})` : sess.taskTitle;

  return `
    <div class="tb-card ${isWaiting ? 'is-waiting' : ''} ${isReplying || isRenaming ? 'is-editing' : ''}" data-session-card="${escapeHtml(sess.name)}">
      ${isRenaming ? `
        <div class="tb-rename-row" data-no-open="1">
          <input type="text" class="tb-rename-input" data-rename-input="${escapeHtml(sess.name)}" value="${escapeHtml(sess.customTitle || sess.taskTitle || '')}" placeholder="任务标题">
          <button class="tb-mini-btn primary" data-action="save-rename" data-session="${escapeHtml(sess.name)}">保存</button>
          <button class="tb-mini-btn" data-action="cancel-rename">取消</button>
        </div>
      ` : `
        <div class="tb-card-head">
          <div class="tb-card-title-wrap">
            ${showStatus ? `<span class="tb-inline-dot ${status}" title="${escapeHtml(getStatusText(status))}"></span>` : ''}
            <span class="tb-card-title" title="${escapeHtml(cardTooltip)}">${escapeHtml(sess.taskTitle)}</span>
          </div>
          ${isWaiting && !showStatus ? `<span class="tb-urgent-badge">需确认</span>` : ''}
          <div class="tb-hover-actions" data-no-open="1">
            <button class="tb-icon-btn ${isReplying ? 'active' : ''}" data-action="toggle-reply" data-session="${escapeHtml(sess.name)}" title="快捷续发指令">
              <i data-lucide="message-square" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="tb-icon-btn" data-action="rename-card" data-session="${escapeHtml(sess.name)}" title="重命名">
              <i data-lucide="pencil" style="width: 12px; height: 12px;"></i>
            </button>
          </div>
        </div>
      `}

      ${snippet && !isRenaming ? `
        <div class="tb-card-snippet" title="${escapeHtml(snippet)}">${escapeHtml(snippet)}</div>
      ` : ''}

      ${isReplying ? `
        <div class="tb-quick-reply" data-no-open="1">
          <input type="text" class="tb-quick-reply-input" data-reply-input="${escapeHtml(sess.name)}" placeholder="发送指令 (Enter)...">
          <button class="tb-mini-btn primary" data-action="send-reply" data-session="${escapeHtml(sess.name)}" title="发送">
            <i data-lucide="send" style="width: 11px; height: 11px;"></i>
          </button>
        </div>
      ` : ''}

      <div class="tb-card-meta">
        <div class="tb-meta-left">
          <span class="tb-agent-label ${agent.badgeClass}" title="${escapeHtml(agentTooltip)}">
            <span class="tb-agent-dot"></span>
            <span>${escapeHtml(agent.brand)}</span>
          </span>
          ${showWorkspace && sess.workspaceName ? `
            <span class="tb-meta-sep">·</span>
            <span class="tb-meta-ws" title="${escapeHtml(sess.workspaceName)}">${escapeHtml(sess.workspaceName)}</span>
          ` : ''}
          ${showStatus ? `
            <span class="tb-meta-sep">·</span>
            <span class="tb-meta-status ${status}">${escapeHtml(getStatusText(status))}</span>
          ` : ''}
        </div>
        ${relTime ? `<span class="tb-time-label">${escapeHtml(relTime)}</span>` : ''}
      </div>
    </div>
  `;
}

/**
 * Render a clean Todo Card
 */
function renderTodoCard(todo, ctx = {}) {
  const { showStatus = false, showWorkspace = false } = ctx;
  const agent = getAgentInfo(todo.agentType || 'agy', '');
  const relTime = formatRelativeTime(todo.updatedAt || todo.createdAt);

  return `
    <div class="tb-card tb-card-todo" data-todo-card="${escapeHtml(todo.id)}">
      <div class="tb-card-head">
        <div class="tb-card-title-wrap">
          ${showStatus ? `<span class="tb-inline-dot todo" title="待办"></span>` : ''}
          <span class="tb-card-title">${escapeHtml(todo.title)}</span>
        </div>
        ${todo.priority === 'high' ? `<span class="tb-priority-tag high">高优</span>` : ''}
        <div class="tb-hover-actions" data-no-open="1">
          <button class="tb-icon-btn danger" data-action="delete-todo" data-todo-id="${escapeHtml(todo.id)}" title="删除">
            <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
          </button>
        </div>
      </div>

      ${todo.description ? `<div class="tb-card-snippet">${escapeHtml(todo.description)}</div>` : ''}

      <div class="tb-card-meta">
        <div class="tb-meta-left">
          <span class="tb-agent-label ${agent.badgeClass}">
            <span class="tb-agent-dot"></span>
            <span>${escapeHtml(agent.brand)}</span>
          </span>
          ${showWorkspace && todo.workspaceName ? `
            <span class="tb-meta-sep">·</span>
            <span class="tb-meta-ws" title="${escapeHtml(todo.workspaceName)}">${escapeHtml(todo.workspaceName)}</span>
          ` : ''}
          ${relTime ? `<span class="tb-meta-sep">·</span><span class="tb-time-label">${escapeHtml(relTime)}</span>` : ''}
        </div>
        <button class="tb-launch-btn" data-no-open="1" data-action="launch-todo" data-todo-id="${escapeHtml(todo.id)}" title="启动会话">
          <i data-lucide="play" style="width: 10px; height: 10px;"></i>
          <span>启动</span>
        </button>
      </div>
    </div>
  `;
}

function buildBoardDOM(container, data) {
  const { sessions, todos } = filterItems(data);
  const workspaces = data.workspaces || [];
  const hasMultipleWorkspaces = workspaces.length > 1;
  const showCardWorkspace = hasMultipleWorkspaces && !selectedWorkspaceFilter;

  const waitingSessions = sessions.filter(s => s.status === 'waiting');
  const busySessions = sessions.filter(s => s.status === 'busy');
  const activeSessions = [...waitingSessions, ...busySessions];
  const idleSessions = sessions.filter(s => s.status === 'idle');
  const totalAllItems = (data.sessions || []).length + (data.todos || []).length;

  let bodyHtml = '';

  if (boardViewMode === 'kanban') {
    const columns = [];

    if (activeSessions.length > 0) {
      columns.push(`
        <div class="tb-column col-active ${waitingSessions.length > 0 ? 'has-waiting' : ''}">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot ${waitingSessions.length > 0 ? 'waiting' : 'busy'}"></span>
              <span>进行中</span>
              <span class="tb-col-count">${activeSessions.length}</span>
              ${waitingSessions.length > 0 ? `<span class="tb-col-alert">${waitingSessions.length} 需确认</span>` : ''}
            </div>
          </div>
          <div class="tb-col-cards">
            ${activeSessions.map(s => renderSessionCard(s, { showStatus: false, showWorkspace: showCardWorkspace })).join('')}
          </div>
        </div>
      `);
    }

    if (idleSessions.length > 0) {
      columns.push(`
        <div class="tb-column col-idle">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot idle"></span>
              <span>待命</span>
              <span class="tb-col-count">${idleSessions.length}</span>
            </div>
          </div>
          <div class="tb-col-cards">
            ${idleSessions.map(s => renderSessionCard(s, { showStatus: false, showWorkspace: showCardWorkspace })).join('')}
          </div>
        </div>
      `);
    }

    if (todos.length > 0) {
      columns.push(`
        <div class="tb-column col-todo">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot todo"></span>
              <span>待办</span>
              <span class="tb-col-count">${todos.length}</span>
            </div>
            <button class="tb-col-add-btn" data-action="open-new-task" title="新建待办">
              <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
          <div class="tb-col-cards">
            ${todos.map(t => renderTodoCard(t, { showStatus: false, showWorkspace: showCardWorkspace })).join('')}
          </div>
        </div>
      `);
    }

    if (columns.length === 0) {
      bodyHtml = `
        <div class="tb-empty-state">
          <span class="tb-empty-title">${searchQuery.trim() ? '未找到匹配任务' : '暂无任务'}</span>
          ${!searchQuery.trim() ? `
            <button class="tb-btn tb-btn-primary" data-action="open-new-task" style="margin-top: 4px;">
              <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
              <span>新建任务</span>
            </button>
          ` : ''}
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="tb-kanban-grid" data-cols="${columns.length}">
          ${columns.join('')}
        </div>
      `;
    }
  } else {
    // By-Project Grid View (cards show compact status, hide duplicate workspace name)
    const groupMap = new Map();
    for (const s of sessions) {
      const key = s.workspaceName || '默认工作区';
      if (!groupMap.has(key)) groupMap.set(key, { sessions: [], todos: [] });
      groupMap.get(key).sessions.push(s);
    }
    for (const t of todos) {
      const key = t.workspaceName || '未分组';
      if (!groupMap.has(key)) groupMap.set(key, { sessions: [], todos: [] });
      groupMap.get(key).todos.push(t);
    }

    if (groupMap.size === 0) {
      bodyHtml = `
        <div class="tb-empty-state">
          <span class="tb-empty-title">暂无任务</span>
          <button class="tb-btn tb-btn-primary" data-action="open-new-task" style="margin-top: 6px;">
            <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
            <span>新建任务</span>
          </button>
        </div>
      `;
    } else {
      bodyHtml = `<div class="tb-ws-groups">`;
      for (const [wsName, group] of groupMap.entries()) {
        const count = group.sessions.length + group.todos.length;
        bodyHtml += `
          <div class="tb-ws-group">
            <div class="tb-ws-group-header">
              <div class="tb-ws-group-title">
                <i data-lucide="folder" style="width: 14px; height: 14px; opacity: 0.7;"></i>
                <span>${escapeHtml(wsName)}</span>
                <span class="tb-col-count">${count}</span>
              </div>
            </div>
            <div class="tb-ws-group-grid">
              ${group.sessions.map(s => renderSessionCard(s, { showStatus: true, showWorkspace: false })).join('')}
              ${group.todos.map(t => renderTodoCard(t, { showStatus: true, showWorkspace: false })).join('')}
            </div>
          </div>
        `;
      }
      bodyHtml += `</div>`;
    }
  }

  container.innerHTML = `
    <div class="tb-root">
      <!-- 1. Minimal Borderless Top Bar -->
      <div class="tb-topbar">
        <div class="tb-topbar-left">
          <h2 class="tb-heading">任务看板</h2>
        </div>

        <div class="tb-topbar-right">
          <div class="tb-search-wrap">
            <i data-lucide="search" class="tb-search-icon"></i>
            <input type="text" id="tbSearchInput" class="tb-search-input" placeholder="搜索..." value="${escapeHtml(searchQuery)}">
            ${searchQuery ? `
              <button class="tb-search-clear" id="tbSearchClearBtn" title="清除">
                <i data-lucide="x" style="width: 12px; height: 12px;"></i>
              </button>
            ` : ''}
          </div>

          <div class="tb-segmented" role="tablist" aria-label="视图切换">
            <button class="tb-seg-btn ${boardViewMode === 'kanban' ? 'active' : ''}" data-action="switch-view" data-view="kanban">
              <i data-lucide="columns-3" style="width: 13px; height: 13px;"></i>
              <span>看板</span>
            </button>
            <button class="tb-seg-btn ${boardViewMode === 'grid' ? 'active' : ''}" data-action="switch-view" data-view="grid">
              <i data-lucide="layout-grid" style="width: 13px; height: 13px;"></i>
              <span>按项目</span>
            </button>
          </div>

          <button class="tb-btn tb-btn-primary" data-action="open-new-task" title="新建任务">
            <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
            <span class="tb-btn-label-hide-sm">新建</span>
          </button>

          <button class="tb-btn tb-btn-ghost tb-btn-icon" id="tbRefreshBtn" title="刷新">
            <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i>
          </button>
        </div>
      </div>

      <!-- 2. Workspace Filter Pills (only shown when > 1 workspace exists) -->
      ${hasMultipleWorkspaces ? `
        <div class="tb-ws-pills">
          <button class="tb-ws-pill ${selectedWorkspaceFilter === '' ? 'active' : ''}" data-action="filter-ws" data-ws="">
            <span>全部</span>
            <span class="tb-ws-count">${totalAllItems}</span>
          </button>
          ${workspaces.map(ws => {
            const wsTotal = (ws.sessionCount || 0) + (ws.todoCount || 0);
            return `
              <button class="tb-ws-pill ${selectedWorkspaceFilter === ws.name ? 'active' : ''}" data-action="filter-ws" data-ws="${escapeHtml(ws.name)}" title="${escapeHtml(ws.path || ws.name)}">
                <span>${escapeHtml(ws.name)}</span>
                ${wsTotal > 0 ? `<span class="tb-ws-count">${wsTotal}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      ` : ''}

      <!-- 3. Main Board Area -->
      ${bodyHtml}
    </div>
  `;

  if (window.lucide) {
    window.lucide.createIcons();
  }

  bindBoardEvents(container, data);

  // Restore focus to inline input if active
  if (activeRenameSession) {
    const renameInput = container.querySelector(`[data-rename-input="${CSS.escape(activeRenameSession)}"]`);
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
    }
  } else if (activeQuickReplySession) {
    const replyInput = container.querySelector(`[data-reply-input="${CSS.escape(activeQuickReplySession)}"]`);
    if (replyInput) {
      replyInput.focus();
    }
  }
}

function bindBoardEvents(container, data) {
  const refreshBtn = container.querySelector('#tbRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => renderProjectOverview());
  }

  // Search input (with Chinese IME guard)
  const searchInput = container.querySelector('#tbSearchInput');
  if (searchInput) {
    let isComposing = false;
    searchInput.addEventListener('compositionstart', () => { isComposing = true; });
    searchInput.addEventListener('compositionend', () => {
      isComposing = false;
      searchQuery = searchInput.value;
      buildBoardDOM(container, data);
      const nextInput = container.querySelector('#tbSearchInput');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
      }
    });
    searchInput.addEventListener('input', () => {
      if (isComposing) return;
      searchQuery = searchInput.value;
      buildBoardDOM(container, data);
      const nextInput = container.querySelector('#tbSearchInput');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
      }
    });
  }

  const clearBtn = container.querySelector('#tbSearchClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchQuery = '';
      buildBoardDOM(container, data);
    });
  }

  // View mode switcher
  container.querySelectorAll('[data-action="switch-view"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      if (view && view !== boardViewMode) {
        boardViewMode = view;
        localStorage.setItem('deck_taskboard_view_mode', view);
        buildBoardDOM(container, data);
      }
    });
  });

  // Workspace filter pills
  container.querySelectorAll('[data-action="filter-ws"]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedWorkspaceFilter = btn.getAttribute('data-ws') || '';
      localStorage.setItem('deck_taskboard_ws_filter', selectedWorkspaceFilter);
      buildBoardDOM(container, data);
    });
  });

  // Open new task modal
  container.querySelectorAll('[data-action="open-new-task"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNewTaskModal(data);
    });
  });

  // Click session card -> open session directly
  container.querySelectorAll('.tb-card[data-session-card]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-no-open]') || e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      const sessionName = card.getAttribute('data-session-card');
      if (sessionName) {
        attachSession(sessionName);
        closeSidebarOnMobile();
      }
    });
  });

  // Inline Rename Card
  container.querySelectorAll('[data-action="rename-card"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionName = btn.getAttribute('data-session');
      activeRenameSession = activeRenameSession === sessionName ? null : sessionName;
      activeQuickReplySession = null;
      buildBoardDOM(container, data);
    });
  });

  container.querySelectorAll('[data-action="cancel-rename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      activeRenameSession = null;
      buildBoardDOM(container, data);
    });
  });

  const submitRename = async (sessionName, value) => {
    try {
      await fetch('/api/task-board/card-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, customTitle: value.trim() })
      });
    } catch (err) {
      console.error('Failed to rename card:', err);
    }
    activeRenameSession = null;
    renderProjectOverview();
  };

  container.querySelectorAll('[data-action="save-rename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionName = btn.getAttribute('data-session');
      const input = container.querySelector(`[data-rename-input="${CSS.escape(sessionName)}"]`);
      if (input) submitRename(sessionName, input.value);
    });
  });

  container.querySelectorAll('.tb-rename-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const sessionName = input.getAttribute('data-rename-input');
        submitRename(sessionName, input.value);
      } else if (e.key === 'Escape') {
        activeRenameSession = null;
        buildBoardDOM(container, data);
      }
    });
  });

  // Inline Quick Reply
  container.querySelectorAll('[data-action="toggle-reply"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionName = btn.getAttribute('data-session');
      activeQuickReplySession = activeQuickReplySession === sessionName ? null : sessionName;
      activeRenameSession = null;
      buildBoardDOM(container, data);
    });
  });

  const submitQuickReply = async (sessionName, text, btnEl) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    if (btnEl) btnEl.disabled = true;
    try {
      const targetSess = (data.sessions || []).find(s => s.name === sessionName);
      const res = await fetch('/api/task-board/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionName,
          promptText: trimmed,
          sessionMode: targetSess ? targetSess.sessionMode : undefined,
          deviceId: state.currentDeviceId || undefined
        })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || '发送失败');
      }
      activeQuickReplySession = null;
      renderProjectOverview();
    } catch (err) {
      toast.error('发送失败: ' + err.message);
      if (btnEl) btnEl.disabled = false;
    }
  };

  container.querySelectorAll('[data-action="send-reply"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionName = btn.getAttribute('data-session');
      const input = container.querySelector(`[data-reply-input="${CSS.escape(sessionName)}"]`);
      if (input) submitQuickReply(sessionName, input.value, btn);
    });
  });

  container.querySelectorAll('.tb-quick-reply-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const sessionName = input.getAttribute('data-reply-input');
        const sendBtn = container.querySelector(`[data-action="send-reply"][data-session="${CSS.escape(sessionName)}"]`);
        submitQuickReply(sessionName, input.value, sendBtn);
      } else if (e.key === 'Escape') {
        activeQuickReplySession = null;
        buildBoardDOM(container, data);
      }
    });
  });

  // Delete Todo card
  container.querySelectorAll('[data-action="delete-todo"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const todoId = btn.getAttribute('data-todo-id');
      if (!todoId) return;
      try {
        await fetch(`/api/task-board/todos/${encodeURIComponent(todoId)}`, { method: 'DELETE' });
        renderProjectOverview();
      } catch (err) {
        console.error('Failed to delete todo:', err);
      }
    });
  });

  // Launch Todo card directly into a live Agent Session
  container.querySelectorAll('[data-action="launch-todo"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const todoId = btn.getAttribute('data-todo-id');
      const todo = (data.todos || []).find(t => String(t.id) === String(todoId));
      if (!todo) return;

      btn.disabled = true;
      try {
        await launchTaskSession({
          title: todo.title,
          description: todo.description,
          workspaceName: todo.workspaceName,
          workspacePath: todo.workspacePath,
          agentType: todo.agentType || 'agy',
          todoIdToDelete: todo.id
        });
      } catch (err) {
        toast.error('启动失败: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

/**
 * Create a live session for a task, set its custom card title, optionally dispatch initial prompt, and attach it
 */
async function launchTaskSession({ title, description, workspaceName, workspacePath, agentType = 'agy', todoIdToDelete = null }) {
  const workspaces = (lastBoardData && lastBoardData.workspaces) || state.workspacesList || [];
  let targetWs = workspaces.find(w => w.name === workspaceName);
  if (!targetWs && state.currentWorkspacePath) {
    targetWs = workspaces.find(w => w.path === state.currentWorkspacePath);
  }
  if (!targetWs && workspaces.length > 0) {
    targetWs = workspaces[0];
  }

  const finalWsName = workspaceName || (targetWs ? targetWs.name : 'default');
  const finalWsPath = workspacePath || (targetWs ? targetWs.path : state.currentWorkspacePath || '');
  const slug = `${agentType || 'task'}-${Date.now().toString(36).slice(-4)}`;

  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: slug,
      agent: agentType || 'agy',
      workspaceName: finalWsName,
      workspacePath: finalWsPath,
      deviceId: state.currentDeviceId || 'cloud'
    })
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP ${res.status}`);
  }

  const created = await res.json().catch(() => ({}));
  const createdName = created.name || slug;

  if (title) {
    await fetch('/api/task-board/card-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: createdName, customTitle: title })
    }).catch(() => {});
  }

  if (todoIdToDelete) {
    await fetch(`/api/task-board/todos/${encodeURIComponent(todoIdToDelete)}`, { method: 'DELETE' }).catch(() => {});
  }

  if (window.loadSessions) {
    await window.loadSessions();
  }

  attachSession(createdName);

  const promptText = description ? `${title}\n${description}` : title;
  if (promptText && (!state.currentDeviceId || state.currentDeviceId === 'cloud')) {
    setTimeout(() => {
      fetch('/api/task-board/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: createdName, promptText })
      }).catch(() => {});
    }, 1800);
  }
}

/**
 * Open minimal modal to create a Todo or directly launch a Task Session
 */
function openNewTaskModal(data) {
  const existing = document.getElementById('tbNewTaskModalOverlay');
  if (existing) existing.remove();

  isModalOpen = true;
  const workspaces = (data && data.workspaces) || state.workspacesList || [];
  const defaultWsName = selectedWorkspaceFilter ||
    (state.workspacesList.find(w => w.path === state.currentWorkspacePath)?.name) ||
    (workspaces[0]?.name || '');

  const overlay = document.createElement('div');
  overlay.id = 'tbNewTaskModalOverlay';
  overlay.className = 'tb-modal-overlay';
  overlay.innerHTML = `
    <div class="tb-modal-card" role="dialog" aria-modal="true" aria-label="新建任务">
      <div class="tb-modal-header">
        <span class="tb-modal-title">新建任务</span>
        <button class="tb-modal-close" id="tbModalCloseBtn" title="关闭">
          <i data-lucide="x" style="width: 16px; height: 16px;"></i>
        </button>
      </div>

      <div class="tb-form-group">
        <input type="text" id="tbNewTaskTitle" class="tb-input tb-input-title" placeholder="任务标题">
      </div>

      <div class="tb-form-group">
        <textarea id="tbNewTaskDesc" class="tb-textarea" placeholder="补充说明或首条指令（可选）"></textarea>
      </div>

      <div class="tb-form-row">
        <div class="tb-form-group">
          <label class="tb-form-label" for="tbNewTaskWs">工作区</label>
          <select id="tbNewTaskWs" class="tb-select">
            ${workspaces.map(ws => `
              <option value="${escapeHtml(ws.name)}" data-path="${escapeHtml(ws.path || '')}" ${ws.name === defaultWsName ? 'selected' : ''}>
                ${escapeHtml(ws.name)}
              </option>
            `).join('')}
          </select>
        </div>

        <div class="tb-form-group">
          <label class="tb-form-label" for="tbNewTaskAgent">智能体</label>
          <select id="tbNewTaskAgent" class="tb-select">
            <option value="agy">Antigravity</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="kimi">Kimi Code</option>
            <option value="default">Terminal</option>
          </select>
        </div>
      </div>

      <div class="tb-modal-footer">
        <button class="tb-btn tb-btn-ghost" id="tbModalCancelBtn">取消</button>
        <button class="tb-btn" id="tbModalSaveTodoBtn">加入待办</button>
        <button class="tb-btn tb-btn-primary" id="tbModalLaunchNowBtn">
          <i data-lucide="play" style="width: 12px; height: 12px;"></i>
          <span>直接启动</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  if (window.lucide) window.lucide.createIcons();

  const closeModal = () => {
    isModalOpen = false;
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('#tbModalCloseBtn').addEventListener('click', closeModal);
  overlay.querySelector('#tbModalCancelBtn').addEventListener('click', closeModal);

  const titleInput = overlay.querySelector('#tbNewTaskTitle');
  const descInput = overlay.querySelector('#tbNewTaskDesc');
  const wsSelect = overlay.querySelector('#tbNewTaskWs');
  const agentSelect = overlay.querySelector('#tbNewTaskAgent');
  const saveTodoBtn = overlay.querySelector('#tbModalSaveTodoBtn');
  const launchNowBtn = overlay.querySelector('#tbModalLaunchNowBtn');

  titleInput.focus();
  titleInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') closeModal();
  });

  const readForm = () => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return null;
    }
    const selectedOpt = wsSelect.options[wsSelect.selectedIndex];
    return {
      title,
      description: descInput.value.trim(),
      workspaceName: wsSelect.value || '',
      workspacePath: selectedOpt ? (selectedOpt.getAttribute('data-path') || '') : '',
      agentType: agentSelect.value || 'agy',
      priority: 'medium'
    };
  };

  saveTodoBtn.addEventListener('click', async () => {
    const payload = readForm();
    if (!payload) return;
    saveTodoBtn.disabled = true;
    try {
      const res = await fetch('/api/task-board/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('保存失败');
      closeModal();
      renderProjectOverview();
    } catch (err) {
      toast.error(err.message);
      saveTodoBtn.disabled = false;
    }
  });

  launchNowBtn.addEventListener('click', async () => {
    const payload = readForm();
    if (!payload) return;
    launchNowBtn.disabled = true;
    try {
      closeModal();
      await launchTaskSession(payload);
    } catch (err) {
      toast.error('启动失败: ' + err.message);
    }
  });
}

/**
 * Initialize event listeners for opening the Task Board from sidebar and background status poller
 */
export function initProjectOverviewEvents() {
  const openBtn = document.getElementById('openProjectOverviewBtn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      openProjectTab();
    });
  }

  if (!autoStatusInterval) {
    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'visible' &&
        state.activeTabId === 'tab-project-overview' &&
        !activeQuickReplySession &&
        !activeRenameSession &&
        !isModalOpen
      ) {
        renderProjectOverview({ silent: true });
      }
    });

    autoStatusInterval = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const hasProjectTab = state.tabs && state.tabs.some(t => t.type === 'project');
      if (!hasProjectTab) return;

      const isViewingBoard = state.activeTabId === 'tab-project-overview';
      const isUserInteracting = Boolean(activeQuickReplySession || activeRenameSession || isModalOpen);
      const searchEl = document.getElementById('tbSearchInput');
      const isTypingSearch = searchEl && document.activeElement === searchEl;

      if (isViewingBoard) {
        if (!isUserInteracting && !isTypingSearch) {
          renderProjectOverview({ silent: true });
        }
        return;
      }

      // Background tab-dot update throttled to every 10s when viewing other tabs
      const now = Date.now();
      if (now - lastBgBadgePollAt < 10000) return;
      lastBgBadgePollAt = now;

      try {
        const params = new URLSearchParams();
        if (state.currentDeviceId && state.currentDeviceId !== 'cloud') {
          params.set('deviceId', state.currentDeviceId);
        }
        const res = await fetch(`/api/task-board${params.toString() ? `?${params.toString()}` : ''}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.summary && data.summary.workspaceStatus) {
            updateProjectTabStatus(data.summary.workspaceStatus);
          }
        }
      } catch (e) {}
    }, 2500);
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
