import { state } from './state.js';
import { activateTab, renderTabs, updateProjectTabStatus } from './tabs.js';
import { attachSession } from './terminal.js';

let isEditingMission = false;
let autoStatusInterval = null;

function closeSidebarOnMobile() {
  const sidebar = document.querySelector('.sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  if (window.innerWidth <= 768 && sidebar && sidebarOverlay) {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.add('hidden');
  }
}

/**
 * Helper to resolve agent brand info, labels and styling
 */
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
  } else if (agentType) {
    brand = agentType.toUpperCase();
  }

  // Clean up and compact model name for tag display
  let shortModel = (agentModel || '').trim();
  if (shortModel.includes(' · ')) {
    // e.g. "Moonshot Kimi · Kimi K3 (256k)" -> "Kimi K3"
    const parts = shortModel.split(' · ');
    shortModel = parts[parts.length - 1];
  }
  // Strip trailing context window parentheses like "(256k)", "(128k)" to keep it clean
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

/**
 * Open or focus the Project Progress HUD tab (ALWAYS at Index 0)
 */
export function openProjectTab() {
  closeSidebarOnMobile();
  const tabId = 'tab-project-overview';
  let tab = state.tabs.find(t => t.id === tabId);
  if (!tab) {
    tab = {
      id: tabId,
      name: '项目进度',
      type: 'project',
      path: 'project'
    };
    // Ensure it is ALWAYS inserted at the very beginning (index 0)
    state.tabs.unshift(tab);
  } else {
    // If already exists, ensure it is moved to index 0
    const idx = state.tabs.indexOf(tab);
    if (idx > 0) {
      state.tabs.splice(idx, 1);
      state.tabs.unshift(tab);
    }
  }
  activateTab(tabId);
}

/**
 * Fetch and render the comprehensive project progression dashboard
 */
export async function renderProjectOverview() {
  const container = document.getElementById('projectPanelContainer');
  if (!container) return;

  // Determine current active workspace name
  const workspaceSelect = document.getElementById('explorerWorkspaceSelect');
  const currentPath = state.currentWorkspacePath || (workspaceSelect ? workspaceSelect.value : '');
  const matchedWs = state.workspacesList.find(w => w.path === currentPath);
  const workspaceName = matchedWs ? matchedWs.name : (currentPath ? currentPath.split('/').filter(Boolean).pop() : '');

  if (!workspaceName && !currentPath) {
    container.innerHTML = `
      <div class="project-empty-lanes">
        <i data-lucide="alert-circle" style="width: 32px; height: 32px;"></i>
        <span>请先选择一个有效的工作区</span>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  const queryIdentifier = workspaceName || currentPath;

  // Show loading state if container is empty
  if (!container.querySelector('.project-hero-card')) {
    container.innerHTML = `
      <div class="loading-placeholder">
        <div class="cyber-spinner"></div>
        <span>正在扫描工作区项目脉络与智能体工位...</span>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(queryIdentifier)}/project-progress`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    buildOverviewDOM(container, data, queryIdentifier);
  } catch (err) {
    container.innerHTML = `
      <div class="project-empty-lanes">
        <i data-lucide="alert-triangle" style="width: 36px; height: 36px; color: var(--neon-pink, #ff007f);"></i>
        <span style="font-weight: 600; color: #ffffff;">无法读取工作区项目进度</span>
        <span style="font-size: 12px; color: var(--text-muted);">${err.message}</span>
        <button id="projectRetryBtn" class="cyber-btn-outline" style="margin-top: 8px;">
          <i data-lucide="refresh-cw"></i> 重试
        </button>
      </div>
    `;
    const retryBtn = document.getElementById('projectRetryBtn');
    if (retryBtn) retryBtn.addEventListener('click', () => renderProjectOverview());
    if (window.lucide) window.lucide.createIcons();
  }
}

/**
 * Build the full Project Overview DOM tree
 */
function buildOverviewDOM(container, data, queryIdentifier) {
  const { workspaceName, git, mission, sessions, workspaceStatus, tasks = [] } = data;

  // Update tab status badge immediately
  if (workspaceStatus) {
    updateProjectTabStatus(workspaceStatus);
  }

  const gitChangesBadge = git.isRepo
    ? (git.changedFilesCount > 0
      ? `<span class="project-git-changes-badge dirty"><i data-lucide="file-diff" style="width: 12px; height: 12px;"></i> ${git.changedFilesCount} 项修改</span>`
      : `<span class="project-git-changes-badge clean"><i data-lucide="check" style="width: 12px; height: 12px;"></i> 工作区干净</span>`)
    : '';

  const gitBranchBadge = git.isRepo
    ? `<span class="project-git-badge"><i data-lucide="git-branch" style="width: 12px; height: 12px;"></i> ${git.branch}</span>`
    : `<span class="project-git-badge"><i data-lucide="folder" style="width: 12px; height: 12px;"></i> 本地目录</span>`;

  // 1. Hero / Header Card
  let html = `
    <div class="project-hero-card">
      <div class="project-hero-top">
        <div class="project-identity">
          <div class="project-name">
            <i data-lucide="layers" style="color: var(--neon-cyan, #00f0ff); width: 22px; height: 22px;"></i>
            <span>${escapeHtml(workspaceName)}</span>
          </div>
          ${gitBranchBadge}
          ${gitChangesBadge}
        </div>
        <div class="project-hero-actions">
          <button id="projectRefreshDataBtn" class="cyber-btn-outline" title="刷新项目实时动态" style="height: 32px; padding: 0 10px; font-size: 11px;">
            <i data-lucide="refresh-cw" style="width: 13px; height: 13px;"></i>
            <span>刷新</span>
          </button>
        </div>
      </div>

      <div class="project-mission-box" id="projectMissionBox">
        <div class="project-mission-content">
          <div class="mission-label">
            <i data-lucide="target" style="width: 13px; height: 13px;"></i>
            <span>当前推进目标 (MISSION)</span>
          </div>
          <div class="mission-text ${!mission ? 'placeholder' : ''}" id="projectMissionDisplay">
            ${mission ? escapeHtml(mission) : '点击右侧按钮设定当前项目的核心推进目标...'}
          </div>
        </div>
        <button id="editMissionBtn" class="mission-edit-btn" title="编辑目标">
          <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i>
          <span>设定</span>
        </button>
      </div>
    </div>
  `;

  // 2. Roadmap & Tasks Board (目标拆解大盘)
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
  const todoTasks = tasks.filter(t => t.status === 'todo' || !t.status).length;
  const progressPercent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  html += `
    <div class="project-roadmap-card" id="projectRoadmapCard">
      <div class="roadmap-header">
        <div class="roadmap-title-row">
          <div class="roadmap-title">
            <i data-lucide="kanban" style="width: 15px; height: 15px;"></i>
            <span>目标拆解与推进大盘 (ROADMAP & TASKS)</span>
            <span class="roadmap-count-pill">${doneTasks}/${totalTasks} 完成 (${progressPercent}%)</span>
          </div>
          <div class="roadmap-actions">
            <button id="decomposeWithAgentBtn" class="roadmap-action-btn secondary" title="生成标准拆解指令并填入派发栏">
              <i data-lucide="sparkles" style="width: 12px; height: 12px;"></i>
              <span>让 Agent 拆解任务</span>
            </button>
            <button id="openNewTaskModalBtn" class="roadmap-action-btn primary" title="手动添加子任务">
              <i data-lucide="plus" style="width: 12px; height: 12px;"></i>
              <span>新建任务</span>
            </button>
          </div>
        </div>

        <div class="roadmap-progress-bar-bg">
          <div class="roadmap-progress-bar-fill" style="width: ${progressPercent}%;"></div>
        </div>
      </div>

      <div class="roadmap-tasks-list" id="roadmapTasksList">
  `;

  if (tasks.length === 0) {
    html += `
      <div class="roadmap-empty-state">
        <i data-lucide="list-checks" style="width: 28px; height: 28px;"></i>
        <span>尚未拆解子任务。点击右上角【让 Agent 拆解任务】或手动添加任务。</span>
      </div>
    `;
  } else {
    tasks.forEach(task => {
      const isDone = task.status === 'done';
      const isInProgress = task.status === 'in_progress';
      const statusClass = isDone ? 'done' : (isInProgress ? 'in-progress' : 'todo');
      const statusIcon = isDone ? 'check-circle-2' : (isInProgress ? 'play-circle' : 'circle');

      html += `
        <div class="roadmap-task-row ${statusClass}" data-task-id="${escapeHtml(task.id)}">
          <button class="task-check-btn ${isDone ? 'checked' : ''}" data-task-id="${escapeHtml(task.id)}" title="${isDone ? '标记为未完成' : '标记为已完成'}">
            <i data-lucide="${statusIcon}" style="width: 15px; height: 15px;"></i>
          </button>
          <div class="task-content">
            <div class="task-title-line">
              <span class="task-title ${isDone ? 'done-text' : ''}">${escapeHtml(task.title)}</span>
              ${task.priority === 'high' ? '<span class="task-priority-tag high">高优</span>' : ''}
              ${task.assignee ? `<span class="task-assignee-tag"><i data-lucide="user" style="width: 10px; height: 10px;"></i> ${escapeHtml(task.assignee)}</span>` : ''}
            </div>
            ${task.description ? `<div class="task-desc">${escapeHtml(task.description)}</div>` : ''}
          </div>
          <div class="task-actions">
            ${!isDone ? `
              <button class="task-btn-dispatch" data-task-id="${escapeHtml(task.id)}" data-title="${escapeHtml(task.title)}" data-desc="${escapeHtml(task.description || '')}" title="将此任务填入派发输入框">
                <i data-lucide="send" style="width: 12px; height: 12px;"></i>
                <span>派发</span>
              </button>
            ` : ''}
            <button class="task-btn-delete" data-task-id="${escapeHtml(task.id)}" title="删除此任务">
              <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </button>
          </div>
        </div>
      `;
    });
  }

  html += `
      </div>
    </div>
  `;

  // 3. Task Dispatch Card (任务派发中枢)
  const defaultTarget = (sessions && sessions.length > 0) ? sessions[0].name : '__new__';
  const firstSession = (sessions && sessions.length > 0) ? sessions[0] : null;
  const firstSessionStatus = firstSession ? firstSession.status : 'empty';

  let initialHint = '💡 当前无可用会话，派发后将自动引导创建新智能体会话。';
  if (firstSession) {
    if (firstSessionStatus === 'busy') {
      initialHint = `⚠️ 提示：选中的 Agent [${escapeHtml(firstSession.name)}] 当前正在执行中，派发指令可能会打断当前任务或进入排队。`;
    } else if (firstSessionStatus === 'waiting') {
      initialHint = `🟡 提示：选中的 Agent [${escapeHtml(firstSession.name)}] 当前正在等待用户确认或授权。`;
    } else {
      initialHint = `🟢 选中的 Agent [${escapeHtml(firstSession.name)}] 当前空闲就绪，派发后将立即开始执行。`;
    }
  }

  html += `
    <div class="project-dispatch-card" id="projectDispatchCard">
      <div class="dispatch-header">
        <div class="dispatch-title">
          <i data-lucide="send" style="width: 14px; height: 14px;"></i>
          <span>派发任务给智能体 (DISPATCH TASK)</span>
        </div>
        <div class="dispatch-target-row">
          <label for="dispatchTargetSelect" class="dispatch-target-label">指派工位:</label>
          <select id="dispatchTargetSelect" class="dispatch-select">
            ${sessions.map(s => {
              const statusIcon = s.status === 'busy' ? '🟠' : (s.status === 'waiting' ? '🟡' : '🟢');
              const agentMeta = getAgentInfo(s.agentType, s.agentModel);
              return `<option value="${escapeHtml(s.name)}" data-agent-type="${escapeHtml(s.agentType || '')}" data-status="${s.status}">${statusIcon} ${escapeHtml(s.name)} [${escapeHtml(agentMeta.label)}] · ${escapeHtml(s.statusLabel || '空闲')}</option>`;
            }).join('')}
            <option value="__new__">➕ 启动新会话并指派...</option>
          </select>
        </div>
      </div>

      <div class="dispatch-input-row">
        <textarea id="dispatchTaskInput" class="dispatch-textarea" placeholder="输入给该 Agent 的具体指令或任务（例如：检查路由并添加手机端收起逻辑，支持按 Ctrl+Enter 派发）..." rows="2"></textarea>
        <button id="dispatchSubmitBtn" class="dispatch-submit-btn ${firstSessionStatus === 'busy' ? 'busy-warn' : ''}" title="派发任务指令 (Ctrl+Enter)">
          <i data-lucide="play" style="width: 14px; height: 14px;"></i>
          <span class="submit-btn-text">${firstSessionStatus === 'busy' ? '⚠️ 确认插队派发' : '立即派发'}</span>
        </button>
      </div>

      <div class="dispatch-options-row">
        <label class="dispatch-checkbox-label" title="开启后派发任务前将主动清理当前对话上下文（Claude/Agy 执行 /clear，Codex 执行 /new）">
          <input type="checkbox" id="dispatchClearHistoryCheck">
          <span class="checkbox-custom"></span>
          <span class="checkbox-text">派发前清理上下文</span>
          <span class="checkbox-agent-hint" id="dispatchCleanCmdHint">(执行 /clear)</span>
        </label>
      </div>

      <div class="dispatch-feedback-bar ${firstSessionStatus === 'busy' ? 'warning' : 'ready'}" id="dispatchFeedbackBar">
        <span id="dispatchStatusHintText">${initialHint}</span>
      </div>
    </div>
  `;

  // 3. Active Workstreams Section
  html += `
    <div class="project-section-header">
      <div class="project-section-title">
        <i data-lucide="cpu" style="width: 15px; height: 15px;"></i>
        <span>活跃智能体工位 (WORKSTREAMS)</span>
        <span class="project-section-badge">${sessions.length}</span>
      </div>
    </div>
  `;

  if (sessions.length === 0) {
    html += `
      <div class="project-empty-lanes">
        <i data-lucide="terminal" style="width: 32px; height: 32px;"></i>
        <span>当前工作区暂无运行中的智能体会话</span>
        <button id="projectLaunchSessionBtn" class="cyber-btn-outline" style="margin-top: 6px;">
          <i data-lucide="plus"></i> 启动第一个会话
        </button>
      </div>
    `;
  } else {
    html += `<div class="project-lanes-grid">`;
    sessions.forEach(sess => {
      const agentMeta = getAgentInfo(sess.agentType, sess.agentModel);
      const badgeClass = agentMeta.badgeClass;
      const badgeLabel = agentMeta.label;
      const agentIcon = agentMeta.icon;

      let snippetText = '会话已挂载就绪，等待输入...';
      if (sess.lastActivity && sess.lastActivity.text) {
        snippetText = sess.lastActivity.text;
      }

      const statusCls = sess.status === 'busy' ? 'status-busy' : (sess.status === 'waiting' ? 'status-waiting' : 'status-idle');

      html += `
        <div class="project-lane-card" data-session-name="${escapeHtml(sess.name)}">
          <div class="lane-card-top">
            <div class="lane-agent-info">
              <span class="lane-session-name">${escapeHtml(sess.name)}</span>
              <span class="lane-agent-badge ${badgeClass}">
                <i data-lucide="${agentIcon}" style="width: 12px; height: 12px;"></i>
                ${escapeHtml(badgeLabel)}
              </span>
              ${agentMeta.shortModel ? `<span class="lane-model-tag" title="完整模型: ${escapeHtml(agentMeta.model)}">${escapeHtml(agentMeta.shortModel)}</span>` : ''}
            </div>
            <div class="lane-status-pill ${statusCls}">
              <span class="lane-status-dot ${sess.status || 'idle'}"></span>
              <span>${escapeHtml(sess.statusLabel || (sess.attached ? '活跃中' : '空闲'))}</span>
            </div>
          </div>

          <div class="lane-activity-snippet" title="${escapeHtml(snippetText)}">
            ${escapeHtml(snippetText)}
          </div>

          <div class="lane-card-actions">
            <button class="btn-jump-session" data-session="${escapeHtml(sess.name)}">
              <i data-lucide="arrow-up-right" style="width: 13px; height: 13px;"></i>
              <span>进入终端 / Chat</span>
            </button>
          </div>
        </div>
      `;
    });
    html += `</div>`;
  }

  // 4. Unified Timeline & Feed Section
  if (git.isRepo && git.recentCommits && git.recentCommits.length > 0) {
    html += `
      <div class="project-section-header" style="margin-top: 10px;">
        <div class="project-section-title">
          <i data-lucide="git-commit" style="width: 15px; height: 15px;"></i>
          <span>项目大事记 (TIMELINE & COMMITS)</span>
        </div>
      </div>

      <div class="project-timeline-card">
        <div class="project-timeline-list">
    `;

    git.recentCommits.forEach(c => {
      html += `
        <div class="timeline-item">
          <div class="timeline-item-dot"></div>
          <div class="timeline-item-header">
            <span class="timeline-hash-badge">${escapeHtml(c.hash)}</span>
            <span class="timeline-item-author">${escapeHtml(c.author)}</span>
            <span class="timeline-time">${escapeHtml(c.relativeTime)}</span>
          </div>
          <div class="timeline-item-message">${escapeHtml(c.subject)}</div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  // Re-bind Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Attach event listeners
  bindOverviewEvents(container, queryIdentifier, mission, sessions, tasks);
}

/**
 * Bind interactive events in the Overview DOM
 */
function bindOverviewEvents(container, workspaceIdentifier, currentMission, sessions, currentTasks = []) {
  // Refresh button
  const refreshBtn = container.querySelector('#projectRefreshDataBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderProjectOverview();
    });
  }

  // Launch first session button (empty state)
  const launchBtn = container.querySelector('#projectLaunchSessionBtn');
  if (launchBtn) {
    launchBtn.addEventListener('click', () => {
      const newSessionBtn = document.getElementById('newSessionBtn');
      if (newSessionBtn) newSessionBtn.click();
    });
  }

  // Jump to session buttons
  const jumpBtns = container.querySelectorAll('.btn-jump-session');
  jumpBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionName = btn.getAttribute('data-session');
      if (sessionName) {
        attachSession(sessionName);
        closeSidebarOnMobile();
      }
    });
  });

  // Task Dispatcher bindings
  const targetSelect = container.querySelector('#dispatchTargetSelect');
  const taskInput = container.querySelector('#dispatchTaskInput');
  const submitBtn = container.querySelector('#dispatchSubmitBtn');
  const feedbackBar = container.querySelector('#dispatchFeedbackBar');
  const hintText = container.querySelector('#dispatchStatusHintText');
  const clearHistoryCheck = container.querySelector('#dispatchClearHistoryCheck');
  const cleanCmdHint = container.querySelector('#dispatchCleanCmdHint');

  // Update clear command hint based on selected agent type
  const updateCleanHint = () => {
    if (!cleanCmdHint || !targetSelect) return;
    const selectedOpt = targetSelect.options[targetSelect.selectedIndex];
    const agentType = selectedOpt ? (selectedOpt.getAttribute('data-agent-type') || '').toLowerCase() : '';
    if (agentType === 'codex') {
      cleanCmdHint.textContent = '(执行 /new)';
    } else if (agentType === 'claude' || agentType === 'agy' || agentType === 'antigravity') {
      cleanCmdHint.textContent = '(执行 /clear)';
    } else {
      cleanCmdHint.textContent = '(执行 clear)';
    }
  };

  if (targetSelect && taskInput && submitBtn) {
    updateCleanHint();

    // Dynamic change of selected agent
    targetSelect.addEventListener('change', () => {
      updateCleanHint();
      const selectedOpt = targetSelect.options[targetSelect.selectedIndex];
      const status = selectedOpt ? selectedOpt.getAttribute('data-status') : 'idle';
      const val = targetSelect.value;
      const submitTextEl = submitBtn.querySelector('.submit-btn-text');

      if (val === '__new__') {
        hintText.textContent = '💡 点击派发后，将自动弹出新建会话窗口并将指令填入启动项。';
        feedbackBar.className = 'dispatch-feedback-bar ready';
        submitBtn.classList.remove('busy-warn');
        if (submitTextEl) submitTextEl.textContent = '➕ 新建并执行';
      } else if (status === 'busy') {
        hintText.textContent = `⚠️ 提示：选中的 Agent [${escapeHtml(val)}] 当前正在执行中，派发指令可能会打断当前任务或进入排队。`;
        feedbackBar.className = 'dispatch-feedback-bar warning';
        submitBtn.classList.add('busy-warn');
        if (submitTextEl) submitTextEl.textContent = '⚠️ 确认插队派发';
      } else if (status === 'waiting') {
        hintText.textContent = `🟡 提示：选中的 Agent [${escapeHtml(val)}] 当前正在等待用户授权或确认。`;
        feedbackBar.className = 'dispatch-feedback-bar warning';
        submitBtn.classList.remove('busy-warn');
        if (submitTextEl) submitTextEl.textContent = '📥 发送确认/指令';
      } else {
        hintText.textContent = `🟢 选中的 Agent [${escapeHtml(val)}] 当前空闲就绪，派发后将立即开始执行。`;
        feedbackBar.className = 'dispatch-feedback-bar ready';
        submitBtn.classList.remove('busy-warn');
        if (submitTextEl) submitTextEl.textContent = '立即派发';
      }
    });

    // Execute dispatch function
    const executeDispatch = async () => {
      const promptText = taskInput.value.trim();
      const targetSession = targetSelect.value;
      const clearHistory = clearHistoryCheck ? clearHistoryCheck.checked : false;

      if (!promptText) {
        taskInput.focus();
        hintText.textContent = '❌ 请先输入要派发给 Agent 的具体任务内容！';
        feedbackBar.className = 'dispatch-feedback-bar warning';
        return;
      }

      if (targetSession === '__new__') {
        const newSessionBtn = document.getElementById('newSessionBtn');
        if (newSessionBtn) newSessionBtn.click();
        return;
      }

      submitBtn.disabled = true;
      const originalText = submitBtn.querySelector('.submit-btn-text')?.textContent || '派发';
      if (submitBtn.querySelector('.submit-btn-text')) {
        submitBtn.querySelector('.submit-btn-text').textContent = '正在派发...';
      }

      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/dispatch-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionName: targetSession, promptText, clearHistory })
        });

        const resData = await res.json();
        if (!res.ok) {
          throw new Error(resData.error || '派发失败');
        }

        taskInput.value = '';
        const cleanNotice = clearHistory ? '（已执行会话清理）' : '';
        hintText.innerHTML = `✅ 任务已成功派发给 <strong>${escapeHtml(targetSession)}</strong>${cleanNotice}！已开始执行。`;
        feedbackBar.className = 'dispatch-feedback-bar success';

        // Update tab badge to busy immediately
        updateProjectTabStatus('busy');

        // Refresh overview cards after a brief moment
        setTimeout(() => {
          renderProjectOverview();
        }, 800);
      } catch (err) {
        hintText.textContent = `❌ 派发失败: ${err.message}`;
        feedbackBar.className = 'dispatch-feedback-bar warning';
      } finally {
        submitBtn.disabled = false;
        if (submitBtn.querySelector('.submit-btn-text')) {
          submitBtn.querySelector('.submit-btn-text').textContent = originalText;
        }
      }
    };

    submitBtn.addEventListener('click', executeDispatch);

    // Support Ctrl+Enter / Cmd+Enter keyboard shortcut
    taskInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        executeDispatch();
      }
    });
  }

  // --- Roadmap & Tasks Interactive Handlers ---
  // 1. Task checkbox toggle (complete / uncomplete)
  const checkBtns = container.querySelectorAll('.task-check-btn');
  checkBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      const taskObj = currentTasks.find(t => String(t.id) === String(taskId));
      if (!taskObj) return;

      taskObj.status = taskObj.status === 'done' ? 'todo' : 'done';
      taskObj.updatedAt = new Date().toISOString();

      try {
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/project-tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: currentTasks, mission: currentMission })
        });
        renderProjectOverview();
      } catch (err) {
        console.error('Failed to update task status:', err);
      }
    });
  });

  // 2. Task quick dispatch to input
  const dispatchBtns = container.querySelectorAll('.task-btn-dispatch');
  dispatchBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const title = btn.getAttribute('data-title') || '';
      const desc = btn.getAttribute('data-desc') || '';
      if (taskInput) {
        taskInput.value = desc ? `【任务】${title}\n详细说明: ${desc}` : `【任务】${title}`;
        taskInput.focus();
        taskInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  // 3. Task delete
  const deleteBtns = container.querySelectorAll('.task-btn-delete');
  deleteBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      if (!confirm('确定删除此任务项？')) return;

      const updatedTasks = currentTasks.filter(t => String(t.id) !== String(taskId));
      try {
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/project-tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: updatedTasks, mission: currentMission })
        });
        renderProjectOverview();
      } catch (err) {
        console.error('Failed to delete task:', err);
      }
    });
  });

  // 4. Decompose with Agent button (生成标准提示词到派发栏)
  const decomposeBtn = container.querySelector('#decomposeWithAgentBtn');
  if (decomposeBtn) {
    decomposeBtn.addEventListener('click', () => {
      const missionText = currentMission ? currentMission.trim() : '';
      const promptTemplate = `请阅读当前工作区的代码结构、参考工作区中的 \`.deck/deck_task_spec.md\` 规范以及目标「${missionText || '推进项目核心能力'}」，将目标拆解为 3~5 个子任务，并严格按照规范写入工作区的 \`.deck/tasks.json\` 文件中。\n格式参考：\n{\n  "mission": "${missionText || '项目目标'}",\n  "tasks": [\n    { "id": "t-1", "title": "任务简述", "description": "具体说明与修改文件", "status": "todo", "priority": "high", "assignee": "" }\n  ]\n}`;
      
      if (taskInput) {
        taskInput.value = promptTemplate;
        taskInput.focus();
        taskInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (hintText) {
          hintText.textContent = '💡 拆解指令已生成并填入输入框，可直接指派给 Agent 执行拆解。';
          feedbackBar.className = 'dispatch-feedback-bar ready';
        }
      }
    });
  }

  // 5. Open new task prompt/dialog
  const newTaskBtn = container.querySelector('#openNewTaskModalBtn');
  if (newTaskBtn) {
    newTaskBtn.addEventListener('click', async () => {
      const title = prompt('请输入新子任务的名称:');
      if (!title || !title.trim()) return;

      const newTask = {
        id: `t-${Date.now().toString(36)}`,
        title: title.trim(),
        description: '',
        status: 'todo',
        priority: 'medium',
        assignee: (sessions && sessions.length > 0) ? sessions[0].name : '',
        updatedAt: new Date().toISOString()
      };

      currentTasks.push(newTask);
      try {
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/project-tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: currentTasks, mission: currentMission })
        });
        renderProjectOverview();
      } catch (err) {
        console.error('Failed to add new task:', err);
      }
    });
  }

  // Mission Edit Button
  const editMissionBtn = container.querySelector('#editMissionBtn');
  const missionBox = container.querySelector('#projectMissionBox');
  if (editMissionBtn && missionBox) {
    editMissionBtn.addEventListener('click', () => {
      if (isEditingMission) return;
      isEditingMission = true;

      missionBox.innerHTML = `
        <div class="mission-edit-wrapper">
          <input type="text" id="projectMissionInput" class="mission-input" placeholder="输入当前工作区的推进目标（例如：重构后端鉴权并联调前端）" value="${escapeHtml(currentMission || '')}">
          <button id="saveMissionBtn" class="cyber-btn-outline" style="height: 32px; padding: 0 10px;">
            <i data-lucide="check"></i> 保存
          </button>
          <button id="cancelMissionBtn" class="cyber-btn-outline" style="height: 32px; padding: 0 10px;">
            <i data-lucide="x"></i> 取消
          </button>
        </div>
      `;

      if (window.lucide) window.lucide.createIcons();

      const input = missionBox.querySelector('#projectMissionInput');
      const saveBtn = missionBox.querySelector('#saveMissionBtn');
      const cancelBtn = missionBox.querySelector('#cancelMissionBtn');

      if (input) {
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') saveBtn.click();
          if (e.key === 'Escape') cancelBtn.click();
        });
      }

      saveBtn.addEventListener('click', async () => {
        const val = input.value.trim();
        saveBtn.disabled = true;
        try {
          await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/project-mission`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mission: val })
          });
        } catch (e) {
          console.error('Failed to update project mission:', e);
        }
        isEditingMission = false;
        renderProjectOverview();
      });

      cancelBtn.addEventListener('click', () => {
        isEditingMission = false;
        renderProjectOverview();
      });
    });
  }
}

/**
 * Initialize event listeners for opening the project overview from sidebar and background poller
 */
export function initProjectOverviewEvents() {
  const openBtn = document.getElementById('openProjectOverviewBtn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      openProjectTab();
    });
  }

  // Periodic status poller to keep tab status badge in sync
  if (!autoStatusInterval) {
    autoStatusInterval = setInterval(async () => {
      const hasProjectTab = state.tabs && state.tabs.some(t => t.type === 'project');
      if (!hasProjectTab) return;

      const workspaceSelect = document.getElementById('explorerWorkspaceSelect');
      const currentPath = state.currentWorkspacePath || (workspaceSelect ? workspaceSelect.value : '');
      const matchedWs = state.workspacesList.find(w => w.path === currentPath);
      const wsIdent = matchedWs ? matchedWs.name : currentPath;

      if (!wsIdent) return;

      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(wsIdent)}/project-progress`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.workspaceStatus) {
            updateProjectTabStatus(data.workspaceStatus);
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
