import { state } from './state.js';
import { attachSession, removeSessionFromCache, fitTerminalFor } from './terminal.js';
import { loadEditorFile } from './editor.js';
import { loadGitDiff } from './diff.js';

export function saveTabsState() {
  try {
    localStorage.setItem('deckTabs', JSON.stringify(state.tabs));
    localStorage.setItem('activeTabId', state.activeTabId || '');
  } catch (e) {
    console.error('Failed to save tabs state to localStorage:', e);
  }
}

export function renderTabs() {
  const workspaceTabs = document.getElementById('workspaceTabs');
  const welcomePanel = document.getElementById('welcomePanel');
  const terminalPanel = document.getElementById('terminalPanel');
  const editorPanel = document.getElementById('editorPanel');
  const diffPanel = document.getElementById('diffPanel');
  
  if (state.tabs.length === 0) {
    workspaceTabs.classList.add('hidden');
    welcomePanel.classList.remove('hidden');
    terminalPanel.classList.add('hidden');
    editorPanel.classList.add('hidden');
    diffPanel.classList.add('hidden');
    state.currentSession = null;
    state.activeTabId = null;
    saveTabsState();
    return;
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
      : (tab.type === 'git-diff' ? 'git-compare' : 'file-code');
    tabEl.innerHTML = `
      <i data-lucide="${icon}"></i>
      <span>${tab.name}</span>
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
}

export function activateTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  state.activeTabId = tabId;
  renderTabs();

  const terminalPanel = document.getElementById('terminalPanel');
  const welcomePanel = document.getElementById('welcomePanel');
  const editorPanel = document.getElementById('editorPanel');
  const diffPanel = document.getElementById('diffPanel');
  const activeSessionNameText = document.getElementById('activeSessionName');
  const activeFilePath = document.getElementById('activeFilePath');
  const currentPathLabel = document.getElementById('currentPathLabel');

  if (tab.type === 'terminal') {
    const targetSession = tab.id;
    let cached = state.sessionCache.get(targetSession);
    if (!cached) {
      attachSession(targetSession);
      return;
    }

    editorPanel.classList.add('hidden');
    diffPanel.classList.add('hidden');
    welcomePanel.classList.add('hidden');
    terminalPanel.classList.remove('hidden');

    for (const [name, cachedSession] of state.sessionCache.entries()) {
      if (name === targetSession) {
        if (cachedSession.container) cachedSession.container.classList.remove('hidden');
      } else {
        if (cachedSession.container) cachedSession.container.classList.add('hidden');
      }
    }

    state.currentSession = targetSession;
    activeSessionNameText.textContent = targetSession;

    setTimeout(() => {
      fitTerminalFor(targetSession);
      const cachedSession = state.sessionCache.get(targetSession);
      if (cachedSession && cachedSession.term) {
        cachedSession.term.focus();
      }
    }, 50);
  } else if (tab.type === 'editor') {
    terminalPanel.classList.add('hidden');
    welcomePanel.classList.add('hidden');
    editorPanel.classList.remove('hidden');
    diffPanel.classList.add('hidden');
    state.currentSession = null;

    for (const cached of state.sessionCache.values()) {
      if (cached.container) cached.container.classList.add('hidden');
    }

    activeFilePath.textContent = tab.path;
    const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
    const wsPrefix = ws ? `[${ws.name}] ` : '';
    currentPathLabel.textContent = wsPrefix + '/' + tab.path;
    loadEditorFile(tab.path);
  } else if (tab.type === 'git-diff') {
    terminalPanel.classList.add('hidden');
    welcomePanel.classList.add('hidden');
    editorPanel.classList.add('hidden');
    diffPanel.classList.remove('hidden');
    state.currentSession = null;

    for (const cached of state.sessionCache.values()) {
      if (cached.container) cached.container.classList.add('hidden');
    }

    activeFilePath.textContent = tab.path || 'All Changes';
    const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
    const wsPrefix = ws ? `[${ws.name}] ` : '';
    currentPathLabel.textContent = wsPrefix + (tab.path ? '/git-diff/' + tab.path : '/git-diff');
    loadGitDiff(tab.path);
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
