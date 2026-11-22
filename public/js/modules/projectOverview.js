import { state } from './state.js';
import { activateTab, updateProjectTabStatus } from './tabs.js';
import { attachSession } from './terminal.js';
import { toast } from './toast.js';

let autoStatusInterval = null;
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
  let icon = 'terminal';
  let badgeClass = 'terminal';

  if (type === 'agy' || type === 'antigravity') {
    brand = 'Antigravity';
    icon = 'sparkles';
    badgeClass = 'agy';
  } else if (type === 'claude') {
    brand = 'Claude Code';
    icon = 'bot';
    badgeClass = 'claude';
  } else if (type === 'codex') {
    brand = 'Codex CLI';
    icon = 'cpu';
    badgeClass = 'codex';
  } else if (type === 'kimi') {
    brand = 'Kimi Code';
    icon = 'zap';
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
    label: brand,
    model: agentModel || '',
    shortModel: shortModel || agentModel || '',
    icon,
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
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
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
 * Fetch and render the Session-as-Task Kanban Board
 */
export async function renderProjectOverview(options = {}) {
  const container = document.getElementById('projectPanelContainer');
  if (!container) return;

  const { silent = false } = options;

  if (!silent && !container.querySelector('.tb-root')) {
    container.innerHTML = `
      <div class="loading-placeholder">
        <div class="cyber-spinner"></div>
        <span>正在汇总全部会话任务与状态...</span>
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

    // Reset workspace filter if the selected workspace no longer exists in list
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
      <div class="project-empty-lanes">
        <i data-lucide="alert-triangle" style="width: 34px; height: 34px; color: var(--neon-pink, #ff007f);"></i>
        <span style="font-weight: 600;">无法加载任务看板</span>
        <span style="font-size: 12px; color: var(--text-muted);">${escapeHtml(err.message)}</span>
        <button id="tbRetryBtn" class="tb-btn" style="margin-top: 8px;">
          <i data-lucide="refresh-cw" style="width: 13px; height: 13px;"></i> 重试
        </button>
      </div>
    `;
    const retryBtn = container.querySelector('#tbRetryBtn');
    if (retryBtn) retryBtn.addEventListener('click', () => renderProjectOverview());
    if (window.lucide) window.lucide.createIcons();
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

function renderSessionCard(sess) {
  const agent = getAgentInfo(sess.agentType, sess.agentModel);
  const status = sess.status || 'idle';
  const statusLabel = sess.statusLabel || (status === 'waiting' ? '需确认' : status === 'busy' ? '执行中' : '待命');
  const snippet = (sess.lastActivity && sess.lastActivity.text)
    ? sess.lastActivity.text
    : '会话已就绪，等待下达指令...';
  const relTime = formatRelativeTime(sess.lastActiveAt || sess.createdTimestamp);
  const showSessionId = sess.taskTitle && sess.taskTitle !== sess.name;
  const isRenaming = activeRenameSession === sess.name;
  const isReplying = activeQuickReplySession === sess.name;

  return `
    <div class="tb-card status-${status}" data-session-card="${escapeHtml(sess.name)}">
      <div class="tb-card-top">
        <div class="tb-card-meta-left">
          <span class="tb-status-tag ${status}">${escapeHtml(statusLabel)}</span>
          <span class="tb-ws-badge" title="工作区: ${escapeHtml(sess.workspaceName)}">
            <i data-lucide="folder" style="width: 11px; height: 11px; flex-shrink: 0;"></i>
            <span>${escapeHtml(sess.workspaceName)}</span>
          </span>
          ${sess.isRemote ? `<span class="tb-ws-badge" title="远程节点">远程</span>` : ''}
        </div>
        <button class="tb-card-edit-btn" data-action="rename-card" data-session="${escapeHtml(sess.name)}" title="重命名任务卡片标题">
          <i data-lucide="pencil" style="width: 12px; height: 12px;"></i>
        </button>
      </div>

      <div class="tb-card-body">
        ${isRenaming ? `
          <div class="tb-rename-row" data-no-open="1">
            <input type="text" class="tb-rename-input" data-rename-input="${escapeHtml(sess.name)}" value="${escapeHtml(sess.customTitle || sess.taskTitle || '')}" placeholder="输入任务标题，留空恢复默认">
            <button class="tb-mini-btn primary" data-action="save-rename" data-session="${escapeHtml(sess.name)}">保存</button>
            <button class="tb-mini-btn" data-action="cancel-rename">取消</button>
          </div>
        ` : `
          <div class="tb-card-title" title="${escapeHtml(sess.taskTitle)}">${escapeHtml(sess.taskTitle)}</div>
          ${showSessionId ? `<div class="tb-card-session-id">#${escapeHtml(sess.name)}</div>` : ''}
        `}
        <div class="tb-card-snippet" title="${escapeHtml(snippet)}">${escapeHtml(snippet)}</div>
      </div>

      ${isReplying ? `
        <div class="tb-quick-reply" data-no-open="1">
          <input type="text" class="tb-quick-reply-input" data-reply-input="${escapeHtml(sess.name)}" placeholder="直接发送下一步指令或回复 (Enter 发送)...">
          <button class="tb-mini-btn primary" data-action="send-reply" data-session="${escapeHtml(sess.name)}">
            <i data-lucide="send" style="width: 11px; height: 11px;"></i>
          </button>
        </div>
      ` : ''}

      <div class="tb-card-footer">
        <div class="tb-card-agent">
          <span class="tb-agent-pill ${agent.badgeClass}">
            <i data-lucide="${agent.icon}" style="width: 11px; height: 11px;"></i>
            <span>${escapeHtml(agent.brand)}</span>
          </span>
          ${agent.shortModel ? `<span class="tb-model-pill" title="${escapeHtml(agent.model)}">${escapeHtml(agent.shortModel)}</span>` : ''}
          ${relTime ? `<span class="tb-time-label">${escapeHtml(relTime)}</span>` : ''}
        </div>
        <div class="tb-card-actions" data-no-open="1">
          ${!sess.isRemote ? `
            <button class="tb-mini-btn" data-action="toggle-reply" data-session="${escapeHtml(sess.name)}" title="在卡片内快捷续发指令">
              <i data-lucide="message-square-plus" style="width: 11px; height: 11px;"></i>
              <span>续发</span>
            </button>
          ` : ''}
          <button class="tb-mini-btn primary" data-action="open-session" data-session="${escapeHtml(sess.name)}" title="进入该会话终端 / Chat">
            <span>进入</span>
            <i data-lucide="arrow-up-right" style="width: 11px; height: 11px;"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderTodoCard(todo) {
  const agent = getAgentInfo(todo.agentType || 'agy', '');
  const relTime = formatRelativeTime(todo.updatedAt || todo.createdAt);

  return `
    <div class="tb-card status-todo" data-todo-card="${escapeHtml(todo.id)}">
      <div class="tb-card-top">
        <div class="tb-card-meta-left">
          <span class="tb-status-tag todo">待办</span>
          ${todo.priority === 'high' ? `<span class="tb-priority-tag high">高优</span>` : ''}
          ${todo.workspaceName ? `
            <span class="tb-ws-badge" title="目标工作区: ${escapeHtml(todo.workspaceName)}">
              <i data-lucide="folder" style="width: 11px; height: 11px; flex-shrink: 0;"></i>
              <span>${escapeHtml(todo.workspaceName)}</span>
            </span>
          ` : ''}
        </div>
      </div>

      <div class="tb-card-body">
        <div class="tb-card-title">${escapeHtml(todo.title)}</div>
        ${todo.description ? `<div class="tb-card-snippet">${escapeHtml(todo.description)}</div>` : ''}
      </div>

      <div class="tb-card-footer">
        <div class="tb-card-agent">
          <span class="tb-agent-pill ${agent.badgeClass}">
            <i data-lucide="${agent.icon}" style="width: 11px; height: 11px;"></i>
            <span>${escapeHtml(agent.brand)}</span>
          </span>
          ${relTime ? `<span class="tb-time-label">${escapeHtml(relTime)}</span>` : ''}
        </div>
        <div class="tb-card-actions" data-no-open="1">
          <button class="tb-mini-btn primary" data-action="launch-todo" data-todo-id="${escapeHtml(todo.id)}" title="基于此待办立即拉起智能体会话并执行">
            <i data-lucide="play" style="width: 11px; height: 11px;"></i>
            <span>启动</span>
          </button>
          <button class="tb-mini-btn danger" data-action="delete-todo" data-todo-id="${escapeHtml(todo.id)}" title="删除待办卡片">
            <i data-lucide="trash-2" style="width: 11px; height: 11px;"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildBoardDOM(container, data) {
  const { sessions, todos } = filterItems(data);
  const workspaces = data.workspaces || [];

  const waitingSessions = sessions.filter(s => s.status === 'waiting');
  const busySessions = sessions.filter(s => s.status === 'busy');
  const idleSessions = sessions.filter(s => s.status === 'idle');
  const totalAllSessions = (data.sessions || []).length;

  let bodyHtml = '';

  if (boardViewMode === 'kanban') {
    bodyHtml = `
      <div class="tb-kanban-grid">
        <!-- Column 1: Needs Attention / Waiting -->
        <div class="tb-column col-waiting ${waitingSessions.length > 0 ? 'has-items' : ''}">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot waiting"></span>
              <span>需确认 / 待介入</span>
              <span class="tb-col-count">${waitingSessions.length}</span>
            </div>
          </div>
          <div class="tb-col-cards">
            ${waitingSessions.length > 0
              ? waitingSessions.map(renderSessionCard).join('')
              : `<div class="tb-col-empty"><i data-lucide="check-circle-2" style="width: 18px; height: 18px; opacity: 0.55;"></i><span>暂无等待审批的任务</span></div>`
            }
          </div>
        </div>

        <!-- Column 2: Running / Busy -->
        <div class="tb-column col-busy">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot busy"></span>
              <span>执行中</span>
              <span class="tb-col-count">${busySessions.length}</span>
            </div>
          </div>
          <div class="tb-col-cards">
            ${busySessions.length > 0
              ? busySessions.map(renderSessionCard).join('')
              : `<div class="tb-col-empty"><i data-lucide="cpu" style="width: 18px; height: 18px; opacity: 0.55;"></i><span>当前没有运行中的 Agent</span></div>`
            }
          </div>
        </div>

        <!-- Column 3: Idle / Ready -->
        <div class="tb-column col-idle">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot idle"></span>
              <span>待命 / 待验收</span>
              <span class="tb-col-count">${idleSessions.length}</span>
            </div>
          </div>
          <div class="tb-col-cards">
            ${idleSessions.length > 0
              ? idleSessions.map(renderSessionCard).join('')
              : `<div class="tb-col-empty"><i data-lucide="coffee" style="width: 18px; height: 18px; opacity: 0.55;"></i><span>暂无空闲待命会话</span></div>`
            }
          </div>
        </div>

        <!-- Column 4: Todo Backlog -->
        <div class="tb-column col-todo">
          <div class="tb-col-header">
            <div class="tb-col-title">
              <span class="tb-col-dot todo"></span>
              <span>待办任务</span>
              <span class="tb-col-count">${todos.length}</span>
            </div>
            <button class="tb-col-add-btn" data-action="open-new-task" title="新建待办任务卡片">
              <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
          <div class="tb-col-cards">
            ${todos.length > 0
              ? todos.map(renderTodoCard).join('')
              : `<div class="tb-col-empty"><i data-lucide="inbox" style="width: 18px; height: 18px; opacity: 0.55;"></i><span>随手记下待办，随时一键拉起会话</span></div>`
            }
          </div>
        </div>
      </div>
    `;
  } else {
    // Grid mode: Grouped by Workspace
    const groupMap = new Map();
    for (const s of sessions) {
      const key = s.workspaceName || '默认工作区';
      if (!groupMap.has(key)) groupMap.set(key, { sessions: [], todos: [] });
      groupMap.get(key).sessions.push(s);
    }
    for (const t of todos) {
      const key = t.workspaceName || '未分配工作区';
      if (!groupMap.has(key)) groupMap.set(key, { sessions: [], todos: [] });
      groupMap.get(key).todos.push(t);
    }

    if (groupMap.size === 0) {
      bodyHtml = `
        <div class="project-empty-lanes">
          <i data-lucide="kanban" style="width: 34px; height: 34px; opacity: 0.65;"></i>
          <span>当前筛选条件下暂无任务卡片</span>
          <button class="tb-btn tb-btn-primary" data-action="open-new-task" style="margin-top: 6px;">
            <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
            <span>新建任务 / 启动会话</span>
          </button>
        </div>
      `;
    } else {
      bodyHtml = `<div class="tb-ws-groups">`;
      for (const [wsName, group] of groupMap.entries()) {
        const wsMeta = workspaces.find(w => w.name === wsName);
        const branchBadge = (wsMeta && wsMeta.git && wsMeta.git.isRepo)
          ? `<span class="tb-ws-badge"><i data-lucide="git-branch" style="width: 11px; height: 11px;"></i> ${escapeHtml(wsMeta.git.branch)}${wsMeta.git.changedFilesCount > 0 ? ` · ${wsMeta.git.changedFilesCount}改` : ''}</span>`
          : '';
        const count = group.sessions.length + group.todos.length;
        bodyHtml += `
          <div class="tb-ws-group">
            <div class="tb-ws-group-header">
              <div class="tb-ws-group-title">
                <i data-lucide="folder-git-2" style="width: 15px; height: 15px;"></i>
                <span>${escapeHtml(wsName)}</span>
                ${branchBadge}
                <span class="tb-col-count">${count}</span>
              </div>
            </div>
            <div class="tb-ws-group-grid">
              ${group.sessions.map(renderSessionCard).join('')}
              ${group.todos.map(renderTodoCard).join('')}
            </div>
          </div>
        `;
      }
      bodyHtml += `</div>`;
    }
  }

  container.innerHTML = `
    <div class="tb-root">
      <!-- 1. Top Command Header -->
      <div class="tb-header">
        <div class="tb-header-left">
          <div class="tb-title-group">
            <span class="tb-title-icon">
              <i data-lucide="kanban" style="width: 16px; height: 16px;"></i>
            </span>
            <div class="tb-title-text">
              <span class="tb-title-main">任务看板</span>
              <span class="tb-title-sub">以会话为任务卡片，一屏掌控全部 Agent 进展</span>
            </div>
          </div>

          <div class="tb-kpi-strip">
            <span class="tb-kpi-pill ${waitingSessions.length > 0 ? 'is-waiting' : ''}">
              <span class="tb-dot" style="background: #f59e0b;"></span>
              <span>需确认 ${waitingSessions.length}</span>
            </span>
            <span class="tb-kpi-pill ${busySessions.length > 0 ? 'is-busy' : ''}">
              <span class="tb-dot" style="background: var(--neon-cyan, #00f0ff);"></span>
              <span>执行中 ${busySessions.length}</span>
            </span>
            <span class="tb-kpi-pill ${idleSessions.length > 0 ? 'is-idle' : ''}">
              <span class="tb-dot" style="background: #10b981;"></span>
              <span>待命 ${idleSessions.length}</span>
            </span>
            <span class="tb-kpi-pill">
              <span class="tb-dot" style="background: #94a3b8;"></span>
              <span>待办 ${todos.length}</span>
            </span>
          </div>
        </div>

        <div class="tb-header-right">
          <div class="tb-segmented" role="tablist" aria-label="视图切换">
            <button class="tb-seg-btn ${boardViewMode === 'kanban' ? 'active' : ''}" data-action="switch-view" data-view="kanban" title="按状态分列看板视图">
              <i data-lucide="columns-3" style="width: 13px; height: 13px;"></i>
              <span>看板</span>
            </button>
            <button class="tb-seg-btn ${boardViewMode === 'grid' ? 'active' : ''}" data-action="switch-view" data-view="grid" title="按工作区分组卡片视图">
              <i data-lucide="layout-grid" style="width: 13px; height: 13px;"></i>
              <span>按项目</span>
            </button>
          </div>

          <button class="tb-btn tb-btn-primary" data-action="open-new-task" title="新建待办卡片或直接启动新会话任务">
            <i data-lucide="plus" style="width: 14px; height: 14px;"></i>
            <span class="tb-btn-label-hide-sm">新建任务</span>
          </button>

          <button class="tb-btn tb-btn-icon" id="tbRefreshBtn" title="立即刷新看板状态">
            <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i>
          </button>
        </div>
      </div>

      <!-- 2. Workspace Filter Pills & Search -->
      <div class="tb-filter-bar">
        <div class="tb-ws-pills">
          <button class="tb-ws-pill ${selectedWorkspaceFilter === '' ? 'active' : ''}" data-action="filter-ws" data-ws="">
            <span>全部工作区</span>
            <span class="tb-ws-count">${totalAllSessions}</span>
          </button>
          ${workspaces.map(ws => `
            <button class="tb-ws-pill ${selectedWorkspaceFilter === ws.name ? 'active' : ''}" data-action="filter-ws" data-ws="${escapeHtml(ws.name)}" title="${escapeHtml(ws.path || ws.name)}">
              <span>${escapeHtml(ws.name)}</span>
              ${ws.git && ws.git.isRepo ? `<span class="tb-ws-branch">${escapeHtml(ws.git.branch)}</span>` : ''}
              ${ws.git && ws.git.changedFilesCount > 0 ? `<span class="tb-ws-dirty-dot" title="${ws.git.changedFilesCount} 个未提交修改"></span>` : ''}
              <span class="tb-ws-count">${ws.sessionCount}</span>
            </button>
          `).join('')}
        </div>

        <div class="tb-search-wrap">
          <i data-lucide="search" class="tb-search-icon"></i>
          <input type="text" id="tbSearchInput" class="tb-search-input" placeholder="搜索任务 / 会话 / 模型..." value="${escapeHtml(searchQuery)}">
          ${searchQuery ? `
            <button class="tb-search-clear" id="tbSearchClearBtn" title="清除搜索">
              <i data-lucide="x" style="width: 12px; height: 12px;"></i>
            </button>
          ` : ''}
        </div>
      </div>

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
  // Refresh
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

  // Click session card body -> open session
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

  // Open session button
  container.querySelectorAll('[data-action="open-session"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionName = btn.getAttribute('data-session');
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
      const res = await fetch('/api/task-board/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, promptText: trimmed })
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
        toast.error('启动任务会话失败: ' + err.message);
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

  // Persist readable task title on the newly created session card
  if (title) {
    await fetch('/api/task-board/card-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: createdName, customTitle: title })
    }).catch(() => {});
  }

  // Delete originating todo card if launched from Todo column
  if (todoIdToDelete) {
    await fetch(`/api/task-board/todos/${encodeURIComponent(todoIdToDelete)}`, { method: 'DELETE' }).catch(() => {});
  }

  // Refresh sidebar session list
  if (window.loadSessions) {
    await window.loadSessions();
  }

  // Attach to the new session immediately
  attachSession(createdName);

  // If user provided a task prompt/description, dispatch it after the CLI boots briefly
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
 * Open sleek modal to create a Todo card or directly launch a new Task Session
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
    <div class="tb-modal-card" role="dialog" aria-modal="true" aria-label="新建任务卡片">
      <div class="tb-modal-header">
        <div class="tb-modal-title">
          <i data-lucide="plus-circle" style="width: 17px; height: 17px;"></i>
          <span>新建任务卡片</span>
        </div>
        <button class="tb-modal-close" id="tbModalCloseBtn" title="关闭">
          <i data-lucide="x" style="width: 16px; height: 16px;"></i>
        </button>
      </div>

      <div class="tb-form-group">
        <label class="tb-form-label" for="tbNewTaskTitle">任务标题 *</label>
        <input type="text" id="tbNewTaskTitle" class="tb-input" placeholder="例如：优化登录页浅色主题对比度">
      </div>

      <div class="tb-form-group">
        <label class="tb-form-label" for="tbNewTaskDesc">任务说明 / 初始指令（可选）</label>
        <textarea id="tbNewTaskDesc" class="tb-textarea" placeholder="补充具体要求；选择「直接启动会话」时将作为首条指令发送给 Agent"></textarea>
      </div>

      <div class="tb-form-row">
        <div class="tb-form-group">
          <label class="tb-form-label" for="tbNewTaskWs">所属工作区</label>
          <select id="tbNewTaskWs" class="tb-select">
            ${workspaces.map(ws => `
              <option value="${escapeHtml(ws.name)}" data-path="${escapeHtml(ws.path || '')}" ${ws.name === defaultWsName ? 'selected' : ''}>
                ${escapeHtml(ws.name)}
              </option>
            `).join('')}
          </select>
        </div>

        <div class="tb-form-group">
          <label class="tb-form-label" for="tbNewTaskAgent">执行智能体</label>
          <select id="tbNewTaskAgent" class="tb-select">
            <option value="agy">Antigravity (AGY)</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="kimi">Kimi Code</option>
            <option value="default">纯终端 (Terminal)</option>
          </select>
        </div>
      </div>

      <div class="tb-form-group">
        <label class="tb-form-label" for="tbNewTaskPriority">优先级</label>
        <select id="tbNewTaskPriority" class="tb-select">
          <option value="medium" selected>普通</option>
          <option value="high">高优先级</option>
          <option value="low">低优先级</option>
        </select>
      </div>

      <div class="tb-modal-footer">
        <button class="tb-btn" id="tbModalCancelBtn">取消</button>
        <button class="tb-btn" id="tbModalSaveTodoBtn">
          <i data-lucide="inbox" style="width: 13px; height: 13px;"></i>
          <span>加入待办列</span>
        </button>
        <button class="tb-btn tb-btn-primary" id="tbModalLaunchNowBtn">
          <i data-lucide="play" style="width: 13px; height: 13px;"></i>
          <span>直接启动会话</span>
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
  const prioritySelect = overlay.querySelector('#tbNewTaskPriority');
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
      priority: prioritySelect.value || 'medium'
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
      if (!res.ok) throw new Error('保存待办失败');
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
      toast.error('启动会话失败: ' + err.message);
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
    autoStatusInterval = setInterval(async () => {
      const hasProjectTab = state.tabs && state.tabs.some(t => t.type === 'project');
      if (!hasProjectTab) return;

      const isViewingBoard = state.activeTabId === 'tab-project-overview';
      const isUserInteracting = Boolean(activeQuickReplySession || activeRenameSession || isModalOpen);
      const searchEl = document.getElementById('tbSearchInput');
      const isTypingSearch = searchEl && document.activeElement === searchEl;

      if (isViewingBoard && !isUserInteracting && !isTypingSearch) {
        renderProjectOverview({ silent: true });
        return;
      }

      // Lightweight status badge update when viewing other tabs
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
    }, 7000);
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
