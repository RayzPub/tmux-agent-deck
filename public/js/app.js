import { state } from './modules/state.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { restoreTabsState, renderTabs, activateTab, closeTab } from './modules/tabs.js';
import { saveEditorFile, updateMarkdownPreview, updatePreviewUI, buildHtmlPreviewUrl } from './modules/editor.js';
import { refreshFileTree, loadDirectory, openDirectoryPicker, loadDirPickerPath } from './modules/explorer.js';
import { attachSession, detachSession, fitTerminal, clearSessionCache, copySelection, pasteFromClipboard, reportFocusStatus, removeSessionFromCache, initMobileKeyboard } from './modules/terminal.js';
import { initPushNotifications, togglePushSubscription } from './modules/push.js';
import { initVoiceInput, stopVoiceInput } from './modules/voice.js';
import { initQrCode } from './modules/qrcode.js';
import { initImBot } from './modules/imBot.js';

// Elements
const sessionList = document.getElementById('sessionList');
const sessionCount = document.getElementById('sessionCount');
const newSessionBtn = document.getElementById('newSessionBtn');
const logoutBtn = document.getElementById('logoutBtn');
const hostIpText = document.getElementById('hostIp');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const pushToggleBtn = document.getElementById('pushToggleBtn');
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

// Push notification toggling initialization
if (pushToggleBtn) {
  pushToggleBtn.addEventListener('click', togglePushSubscription);
}

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

    state.editorInstance.onDidChangeModelContent(() => {
      updateMarkdownPreview();
    });
  });
}

export async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
    if (response.status === 401) {
      window.location.href = '/login';
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
        <span>加载会话失败</span>
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
  
  const welcomeSloganDesc = document.getElementById('welcomeSloganDesc');
  const welcomeNoSessionAction = document.getElementById('welcomeNoSessionAction');

  if (filteredSessions.length === 0) {
    if (welcomeSloganDesc) {
      welcomeSloganDesc.textContent = '当前没有活跃的智能体会话，请新建会话以建立终端连接通道。';
    }
    if (welcomeNoSessionAction) {
      welcomeNoSessionAction.classList.remove('hidden');
    }

    sessionList.innerHTML = `
      <div class="loading-placeholder">
        <span>未找到会话</span>
      </div>
    `;
    return;
  } else {
    if (welcomeSloganDesc) {
      welcomeSloganDesc.textContent = '请从侧边栏选择已有的 tmux 会话，或新建会话以建立终端连接通道。';
    }
    if (welcomeNoSessionAction) {
      welcomeNoSessionAction.classList.add('hidden');
    }
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
        <div class="session-workspace" title="${session.path || '默认工作区'}">
          <i data-lucide="folder"></i>
          <span>${workspaceText}</span>
        </div>
      </div>
      <div class="session-meta">
        <span class="session-time">${session.created}</span>
        <div class="card-actions">
          <button class="card-action-btn danger-btn" data-action="kill" data-name="${session.name}" title="结束会话">
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
      if (confirm(`您确定要终止 tmux 会话 "${name}" 吗？`)) {
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
      alert('关闭会话失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    console.error(err);
    alert('尝试关闭会话时发生网络错误');
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

  // Swipe to open/close sidebar on mobile
  let touchStartX = 0;
  let touchStartY = 0;

  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (window.innerWidth > 768) return;

    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;

    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    // Horizontal swipe threshold of 60px, must be mostly horizontal
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 60) {
      const isSidebarOpen = sidebar.classList.contains('open');

      if (deltaX > 0) {
        // Swipe Right (Left-to-right) -> Open Sidebar
        // Only trigger if starting from the left edge of the screen (< 50px)
        if (!isSidebarOpen && touchStartX < 50) {
          sidebar.classList.add('open');
          sidebarOverlay.classList.remove('hidden');
        }
      } else {
        // Swipe Left (Right-to-left) -> Close Sidebar
        if (isSidebarOpen) {
          sidebar.classList.remove('open');
          sidebarOverlay.classList.add('hidden');
        }
      }
    }
  }, { passive: true });
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
          e.target.closest('#markdownPreview') || 
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
    alert('无法删除默认工作区。');
    return;
  }
  const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
  if (!ws) return;
  
  const confirmDelete = confirm(`您确定要移除工作区 "${ws.name}" 吗？\n\n注意：此操作仅从控制面板列表中移除该工作区配置，并不会删除您磁盘上的实际目录或文件。`);
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
      alert('删除工作区失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    console.error(err);
  }
});

explorerNewWorkspaceBtn.addEventListener('click', () => {
  closeSidebarOnMobile();
  newWorkspaceNameInput.value = '';
  newWorkspacePathInput.value = '';
  // Adjust UI based on multi-user mode
  const pathLabel = document.getElementById('workspacePathLabel');
  const pathHint = document.getElementById('workspacePathHint');
  const browseBtn = document.getElementById('browseNewWorkspacePathBtn');
  if (state.multiUserEnabled) {
    if (state.username === 'admin') {
      if (pathLabel) pathLabel.textContent = '// 工作区绝对路径 (可选)';
      if (pathHint) pathHint.classList.add('hidden');
      if (browseBtn) browseBtn.style.display = '';
      newWorkspacePathInput.placeholder = '例如 /home/ubuntu/project-x 或 my-project';
    } else {
      if (pathLabel) pathLabel.textContent = '// 子目录名称 (可选)';
      if (pathHint) pathHint.classList.remove('hidden');
      if (browseBtn) browseBtn.style.display = 'none';
      newWorkspacePathInput.placeholder = '例如 my-project (留空将自动使用工作区名称)';
    }
  } else {
    if (pathLabel) pathLabel.textContent = '// 工作区绝对路径';
    if (pathHint) pathHint.classList.add('hidden');
    if (browseBtn) browseBtn.style.display = '';
    newWorkspacePathInput.placeholder = '例如 /home/ubuntu/project-x';
  }
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
  if (!wsName) return;
  // In single-user mode, path is required
  if (!state.multiUserEnabled && !wsPath) {
    alert('请输入工作区路径。');
    return;
  }

  try {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: wsName, path: wsPath })
    });

    if (response.ok) {
      const data = await response.json();
      closeWorkspaceModal();
      // Use the resolved path returned by the server
      state.currentWorkspacePath = (data.workspace && data.workspace.path) ? data.workspace.path : wsPath;
      localStorage.setItem('lastWorkspacePath', state.currentWorkspacePath);
      await loadWorkspaces();
      refreshFileTree();
      renderSessions(state.sessionListCache);
    } else {
      const data = await response.json();
      alert('创建工作区失败: ' + (data.error || '未知错误'));
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

const togglePreviewBtn = document.getElementById('togglePreviewBtn');
const previewDropdownTrigger = document.getElementById('previewDropdownTrigger');
const previewDropdownMenu = document.getElementById('previewDropdownMenu');

if (togglePreviewBtn) {
  togglePreviewBtn.addEventListener('click', () => {
    state.previewActive = !state.previewActive;
    const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.type === 'editor');
    const path = activeTab ? activeTab.path : null;
    updatePreviewUI(path);
  });
}

if (previewDropdownTrigger && previewDropdownMenu) {
  previewDropdownTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    previewDropdownMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!previewDropdownMenu.contains(e.target) && e.target !== previewDropdownTrigger) {
      previewDropdownMenu.classList.add('hidden');
    }
  });
}

const openExternalPreviewBtn = document.getElementById('openExternalPreviewBtn');
if (openExternalPreviewBtn) {
  openExternalPreviewBtn.addEventListener('click', () => {
    if (previewDropdownMenu) previewDropdownMenu.classList.add('hidden');
    const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.type === 'editor');
    if (activeTab) {
      const url = buildHtmlPreviewUrl(activeTab.path);
      window.open(url, '_blank');
    }
  });
}

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

const welcomeNewSessionBtn = document.getElementById('welcomeNewSessionBtn');
if (welcomeNewSessionBtn) {
  welcomeNewSessionBtn.addEventListener('click', () => {
    if (newSessionBtn) newSessionBtn.click();
  });
}

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
      alert('创建会话失败: ' + (data.error || '未知错误'));
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
  if (confirm('断开与服务器控制面板的连接？')) {
    try {
      clearSessionCache();
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch (err) {
      console.error(err);
      window.location.href = '/login';
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
      selectedText.innerHTML = '<span style="color: var(--text-secondary);">选择选项</span>';
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
      window.location.href = '/login';
      return;
    }
    state.workspacesList = await response.json();

    // If currentWorkspacePath is empty, default to the first workspace in the list
    if (!state.currentWorkspacePath && state.workspacesList.length > 0) {
      state.currentWorkspacePath = state.workspacesList[0].path;
      localStorage.setItem('lastWorkspacePath', state.currentWorkspacePath);
    }
    
    explorerWorkspaceSelect.innerHTML = '';
    state.workspacesList.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.path;
      opt.textContent = w.name;
      explorerWorkspaceSelect.appendChild(opt);
    });
    explorerWorkspaceSelect.value = state.currentWorkspacePath;

    sessionWorkspaceSelect.innerHTML = '';
    state.workspacesList.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.path;
      opt.textContent = `${w.name} (${w.path})`;
      sessionWorkspaceSelect.appendChild(opt);
    });
    
    const createNewOpt = document.createElement('option');
    createNewOpt.value = '__new__';
    createNewOpt.textContent = state.workspacesList.length === 0 ? '初始化工作区' : '创建新工作区';
    sessionWorkspaceSelect.appendChild(createNewOpt);

    if (state.workspacesList.length === 0) {
      sessionWorkspaceSelect.value = '__new__';
      newWorkspaceFields.classList.remove('hidden');
      modalNewWorkspaceName.setAttribute('required', 'true');
      modalNewWorkspacePath.setAttribute('required', 'true');
    } else {
      sessionWorkspaceSelect.value = state.currentWorkspacePath || state.workspacesList[0].path;
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
convertSelectToCustom(document.getElementById('qrCodeUrlSelect'));

// Initial Load Handler
loadWorkspaces().then(async () => {
  await loadSessions();
  restoreTabsState();
  
  // Setup dynamic intervals and micro-systems
  setInterval(loadSessions, 5000);
  initPushNotifications();
  initVoiceInput();
  initQrCode();
  initImBot();
  initShareModal();

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
      if (target && (target.id === 'imBotBtn' || target.id === 'logoutBtn' || target.id === 'reloadBtn' || target.id === 'qrCodeBtn' || target.id === 'adminPanelBtn' || target.id === 'userKeysBtn')) {
        deckControlDropdownMenu.classList.add('hidden');
      }
    });
  }

  // User API Keys settings
  const userKeysBtn = document.getElementById('userKeysBtn');
  const saveUserKeysBtn = document.getElementById('saveUserKeysBtn');
  const userKeyClaude = document.getElementById('userKeyClaude');
  const userBaseUrlClaude = document.getElementById('userBaseUrlClaude');
  const userModelClaude = document.getElementById('userModelClaude');
  const userKeyCodex = document.getElementById('userKeyCodex');
  const userBaseUrlCodex = document.getElementById('userBaseUrlCodex');
  const userModelCodex = document.getElementById('userModelCodex');
  const userKeyKimi = document.getElementById('userKeyKimi');
  const userBaseUrlKimi = document.getElementById('userBaseUrlKimi');
  const userModelKimi = document.getElementById('userModelKimi');

  // Admin Panel Handlers
  const adminPanelBtn = document.getElementById('adminPanelBtn');
  const adminPanelModal = document.getElementById('adminPanelModal');
  const closeAdminPanelModalBtn = document.getElementById('closeAdminPanelModalBtn');
  const generateCodeBtn = document.getElementById('generateCodeBtn');
  const inviteNoteInput = document.getElementById('inviteNoteInput');
  const inviteCodesTableBody = document.getElementById('inviteCodesTableBody');

  // Tabs
  const tabInviteCodesBtn = document.getElementById('tabInviteCodesBtn');
  const tabAgentsBtn = document.getElementById('tabAgentsBtn');
  const tabContentInviteCodes = document.getElementById('tabContentInviteCodes');
  const tabContentAgents = document.getElementById('tabContentAgents');

  // Agent Config Inputs & Actions
  const agentCfgAgy = document.getElementById('agentCfgAgy');
  const agentCfgClaude = document.getElementById('agentCfgClaude');
  const agentCfgCodex = document.getElementById('agentCfgCodex');
  const agentCfgKimi = document.getElementById('agentCfgKimi');
  const saveAgentSettingsBtn = document.getElementById('saveAgentSettingsBtn');

  async function loadInviteCodes() {
    try {
      const res = await fetch('/api/admin/invite-codes');
      if (res.ok) {
        const codes = await res.json();
        renderInviteCodes(codes);
      }
    } catch (err) {
      console.error('Failed to load invite codes:', err);
    }
  }

  function renderInviteCodes(codes) {
    inviteCodesTableBody.innerHTML = '';
    if (codes.length === 0) {
      inviteCodesTableBody.innerHTML = `<tr><td colspan="5" style="padding: 12px; text-align: center; color: var(--text-muted);">// 暂无可用邀请码</td></tr>`;
      return;
    }
    codes.forEach(c => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';
      
      const inviteLink = `${window.location.origin}/register?code=${c.code}`;
      const statusColor = c.status === 'used' ? 'var(--text-muted)' : 'var(--neon-cyan)';
      const statusText = c.status === 'used' ? '已使用' : '未使用';
      
      tr.innerHTML = `
        <td style="padding: 8px; font-weight: bold; color: var(--neon-pink); cursor: pointer;" title="点击复制注册邀请链接" class="invite-code-cell" data-link="${inviteLink}">
          ${c.code} <i data-lucide="copy" style="width: 10px; height: 10px; display: inline-block; margin-left: 4px; vertical-align: middle;"></i>
        </td>
        <td style="padding: 8px; color: var(--text-secondary); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.note || '-'}</td>
        <td style="padding: 8px; color: ${statusColor}; font-weight: bold;">${statusText}</td>
        <td style="padding: 8px; color: var(--text-secondary);">${c.usedBy || '-'}</td>
        <td style="padding: 8px;">
          <button class="delete-invite-btn" data-code="${c.code}" style="background: none; border: none; color: var(--neon-pink); cursor: pointer; padding: 2px;"><i data-lucide="trash-2" style="width: 14px; height: 14px;"></i></button>
        </td>
      `;
      inviteCodesTableBody.appendChild(tr);
    });
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  if (adminPanelBtn && adminPanelModal) {
    adminPanelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      adminPanelModal.classList.remove('hidden');
      if (deckControlDropdownMenu) {
        deckControlDropdownMenu.classList.add('hidden');
      }
      
      const adminTabsHeader = document.getElementById('adminTabsHeader');
      const tabInviteCodesBtn = document.getElementById('tabInviteCodesBtn');
      const adminAgentCfgSection = document.getElementById('adminAgentCfgSection');
      
      if (adminTabsHeader) adminTabsHeader.classList.remove('hidden');
      if (tabInviteCodesBtn) tabInviteCodesBtn.classList.remove('hidden');
      if (adminAgentCfgSection) adminAgentCfgSection.classList.remove('hidden');

      // Default to invite codes tab on open
      if (tabInviteCodesBtn) tabInviteCodesBtn.click();
    });
  }

  if (closeAdminPanelModalBtn && adminPanelModal) {
    closeAdminPanelModalBtn.addEventListener('click', () => {
      adminPanelModal.classList.add('hidden');
    });
  }

  if (adminPanelModal) {
    adminPanelModal.addEventListener('click', (e) => {
      if (e.target === adminPanelModal) {
        adminPanelModal.classList.add('hidden');
      }
    });
  }

  // API Keys Modal Logic
  async function loadUserKeys() {
    try {
      const res = await fetch('/api/user/keys');
      if (res.ok) {
        const keys = await res.json();
        if (userKeyClaude) userKeyClaude.value = keys.claude || '';
        if (userBaseUrlClaude) userBaseUrlClaude.value = keys.claudeBaseUrl || '';
        if (userModelClaude) userModelClaude.value = keys.claudeModel || '';
        if (userKeyCodex) userKeyCodex.value = keys.codex || '';
        if (userBaseUrlCodex) userBaseUrlCodex.value = keys.codexBaseUrl || '';
        if (userModelCodex) userModelCodex.value = keys.codexModel || '';
        if (userKeyKimi) userKeyKimi.value = keys.kimi || '';
        if (userBaseUrlKimi) userBaseUrlKimi.value = keys.kimiBaseUrl || '';
        if (userModelKimi) userModelKimi.value = keys.kimiModel || '';
      }
    } catch (err) {
      console.error('Failed to load user API keys:', err);
    }
  }

  if (userKeysBtn && adminPanelModal) {
    userKeysBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      adminPanelModal.classList.remove('hidden');
      if (deckControlDropdownMenu) {
        deckControlDropdownMenu.classList.add('hidden');
      }
      
      const adminTabsHeader = document.getElementById('adminTabsHeader');
      const tabInviteCodesBtn = document.getElementById('tabInviteCodesBtn');
      const tabAgentsBtn = document.getElementById('tabAgentsBtn');
      const adminAgentCfgSection = document.getElementById('adminAgentCfgSection');
      const tabContentInviteCodes = document.getElementById('tabContentInviteCodes');
      const tabContentAgents = document.getElementById('tabContentAgents');

      // Load user keys
      loadUserKeys();

      if (state.role === 'admin') {
        // Admins see everything, just switch tab to agents
        if (adminTabsHeader) adminTabsHeader.classList.remove('hidden');
        if (tabInviteCodesBtn) tabInviteCodesBtn.classList.remove('hidden');
        if (adminAgentCfgSection) adminAgentCfgSection.classList.remove('hidden');
        if (tabAgentsBtn) tabAgentsBtn.click();
      } else {
        // Regular users only see the personal API keys settings inside tabContentAgents
        if (adminTabsHeader) adminTabsHeader.classList.add('hidden');
        if (adminAgentCfgSection) adminAgentCfgSection.classList.add('hidden');
        if (tabContentInviteCodes) tabContentInviteCodes.classList.add('hidden');
        if (tabContentAgents) tabContentAgents.classList.remove('hidden');
      }

      if (window.lucide) {
        window.lucide.createIcons();
      }
    });
  }

  if (saveUserKeysBtn) {
    saveUserKeysBtn.addEventListener('click', async () => {
      const keys = {
        claude: userKeyClaude ? userKeyClaude.value.trim() : '',
        claudeBaseUrl: userBaseUrlClaude ? userBaseUrlClaude.value.trim() : '',
        claudeModel: userModelClaude ? userModelClaude.value.trim() : '',
        codex: userKeyCodex ? userKeyCodex.value.trim() : '',
        codexBaseUrl: userBaseUrlCodex ? userBaseUrlCodex.value.trim() : '',
        codexModel: userModelCodex ? userModelCodex.value.trim() : '',
        kimi: userKeyKimi ? userKeyKimi.value.trim() : '',
        kimiBaseUrl: userBaseUrlKimi ? userBaseUrlKimi.value.trim() : '',
        kimiModel: userModelKimi ? userModelKimi.value.trim() : ''
      };

      try {
        const res = await fetch('/api/user/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(keys)
        });
        if (res.ok) {
          alert('API Key 配置保存成功！');
          if (adminPanelModal) adminPanelModal.classList.add('hidden');
        } else {
          const data = await res.json();
          alert(data.error || '保存配置失败');
        }
      } catch (err) {
        console.error('Failed to save user keys:', err);
        alert('保存配置时发生错误');
      }
    });
  }

  // Tab switching logic
  if (tabInviteCodesBtn && tabAgentsBtn && tabContentInviteCodes && tabContentAgents) {
    tabInviteCodesBtn.addEventListener('click', () => {
      tabInviteCodesBtn.classList.add('active');
      tabAgentsBtn.classList.remove('active');
      tabContentInviteCodes.classList.remove('hidden');
      tabContentAgents.classList.add('hidden');
      loadInviteCodes();
    });

    tabAgentsBtn.addEventListener('click', () => {
      tabAgentsBtn.classList.add('active');
      tabInviteCodesBtn.classList.remove('active');
      tabContentAgents.classList.remove('hidden');
      tabContentInviteCodes.classList.add('hidden');
      if (state.role === 'admin') {
        loadAgentSettings();
      }
      loadUserKeys();
    });
  }

  // Load and apply agent settings (Admin only)
  async function loadAgentSettings() {
    try {
      const res = await fetch('/api/admin/settings');
      if (res.ok) {
        const data = await res.json();
        const enabled = data.enabledAgents || ['default', 'agy', 'claude', 'codex', 'kimi'];
        if (agentCfgAgy) agentCfgAgy.checked = enabled.includes('agy');
        if (agentCfgClaude) agentCfgClaude.checked = enabled.includes('claude');
        if (agentCfgCodex) agentCfgCodex.checked = enabled.includes('codex');
        if (agentCfgKimi) agentCfgKimi.checked = enabled.includes('kimi');
      }
    } catch (err) {
      console.error('Failed to load admin agent settings:', err);
    }
  }

  // Save agent settings
  if (saveAgentSettingsBtn) {
    saveAgentSettingsBtn.addEventListener('click', async () => {
      const enabledAgents = ['default'];
      if (agentCfgAgy && agentCfgAgy.checked) enabledAgents.push('agy');
      if (agentCfgClaude && agentCfgClaude.checked) enabledAgents.push('claude');
      if (agentCfgCodex && agentCfgCodex.checked) enabledAgents.push('codex');
      if (agentCfgKimi && agentCfgKimi.checked) enabledAgents.push('kimi');

      try {
        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabledAgents })
        });
        if (res.ok) {
          const data = await res.json();
          state.enabledAgents = data.settings.enabledAgents;
          applyAgentVisibility();
          alert('智能体配置保存成功！');
        } else {
          const data = await res.json();
          alert(data.error || '保存配置失败');
        }
      } catch (err) {
        console.error('Failed to save settings:', err);
        alert('保存配置时发生错误');
      }
    });
  }

  // Global settings function for all users
  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const settings = await res.json();
        state.enabledAgents = settings.enabledAgents || ['default', 'agy', 'claude', 'codex', 'kimi'];
        applyAgentVisibility();
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  function applyAgentVisibility() {
    const allowed = state.enabledAgents || ['default', 'agy', 'claude', 'codex', 'kimi'];
    document.querySelectorAll('input[name="sessionAgent"]').forEach(radio => {
      const card = radio.closest('.agent-card-option');
      if (card) {
        const val = radio.value;
        if (allowed.includes(val)) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
          if (radio.checked) {
            const defRadio = document.querySelector('input[name="sessionAgent"][value="default"]');
            if (defRadio) defRadio.checked = true;
          }
        }
      }
    });
  }

  if (generateCodeBtn) {
    generateCodeBtn.addEventListener('click', async () => {
      const note = inviteNoteInput.value.trim();
      try {
        const res = await fetch('/api/admin/invite-codes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note })
        });
        if (res.ok) {
          inviteNoteInput.value = '';
          loadInviteCodes();
        } else {
          const data = await res.json();
          alert(data.error || '生成邀请码失败');
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  if (inviteCodesTableBody) {
    inviteCodesTableBody.addEventListener('click', async (e) => {
      const cell = e.target.closest('.invite-code-cell');
      if (cell) {
        const link = cell.getAttribute('data-link');
        try {
          await navigator.clipboard.writeText(link);
          alert('注册邀请链接已复制到剪贴板！');
        } catch (err) {
          const input = document.createElement('input');
          input.value = link;
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
          alert('注册邀请链接已复制到剪贴板！');
        }
      }
      
      const deleteBtn = e.target.closest('.delete-invite-btn');
      if (deleteBtn) {
        const code = deleteBtn.getAttribute('data-code');
        if (confirm(`您确定要撤销邀请码 ${code} 吗？`)) {
          try {
            const res = await fetch('/api/admin/invite-codes', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code })
            });
            if (res.ok) {
              loadInviteCodes();
            } else {
              const data = await res.json();
              alert(data.error || 'Failed to revoke invite code');
            }
          } catch (err) {
            console.error(err);
          }
        }
      }
    });
  }

  // Auth check and role check on load
  fetch('/api/auth-status')
    .then(res => res.json())
    .then(data => {
      if (!data.authenticated) {
        window.location.href = '/login';
        return;
      }
      // Store multi-user mode in state for use across the UI
      state.multiUserEnabled = !!data.multiUserEnabled;
      state.username = data.username;
      state.role = data.role;
      
      // Load global settings for showing/hiding disabled agents
      loadSettings();

      if (data.multiUserEnabled) {
        if (userKeysBtn) {
          userKeysBtn.classList.remove('hidden');
        }
        if (data.role === 'admin') {
          if (adminPanelBtn) {
            adminPanelBtn.classList.remove('hidden');
          }
        }
        // Update DECK CONTROLS to show the current username directly
        if (data.username) {
          const maxBtnLen = 10;
          const maxHeaderLen = 18;
          const truncatedBtnUser = data.username.length > maxBtnLen ? data.username.substring(0, maxBtnLen) + '...' : data.username;
          const truncatedHeaderUser = data.username.length > maxHeaderLen ? data.username.substring(0, maxHeaderLen) + '...' : data.username;

          if (deckControlToggleBtn) {
            const toggleBtnSpan = deckControlToggleBtn.querySelector('span');
            if (toggleBtnSpan) {
              toggleBtnSpan.textContent = truncatedBtnUser.toUpperCase();
            }
            deckControlToggleBtn.title = `System Settings & Connections (${data.username})`;
          }
          const dropdownHeader = document.querySelector('.deck-dropdown-header');
          if (dropdownHeader) {
            dropdownHeader.textContent = `// ${truncatedHeaderUser.toUpperCase()}`;
          }
        }
      }
    })
    .catch(err => console.error('Auth check error:', err));
});

// Share preview link functionality
function initShareModal() {
  const sharePreviewBtn = document.getElementById('sharePreviewBtn');
  const shareLinkModal = document.getElementById('shareLinkModal');
  const closeShareLinkModalBtn = document.getElementById('closeShareLinkModalBtn');
  const generateShareLinkBtn = document.getElementById('generateShareLinkBtn');
  const shareDurationSelect = document.getElementById('shareDurationSelect');
  const shareResultSection = document.getElementById('shareResultSection');
  const shareUrlInput = document.getElementById('shareUrlInput');
  const shareExpiryText = document.getElementById('shareExpiryText');

  if (!sharePreviewBtn || !shareLinkModal) return;

  const openModal = () => {
    shareLinkModal.classList.remove('hidden');
    shareResultSection.classList.add('hidden');
    shareUrlInput.value = '';
    shareExpiryText.textContent = '';
    if (window.lucide) {
      window.lucide.createIcons();
    }
  };

  const closeModal = () => {
    shareLinkModal.classList.add('hidden');
  };

  sharePreviewBtn.addEventListener('click', () => {
    const previewDropdownMenu = document.getElementById('previewDropdownMenu');
    if (previewDropdownMenu) previewDropdownMenu.classList.add('hidden');
    openModal();
  });
  if (closeShareLinkModalBtn) {
    closeShareLinkModalBtn.addEventListener('click', closeModal);
  }

  shareLinkModal.addEventListener('click', (e) => {
    if (e.target === shareLinkModal) {
      closeModal();
    }
  });

  if (generateShareLinkBtn) {
    generateShareLinkBtn.addEventListener('click', async () => {
      const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.type === 'editor');
      if (!activeTab) {
        alert('无法获取当前编辑文件');
        return;
      }

      const durationHours = shareDurationSelect.value;
      const originalText = generateShareLinkBtn.innerHTML;
      generateShareLinkBtn.disabled = true;
      generateShareLinkBtn.innerHTML = '<span class="btn-text">生成中...</span>';

      try {
        const response = await fetch('/api/share/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            workspacePath: state.currentWorkspacePath,
            filePath: activeTab.path,
            durationHours: parseFloat(durationHours)
          })
        });

        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }

        const data = await response.json();
        if (response.ok && data.success) {
          // Format full sharing URL
          const protocol = window.location.protocol;
          const host = window.location.host;
          const fullShareUrl = `${protocol}//${host}${data.sharePath}`;

          shareUrlInput.value = fullShareUrl;
          
          const expiryDate = new Date(data.expiresAt);
          shareExpiryText.textContent = `有效期至: ${expiryDate.toLocaleString()}`;
          shareResultSection.classList.remove('hidden');
        } else {
          alert('生成分享链接失败: ' + (data.error || '未知错误'));
        }
      } catch (err) {
        console.error(err);
        alert('生成分享链接时发生网络错误。');
      } finally {
        generateShareLinkBtn.disabled = false;
        generateShareLinkBtn.innerHTML = originalText;
      }
    });
  }

  if (shareUrlInput) {
    shareUrlInput.addEventListener('click', () => {
      shareUrlInput.select();
      shareUrlInput.setSelectionRange(0, 99999); // For mobile devices
      
      navigator.clipboard.writeText(shareUrlInput.value)
        .then(() => {
          // Show a temporary visual feedback text
          const originalExpiry = shareExpiryText.textContent;
          shareExpiryText.textContent = '✓ 链接已成功复制到剪贴板！';
          shareExpiryText.style.color = 'var(--neon-green)';
          setTimeout(() => {
            shareExpiryText.textContent = originalExpiry;
            shareExpiryText.style.color = '';
          }, 2000);
        })
        .catch(err => {
          console.error('Failed to copy: ', err);
        });
    });
  }
}
