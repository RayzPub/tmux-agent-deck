import { state } from './modules/state.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { restoreTabsState, renderTabs, activateTab, closeTab } from './modules/tabs.js';
import { saveEditorFile } from './modules/editor.js';
import { refreshFileTree, loadDirectory, openDirectoryPicker, loadDirPickerPath } from './modules/explorer.js';
import { attachSession, detachSession, fitTerminal, clearSessionCache, copySelection, pasteFromClipboard, reportFocusStatus, removeSessionFromCache, initMobileKeyboard } from './modules/terminal.js?v=1.0.2';
import { initPushNotifications, togglePushSubscription } from './modules/push.js';
import { initVoiceInput, stopVoiceInput } from './modules/voice.js';

// Elements
const sessionList = document.getElementById('sessionList');
const sessionCount = document.getElementById('sessionCount');
const newSessionBtn = document.getElementById('newSessionBtn');
const logoutBtn = document.getElementById('logoutBtn');
const hostIpText = document.getElementById('hostIp');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const reloadBtn = document.getElementById('reloadBtn');

const welcomePanel = document.getElementById('welcomePanel');
const terminalPanel = document.getElementById('terminalPanel');
const activeSessionNameText = document.getElementById('activeSessionName');
const fitTerminalBtn = document.getElementById('fitTerminalBtn');
const copyTerminalBtn = document.getElementById('copyTerminalBtn');
const pasteTerminalBtn = document.getElementById('pasteTerminalBtn');
const detachBtn = document.getElementById('detachBtn');
const terminalContainer = document.getElementById('terminal-container');

const sessionModal = document.getElementById('sessionModal');
const createSessionForm = document.getElementById('createSessionForm');
const newSessionNameInput = document.getElementById('newSessionName');
const closeModalBtn = document.getElementById('closeModalBtn');
const cancelModalBtn = document.getElementById('cancelModalBtn');

const sidebar = document.querySelector('.sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');

const mobileKeyboardBar = document.getElementById('mobileKeyboardBar');
const workspaceTabs = document.getElementById('workspaceTabs');
const editorPanel = document.getElementById('editorPanel');
const activeFilePath = document.getElementById('activeFilePath');
const editorStatusMsg = document.getElementById('editorStatusMsg');
const saveFileBtn = document.getElementById('saveFileBtn');
const closeEditorBtn = document.getElementById('closeEditorBtn');
const editorTextarea = document.getElementById('editorTextarea');

const diffPanel = document.getElementById('diffPanel');
const activeDiffPath = document.getElementById('activeDiffPath');
const diffStatusMsg = document.getElementById('diffStatusMsg');
const refreshDiffBtn = document.getElementById('refreshDiffBtn');
const closeDiffBtn = document.getElementById('closeDiffBtn');
const gitDiffWorkspaceBtn = document.getElementById('gitDiffWorkspaceBtn');

const tabSessionsBtn = document.getElementById('tabSessionsBtn');
const tabFilesBtn = document.getElementById('tabFilesBtn');
const sessionsContent = document.getElementById('sessionsContent');
const filesContent = document.getElementById('filesContent');
const closeSidebarBtnFiles = document.getElementById('closeSidebarBtnFiles');

const refreshFilesBtn = document.getElementById('refreshFilesBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const currentPathLabel = document.getElementById('currentPathLabel');
const fileTreeContainer = document.getElementById('fileTreeContainer');

const explorerWorkspaceSelect = document.getElementById('explorerWorkspaceSelect');
const explorerNewWorkspaceBtn = document.getElementById('explorerNewWorkspaceBtn');
const explorerDeleteWorkspaceBtn = document.getElementById('explorerDeleteWorkspaceBtn');
const sessionWorkspaceSelect = document.getElementById('sessionWorkspaceSelect');
const newWorkspaceFields = document.getElementById('newWorkspaceFields');
const modalNewWorkspaceName = document.getElementById('modalNewWorkspaceName');
const modalNewWorkspacePath = document.getElementById('modalNewWorkspacePath');

const workspaceModal = document.getElementById('workspaceModal');
const createWorkspaceForm = document.getElementById('createWorkspaceForm');
const newWorkspaceNameInput = document.getElementById('newWorkspaceNameInput');
const newWorkspacePathInput = document.getElementById('newWorkspacePathInput');
const closeWorkspaceModalBtn = document.getElementById('closeWorkspaceModalBtn');
const cancelWorkspaceModalBtn = document.getElementById('cancelWorkspaceModalBtn');

const dirPickerModal = document.getElementById('dirPickerModal');
const dirPickerCurrentPath = document.getElementById('dirPickerCurrentPath');
const dirPickerList = document.getElementById('dirPickerList');
const closeDirPickerBtn = document.getElementById('closeDirPickerBtn');
const cancelDirPickerBtn = document.getElementById('cancelDirPickerBtn');
const confirmDirPickerBtn = document.getElementById('confirmDirPickerBtn');

const browseModalWorkspacePathBtn = document.getElementById('browseModalWorkspacePathBtn');
const browseNewWorkspacePathBtn = document.getElementById('browseNewWorkspacePathBtn');

// Initialize State
state.tabs = JSON.parse(localStorage.getItem('deckTabs') || '[]');
state.activeTabId = localStorage.getItem('activeTabId') || null;

// Initialize Lucide Icons
if (window.lucide) {
  window.lucide.createIcons();
}

// Set Host IP in header
hostIpText.textContent = window.location.hostname || '127.0.0.1';

// Theme toggling initialization
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', toggleTheme);
}
initTheme();

// Monaco initialization
if (typeof require !== 'undefined') {
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    monaco.editor.defineTheme('cyberTheme', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '7f8a9e', fontStyle: 'italic' },
        { token: 'keyword', foreground: '00f0ff', fontStyle: 'bold' },
        { token: 'string', foreground: 'ff007f' },
        { token: 'number', foreground: '39ff14' },
        { token: 'type', foreground: '9d00ff' },
        { token: 'class', foreground: '9d00ff', fontStyle: 'bold' },
        { token: 'function', foreground: 'ffcc00' }
      ],
      colors: {
        'editor.background': '#020205',
        'editor.foreground': '#f2f5fa',
        'editor.lineHighlightBackground': '#0d0e15',
        'editorCursor.foreground': '#00f0ff',
        'editor.selectionBackground': 'rgba(0, 240, 255, 0.2)',
        'editorLineNumber.foreground': '#4e5866',
        'editorLineNumber.activeForeground': '#00f0ff',
        'editor.lineHighlightBorder': 'rgba(0, 240, 255, 0.1)'
      }
    });

    const currentTheme = document.body.classList.contains('light-minimalist') ? 'vs' : 'cyberTheme';
    editorTextarea.innerHTML = '';
    state.editorInstance = monaco.editor.create(editorTextarea, {
      value: '',
      language: 'plaintext',
      theme: currentTheme,
      automaticLayout: true,
      fontSize: 14,
      fontFamily: 'var(--font-mono)',
      minimap: { enabled: true },
      scrollbar: {
        vertical: 'visible',
        horizontal: 'visible',
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8
      }
    });

    state.editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveEditorFile();
    });
  });
}

export async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
    if (response.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    
    const sessions = await response.json();
    state.sessionListCache = sessions;
    renderSessions(sessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
    sessionList.innerHTML = `
      <div class="loading-placeholder">
        <i data-lucide="alert-circle" style="color: var(--neon-pink)"></i>
        <span>ERROR LOADING SESSIONS</span>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
}

export function renderSessions(sessions) {
  const activeWs = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
  const activeWorkspaceName = activeWs ? activeWs.name : '';

  const filteredSessions = sessions.filter(session => {
    if (session.workspaceName) {
      if (activeWorkspaceName) {
        return session.workspaceName.toLowerCase() === activeWorkspaceName.toLowerCase();
      }
      return false;
    }
    if (session.path) {
      if (state.currentWorkspacePath) {
        return session.path === state.currentWorkspacePath;
      } else {
        const belongsToSomeWorkspace = state.workspacesList.some(w => w.path === session.path);
        return !belongsToSomeWorkspace;
      }
    }
    return !state.currentWorkspacePath;
  });

  sessionCount.textContent = filteredSessions.length;
  
  if (filteredSessions.length === 0) {
    sessionList.innerHTML = `
      <div class="loading-placeholder">
        <span>NO SESSIONS FOUND</span>
      </div>
    `;
    return;
  }

  sessionList.innerHTML = '';
  filteredSessions.forEach(session => {
    const card = document.createElement('div');
    card.className = `session-card ${state.currentSession === session.name ? 'active' : ''}`;
    
    const matchingWs = state.workspacesList.find(w => w.path === session.path);
    let workspaceText = 'DEFAULT';
    if (matchingWs) {
      workspaceText = matchingWs.name;
    } else if (session.path) {
      const homeDir = '/home/ubuntu';
      if (session.path === homeDir) {
        workspaceText = '~';
      } else {
        workspaceText = session.path.split('/').pop() || 'DEFAULT';
      }
    }

    card.innerHTML = `
      <div class="session-info">
        <div class="session-name-wrapper" style="display: flex; align-items: center; gap: 8px; overflow: hidden; max-width: 140px;">
          <span class="session-status-dot" title="${session.attached ? '前台查看 (Active)' : '后台挂起 (Background)'}" style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background-color: ${session.attached ? 'var(--neon-green)' : 'rgba(255, 255, 255, 0.25)'}; box-shadow: ${session.attached ? 'var(--glow-green)' : 'none'};"></span>
          <div class="session-name" title="${session.name}" style="max-width: 120px;">${session.name}</div>
        </div>
        <div class="session-workspace" title="${session.path || 'Default Workspace'}">
          <i data-lucide="folder"></i>
          <span>${workspaceText}</span>
        </div>
      </div>
      <div class="session-meta">
        <span class="session-time">${session.created}</span>
        <div class="card-actions">
          <button class="card-action-btn danger-btn" data-action="kill" data-name="${session.name}" title="Kill Session">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-action-btn')) return;
      closeSidebarOnMobile();
      attachSession(session.name);
    });

    sessionList.appendChild(card);
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }

  document.querySelectorAll('.card-action-btn[data-action="kill"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.getAttribute('data-name');
      if (confirm(`Are you sure you want to terminate tmux session "${name}"?`)) {
        await killSession(name);
      }
    });
  });
}

async function killSession(name) {
  try {
    const response = await fetch(`/api/sessions/${name}`, { method: 'DELETE' });
    if (response.ok) {
      removeSessionFromCache(name);
      if (state.currentSession === name) {
        detachSession();
      }
      await loadSessions();
    } else {
      const data = await response.json();
      alert('Failed to kill session: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error(err);
    alert('Network error when attempting to kill session');
  }
}

// Publish loadSessions globally
window.deckEvents = {
  loadSessions
};

// Unified sidebar closed function
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768 && sidebar && sidebarOverlay) {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.add('hidden');
  }
}

// Bind UI actions
fitTerminalBtn.addEventListener('click', fitTerminal);
if (copyTerminalBtn) {
  copyTerminalBtn.addEventListener('click', async () => {
    const cached = state.sessionCache.get(state.currentSession);
    const selection = cached?.term?.getSelection();
    if (selection && selection.trim()) {
      await writeToClipboard(selection);
    } else if (state.lastSelection) {
      await writeToClipboard(state.lastSelection);
    }
  });
}
if (pasteTerminalBtn) {
  pasteTerminalBtn.addEventListener('click', pasteFromClipboard);
}
detachBtn.addEventListener('click', detachSession);

// Sidebar drawer toggle
if (sidebar && sidebarOverlay) {
  const toggleSidebar = () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle('open');
      sidebarOverlay.classList.toggle('hidden');
    } else {
      sidebar.classList.toggle('collapsed');
      setTimeout(fitTerminal, 350);
    }
  };

  const closeSidebar = () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.add('hidden');
    } else {
      if (!sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        setTimeout(fitTerminal, 350);
      }
    }
  };

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', toggleSidebar);
  }
  sidebarOverlay.addEventListener('click', closeSidebar);
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', closeSidebar);
  }
  if (closeSidebarBtnFiles) {
    closeSidebarBtnFiles.addEventListener('click', closeSidebar);
  }
}

// Prevent bouncing drag scrolls
const cyberHeader = document.querySelector('.cyber-header');
if (cyberHeader) {
  cyberHeader.addEventListener('touchmove', (e) => {
    if (window.innerWidth <= 768) e.preventDefault();
  }, { passive: false });
}

const terminalWorkspace = document.querySelector('.terminal-workspace');
if (terminalWorkspace) {
  terminalWorkspace.addEventListener('touchmove', (e) => {
    if (window.innerWidth <= 768) {
      if (e.target.closest('#editorTextarea') || 
          e.target.closest('#diffPanel .editor-container-wrapper') || 
          e.target.closest('#workspaceTabs')) {
        return;
      }
      e.preventDefault();
    }
  }, { passive: false });
}

// Workspace Selector changes
explorerWorkspaceSelect.addEventListener('change', () => {
  state.currentWorkspacePath = explorerWorkspaceSelect.value;
  localStorage.setItem('lastWorkspacePath', state.currentWorkspacePath);
  updateDeleteWorkspaceBtnState();
  refreshFileTree();
  renderSessions(state.sessionListCache);
});

sessionWorkspaceSelect.addEventListener('change', () => {
  if (sessionWorkspaceSelect.value === '__new__') {
    newWorkspaceFields.classList.remove('hidden');
    modalNewWorkspaceName.setAttribute('required', 'true');
    modalNewWorkspacePath.setAttribute('required', 'true');
  } else {
    newWorkspaceFields.classList.add('hidden');
    modalNewWorkspaceName.removeAttribute('required');
    modalNewWorkspacePath.removeAttribute('required');
  }
});

// Delete Workspace
explorerDeleteWorkspaceBtn.addEventListener('click', async () => {
  if (!state.currentWorkspacePath) {
    alert('Default workspace cannot be deleted.');
    return;
  }
  const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
  if (!ws) return;
  
  const confirmDelete = confirm(`Are you sure you want to remove workspace "${ws.name}"?\n\nNOTE: This action only removes the workspace configuration from the dashboard list. It will NOT delete the actual directory or any files on your disk.`);
  if (!confirmDelete) return;

  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(ws.name)}`, { method: 'DELETE' });
    if (response.ok) {
      state.currentWorkspacePath = '';
      localStorage.setItem('lastWorkspacePath', '');
      await loadWorkspaces();
      refreshFileTree();
      loadSessions();
    } else {
      const data = await response.json();
      alert('Failed to delete workspace: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error(err);
  }
});

explorerNewWorkspaceBtn.addEventListener('click', () => {
  newWorkspaceNameInput.value = '';
  newWorkspacePathInput.value = '';
  workspaceModal.classList.remove('hidden');
});

const closeWorkspaceModal = () => {
  workspaceModal.classList.add('hidden');
};
closeWorkspaceModalBtn.addEventListener('click', closeWorkspaceModal);
cancelWorkspaceModalBtn.addEventListener('click', closeWorkspaceModal);

createWorkspaceForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const wsName = newWorkspaceNameInput.value.trim();
  const wsPath = newWorkspacePathInput.value.trim();
  if (!wsName || !wsPath) return;

  try {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: wsName, path: wsPath })
    });

    if (response.ok) {
      closeWorkspaceModal();
      state.currentWorkspacePath = wsPath;
      localStorage.setItem('lastWorkspacePath', state.currentWorkspacePath);
      await loadWorkspaces();
      refreshFileTree();
      renderSessions(state.sessionListCache);
    } else {
      const data = await response.json();
      alert('Failed to create workspace: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error(err);
  }
});

// Directory picker browsing
browseModalWorkspacePathBtn.addEventListener('click', () => {
  openDirectoryPicker(modalNewWorkspacePath);
});
browseNewWorkspacePathBtn.addEventListener('click', () => {
  openDirectoryPicker(newWorkspacePathInput);
});

const closeDirPicker = () => {
  dirPickerModal.classList.add('hidden');
};
closeDirPickerBtn.addEventListener('click', closeDirPicker);
cancelDirPickerBtn.addEventListener('click', closeDirPicker);

confirmDirPickerBtn.addEventListener('click', () => {
  if (state.activeTargetInput && state.pickerCurrentPath) {
    state.activeTargetInput.value = state.pickerCurrentPath;
  }
  closeDirPicker();
});

// Tab Switch listeners
tabSessionsBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('collapsed')) {
    sidebar.classList.remove('collapsed');
    setTimeout(fitTerminal, 350);
  }
  tabSessionsBtn.classList.add('active');
  tabFilesBtn.classList.remove('active');
  sessionsContent.classList.remove('hidden');
  filesContent.classList.add('hidden');
});

tabFilesBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('collapsed')) {
    sidebar.classList.remove('collapsed');
    setTimeout(fitTerminal, 350);
  }
  tabFilesBtn.classList.add('active');
  tabSessionsBtn.classList.remove('active');
  filesContent.classList.remove('hidden');
  sessionsContent.classList.add('hidden');
  if (fileTreeContainer.querySelector('.loading-placeholder') || fileTreeContainer.innerHTML.trim() === '') {
    refreshFileTree();
  }
});

// File Explorer events
refreshFilesBtn.addEventListener('click', refreshFileTree);
collapseAllBtn.addEventListener('click', () => {
  if (state.showOnlyGitChanges) {
    state.showOnlyGitChanges = false;
    gitDiffWorkspaceBtn.classList.remove('active');
    gitDiffWorkspaceBtn.title = "Show Only Modified Files";
  }
  state.expandedFolders.clear();
  refreshFileTree();
});

gitDiffWorkspaceBtn.addEventListener('click', () => {
  state.showOnlyGitChanges = !state.showOnlyGitChanges;
  if (state.showOnlyGitChanges) {
    gitDiffWorkspaceBtn.classList.add('active');
    gitDiffWorkspaceBtn.title = "Show All Files";
  } else {
    gitDiffWorkspaceBtn.classList.remove('active');
    gitDiffWorkspaceBtn.title = "Show Only Modified Files";
  }
  refreshFileTree();
});

refreshDiffBtn.addEventListener('click', () => {
  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  if (activeTab && activeTab.type === 'git-diff') {
    loadGitDiff(activeTab.path);
  }
});
closeDiffBtn.addEventListener('click', () => {
  if (state.activeTabId) closeTab(state.activeTabId);
});

saveFileBtn.addEventListener('click', saveEditorFile);
closeEditorBtn.addEventListener('click', () => {
  if (state.activeTabId) closeTab(state.activeTabId);
});

editorTextarea.addEventListener('keydown', (e) => {
  if (!state.editorInstance && (e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveEditorFile();
  }
});

// Session creation
newSessionBtn.addEventListener('click', () => {
  closeSidebarOnMobile();
  sessionModal.classList.remove('hidden');
  newSessionNameInput.value = '';
  
  sessionWorkspaceSelect.value = state.currentWorkspacePath || '';
  const activeWs = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
  const activeWorkspaceName = activeWs ? activeWs.name : 'Default Workspace';
  const badgeEl = document.getElementById('modalActiveWorkspaceName');
  if (badgeEl) {
    badgeEl.textContent = activeWorkspaceName;
  }
  
  newSessionNameInput.focus();
});

const closeModal = () => {
  sessionModal.classList.add('hidden');
};
closeModalBtn.addEventListener('click', closeModal);
cancelModalBtn.addEventListener('click', closeModal);
sessionModal.addEventListener('click', (e) => {
  if (e.target === sessionModal) closeModal();
});

createSessionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newSessionNameInput.value.trim();
  if (!name) return;

  const selectedAgentRadio = document.querySelector('input[name="sessionAgent"]:checked');
  const agent = selectedAgentRadio ? selectedAgentRadio.value : 'default';

  const workspacePath = sessionWorkspaceSelect.value;
  const activeWs = state.workspacesList.find(w => w.path === workspacePath);
  const workspaceName = activeWs ? activeWs.name : '';

  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, agent, workspacePath, workspaceName })
    });

    if (response.ok) {
      closeModal();
      await loadSessions();
      attachSession(name);
    } else {
      const data = await response.json();
      alert('Failed to create session: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error(err);
  }
});

if (reloadBtn) {
  reloadBtn.addEventListener('click', () => {
    window.location.reload();
  });
}

logoutBtn.addEventListener('click', async () => {
  if (confirm('Disconnect from server control session?')) {
    try {
      clearSessionCache();
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login.html';
    } catch (err) {
      console.error(err);
      window.location.href = '/login.html';
    }
  }
});

// Mobile Input send
const mobileCommandInput = document.getElementById('mobileCommandInput');
const mobileSendBtn = document.getElementById('mobileSendBtn');

if (mobileCommandInput && mobileSendBtn) {
  let lastSendCommandTime = 0;
  const sendMobileCommand = () => {
    const now = Date.now();
    if (now - lastSendCommandTime < 350) return;
    lastSendCommandTime = now;

    const text = mobileCommandInput.value;
    stopVoiceInput();

    if (state.currentSession) {
      const cached = state.sessionCache.get(state.currentSession);
      if (cached && cached.socket) {
        const cleanText = text.trim();
        if (cleanText) {
          cached.socket.emit('terminal-input', cleanText + '\r');
          mobileCommandInput.value = '';
          mobileCommandInput.blur();
        } else {
          cached.socket.emit('terminal-input', '\r');
          mobileCommandInput.value = '';
        }
      }
    }
  };

  mobileSendBtn.addEventListener('click', sendMobileCommand);
  mobileCommandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendMobileCommand();
    }
  });
}

// Initialize Mobile Keyboard Helper Bar
initMobileKeyboard(mobileKeyboardBar);

// Window visibility focus handling
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    state.sessionCache.forEach((cached, name) => {
      if (cached.socket && !cached.socket.connected) {
        cached.socket.connect();
      }
    });
  }
  reportFocusStatus();
});

window.addEventListener('focus', reportFocusStatus);
window.addEventListener('blur', reportFocusStatus);

// Welcome Parallax
const welcomeGrid3D = document.getElementById('welcomeGrid3D');
if (welcomePanel && welcomeGrid3D) {
  welcomePanel.addEventListener('mousemove', (e) => {
    if (window.innerWidth <= 768) return;
    const rect = welcomePanel.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const tiltX = ((y - centerY) / centerY) * -5;
    const tiltY = ((x - centerX) / centerX) * 6;
    welcomeGrid3D.style.transform = `rotateX(${30 + tiltX}deg) rotateY(${tiltY}deg) translate3d(0, 0, 0)`;
  });
  
  welcomePanel.addEventListener('mouseleave', () => {
    if (window.innerWidth <= 768) return;
    welcomeGrid3D.style.transform = 'rotateX(30deg) rotateY(0deg) translate3d(0, 0, 0)';
  });
}

// Custom Select drop box helper
function convertSelectToCustom(selectEl) {
  if (!selectEl) return;
  if (selectEl.dataset.customSelectInit) return;
  selectEl.dataset.customSelectInit = 'true';

  const container = document.createElement('div');
  container.className = 'cyber-custom-select-container';
  selectEl.classList.add('cyber-select-hidden');
  selectEl.parentNode.insertBefore(container, selectEl.nextSibling);

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'cyber-custom-select-trigger';
  
  const selectedText = document.createElement('span');
  selectedText.className = 'selected-text';
  
  const chevronSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevronSvg.setAttribute('width', '12');
  chevronSvg.setAttribute('height', '12');
  chevronSvg.setAttribute('viewBox', '0 0 24 24');
  chevronSvg.setAttribute('fill', 'none');
  chevronSvg.setAttribute('stroke', 'currentColor');
  chevronSvg.setAttribute('stroke-width', '2');
  chevronSvg.setAttribute('stroke-linecap', 'round');
  chevronSvg.setAttribute('stroke-linejoin', 'round');
  chevronSvg.setAttribute('class', 'chevron-icon');
  
  const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevronPath.setAttribute('d', 'm6 9 6 6 6-6');
  chevronSvg.appendChild(chevronPath);
  
  triggerBtn.appendChild(selectedText);
  triggerBtn.appendChild(chevronSvg);
  container.appendChild(triggerBtn);

  const computed = window.getComputedStyle(selectEl);
  const layoutProps = [
    'height', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'borderRadius'
  ];
  layoutProps.forEach(prop => {
    const val = selectEl.style[prop] || computed[prop];
    if (val && val !== 'auto' && val !== '0px') {
      triggerBtn.style[prop] = val;
    }
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'cyber-custom-select-dropdown';
  container.appendChild(dropdown);

  function syncSelectedText() {
    const selectedIndex = selectEl.selectedIndex;
    if (selectedIndex < 0) {
      selectedText.innerHTML = '<span style="color: var(--text-secondary);">Select Option</span>';
      return;
    }
    const opt = selectEl.options[selectedIndex];
    const text = opt.textContent;
    
    if (opt.value === '') {
      selectedText.innerHTML = `<span style="color: var(--text-secondary);">${text}</span>`;
    } else if (opt.value === '__new__') {
      selectedText.innerHTML = `<span style="color: var(--neon-pink);">${text}</span>`;
    } else {
      const match = text.match(/^(.+?)\s*\((.+?)\)$/);
      if (match) {
        selectedText.innerHTML = `
          <span style="display: flex; align-items: center; gap: 6px; overflow: hidden; width: 100%;">
            <span style="color: var(--neon-cyan); font-weight: bold; flex-shrink: 0;">${match[1]}</span>
            <span style="color: var(--text-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${match[2]}</span>
          </span>
        `;
      } else {
        selectedText.innerHTML = `<span style="color: var(--neon-cyan);">${text}</span>`;
      }
    }
  }

  function rebuildOptions() {
    dropdown.innerHTML = '';
    Array.from(selectEl.options).forEach((opt, idx) => {
      const optEl = document.createElement('div');
      optEl.className = 'cyber-custom-select-option';
      optEl.dataset.value = opt.value;
      optEl.dataset.index = idx;
      
      const isSelected = opt.value === selectEl.value;
      if (isSelected) {
        optEl.classList.add('selected');
      }
      
      const text = opt.textContent;
      if (opt.value === '') {
        optEl.innerHTML = `<span>${text}</span>`;
      } else if (opt.value === '__new__') {
        optEl.classList.add('special-option');
        optEl.innerHTML = `
          <span style="display: flex; align-items: center; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px; height:12px;"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            ${text}
          </span>
        `;
      } else {
        const match = text.match(/^(.+?)\s*\((.+?)\)$/);
        if (match) {
          optEl.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span class="ws-opt-name" style="color: var(--text-primary); font-weight: 500;">${match[1]}</span>
              <span class="ws-opt-path" style="color: var(--text-secondary); opacity: 0.6; font-size: 9px;">${match[2]}</span>
            </div>
          `;
        } else {
          optEl.innerHTML = `<span>${text}</span>`;
        }
      }

      optEl.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change'));
        container.classList.remove('open');
        syncSelectedText();
        Array.from(dropdown.querySelectorAll('.cyber-custom-select-option')).forEach(o => {
          o.classList.toggle('selected', o.dataset.value === opt.value);
        });
      });

      dropdown.appendChild(optEl);
    });
  }

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = container.classList.contains('open');
    document.querySelectorAll('.cyber-custom-select-container').forEach(c => {
      c.classList.remove('open');
    });
    if (!isOpen) {
      container.classList.add('open');
    }
  });

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      container.classList.remove('open');
    }
  });

  const observer = new MutationObserver(() => {
    rebuildOptions();
    syncSelectedText();
  });
  observer.observe(selectEl, { childList: true });

  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (desc) {
    Object.defineProperty(selectEl, 'value', {
      get() {
        return desc.get.call(this);
      },
      set(val) {
        desc.set.call(this, val);
        syncSelectedText();
        Array.from(dropdown.querySelectorAll('.cyber-custom-select-option')).forEach(o => {
          o.classList.toggle('selected', o.dataset.value === val);
        });
      }
    });
  }

  rebuildOptions();
  syncSelectedText();
}

function updateDeleteWorkspaceBtnState() {
  if (!state.currentWorkspacePath) {
    explorerDeleteWorkspaceBtn.disabled = true;
    explorerDeleteWorkspaceBtn.style.opacity = '0.4';
    explorerDeleteWorkspaceBtn.style.pointerEvents = 'none';
  } else {
    explorerDeleteWorkspaceBtn.disabled = false;
    explorerDeleteWorkspaceBtn.style.opacity = '1';
    explorerDeleteWorkspaceBtn.style.pointerEvents = 'auto';
  }
}

async function loadWorkspaces() {
  try {
    const response = await fetch('/api/workspaces');
    if (response.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    state.workspacesList = await response.json();
    
    explorerWorkspaceSelect.innerHTML = '<option value="">Default</option>';
    state.workspacesList.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.path;
      opt.textContent = w.name;
      explorerWorkspaceSelect.appendChild(opt);
    });
    explorerWorkspaceSelect.value = state.currentWorkspacePath;

    sessionWorkspaceSelect.innerHTML = '<option value="">Default</option>';
    state.workspacesList.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.path;
      opt.textContent = `${w.name} (${w.path})`;
      sessionWorkspaceSelect.appendChild(opt);
    });
    
    const createNewOpt = document.createElement('option');
    createNewOpt.value = '__new__';
    createNewOpt.textContent = state.workspacesList.length === 0 ? 'Initialize Workspace' : 'Create Workspace';
    sessionWorkspaceSelect.appendChild(createNewOpt);

    if (state.workspacesList.length === 0) {
      sessionWorkspaceSelect.value = '__new__';
      newWorkspaceFields.classList.remove('hidden');
      modalNewWorkspaceName.setAttribute('required', 'true');
      modalNewWorkspacePath.setAttribute('required', 'true');
    } else {
      sessionWorkspaceSelect.value = state.currentWorkspacePath || '';
      newWorkspaceFields.classList.add('hidden');
      modalNewWorkspaceName.removeAttribute('required');
      modalNewWorkspacePath.removeAttribute('required');
    }
    updateDeleteWorkspaceBtnState();
  } catch (err) {
    console.error('Failed to load workspaces:', err);
  }
}

// Service worker navigation message handler
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'attach-session') {
      const sessionName = event.data.session;
      const tabEl = document.querySelector(`.sidebar-item[data-session="${sessionName}"]`);
      if (tabEl) {
        tabEl.click();
      }
    }
  });
}

// Convert native selects to custom ones
convertSelectToCustom(explorerWorkspaceSelect);
convertSelectToCustom(sessionWorkspaceSelect);

// Initial Load Handler
loadWorkspaces().then(async () => {
  await loadSessions();
  restoreTabsState();
  
  // Setup dynamic intervals and micro-systems
  setInterval(loadSessions, 5000);
  initPushNotifications();
  initVoiceInput();

  // Control Dropdown settings panel
  const deckControlToggleBtn = document.getElementById('deckControlToggleBtn');
  const deckControlDropdownMenu = document.getElementById('deckControlDropdownMenu');

  if (deckControlToggleBtn && deckControlDropdownMenu) {
    deckControlToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deckControlDropdownMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!deckControlDropdownMenu.contains(e.target) && e.target !== deckControlToggleBtn) {
        deckControlDropdownMenu.classList.add('hidden');
      }
    });

    deckControlDropdownMenu.addEventListener('click', (e) => {
      const target = e.target.closest('button, .header-btn');
      if (target && (target.id === 'imBotBtn' || target.id === 'logoutBtn' || target.id === 'reloadBtn')) {
        deckControlDropdownMenu.classList.add('hidden');
      }
    });
  }
});
