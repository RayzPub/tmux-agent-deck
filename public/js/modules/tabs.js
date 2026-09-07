import { state } from './state.js';
import { attachSession, removeSessionFromCache } from './terminal.js';
import { loadEditorFile } from './editor.js';
import { loadGitDiff } from './diff.js';
import { renderHelpDoc } from './helpDoc.js';
import { renderProjectOverview } from './projectOverview.js';

export function saveTabsState() {
  try {
    localStorage.setItem('deckTabs', JSON.stringify(state.tabs));
    localStorage.setItem('activeTabId', state.activeTabId || '');
  } catch (e) {
    console.error('Failed to save tabs state to localStorage:', e);
  }
}

export function updateMobileControlsVisibility() {
  const mobileControls = document.querySelector('.mobile-bottom-controls');
  const workspaceMain = document.querySelector('.terminal-workspace');
  if (!mobileControls) return;

  const hasActiveTerminal = state.tabs.length > 0 && state.activeTabId && state.tabs.some(t => t.id === state.activeTabId && t.type === 'terminal');
  const isChatMode = state.currentSession && localStorage.getItem(`deck_mode_${state.currentSession}`) === 'chat';

  if (hasActiveTerminal && !isChatMode) {
    mobileControls.classList.remove('hidden');
    mobileControls.style.display = '';
    if (workspaceMain) workspaceMain.classList.add('has-mobile-controls');
  } else {
    mobileControls.classList.add('hidden');
    mobileControls.style.display = 'none';
    if (workspaceMain) workspaceMain.classList.remove('has-mobile-controls');
  }
}

export function switchMainPanel(panelType) {
  const panels = {
    welcome: document.getElementById('welcomePanel'),
    terminal: document.getElementById('terminalPanel'),
    editor: document.getElementById('editorPanel'),
    'git-diff': document.getElementById('diffPanel'),
    doc: document.getElementById('docPanel'),
    project: document.getElementById('projectPanel')
  };

  const targetKey = panels[panelType] ? panelType : 'welcome';

  for (const [key, el] of Object.entries(panels)) {
    if (!el) continue;
    if (key === targetKey) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  // Double safeguard: if leaving terminal panel, ensure chat container is marked hidden
  if (targetKey !== 'terminal') {
    const chatContainer = document.getElementById('agentChatContainer');
    if (chatContainer) {
      chatContainer.classList.add('hidden');
    }
  }
}

export function renderTabs() {
  const workspaceTabs = document.getElementById('workspaceTabs');
  
  if (state.tabs.length === 0) {
    workspaceTabs.classList.add('hidden');
    switchMainPanel('welcome');
    state.currentSession = null;
    state.activeTabId = null;
    saveTabsState();
    updateMobileControlsVisibility();
    return;
  }

  // Ensure project tab is always the first tab (index 0) on the leftmost side
  const projectIdx = state.tabs.findIndex(t => t.type === 'project');
  if (projectIdx > 0) {
    const [projectTab] = state.tabs.splice(projectIdx, 1);
    state.tabs.unshift(projectTab);
  }

  workspaceTabs.classList.remove('hidden');
  workspaceTabs.innerHTML = '';

  state.tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    const isActive = state.activeTabId === tab.id;
    tabEl.className = `workspace-tab ${tab.type}-tab ${isActive ? 'active' : ''}`;
    tabEl.setAttribute('data-id', tab.id);

    const icon = tab.type === 'terminal' 
      ? 'terminal' 
      : (tab.type === 'git-diff' ? 'git-compare' : (tab.type === 'doc' ? 'book-open' : (tab.type === 'project' ? 'activity' : 'file-code')));

    let statusPillHtml = '';
    if (tab.type === 'project') {
      const wsStatus = state.workspaceStatus || 'idle';
      const statusMap = {
        busy: { label: '执行中', cls: 'status-busy' },
        waiting: { label: '待确认', cls: 'status-waiting' },
        idle: { label: '空闲', cls: 'status-idle' },
        empty: { label: '就绪', cls: 'status-empty' }
      };
      const cur = statusMap[wsStatus] || statusMap.idle;
      statusPillHtml = `
        <span class="project-tab-status-badge ${cur.cls}" title="智能体当前状态: ${cur.label}">
          <span class="pulse-dot"></span>
          <span class="tab-status-label">${cur.label}</span>
        </span>
      `;
    }

    tabEl.innerHTML = `
      <i data-lucide="${icon}"></i>
      <span>${tab.name}</span>
      ${statusPillHtml}
      <i data-lucide="x" class="close-tab-btn" title="Close Tab"></i>
    `;

    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.close-tab-btn')) {
        e.stopPropagation();
        closeTab(tab.id);
      } else {
        activateTab(tab.id);
      }
    });

    workspaceTabs.appendChild(tabEl);
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }
  saveTabsState();
  updateMobileControlsVisibility();
}

export function activateTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  if (tab.type === 'terminal') {
    attachSession(tab.id);
    return;
  }

  state.activeTabId = tabId;
  state.currentSession = null;
  renderTabs();

  const activeSessionNameText = document.getElementById('activeSessionName');
  const activeFilePath = document.getElementById('activeFilePath');
  const currentPathLabel = document.getElementById('currentPathLabel');

  // Enforce mutual exclusivity of main workspace panels
  switchMainPanel(tab.type);

  for (const cached of state.sessionCache.values()) {
    if (cached.container) cached.container.classList.add('hidden');
  }

  if (tab.type === 'editor') {

    if (activeFilePath) activeFilePath.textContent = tab.path;
    const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
    const wsPrefix = ws ? `[${ws.name}] ` : '';
    if (currentPathLabel) {
      currentPathLabel.textContent = wsPrefix + '/' + tab.path;
    }
    loadEditorFile(tab.path);
  } else if (tab.type === 'git-diff') {
    state.currentSession = null;

    for (const cached of state.sessionCache.values()) {
      if (cached.container) cached.container.classList.add('hidden');
    }

    if (activeFilePath) activeFilePath.textContent = tab.path || 'All Changes';
    const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
    const wsPrefix = ws ? `[${ws.name}] ` : '';
    if (currentPathLabel) {
      currentPathLabel.textContent = wsPrefix + (tab.path ? '/git-diff/' + tab.path : '/git-diff');
    }
    loadGitDiff(tab.path);
  } else if (tab.type === 'doc') {
    state.currentSession = null;

    for (const cached of state.sessionCache.values()) {
      if (cached.container) cached.container.classList.add('hidden');
    }

    if (currentPathLabel) {
      currentPathLabel.textContent = '// 新手使用指南与帮助文档';
    }
    renderHelpDoc();
  } else if (tab.type === 'project') {
    state.currentSession = null;

    for (const cached of state.sessionCache.values()) {
      if (cached.container) cached.container.classList.add('hidden');
    }

    if (currentPathLabel) {
      currentPathLabel.textContent = '// 项目推进总览 (Project HUD)';
    }
    renderProjectOverview();
  }
}

export function closeTab(tabId) {
  const tabIndex = state.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = state.tabs[tabIndex];
  state.tabs.splice(tabIndex, 1);

  if (tab.type === 'terminal') {
    removeSessionFromCache(tabId);
    const loadSessions = window.deckEvents?.loadSessions;
    if (loadSessions) {
      loadSessions();
      setTimeout(loadSessions, 500);
    }
  }

  if (state.activeTabId === tabId) {
    if (state.tabs.length > 0) {
      const nextActiveIndex = Math.min(tabIndex, state.tabs.length - 1);
      activateTab(state.tabs[nextActiveIndex].id);
    } else {
      state.activeTabId = null;
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

export function updateProjectTabStatus(status) {
  state.workspaceStatus = status;
  const projectTab = document.querySelector('.workspace-tab.project-tab');
  if (!projectTab) return;

  const badge = projectTab.querySelector('.project-tab-status-badge');
  if (!badge) {
    renderTabs();
    return;
  }

  const statusMap = {
    busy: { label: '执行中', cls: 'status-busy' },
    waiting: { label: '待确认', cls: 'status-waiting' },
    idle: { label: '空闲', cls: 'status-idle' },
    empty: { label: '就绪', cls: 'status-empty' }
  };
  const cur = statusMap[status] || statusMap.idle;

  badge.className = `project-tab-status-badge ${cur.cls}`;
  badge.title = `智能体当前状态: ${cur.label}`;
  const labelEl = badge.querySelector('.tab-status-label');
  if (labelEl) labelEl.textContent = cur.label;
}

export function restoreTabsState() {
  try {
    const savedTabsRaw = localStorage.getItem('deckTabs');
    const savedActiveTabId = localStorage.getItem('activeTabId');
    
    if (savedTabsRaw) {
      const savedTabs = JSON.parse(savedTabsRaw);
      if (Array.isArray(savedTabs) && savedTabs.length > 0) {
        state.tabs.length = 0;
        
        savedTabs.forEach(tab => {
          if (tab.type === 'terminal') {
            const sessionExists = state.sessionListCache.some(s => s.name === tab.id);
            if (sessionExists) {
              state.tabs.push(tab);
            }
          } else {
            state.tabs.push(tab);
          }
        });

        // Ensure project tab is always at index 0
        const pIdx = state.tabs.findIndex(t => t.type === 'project');
        if (pIdx > 0) {
          const [pTab] = state.tabs.splice(pIdx, 1);
          state.tabs.unshift(pTab);
        }
        
        if (state.tabs.length > 0) {
          let targetActiveTabId = savedActiveTabId;
          const activeTabExists = state.tabs.some(t => t.id === targetActiveTabId);
          if (!activeTabExists) {
            targetActiveTabId = state.tabs[0].id;
          }
          activateTab(targetActiveTabId);
        } else {
          renderTabs();
        }
      }
    }
  } catch (e) {
    console.error('Failed to restore tabs state from localStorage:', e);
  }
}
