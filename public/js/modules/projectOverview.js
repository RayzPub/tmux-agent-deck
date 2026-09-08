import { state } from './state.js';
import { activateTab, renderTabs, updateProjectTabStatus } from './tabs.js';
import { attachSession } from './terminal.js';
import { renderDagCanvas, getSelectedTaskId, setSelectedTaskId } from './projectDagCanvas.js';
import { openAgyDrawer, closeAgyDrawer, updateDrawerSelectedTask } from './projectAgyDrawer.js';
import { openDispatchModal } from './promptStaging.js';

let isEditingMission = false;
let autoStatusInterval = null;
let roadmapViewMode = localStorage.getItem('deck_roadmap_view_mode') || 'dag';

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
        <div class="mission-actions">
          <button id="decomposeMissionBtn" class="mission-decompose-btn" title="呼叫 AGY 结合当前核心推进目标，自动生成任务拆解草稿">
            <i data-lucide="sparkles" style="width: 12px; height: 12px;"></i>
            <span>让 AGY 拆解</span>
          </button>
          <button id="editMissionBtn" class="mission-edit-btn" title="编辑目标">
            <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i>
            <span>设定</span>
          </button>
        </div>
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
            <span class="roadmap-title-text">
              <span class="title-main">推进大盘</span>
              <span class="title-sub">(ROADMAP & TASKS)</span>
            </span>
            <span class="roadmap-count-pill">${doneTasks}/${totalTasks} 完成 (${progressPercent}%)</span>
          </div>

          <div class="roadmap-controls-bar">
            <div class="roadmap-view-switcher">
              <button class="roadmap-switch-btn ${roadmapViewMode === 'dag' ? 'active' : ''}" data-view="dag" title="切换到 DAG 拓扑画布模式">
                <i data-lucide="network" style="width: 12px; height: 12px;"></i>
                <span>DAG 画布</span>
              </button>
              <button class="roadmap-switch-btn ${roadmapViewMode === 'list' ? 'active' : ''}" data-view="list" title="切换到清单列表模式">
                <i data-lucide="list" style="width: 12px; height: 12px;"></i>
                <span>列表</span>
              </button>
            </div>
            <div class="roadmap-actions">
              <button id="openDispatchBtn" class="roadmap-action-btn primary" title="选择智能体工位，自由编辑并发送指令到终端">
                <i data-lucide="send" style="width: 13px; height: 13px;"></i>
                <span class="btn-text-full">🚀 发送到终端</span>
                <span class="btn-text-short">🚀 发送到终端</span>
              </button>
              <button id="openNewTaskModalBtn" class="roadmap-action-btn secondary" title="手动添加子任务">
                <i data-lucide="plus" style="width: 12px; height: 12px;"></i>
                <span>新建任务</span>
              </button>
            </div>
          </div>
        </div>

        <div class="roadmap-progress-bar-bg">
          <div class="roadmap-progress-bar-fill" style="width: ${progressPercent}%;"></div>
        </div>
      </div>
  `;

  if (tasks.length === 0) {
    html += `
      <div class="roadmap-onboarding-card">
        <div class="onboarding-header">
          <i data-lucide="compass" style="width: 18px; height: 18px; color: var(--neon-cyan, #00f0ff);"></i>
          <span>首次使用指引：人机协同推进 3 步法</span>
        </div>
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <span class="step-num">1</span>
            <div class="step-info">
              <span class="step-title">设定目标 (MISSION)</span>
              <span class="step-desc">上方设定本次迭代核心目标</span>
            </div>
          </div>
          <div class="onboarding-arrow"><i data-lucide="chevron-right" style="width: 14px; height: 14px;"></i></div>
          <div class="onboarding-step">
            <span class="step-num">2</span>
            <div class="step-info">
              <span class="step-title">唤起 AGY 拆解</span>
              <span class="step-desc">自动注入指令，生成 DAG 依赖图</span>
            </div>
          </div>
          <div class="onboarding-arrow"><i data-lucide="chevron-right" style="width: 14px; height: 14px;"></i></div>
          <div class="onboarding-step">
            <span class="step-num">3</span>
            <div class="step-info">
              <span class="step-title">审阅推进与细化</span>
              <span class="step-desc">派发工位执行，卡片可就地细化</span>
            </div>
          </div>
        </div>
        <button id="onboardingLaunchAgyBtn" class="roadmap-action-btn primary large" style="margin-top: 14px; padding: 6px 16px; font-size: 12px;">
          <i data-lucide="sparkles" style="width: 14px; height: 14px;"></i>
          <span>立即开始：唤起 AGY 拆解当前目标</span>
        </button>
      </div>
    </div>
    `;
  } else if (roadmapViewMode === 'dag') {
    html += `
      <div class="roadmap-dag-wrapper" id="roadmapDagWrapper"></div>
    </div>
    `;
  } else {
    html += `
      <div class="roadmap-tasks-list" id="roadmapTasksList">
    `;
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

  // --- Roadmap & Tasks Interactive Handlers ---
  // View Switcher (DAG vs List)
  const switchBtns = container.querySelectorAll('.roadmap-switch-btn');
  switchBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const view = btn.getAttribute('data-view');
      if (view && view !== roadmapViewMode) {
        roadmapViewMode = view;
        localStorage.setItem('deck_roadmap_view_mode', view);
        renderProjectOverview();
      }
    });
  });

  // Open "发送到终端" button in Roadmap Actions bar
  const openDispatchBtn = container.querySelector('#openDispatchBtn');
  if (openDispatchBtn) {
    openDispatchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDispatchModal({
        workspaceIdentifier,
        sessions,
        defaultPrompt: '',
        title: '🚀 发送任务到终端',
        subtitle: '选择目标工位，输入指令后直接派发执行并切换到终端',
        mode: 'free',
        onSuccess: () => renderProjectOverview()
      });
    });
  }

  // Decompose Mission button beside Mission Goal (Stages Mission Decompose Prompt in Draft Tray)
  const decomposeMissionBtn = container.querySelector('#decomposeMissionBtn');
  if (decomposeMissionBtn) {
    decomposeMissionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAgyDrawer({
        workspaceIdentifier,
        mission: currentMission,
        tasks: currentTasks,
        sessions,
        selectedTask: null,
        stageDecompose: true,
        stageRefine: false,
        onRefreshBoard: () => renderProjectOverview()
      });
    });
  }

  // Onboarding launch AGY button in empty state
  const onboardingBtn = container.querySelector('#onboardingLaunchAgyBtn');
  if (onboardingBtn) {
    onboardingBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAgyDrawer({
        workspaceIdentifier,
        mission: currentMission,
        tasks: currentTasks,
        sessions,
        selectedTask: null,
        stageDecompose: true,
        stageRefine: false,
        onRefreshBoard: () => renderProjectOverview()
      });
    });
  }

  // Render DAG Canvas if in dag view mode
  if (roadmapViewMode === 'dag') {
    const dagWrapper = container.querySelector('#roadmapDagWrapper');
    if (dagWrapper) {
      renderDagCanvas(dagWrapper, {
        tasks: currentTasks,
        mission: currentMission,
        onToggleTask: async (taskId) => {
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
        },
        onRefineTask: (task) => {
          updateDrawerSelectedTask(task);
          openAgyDrawer({
            workspaceIdentifier,
            mission: currentMission,
            tasks: currentTasks,
            sessions,
            selectedTask: task,
            autoFillRefine: true,
            onRefreshBoard: () => renderProjectOverview()
          });
        },
        onDispatchTask: (task) => {
          updateDrawerSelectedTask(task);
          openDispatchModal({
            workspaceIdentifier,
            sessions,
            defaultPrompt: task.description ? `【任务】${task.title}\n详细说明: ${task.description}` : `【任务】${task.title}`,
            title: `⚡ 派发任务 [${task.id}] · 发送到终端`,
            subtitle: '选择目标工位，微调指令后直接派发执行并切换到终端',
            mode: 'dispatch',
            selectedTask: task,
            onSuccess: () => renderProjectOverview()
          });
        },
        onDeleteTask: async (taskId) => {
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
        },
        onSelectTask: (task) => {
          updateDrawerSelectedTask(task);
        }
      });
    }
  }

  // 1. Task checkbox toggle (complete / uncomplete) for List View
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

  // 2. Task quick dispatch to modal
  const dispatchBtns = container.querySelectorAll('.task-btn-dispatch');
  dispatchBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      const taskObj = currentTasks.find(t => String(t.id) === String(taskId)) || {
        id: taskId,
        title: btn.getAttribute('data-title') || '',
        description: btn.getAttribute('data-desc') || ''
      };
      updateDrawerSelectedTask(taskObj);
      openDispatchModal({
        workspaceIdentifier,
        sessions,
        defaultPrompt: taskObj.description ? `【任务】${taskObj.title}\n详细说明: ${taskObj.description}` : `【任务】${taskObj.title}`,
        title: `⚡ 派发任务 [${taskObj.id}] · 发送到终端`,
        subtitle: '选择目标工位，微调指令后直接派发执行并切换到终端',
        mode: 'dispatch',
        selectedTask: taskObj,
        onSuccess: () => renderProjectOverview()
      });
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

  // Open new task prompt/dialog
  const newTaskBtn = container.querySelector('#openNewTaskModalBtn');
  if (newTaskBtn) {
    newTaskBtn.addEventListener('click', async () => {
      const title = prompt('请输入新子任务的名称:');
      if (!title || !title.trim()) return;

      const depInput = prompt('前置依赖任务ID（可选，例如 t-1，若无请直接留空点确定）:');
      const dependsOn = (depInput && depInput.trim()) ? [depInput.trim()] : [];

      const newTask = {
        id: `t-${Date.now().toString(36)}`,
        title: title.trim(),
        description: '',
        status: 'todo',
        priority: 'medium',
        assignee: (sessions && sessions.length > 0) ? sessions[0].name : '',
        dependsOn,
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
