// TMUX WEB DECK - Frontend Logic
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const sessionList = document.getElementById('sessionList');
  const sessionCount = document.getElementById('sessionCount');
  const newSessionBtn = document.getElementById('newSessionBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const hostIpText = document.getElementById('hostIp');
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const reloadBtn = document.getElementById('reloadBtn');

  // Theme constants
  const DARK_THEME = {
    background: '#030307',
    foreground: '#00f0ff', // Cyan
    cursor: '#ff007f', // Neon pink blinking cursor
    cursorAccent: '#030307',
    selectionBackground: 'rgba(255, 0, 127, 0.3)',
    black: '#000000',
    red: '#ff0055',
    green: '#00ff66',
    yellow: '#ffcc00',
    blue: '#00ccff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#ffffff',
    brightBlack: '#555555',
    brightRed: '#ff5555',
    brightGreen: '#55ff55',
    brightYellow: '#ffff55',
    brightBlue: '#55ffff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ffff',
    brightWhite: '#ffffff'
  };

  const LIGHT_THEME = {
    background: '#fafafa',
    foreground: '#0f172a', // Dark slate
    cursor: '#4f46e5', // Indigo cursor
    cursorAccent: '#fafafa',
    selectionBackground: 'rgba(79, 70, 229, 0.15)',
    black: '#0f172a',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#475569',      // Readable gray instead of white
    brightBlack: '#475569',
    brightRed: '#b91c1c',
    brightGreen: '#15803d',
    brightYellow: '#a16207',
    brightBlue: '#1d4ed8',
    brightMagenta: '#7e22ce',
    brightCyan: '#0e7490',
    brightWhite: '#0f172a'  // Dark slate/black instead of bright white
  };

  function initTheme() {
    const savedTheme = localStorage.getItem('theme-style');
    if (savedTheme === 'light-minimalist') {
      document.body.classList.add('light-minimalist');
      updateThemeButtonUI(true);
    } else {
      document.body.classList.remove('light-minimalist');
      updateThemeButtonUI(false);
    }
  }

  function toggleTheme() {
    const isLight = document.body.classList.toggle('light-minimalist');
    localStorage.setItem('theme-style', isLight ? 'light-minimalist' : 'dark-cyberpunk');
    updateThemeButtonUI(isLight);
    
    // Update all terminal instances themes
    for (const cached of sessionCache.values()) {
      if (cached && cached.term) {
        cached.term.options.theme = isLight ? LIGHT_THEME : DARK_THEME;
      }
    }
  }

  function updateThemeButtonUI(isLight) {
    if (!themeToggleBtn) return;
    const textSpan = themeToggleBtn.querySelector('span');
    const icon = themeToggleBtn.querySelector('i');
    if (isLight) {
      if (textSpan) textSpan.textContent = 'CYBERPUNK';
      if (icon) {
        icon.setAttribute('data-lucide', 'moon');
      }
    } else {
      if (textSpan) textSpan.textContent = 'MINIMAL';
      if (icon) {
        icon.setAttribute('data-lucide', 'sun');
      }
    }
    // Re-render lucide icons to display the updated icon
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', toggleTheme);
  }
  
  // Call initTheme immediately
  initTheme();
  
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

  // Mobile Sidebar Elements
  const sidebar = document.querySelector('.sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const closeSidebarBtn = document.getElementById('closeSidebarBtn');
  
  // Mobile Keyboard Bar Elements
  const mobileKeyboardBar = document.getElementById('mobileKeyboardBar');

  // Terminal & Socket State Cache
  const sessionCache = new Map(); // sessionName -> { socket, term, fitAddon, container }
  let currentSession = null;
  let stopVoiceInputGlobal = null;
  let resizeTimeout = null;
  let visibilityListenerAdded = false;

  // Open tabs list
  const tabs = []; // { id, name, type: 'terminal'|'editor', path }
  let activeTabId = null;

  // New DOM Elements for File Explorer & Editor
  const workspaceTabs = document.getElementById('workspaceTabs');
  const editorPanel = document.getElementById('editorPanel');
  const activeFilePath = document.getElementById('activeFilePath');
  const editorStatusMsg = document.getElementById('editorStatusMsg');
  const saveFileBtn = document.getElementById('saveFileBtn');
  const closeEditorBtn = document.getElementById('closeEditorBtn');
  const editorTextarea = document.getElementById('editorTextarea');

  // Git Diff Panel elements
  const diffPanel = document.getElementById('diffPanel');
  const activeDiffPath = document.getElementById('activeDiffPath');
  const diffStatusMsg = document.getElementById('diffStatusMsg');
  const refreshDiffBtn = document.getElementById('refreshDiffBtn');
  const closeDiffBtn = document.getElementById('closeDiffBtn');
  const gitDiffWorkspaceBtn = document.getElementById('gitDiffWorkspaceBtn');

  // Sidebar Tabs Toggle elements
  const tabSessionsBtn = document.getElementById('tabSessionsBtn');
  const tabFilesBtn = document.getElementById('tabFilesBtn');
  const sessionsContent = document.getElementById('sessionsContent');
  const filesContent = document.getElementById('filesContent');
  const closeSidebarBtnFiles = document.getElementById('closeSidebarBtnFiles');

  // File Explorer elements
  const refreshFilesBtn = document.getElementById('refreshFilesBtn');
  const collapseAllBtn = document.getElementById('collapseAllBtn');
  const currentPathLabel = document.getElementById('currentPathLabel');
  const fileTreeContainer = document.getElementById('fileTreeContainer');

  // Workspace elements
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

  // Workspace & Session Cache State
  let workspacesList = [];
  let currentWorkspacePath = localStorage.getItem('lastWorkspacePath') || '';
  let sessionListCache = [];

  // Directory Picker elements
  const dirPickerModal = document.getElementById('dirPickerModal');
  const dirPickerCurrentPath = document.getElementById('dirPickerCurrentPath');
  const dirPickerList = document.getElementById('dirPickerList');
  const closeDirPickerBtn = document.getElementById('closeDirPickerBtn');
  const cancelDirPickerBtn = document.getElementById('cancelDirPickerBtn');
  const confirmDirPickerBtn = document.getElementById('confirmDirPickerBtn');
  
  const browseModalWorkspacePathBtn = document.getElementById('browseModalWorkspacePathBtn');
  const browseNewWorkspacePathBtn = document.getElementById('browseNewWorkspacePathBtn');

  // Directory Picker State
  let activeTargetInput = null;
  let pickerCurrentPath = '';

  async function loadDirPickerPath(dirPath) {
    dirPickerList.innerHTML = `
      <div class="loading-placeholder" style="padding: 4px 8px;">
        <div class="cyber-spinner" style="width: 14px; height: 14px; border-width: 1px;"></div>
        <span style="font-size: 11px;">SCANNING DIRECTORIES...</span>
      </div>
    `;

    try {
      const response = await fetch(`/api/directories?path=${encodeURIComponent(dirPath)}`);
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      
      const data = await response.json();
      dirPickerList.innerHTML = '';

      if (!response.ok) {
        dirPickerList.innerHTML = '<div class="error-text" style="color: var(--neon-pink); padding: 4px; font-size:11px;">ERROR: ' + (data.error || 'Load failed') + '</div>';
        return;
      }

      pickerCurrentPath = data.currentPath;
      dirPickerCurrentPath.value = data.currentPath;

      // Add parent navigation if available
      if (data.parentPath) {
        const upRow = document.createElement('div');
        upRow.className = 'file-node-row';
        upRow.style.cursor = 'pointer';
        upRow.style.display = 'flex';
        upRow.style.alignItems = 'center';
        upRow.style.gap = '8px';
        upRow.style.padding = '6px 8px';
        upRow.innerHTML = `
          <div class="file-node-icon dir-icon"><i data-lucide="corner-left-up"></i></div>
          <span class="file-node-name" style="font-size: 13px; font-family: var(--font-mono);">.. (Go Up)</span>
        `;
        upRow.addEventListener('click', () => {
          loadDirPickerPath(data.parentPath);
        });
        dirPickerList.appendChild(upRow);
      }

      if (data.directories.length === 0 && !data.parentPath) {
        dirPickerList.innerHTML = '<div class="empty-text" style="color: var(--text-muted); padding: 4px 8px; font-style: italic; font-size:11px;">(no subdirectories)</div>';
        return;
      }

      data.directories.forEach(dir => {
        const row = document.createElement('div');
        row.className = 'file-node-row';
        row.style.cursor = 'pointer';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.padding = '6px 8px';
        row.innerHTML = `
          <div class="file-node-icon dir-icon"><i data-lucide="folder"></i></div>
          <span class="file-node-name" style="font-size: 13px; font-family: var(--font-mono);" title="${dir.path}">${dir.name}</span>
        `;
        row.addEventListener('click', () => {
          loadDirPickerPath(dir.path);
        });
        dirPickerList.appendChild(row);
      });

      lucide.createIcons();
    } catch (err) {
      console.error(err);
      dirPickerList.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 4px; font-size:11px;">NET ERROR</div>`;
    }
  }

  function openDirectoryPicker(targetInput) {
    activeTargetInput = targetInput;
    const initialPath = targetInput.value.trim();
    dirPickerModal.classList.remove('hidden');
    loadDirPickerPath(initialPath);
  }

  const getWorkspacePrefix = () => {
    if (!currentWorkspacePath) return '';
    const ws = workspacesList.find(w => w.path === currentWorkspacePath);
    return ws ? `[${ws.name}] ` : '';
  };

  function updateDeleteWorkspaceBtnState() {
    if (!currentWorkspacePath) {
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
      workspacesList = await response.json();
      
      // Populate explorer workspace select
      explorerWorkspaceSelect.innerHTML = '<option value="">Default</option>';
      workspacesList.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.path;
        opt.textContent = w.name;
        explorerWorkspaceSelect.appendChild(opt);
      });
      explorerWorkspaceSelect.value = currentWorkspacePath;

      // Populate session workspace select
      sessionWorkspaceSelect.innerHTML = '<option value="">Default</option>';
      workspacesList.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.path;
        opt.textContent = `${w.name} (${w.path})`;
        sessionWorkspaceSelect.appendChild(opt);
      });
      
      const createNewOpt = document.createElement('option');
      createNewOpt.value = '__new__';
      createNewOpt.textContent = workspacesList.length === 0 ? 'Initialize Workspace' : 'Create Workspace';
      sessionWorkspaceSelect.appendChild(createNewOpt);

      if (workspacesList.length === 0) {
        sessionWorkspaceSelect.value = '__new__';
        newWorkspaceFields.classList.remove('hidden');
        modalNewWorkspaceName.setAttribute('required', 'true');
        modalNewWorkspacePath.setAttribute('required', 'true');
      } else {
        sessionWorkspaceSelect.value = currentWorkspacePath || '';
        newWorkspaceFields.classList.add('hidden');
        modalNewWorkspaceName.removeAttribute('required');
        modalNewWorkspacePath.removeAttribute('required');
      }
      updateDeleteWorkspaceBtnState();
    } catch (err) {
      console.error('Failed to load workspaces:', err);
    }
  }

  // File Explorer state
  const expandedFolders = new Set();

  // Git status cache state
  let gitStatusMap = new Map();
  let gitDirStatusMap = new Map();

  async function updateGitStatus() {
    gitStatusMap.clear();
    gitDirStatusMap.clear();
    try {
      const response = await fetch(`/api/git/status?workspacePath=${encodeURIComponent(currentWorkspacePath)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.isGit && data.files) {
          data.files.forEach(file => {
            gitStatusMap.set(file.path, file);
            
            // Propagate git status to parents
            const parts = file.path.split('/');
            let currentParent = '';
            for (let i = 0; i < parts.length - 1; i++) {
              currentParent = currentParent ? `${currentParent}/${parts[i]}` : parts[i];
              if (!gitDirStatusMap.has(currentParent)) {
                gitDirStatusMap.set(currentParent, new Set());
              }
              const statusChar = file.status.includes('M') ? 'M' : (file.status.includes('A') ? 'A' : 'U');
              gitDirStatusMap.get(currentParent).add(statusChar);
            }
          });
        }
      }
    } catch (err) {
      console.error('Error fetching git status:', err);
    }
  }

  function applyGitTreeClasses() {
    document.querySelectorAll('.file-node').forEach(nodeEl => {
      const filePath = nodeEl.getAttribute('data-path');
      const rowEl = nodeEl.querySelector('.file-node-row');
      if (!rowEl) return;
      
      rowEl.classList.remove('git-modified', 'git-added', 'git-untracked');
      const existingBadge = rowEl.querySelector('.git-status-badge');
      if (existingBadge) existingBadge.remove();
      const existingDiffBtn = rowEl.querySelector('.git-diff-inline-btn');
      if (existingDiffBtn) existingDiffBtn.remove();
      
      if (gitStatusMap.has(filePath)) {
        const fileStatus = gitStatusMap.get(filePath);
        const status = fileStatus.status;
        
        let badgeText = '';
        let badgeClass = '';
        
        if (status.includes('M')) {
          rowEl.classList.add('git-modified');
          badgeText = 'M';
          badgeClass = 'modified';
        } else if (status.includes('A')) {
          rowEl.classList.add('git-added');
          badgeText = 'A';
          badgeClass = 'added';
        } else if (status.includes('?')) {
          rowEl.classList.add('git-untracked');
          badgeText = 'U';
          badgeClass = 'added';
        }
        
        if (badgeText) {
          const badgeEl = document.createElement('span');
          badgeEl.className = `git-status-badge ${badgeClass}`;
          badgeEl.textContent = badgeText;
          
          const sizeEl = rowEl.querySelector('.file-node-size');
          if (sizeEl) {
            rowEl.insertBefore(badgeEl, sizeEl);
          } else {
            rowEl.appendChild(badgeEl);
          }
          
          if (!rowEl.classList.contains('directory-row')) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'git-diff-inline-btn';
            diffBtn.title = 'View Git Diff';
            diffBtn.setAttribute('data-path', filePath);
            diffBtn.innerHTML = '<i data-lucide="git-compare"></i>';
            rowEl.appendChild(diffBtn);
          }
        }
      } else if (gitDirStatusMap.has(filePath)) {
        const dirStatuses = gitDirStatusMap.get(filePath);
        let badgeText = '';
        let badgeClass = '';
        
        if (dirStatuses.has('M')) {
          rowEl.classList.add('git-modified');
          badgeText = 'M';
          badgeClass = 'modified';
        } else if (dirStatuses.has('A')) {
          rowEl.classList.add('git-added');
          badgeText = 'A';
          badgeClass = 'added';
        } else if (dirStatuses.has('U')) {
          rowEl.classList.add('git-untracked');
          badgeText = 'U';
          badgeClass = 'added';
        }
        
        if (badgeText) {
          const badgeEl = document.createElement('span');
          badgeEl.className = `git-status-badge ${badgeClass}`;
          badgeEl.textContent = badgeText;
          rowEl.appendChild(badgeEl);
        }
      }
    });
    
    lucide.createIcons();
  }

  function renderTabs() {
    if (tabs.length === 0) {
      workspaceTabs.classList.add('hidden');
      welcomePanel.classList.remove('hidden');
      terminalPanel.classList.add('hidden');
      editorPanel.classList.add('hidden');
      diffPanel.classList.add('hidden');
      currentSession = null;
      activeTabId = null;
      return;
    }

    workspaceTabs.classList.remove('hidden');
    workspaceTabs.innerHTML = '';

    tabs.forEach(tab => {
      const tabEl = document.createElement('div');
      const isActive = activeTabId === tab.id;
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

    lucide.createIcons();
  }

  function activateTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    activeTabId = tabId;
    renderTabs();

    if (tab.type === 'terminal') {
      editorPanel.classList.add('hidden');
      diffPanel.classList.add('hidden');
      welcomePanel.classList.add('hidden');
      terminalPanel.classList.remove('hidden');

      // Hide all terminal containers except the active one
      const targetSession = tab.id;
      for (const [name, cached] of sessionCache.entries()) {
        if (name === targetSession) {
          if (cached.container) cached.container.classList.remove('hidden');
        } else {
          if (cached.container) cached.container.classList.add('hidden');
        }
      }

      currentSession = targetSession;
      activeSessionNameText.textContent = targetSession;

      // Make sure the active terminal layout fits and has focus
      setTimeout(() => {
        fitTerminalFor(targetSession);
        const cached = sessionCache.get(targetSession);
        if (cached && cached.term) {
          cached.term.focus();
        }
      }, 50);
    } else if (tab.type === 'editor') {
      terminalPanel.classList.add('hidden');
      welcomePanel.classList.add('hidden');
      editorPanel.classList.remove('hidden');
      diffPanel.classList.add('hidden');
      currentSession = null; // deactivate active session terminal inputs

      // Hide all terminal containers
      for (const cached of sessionCache.values()) {
        if (cached.container) cached.container.classList.add('hidden');
      }

      // Load file content
      activeFilePath.textContent = tab.path;
      currentPathLabel.textContent = getWorkspacePrefix() + '/' + tab.path;
      loadEditorFile(tab.path);
    } else if (tab.type === 'git-diff') {
      terminalPanel.classList.add('hidden');
      welcomePanel.classList.add('hidden');
      editorPanel.classList.add('hidden');
      diffPanel.classList.remove('hidden');
      currentSession = null;

      // Hide all terminal containers
      for (const cached of sessionCache.values()) {
        if (cached.container) cached.container.classList.add('hidden');
      }

      activeDiffPath.textContent = tab.path || 'All Changes';
      currentPathLabel.textContent = getWorkspacePrefix() + (tab.path ? '/git-diff/' + tab.path : '/git-diff');
      loadGitDiff(tab.path);
    }
  }

  function closeTab(tabId) {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];
    tabs.splice(tabIndex, 1);

    if (tab.type === 'terminal') {
      removeSessionFromCache(tabId);
      loadSessions();
      setTimeout(loadSessions, 500);
    }

    // If we closed the active tab, pick a new active tab
    if (activeTabId === tabId) {
      if (tabs.length > 0) {
        // Activate the tab that took its position, or the last one
        const nextActiveIndex = Math.min(tabIndex, tabs.length - 1);
        activateTab(tabs[nextActiveIndex].id);
      } else {
        activeTabId = null;
        renderTabs();
      }
    } else {
      renderTabs();
    }
  }

  let editorLoadingPath = null;
  async function loadEditorFile(path) {
    if (editorLoadingPath === path) return;
    editorLoadingPath = path;
    editorTextarea.value = '';
    editorTextarea.disabled = true;
    editorStatusMsg.textContent = 'LOADING...';
    
    try {
      const response = await fetch(`/api/files/content?path=${encodeURIComponent(path)}&workspacePath=${encodeURIComponent(currentWorkspacePath)}`);
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const data = await response.json();
      if (response.ok) {
        editorTextarea.value = data.content;
        editorTextarea.disabled = false;
        editorStatusMsg.textContent = '';
        editorTextarea.focus();
      } else {
        editorStatusMsg.textContent = 'LOAD ERROR';
        editorTextarea.value = `Error loading file: ${data.error || 'Unknown error'}`;
      }
    } catch (err) {
      console.error(err);
      editorStatusMsg.textContent = 'NET ERROR';
      editorTextarea.value = 'Network error while retrieving file content.';
    } finally {
      editorLoadingPath = null;
    }
  }

  async function saveEditorFile() {
    const activeTab = tabs.find(t => t.id === activeTabId && t.type === 'editor');
    if (!activeTab || editorTextarea.disabled) return;

    const path = activeTab.path;
    const content = editorTextarea.value;
    editorStatusMsg.textContent = 'SAVING...';
    
    try {
      const response = await fetch('/api/files/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ workspacePath: currentWorkspacePath, filePath: path, content })
      });

      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }

      const data = await response.json();
      if (response.ok && data.success) {
        editorStatusMsg.textContent = 'SAVED';
        updateGitStatus().then(() => {
          applyGitTreeClasses();
        });
        setTimeout(() => {
          // Clear status message if it hasn't changed to something else
          if (editorStatusMsg.textContent === 'SAVED') {
            editorStatusMsg.textContent = '';
          }
        }, 2000);
      } else {
        editorStatusMsg.textContent = 'SAVE ERROR';
        alert('Failed to save file: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error(err);
      editorStatusMsg.textContent = 'NET ERROR';
      alert('Network error when attempting to save file.');
    }
  }

  async function loadDirectory(dirPath, containerEl) {
    containerEl.innerHTML = `
      <div class="loading-placeholder" style="padding: 4px 8px;">
        <div class="cyber-spinner" style="width: 14px; height: 14px; border-width: 1px;"></div>
        <span style="font-size: 11px;">SCANNING...</span>
      </div>
    `;

    try {
      const response = await fetch(`/api/files/list?path=${encodeURIComponent(dirPath)}&workspacePath=${encodeURIComponent(currentWorkspacePath)}`);
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const files = await response.json();
      containerEl.innerHTML = '';

      if (!response.ok) {
        containerEl.innerHTML = '<div class="error-text" style="color: var(--neon-pink); padding: 4px; font-size:11px;">ERROR: ' + (files.error || 'Load failed') + '</div>';
        return;
      }

      if (files.length === 0) {
        containerEl.innerHTML = '<div class="empty-text" style="color: var(--text-muted); padding: 4px 8px; font-style: italic; font-size:11px;">(empty)</div>';
        return;
      }

      files.forEach(file => {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'file-node';
        nodeEl.setAttribute('data-path', file.path);

        const rowEl = document.createElement('div');
        rowEl.className = 'file-node-row';
        if (file.isDir) {
          rowEl.classList.add('directory-row');
        } else {
          rowEl.classList.add('file-row');
        }

        const isExpanded = expandedFolders.has(file.path);
        const folderIcon = isExpanded ? 'folder-open' : 'folder';
        const iconName = file.isDir ? folderIcon : 'file';
        const iconClass = file.isDir ? 'dir-icon' : 'file-icon';

        // Size format
        let sizeText = '';
        if (file.size !== null) {
          if (file.size < 1024) sizeText = `${file.size} B`;
          else if (file.size < 1024 * 1024) sizeText = `${(file.size / 1024).toFixed(1)} KB`;
          else sizeText = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
        }

        rowEl.innerHTML = `
          <div class="file-node-icon ${iconClass}">
            <i data-lucide="${iconName}"></i>
          </div>
          <span class="file-node-name" title="${file.name}">${file.name}</span>
          ${sizeText ? `<span class="file-node-size">${sizeText}</span>` : ''}
        `;

        nodeEl.appendChild(rowEl);

        let childrenEl = null;
        if (file.isDir) {
          childrenEl = document.createElement('div');
          childrenEl.className = 'file-node-children';
          if (!isExpanded) {
            childrenEl.style.display = 'none';
          }
          nodeEl.appendChild(childrenEl);

          // If it was expanded, load children right away
          if (isExpanded) {
            loadDirectory(file.path, childrenEl);
          }
        }

        // Click handler for row
        rowEl.addEventListener('click', (e) => {
          e.stopPropagation();
          
          // Check if git diff inline button was clicked
          const diffBtn = e.target.closest('.git-diff-inline-btn');
          if (diffBtn) {
            const filePath = diffBtn.getAttribute('data-path');
            openGitDiff(filePath);
            return;
          }

          if (file.isDir) {
            toggleFolder(file.path, childrenEl, rowEl.querySelector('.file-node-icon i'));
          } else {
            // Select active row style
            document.querySelectorAll('.file-node-row').forEach(r => r.classList.remove('active'));
            rowEl.classList.add('active');
            
            // Open the file!
            openFile(file.path);
          }
        });

        containerEl.appendChild(nodeEl);
      });

      // Apply git highlights and badges
      applyGitTreeClasses();

      lucide.createIcons();

    } catch (err) {
      console.error(err);
      containerEl.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 4px; font-size:11px;">NET ERROR</div>`;
    }
  }

  function toggleFolder(path, childrenEl, iconEl) {
    if (expandedFolders.has(path)) {
      expandedFolders.delete(path);
      childrenEl.style.display = 'none';
      childrenEl.innerHTML = '';
      if (iconEl) {
        iconEl.setAttribute('data-lucide', 'folder');
        lucide.createIcons();
      }
    } else {
      expandedFolders.add(path);
      childrenEl.style.display = 'flex';
      loadDirectory(path, childrenEl);
      if (iconEl) {
        iconEl.setAttribute('data-lucide', 'folder-open');
        lucide.createIcons();
      }
    }
  }

  function openFile(path) {
    const filename = path.split('/').pop();
    let tab = tabs.find(t => t.type === 'editor' && t.path === path);
    if (!tab) {
      tab = {
        id: 'editor-' + path,
        name: filename,
        type: 'editor',
        path: path
      };
      tabs.push(tab);
    }
    activateTab(tab.id);
  }

  function openGitDiff(filePath = '') {
    const tabId = filePath ? `git-diff-${filePath}` : 'git-diff-all';
    const tabName = filePath ? `Diff: ${filePath.split('/').pop()}` : 'Workspace Diff';
    
    let tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      tab = {
        id: tabId,
        name: tabName,
        type: 'git-diff',
        path: filePath
      };
      tabs.push(tab);
    }
    activateTab(tab.id);
  }

  let diffLoadingPath = null;
  async function loadGitDiff(path = '') {
    diffLoadingPath = path;
    const container = document.getElementById('diffContentContainer');
    container.innerHTML = `
      <div class="loading-placeholder">
        <div class="cyber-spinner"></div>
        <span>GENERATING DIFF...</span>
      </div>
    `;
    diffStatusMsg.textContent = 'LOADING...';
    
    try {
      const url = `/api/git/diff?workspacePath=${encodeURIComponent(currentWorkspacePath)}&path=${encodeURIComponent(path)}`;
      const response = await fetch(url);
      
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      
      const data = await response.json();
      if (diffLoadingPath !== path) return;
      
      if (response.ok) {
        diffStatusMsg.textContent = '';
        parseAndRenderDiff(data.diff);
      } else {
        diffStatusMsg.textContent = 'ERROR';
        container.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 20px; text-align: center;">ERROR: ${data.error || 'Failed to load diff'}</div>`;
      }
    } catch (err) {
      console.error(err);
      diffStatusMsg.textContent = 'NET ERROR';
      container.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 20px; text-align: center;">NET ERROR</div>`;
    }
  }

  function parseAndRenderDiff(diffText) {
    const container = document.getElementById('diffContentContainer');
    if (!diffText || !diffText.trim()) {
      container.innerHTML = '<div class="diff-empty">No uncommitted changes in this file / workspace.</div>';
      return;
    }

    container.innerHTML = '';
    const lines = diffText.split('\n');
    const fragment = document.createDocumentFragment();

    lines.forEach(line => {
      const lineEl = document.createElement('span');
      lineEl.className = 'diff-line';
      
      if (line.startsWith('+') && !line.startsWith('+++')) {
        lineEl.classList.add('diff-addition');
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        lineEl.classList.add('diff-deletion');
      } else if (line.startsWith('@@')) {
        lineEl.classList.add('diff-chunk');
      } else if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        lineEl.classList.add('diff-header');
      } else if (line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
        lineEl.classList.add('diff-meta');
      }
      
      lineEl.textContent = line;
      fragment.appendChild(lineEl);
    });

    container.appendChild(fragment);
  }

  async function refreshFileTree() {
    expandedFolders.clear();
    await updateGitStatus();
    loadDirectory('', fileTreeContainer);
    currentPathLabel.textContent = getWorkspacePrefix() + '/';
  }

  function removeSessionFromCache(name) {
    const cached = sessionCache.get(name);
    if (cached) {
      if (cached.socket) {
        cached.socket.disconnect();
      }
      if (cached.term) {
        cached.term.dispose();
      }
      if (cached.container) {
        cached.container.remove();
      }
      sessionCache.delete(name);
    }
  }

  function clearSessionCache() {
    for (const name of sessionCache.keys()) {
      removeSessionFromCache(name);
    }
  }

  // Initialize Lucide Icons
  lucide.createIcons();

  // Set Host IP in header
  hostIpText.textContent = window.location.hostname || '127.0.0.1';

  // Load Sessions
  async function loadSessions() {
    try {
      const response = await fetch('/api/sessions');
      if (response.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      
      const sessions = await response.json();
      sessionListCache = sessions;
      renderSessions(sessions);
    } catch (err) {
      console.error('Failed to load sessions:', err);
      sessionList.innerHTML = `
        <div class="loading-placeholder">
          <i data-lucide="alert-circle" style="color: var(--neon-pink)"></i>
          <span>ERROR LOADING SESSIONS</span>
        </div>
      `;
      lucide.createIcons();
    }
  }

  // Render Session Cards
  function renderSessions(sessions) {
    // Filter sessions to only those in the current workspace context
    const activeWs = workspacesList.find(w => w.path === currentWorkspacePath);
    const activeWorkspaceName = activeWs ? activeWs.name : '';

    const filteredSessions = sessions.filter(session => {
      // 1. If session has explicit workspaceName set, compare names
      if (session.workspaceName) {
        if (activeWorkspaceName) {
          return session.workspaceName.toLowerCase() === activeWorkspaceName.toLowerCase();
        }
        return false;
      }
      
      // 2. Otherwise fall back to matching path
      if (session.path) {
        if (currentWorkspacePath) {
          return session.path === currentWorkspacePath;
        } else {
          // If we are on default workspace, verify if this session path belongs to any registered workspace
          const belongsToSomeWorkspace = workspacesList.some(w => w.path === session.path);
          return !belongsToSomeWorkspace;
        }
      }

      // 3. Fallback: if no path, only show on default workspace
      return !currentWorkspacePath;
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
      card.className = `session-card ${currentSession === session.name ? 'active' : ''}`;
      
      // Determine associated workspace name
      const matchingWs = workspacesList.find(w => w.path === session.path);
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
          <div class="session-name" title="${session.name}">${session.name}</div>
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

      // Click to attach session
      card.addEventListener('click', (e) => {
        // Prevent action button click from triggering attach
        if (e.target.closest('.card-action-btn')) return;
        closeSidebarOnMobile();
        attachSession(session.name);
      });

      sessionList.appendChild(card);
    });

    // Re-run Lucide Icons rendering for dynamic buttons
    lucide.createIcons();

    // Attach click listeners to kill buttons
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

  // Kill Session
  async function killSession(name) {
    try {
      const response = await fetch(`/api/sessions/${name}`, { method: 'DELETE' });
      if (response.ok) {
        removeSessionFromCache(name);
        if (currentSession === name) {
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

  // Fit Terminal Size for specific session
  function fitTerminalFor(sessionName) {
    const cached = sessionCache.get(sessionName);
    if (cached && cached.term && cached.fitAddon) {
      cached.fitAddon.fit();
      if (cached.socket) {
        cached.socket.emit('resize', {
          cols: cached.term.cols,
          rows: cached.term.rows
        });
      }
    }
  }

  // Fit active Terminal Size
  function fitTerminal() {
    if (currentSession) {
      fitTerminalFor(currentSession);
    }
  }

  // Attach to session
  function attachSession(sessionName) {
    let tab = tabs.find(t => t.type === 'terminal' && t.id === sessionName);
    if (!tab) {
      tab = {
        id: sessionName,
        name: sessionName,
        type: 'terminal'
      };
      tabs.push(tab);
    }

    if (currentSession && currentSession !== sessionName) {
      const prevCached = sessionCache.get(currentSession);
      if (prevCached && prevCached.container) {
        prevCached.container.classList.add('hidden');
      }
    }

    activeTabId = sessionName;
    renderTabs();

    currentSession = sessionName;
    activeSessionNameText.textContent = sessionName;
    reportFocusStatus();
    
    // Auto-scope Explorer to session's working directory
    const sessionObj = sessionListCache.find(s => s.name === sessionName);
    if (sessionObj) {
      let matchingWs = null;
      if (sessionObj.workspaceName) {
        matchingWs = workspacesList.find(w => w.name.toLowerCase() === sessionObj.workspaceName.toLowerCase());
      }
      if (!matchingWs && sessionObj.path) {
        matchingWs = workspacesList.find(w => w.path === sessionObj.path);
      }
      
      if (matchingWs) {
        currentWorkspacePath = matchingWs.path;
        explorerWorkspaceSelect.value = matchingWs.path;
        localStorage.setItem('lastWorkspacePath', currentWorkspacePath);
        refreshFileTree();
      } else if (sessionObj.path) {
        currentWorkspacePath = sessionObj.path;
        let optionExists = Array.from(explorerWorkspaceSelect.options).some(opt => opt.value === sessionObj.path);
        if (!optionExists) {
          const tempOpt = document.createElement('option');
          tempOpt.value = sessionObj.path;
          tempOpt.textContent = `[Session Dir] ${sessionObj.path}`;
          explorerWorkspaceSelect.appendChild(tempOpt);
        }
        explorerWorkspaceSelect.value = sessionObj.path;
        localStorage.setItem('lastWorkspacePath', currentWorkspacePath);
        refreshFileTree();
      }
    }

    // Update sidebar UI selection
    loadSessions();

    // Show terminal panel
    welcomePanel.classList.add('hidden');
    editorPanel.classList.add('hidden');
    terminalPanel.classList.remove('hidden');

    let cached = sessionCache.get(sessionName);
    if (!cached) {
      // Create new container for this session
      const container = document.createElement('div');
      container.className = 'terminal-instance-container';
      container.style.width = '100%';
      container.style.height = '100%';
      container.style.touchAction = 'none';
      terminalContainer.appendChild(container);

      // Create Socket.io connection for terminal with reconnection enabled
      const sessionSocket = io({
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
      });

      // Connection state tracking
      let reconnectingToast = null;
      let isFirstConnect = true;

      const showConnectionToast = (message, type = 'warning') => {
        if (reconnectingToast) {
          reconnectingToast.querySelector('.toast-message').textContent = message;
          reconnectingToast.className = `connection-toast ${type}`;
          const spinner = reconnectingToast.querySelector('.cyber-spinner');
          if (spinner) {
            spinner.style.display = (type === 'warning') ? 'block' : 'none';
          }
          return;
        }
        reconnectingToast = document.createElement('div');
        reconnectingToast.className = `connection-toast ${type}`;
        reconnectingToast.style.cursor = 'pointer';
        reconnectingToast.innerHTML = `
          <div class="cyber-spinner" style="width: 14px; height: 14px; border-width: 1px; display: ${type === 'warning' ? 'block' : 'none'};"></div>
          <span class="toast-message">${message}</span>
        `;
        
        reconnectingToast.addEventListener('click', () => {
          if (reconnectingToast.classList.contains('error')) {
            showConnectionToast('Reconnecting...', 'warning');
            sessionSocket.connect();
          }
        });
        
        document.body.appendChild(reconnectingToast);
      };

      const hideConnectionToast = () => {
        if (reconnectingToast) {
          reconnectingToast.remove();
          reconnectingToast = null;
        }
      };

      sessionSocket.on('connect', () => {
        hideConnectionToast();
        console.log(`Socket connected for session: ${sessionName}`);
        
        if (!isFirstConnect) {
          console.log(`Socket reconnected (manual/auto) for session: ${sessionName}`);
          sessionTerm.clear();
          setTimeout(() => {
            sessionFitAddon.fit();
            sessionSocket.emit('init-terminal', {
              sessionName: sessionName,
              cols: sessionTerm.cols,
              rows: sessionTerm.rows
            });
            if (sessionName === currentSession) {
              sessionTerm.focus();
            }
            reportFocusStatus();
          }, 100);
        } else {
          isFirstConnect = false;
          reportFocusStatus();
        }
      });

      sessionSocket.on('disconnect', (reason) => {
        console.log(`Socket disconnected for session: ${sessionName}, reason: ${reason}`);
        if (reason === 'io client disconnect') {
          // Client manually disconnected (e.g. session deleted), clear toast
          hideConnectionToast();
          return;
        }
        if (reason === 'io server disconnect') {
          // Server intentionally disconnected, need manual reconnect
          showConnectionToast('Server disconnected. Tap to reconnect.', 'error');
        } else {
          // Network issue, auto-reconnecting
          showConnectionToast('Reconnecting...', 'warning');
        }
      });

      sessionSocket.on('reconnect_attempt', (attemptNumber) => {
        showConnectionToast(`Reconnecting... (${attemptNumber}/10)`, 'warning');
      });

      sessionSocket.on('reconnect_failed', () => {
        showConnectionToast('Connection failed. Tap to retry.', 'error');
      });

      // Create xterm instance
      const sessionTerm = new Terminal({
        cursorBlink: true,
        cursorStyle: 'underline',
        theme: document.body.classList.contains('light-minimalist') ? LIGHT_THEME : DARK_THEME,
        fontFamily: '"Fira Code", Consolas, Menlo, Courier, monospace',
        fontSize: 14,
        lineHeight: 1.2
      });

      const sessionFitAddon = new FitAddon.FitAddon();
      sessionTerm.loadAddon(sessionFitAddon);
      
      // Mount terminal
      sessionTerm.open(container);

      // Touch-to-scroll support for mobile devices (works in tmux mouse mode and standard scrollback)
      let lastTouchY = 0;

      container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          lastTouchY = e.touches[0].clientY;
        }
      }, { capture: true, passive: false });

      container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) {
          const currentY = e.touches[0].clientY;
          const deltaY = lastTouchY - currentY; // Swipe up (positive deltaY) scrolls terminal down
          lastTouchY = currentY;

          const termEl = sessionTerm.element;
          if (termEl) {
            const wheelEvent = new WheelEvent('wheel', {
              deltaY: deltaY * 2, // Scale touch drag delta to mouse wheel delta
              bubbles: true,
              cancelable: true
            });
            termEl.dispatchEvent(wheelEvent);
          }
          e.preventDefault(); // Prevent browser default drag/bounce
        }
      }, { capture: true, passive: false });

      // Mouse drag tracking for copy assistance hint
      let dragStart = null;
      let lastDragWithoutShiftTime = 0;

      container.addEventListener('mousedown', (e) => {
        // Only track left-click drags when Shift key is not pressed
        if (e.button === 0 && !e.shiftKey) {
          dragStart = { x: e.clientX, y: e.clientY };
        }
      });

      container.addEventListener('mouseup', (e) => {
        if (dragStart) {
          const dist = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
          // If the mouse dragged by more than 15px, record the timestamp
          if (dist > 15) {
            lastDragWithoutShiftTime = Date.now();
          }
          dragStart = null;
        }
      });

      cached = {
        socket: sessionSocket,
        term: sessionTerm,
        fitAddon: sessionFitAddon,
        container: container
      };
      sessionCache.set(sessionName, cached);

      // Initial fit and connect
      setTimeout(() => {
        sessionFitAddon.fit();
        const dims = { cols: sessionTerm.cols, rows: sessionTerm.rows };
        
        sessionSocket.emit('init-terminal', {
          sessionName: sessionName,
          cols: dims.cols,
          rows: dims.rows
        });
        // Refresh sessions status after the connection is established and PTY is spawned
        setTimeout(loadSessions, 200);
      }, 100);

      // Terminal -> Server
      sessionTerm.onData(data => {
        if (sessionSocket) {
          // If CTRL modifier is active, modify the input if it's a letter
          const ctrlBtn = document.getElementById('ctrlKeyBtn');
          if (ctrlBtn && ctrlBtn.classList.contains('active') && data.length === 1) {
            const code = data.charCodeAt(0);
            if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
              const ctrlChar = String.fromCharCode(code % 32);
              sessionSocket.emit('terminal-input', ctrlChar);
              ctrlBtn.classList.remove('active');
              return;
            }
          }
          sessionSocket.emit('terminal-input', data);
        }
      });

      // Server -> Terminal
      sessionSocket.on('terminal-output', data => {
        if (sessionTerm) {
          sessionTerm.write(data);
        }
      });

      // Track selection for manual copy (Ctrl+C / Cmd+C)
      sessionTerm.onSelectionChange(() => {
        const selection = sessionTerm.getSelection();
        if (selection && selection.trim().length > 0) {
          lastSelection = selection;
        }
      });

      // Keyboard shortcut: Intercept Ctrl+C/Cmd+C and Ctrl+V/Cmd+V before xterm.js processes them
      sessionTerm.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;

        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        // Ctrl+C or Cmd+C (but not Ctrl+Shift+C which is standard browser/terminal behavior)
        if (isCtrlOrCmd && key === 'c' && !e.shiftKey) {
          const selection = sessionTerm.getSelection();
          if (selection && selection.trim().length > 0) {
            writeToClipboard(selection);
            return false; // Prevent xterm.js from handling the key
          } else {
            // If Ctrl+C is pressed with empty selection, check if they recently dragged the mouse without Shift
            const timeSinceDrag = Date.now() - lastDragWithoutShiftTime;
            if (timeSinceDrag < 4000) {
              showTipToast('💡 提示：tmux 鼠标模式已开启。请按住 Shift 键再用鼠标拖拽选择以进行复制。');
            }
          }
        }
        // Ctrl+V or Cmd+V to paste
        if (isCtrlOrCmd && key === 'v' && !e.shiftKey) {
          pasteFromClipboard();
          return false; // Prevent xterm.js from handling the key
        }
        return true;
      });

      // Handle session exit from server (e.g. process died)
      sessionSocket.on('terminal-exit', () => {
        console.log(`Terminal PTY for "${sessionName}" exited`);
        removeSessionFromCache(sessionName);
        closeTab(sessionName);
        loadSessions();
      });

      // Handle authentication error during socket handshake
      sessionSocket.on('connect_error', (err) => {
        console.error('Socket Auth Error:', err.message);
        alert('Session connection unauthorized. Redirecting to login.');
        window.location.href = '/login.html';
      });

      // Mobile click to focus terminal container
      container.addEventListener('click', () => {
        if (sessionTerm) {
          sessionTerm.focus();
        }
      });
    } else {
      // Show existing container
      cached.container.classList.remove('hidden');
      // Focus the terminal
      setTimeout(() => {
        if (cached.term) {
          cached.term.focus();
        }
        fitTerminalFor(sessionName);
      }, 50);
    }
  }

  // Detach session
  function detachSession() {
    if (currentSession) {
      closeTab(currentSession);
    }
  }

  // Handle Window Resize (Debounced)
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      fitTerminal();
    }, 150);
  });

  // Store selection for later copy action
  let lastSelection = '';

  // Helper to show a brief tip toast
  function showTipToast(message, duration = 4000) {
    const existing = document.querySelector('.connection-toast.tip-toast');
    if (existing) {
      existing.querySelector('.toast-message').textContent = message;
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'connection-toast warning tip-toast';
    toast.innerHTML = `
      <i data-lucide="info"></i>
      <span class="toast-message">${message}</span>
    `;
    document.body.appendChild(toast);
    if (window.lucide) {
      window.lucide.createIcons();
    }
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.5s ease';
      setTimeout(() => toast.remove(), 500);
    }, duration);
  }

  // Clipboard write handler - MUST be called from user interaction context
  function writeToClipboard(text) {
    if (!text) return false;

    // 1. Try the synchronous copy event listener trick first (most reliable, zero prompts, doesn't steal focus)
    let success = false;
    const copyListener = (e) => {
      try {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        success = true;
      } catch (evtErr) {
        console.error('Failed to set clipboard data in copy event listener:', evtErr);
      }
    };
    document.addEventListener('copy', copyListener, { once: true });
    try {
      const execResult = document.execCommand('copy');
      if (execResult && success) {
        console.log('✅ Clipboard write succeeded via synchronous copy listener');
        return true;
      }
    } catch (err) {
      console.warn('Synchronous copy event method failed, trying alternative:', err);
    }

    // 2. Fallback: Try modern Clipboard API (async, might fail if permission denied or deferred)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => console.log('✅ Clipboard write succeeded via navigator.clipboard'))
        .catch(err => console.error('navigator.clipboard.writeText failed:', err));
      return true;
    }

    // 3. Fallback: Absolute last resort focus-stealing textarea fallback
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.opacity = "0";
    textArea.style.pointerEvents = "none";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      success = document.execCommand('copy');
      if (success) {
        console.log('✅ Clipboard write succeeded via fallback textarea');
      }
    } catch (err) {
      console.error('Fallback textarea copy failed:', err);
    }
    document.body.removeChild(textArea);

    // Restore focus to active terminal
    if (typeof currentSession !== 'undefined' && typeof sessionCache !== 'undefined') {
      const cached = sessionCache.get(currentSession);
      if (cached && cached.term) {
        cached.term.focus();
      }
    }
    return success;
  }

  // Clipboard paste handler - MUST be called from user interaction context
  async function pasteFromClipboard() {
    // Try modern Clipboard API first
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && currentSession) {
          const cached = sessionCache.get(currentSession);
          if (cached && cached.socket) {
            cached.socket.emit('terminal-input', text);
          }
          console.log('✅ Paste succeeded via navigator.clipboard');
        }
        return;
      } catch (err) {
        console.warn('navigator.clipboard.readText failed:', err.message || err);
      }
    }

    // Fallback: prompt
    const text = prompt("📋 PASTE ZONE // 请在下方粘贴您的文本 (Ctrl+V):");
    if (text && currentSession) {
      const cached = sessionCache.get(currentSession);
      if (cached && cached.socket) {
        cached.socket.emit('terminal-input', text);
      }
    }
  }

  // Manual copy function - called on Ctrl+C or Copy button
  async function copySelection() {
    if (lastSelection && lastSelection.trim()) {
      const success = await writeToClipboard(lastSelection);
      if (success) {
        // Visual feedback could be added here
        console.log('📋 Copied:', lastSelection.substring(0, 50) + '...');
      }
    }
  }

  // Attach controls listeners
  fitTerminalBtn.addEventListener('click', fitTerminal);
  if (copyTerminalBtn) {
    copyTerminalBtn.addEventListener('click', async () => {
      // Get current terminal selection if available
      const cached = sessionCache.get(currentSession);
      const selection = cached?.term?.getSelection();
      if (selection && selection.trim()) {
        await writeToClipboard(selection);
      } else if (lastSelection) {
        await writeToClipboard(lastSelection);
      } else {
        console.log('No text selected to copy');
      }
    });
  }
  if (pasteTerminalBtn) {
    pasteTerminalBtn.addEventListener('click', pasteFromClipboard);
  }
  detachBtn.addEventListener('click', detachSession);

  // Sidebar Toggle / Collapse Logic
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

    // Swipe to open/close sidebar on mobile (only when terminal is not active to prevent gesture conflicts)
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
        const isTerminalVisible = !terminalPanel.classList.contains('hidden');

        if (deltaX > 0) {
          // Swipe Right (Left-to-right) -> Open Sidebar
          // Only trigger if starting from the left edge of the screen (< 50px) and terminal is not active
          if (!isSidebarOpen && touchStartX < 50 && !isTerminalVisible) {
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

  // Prevent rubber-band/elastic scrolling on mobile for the header and terminal workspace
  const cyberHeader = document.querySelector('.cyber-header');
  if (cyberHeader) {
    cyberHeader.addEventListener('touchmove', (e) => {
      if (window.innerWidth <= 768) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  const terminalWorkspace = document.querySelector('.terminal-workspace');
  if (terminalWorkspace) {
    terminalWorkspace.addEventListener('touchmove', (e) => {
      if (window.innerWidth <= 768) {
        // Allow scrolling inside editor, diff viewer, and horizontal tabs
        if (e.target.closest('#editorTextarea') || 
            e.target.closest('#diffPanel .editor-container-wrapper') || 
            e.target.closest('#workspaceTabs')) {
          return;
        }
        e.preventDefault();
      }
    }, { passive: false });
  }

  // Close sidebar drawer on selection or creation (on mobile)
  function closeSidebarOnMobile() {
    if (window.innerWidth <= 768 && sidebar && sidebarOverlay) {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.add('hidden');
    }
  }

  // Mobile Keyboard Helper Bar Logic
  if (mobileKeyboardBar) {
    const handleHelperKey = (e) => {
      const btn = e.target.closest('.helper-key');
      if (!btn) return;
      
      e.preventDefault(); // Prevent focus loss from xterm's hidden textarea
      
      const key = btn.getAttribute('data-key');
      if (!key) return;
      
      if (key === 'ctrl') {
        btn.classList.toggle('active');
        return;
      }

      if (key === 'paste') {
        pasteFromClipboard();
        return;
      }

      if (key === 'copy') {
        // Copy terminal selection
        (async () => {
          const activeSession = sessionCache.get(currentSession);
          const selection = activeSession?.term?.getSelection();
          if (selection && selection.trim()) {
            await writeToClipboard(selection);
          } else if (lastSelection) {
            await writeToClipboard(lastSelection);
          }
        })();
        return;
      }
      
      const activeSession = sessionCache.get(currentSession);
      
      if (key === 'keyboard-toggle') {
        if (activeSession && activeSession.term) {
          activeSession.term.focus();
        }
        return;
      }
      
      // Send sequence directly
      let seq = '';
      switch (key) {
        case 'esc': seq = '\x1b'; break;
        case 'tab': seq = '\x09'; break;
        case 'enter': seq = '\r'; break;
        case 'tmux-prefix': seq = '\x02'; break; // Ctrl+B
        case 'ctrl-c': seq = '\x03'; break; // Ctrl+C
        case 'up': seq = '\x1b[A'; break;
        case 'down': seq = '\x1b[B'; break;
        case 'left': seq = '\x1b[D'; break;
        case 'right': seq = '\x1b[C'; break;
      }
      
      if (seq && activeSession && activeSession.socket) {
        activeSession.socket.emit('terminal-input', seq);
      }
    };

    mobileKeyboardBar.addEventListener('touchstart', handleHelperKey, { passive: false });
    mobileKeyboardBar.addEventListener('mousedown', handleHelperKey);

    // Also attach listeners to the relocated ENTER button in the input bar
    const mobileEnterBtn = document.querySelector('.mobile-input-bar .enter-key');
    if (mobileEnterBtn) {
      mobileEnterBtn.addEventListener('touchstart', handleHelperKey, { passive: false });
      mobileEnterBtn.addEventListener('mousedown', handleHelperKey);
    }
  }

  // Modal Control
  newSessionBtn.addEventListener('click', () => {
    closeSidebarOnMobile();
    sessionModal.classList.remove('hidden');
    newSessionNameInput.value = '';
    
    // Auto-select and lock/disable the workspace dropdown in the modal
    sessionWorkspaceSelect.value = currentWorkspacePath || '';
    const activeWs = workspacesList.find(w => w.path === currentWorkspacePath);
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

  // Create Session Form Submit
  createSessionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = newSessionNameInput.value.trim();
    if (!name) return;

    // Get selected agent
    const selectedAgentRadio = document.querySelector('input[name="sessionAgent"]:checked');
    const agent = selectedAgentRadio ? selectedAgentRadio.value : 'default';

    const workspacePath = sessionWorkspaceSelect.value;
    const activeWs = workspacesList.find(w => w.path === workspacePath);
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
        // Automatically attach to newly created session
        attachSession(name);
      } else {
        const data = await response.json();
        alert('Failed to create session: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error(err);
      alert('Network error when attempting to create session');
    }
  });

  // Reload Page Click
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }

  // Logout Click
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

  // Mobile Command Input logic
  const mobileCommandInput = document.getElementById('mobileCommandInput');
  const mobileSendBtn = document.getElementById('mobileSendBtn');
  const mobileMicBtn = document.getElementById('mobileMicBtn');

  if (mobileCommandInput && mobileSendBtn) {
    const sendMobileCommand = () => {
      const text = mobileCommandInput.value;
      if (text && currentSession) {
        // Automatically stop recording when sending
        if (stopVoiceInputGlobal) {
          stopVoiceInputGlobal();
        }

        const cached = sessionCache.get(currentSession);
        if (cached && cached.socket) {
          // Send the text followed by a carriage return (Enter key)
          cached.socket.emit('terminal-input', text + '\r');
          mobileCommandInput.value = '';
          mobileCommandInput.blur();
        }
      }
    };

    mobileSendBtn.addEventListener('click', sendMobileCommand);

    mobileCommandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendMobileCommand();
      }
    });

    // Mobile Speech Recognition (Voice Input)
    if (mobileMicBtn) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      
      if (!SpeechRecognition) {
        // Hide button if browser doesn't support Web Speech API
        mobileMicBtn.style.display = 'none';
      } else {
        const recognition = new SpeechRecognition();
        recognition.lang = 'zh-CN'; // Support Chinese/English
        recognition.interimResults = true;
        recognition.continuous = false; // Automatically stops when user stops speaking
        
        let isListening = false;
        let wantsListening = false; // User's intended state (sync toggled)
        
        recognition.onstart = () => {
          isListening = true;
          mobileMicBtn.classList.add('listening');
          mobileCommandInput.placeholder = '正在听取指令... 请说话...';
        };
        
        recognition.onend = () => {
          isListening = false;
          wantsListening = false; // Reset intended state when recording finishes/times out
          mobileMicBtn.classList.remove('listening');
          mobileCommandInput.placeholder = 'Type or dictate command...';
        };
        
        recognition.onresult = (event) => {
          const transcript = Array.from(event.results)
            .map(result => result[0])
            .map(result => result.transcript)
            .join('');
          
          mobileCommandInput.value = transcript;
        };
        
        recognition.onerror = (event) => {
          console.error('Speech recognition error:', event.error);
          isListening = false;
          wantsListening = false;
          try {
            recognition.stop();
          } catch(e) {}
        };

        const startListening = () => {
          if (!isListening) {
            try {
              recognition.start();
            } catch (err) {
              console.warn('[IM Bot] SpeechRecognition start error:', err);
            }
          }
        };

        const stopListening = () => {
          try {
            recognition.stop();
          } catch (err) {
            console.warn('[IM Bot] SpeechRecognition stop error:', err);
          }
        };

        // Expose stop function to higher scope (e.g. for autosend on Send/Enter click)
        stopVoiceInputGlobal = () => {
          if (wantsListening) {
            wantsListening = false;
            stopListening();
          }
        };

        let lastTouchTime = 0;
        const handleMicToggle = (e) => {
          e.preventDefault();
          
          // Throttling double triggers
          const now = Date.now();
          if (now - lastTouchTime < 300) return;
          if (e.type === 'touchstart') {
            lastTouchTime = now;
          }

          if (wantsListening) {
            wantsListening = false;
            stopListening();
          } else {
            wantsListening = true;
            startListening();
          }
        };

        // Bind events for both Mobile touch (fast response) and Desktop mouse click
        mobileMicBtn.addEventListener('touchstart', handleMicToggle, { passive: false });
        mobileMicBtn.addEventListener('click', handleMicToggle);
      }
    }
  }

  // Sidebar tab click listeners
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
    // Load root files if empty or placeholder is present
    if (fileTreeContainer.querySelector('.loading-placeholder') || fileTreeContainer.innerHTML.trim() === '') {
      refreshFileTree();
    }
  });

  // File explorer controls
  refreshFilesBtn.addEventListener('click', refreshFileTree);
  collapseAllBtn.addEventListener('click', () => {
    expandedFolders.clear();
    refreshFileTree();
  });
  gitDiffWorkspaceBtn.addEventListener('click', () => {
    openGitDiff('');
  });
  refreshDiffBtn.addEventListener('click', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.type === 'git-diff') {
      loadGitDiff(activeTab.path);
    }
  });
  closeDiffBtn.addEventListener('click', () => {
    if (activeTabId) {
      closeTab(activeTabId);
    }
  });

  // Editor controls
  saveFileBtn.addEventListener('click', saveEditorFile);
  closeEditorBtn.addEventListener('click', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      closeTab(activeTab.id);
    }
  });

  // Editor keyboard shortcut (Ctrl+S)
  editorTextarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveEditorFile();
    }
  });

  // Close sidebar drawer on mobile for Explorer (Handled in unified Sidebar Collapse Logic)

  // Workspace select and modal handlers
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

  explorerWorkspaceSelect.addEventListener('change', () => {
    currentWorkspacePath = explorerWorkspaceSelect.value;
    localStorage.setItem('lastWorkspacePath', currentWorkspacePath);
    updateDeleteWorkspaceBtnState();
    refreshFileTree();
    renderSessions(sessionListCache);
  });

  explorerDeleteWorkspaceBtn.addEventListener('click', async () => {
    if (!currentWorkspacePath) {
      alert('Default workspace cannot be deleted.');
      return;
    }
    const ws = workspacesList.find(w => w.path === currentWorkspacePath);
    if (!ws) {
      alert('Selected workspace configuration not found.');
      return;
    }
    
    const confirmDelete = confirm(`Are you sure you want to remove workspace "${ws.name}"?\n\nNOTE: This action only removes the workspace configuration from the dashboard list. It will NOT delete the actual directory or any files on your disk.`);
    if (!confirmDelete) return;

    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(ws.name)}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        currentWorkspacePath = ''; // Reset to default workspace
        localStorage.setItem('lastWorkspacePath', '');
        await loadWorkspaces();
        refreshFileTree();
        loadSessions(); // Reload sessions to filter on default workspace
      } else {
        const data = await response.json();
        alert('Failed to delete workspace: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error(err);
      alert('Network error when attempting to delete workspace.');
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
        currentWorkspacePath = wsPath;
        localStorage.setItem('lastWorkspacePath', currentWorkspacePath);
        await loadWorkspaces();
        refreshFileTree();
        renderSessions(sessionListCache);
      } else {
        const data = await response.json();
        alert('Failed to create workspace: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error(err);
      alert('Network error when attempting to create workspace');
    }
  });

  // Directory picker click handlers
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
    if (activeTargetInput && pickerCurrentPath) {
      activeTargetInput.value = pickerCurrentPath;
    }
    closeDirPicker();
  });

  // Global page visibility handler - resume connections when returning from background
  if (!visibilityListenerAdded) {
    visibilityListenerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('Page became visible - checking connections...');
        // Check all active sessions and reconnect if needed
        sessionCache.forEach((cached, name) => {
          if (cached.socket && !cached.socket.connected) {
            console.log(`Reconnecting session: ${name}`);
            // Force reconnect
            cached.socket.connect();
          }
        });
      }
    });
  }

  // --- PWA Web Push Notifications ---
  const pushToggleBtn = document.getElementById('pushToggleBtn');
  let isSubscribed = false;
  let swRegistration = null;

  // Convert Base64 URL-safe to Uint8Array for VAPID key subscription
  function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('Push messaging is not supported in this browser.');
      if (pushToggleBtn) {
        pushToggleBtn.style.display = 'none';
      }
      return;
    }

    try {
      // Register service worker
      swRegistration = await navigator.serviceWorker.register('/sw.js');
      console.log('Service Worker registered successfully:', swRegistration);

      // Check current subscription status
      const subscription = await swRegistration.pushManager.getSubscription();
      isSubscribed = !(subscription === null);
      updatePushBtnUI();

      if (isSubscribed) {
        // Sync subscription with server in case it changed/missing
        await registerSubscriptionOnServer(subscription);
      }
    } catch (err) {
      console.error('Service Worker registration failed:', err);
    }
  }

  function updatePushBtnUI() {
    if (!pushToggleBtn) return;
    const textSpan = pushToggleBtn.querySelector('span');
    const icon = pushToggleBtn.querySelector('i');
    if (isSubscribed) {
      if (textSpan) textSpan.textContent = 'PUSH: ON';
      if (icon) {
        icon.setAttribute('data-lucide', 'bell');
      }
      pushToggleBtn.classList.add('active');
    } else {
      if (textSpan) textSpan.textContent = 'PUSH: OFF';
      if (icon) {
        icon.setAttribute('data-lucide', 'bell');
      }
      pushToggleBtn.classList.remove('active');
    }
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  async function registerSubscriptionOnServer(subscription) {
    try {
      await fetch('/api/push/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });
    } catch (err) {
      console.error('Failed to register subscription on server:', err);
    }
  }

  async function unregisterSubscriptionOnServer(subscription) {
    try {
      await fetch('/api/push/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });
    } catch (err) {
      console.error('Failed to unregister subscription on server:', err);
    }
  }

  async function togglePushSubscription() {
    if (!swRegistration) return;
    
    if (isSubscribed) {
      // Unsubscribe
      try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
          await subscription.unsubscribe();
          await unregisterSubscriptionOnServer(subscription);
        }
        isSubscribed = false;
        updatePushBtnUI();
      } catch (err) {
        console.error('Error unsubscribing:', err);
      }
    } else {
      // Request permission and subscribe
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          alert('Notification permission denied.');
          return;
        }

        // Get VAPID public key from server
        const keyRes = await fetch('/api/push/key');
        const keyData = await keyRes.json();
        const applicationServerKey = urlB64ToUint8Array(keyData.publicKey);

        const subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey
        });

        await registerSubscriptionOnServer(subscription);
        isSubscribed = true;
        updatePushBtnUI();
      } catch (err) {
        console.error('Failed to subscribe the user:', err);
        alert('Failed to subscribe: ' + err.message);
      }
    }
  }

  if (pushToggleBtn) {
    pushToggleBtn.addEventListener('click', togglePushSubscription);
  }

  // Handle messages from service worker (e.g. navigation / attaching session)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.action === 'attach-session') {
        const sessionName = event.data.session;
        console.log('[App] Service worker requested attaching to session:', sessionName);
        // Find existing tab or click on it in sidebar to switch
        const tabEl = document.querySelector(`.sidebar-item[data-session="${sessionName}"]`);
        if (tabEl) {
          tabEl.click();
        }
      }
    });
  }

  // --- Client focus tracking to prevent push notifications while looking at the terminal ---
  function reportFocusStatus() {
    const isTabFocused = document.hasFocus() && document.visibilityState === 'visible';
    sessionCache.forEach((cached, name) => {
      if (cached.socket && cached.socket.connected) {
        cached.socket.emit('client-focus', {
          focused: isTabFocused,
          activeSession: currentSession
        });
      }
    });
  }

  window.addEventListener('focus', reportFocusStatus);
  window.addEventListener('blur', reportFocusStatus);
  document.addEventListener('visibilitychange', reportFocusStatus);

  // Welcome Panel Interactive 3D Parallax Effect (for PC only)
  const welcomeGrid3D = document.getElementById('welcomeGrid3D');
  if (welcomePanel && welcomeGrid3D) {
    welcomePanel.addEventListener('mousemove', (e) => {
      if (window.innerWidth <= 768) return; // Skip on mobile/tablet screen sizes
      
      const rect = welcomePanel.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      // Calculate tilts (Max +/- 5 degrees on X, Max +/- 6 degrees on Y)
      const tiltX = ((y - centerY) / centerY) * -5;
      const tiltY = ((x - centerX) / centerX) * 6;
      
      // Apply transform relative to the base 3D rotateX(30deg)
      welcomeGrid3D.style.transform = `rotateX(${30 + tiltX}deg) rotateY(${tiltY}deg) translate3d(0, 0, 0)`;
    });
    
    welcomePanel.addEventListener('mouseleave', () => {
      if (window.innerWidth <= 768) return;
      // Reset back to original 30deg rotateX and 0deg rotateY
      welcomeGrid3D.style.transform = 'rotateX(30deg) rotateY(0deg) translate3d(0, 0, 0)';
    });
  }

  // Helper to convert a native select into a styled custom dropdown
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

  // Convert the selects to styled custom dropdowns
  convertSelectToCustom(explorerWorkspaceSelect);
  convertSelectToCustom(sessionWorkspaceSelect);

  // Initial Load
  loadWorkspaces().then(() => {
    loadSessions();
    // Poll sessions state every 5 seconds to keep attached/detached states in sync
    setInterval(loadSessions, 5000);
    // Init push notifications on load
    initPushNotifications();
  });
});
