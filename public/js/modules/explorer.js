import { state } from './state.js';
import { activateTab } from './tabs.js';

export async function loadDirPickerPath(dirPath) {
  const dirPickerList = document.getElementById('dirPickerList');
  const dirPickerCurrentPath = document.getElementById('dirPickerCurrentPath');

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

    state.pickerCurrentPath = data.currentPath;
    dirPickerCurrentPath.value = data.currentPath;

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

    if (window.lucide) {
      window.lucide.createIcons();
    }
  } catch (err) {
    console.error(err);
    dirPickerList.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 4px; font-size:11px;">NET ERROR</div>`;
  }
}

export function openDirectoryPicker(targetInput) {
  state.activeTargetInput = targetInput;
  const initialPath = targetInput.value.trim();
  const dirPickerModal = document.getElementById('dirPickerModal');
  dirPickerModal.classList.remove('hidden');
  loadDirPickerPath(initialPath);
}

export const getWorkspacePrefix = () => {
  if (!state.currentWorkspacePath) return '';
  const ws = state.workspacesList.find(w => w.path === state.currentWorkspacePath);
  return ws ? `[${ws.name}] ` : '';
};

export async function updateGitStatus() {
  state.gitStatusMap.clear();
  state.gitDirStatusMap.clear();
  try {
    const response = await fetch(`/api/git/status?workspacePath=${encodeURIComponent(state.currentWorkspacePath)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.isGit && data.files) {
        data.files.forEach(file => {
          let cleanPath = file.path;
          if (cleanPath.endsWith('/')) {
            cleanPath = cleanPath.slice(0, -1);
          }
          state.gitStatusMap.set(cleanPath, file);
          
          const parts = cleanPath.split('/');
          let currentParent = '';
          for (let i = 0; i < parts.length - 1; i++) {
            currentParent = currentParent ? `${currentParent}/${parts[i]}` : parts[i];
            if (!state.gitDirStatusMap.has(currentParent)) {
              state.gitDirStatusMap.set(currentParent, new Set());
            }
            const statusChar = file.status.includes('M') ? 'M' : (file.status.includes('A') ? 'A' : (file.status.includes('!') ? 'I' : 'U'));
            state.gitDirStatusMap.get(currentParent).add(statusChar);
          }
        });
      }
    }
  } catch (err) {
    console.error('Error fetching git status:', err);
  }
}

export function applyGitTreeClasses() {
  document.querySelectorAll('.file-node').forEach(nodeEl => {
    const filePath = nodeEl.getAttribute('data-path');
    const rowEl = nodeEl.querySelector('.file-node-row');
    if (!rowEl) return;
    
    rowEl.classList.remove('git-modified', 'git-added', 'git-untracked', 'git-ignored');
    const existingBadge = rowEl.querySelector('.git-status-badge');
    if (existingBadge) existingBadge.remove();
    const existingDiffBtn = rowEl.querySelector('.git-diff-inline-btn');
    if (existingDiffBtn) existingDiffBtn.remove();
    
    if (state.gitStatusMap.has(filePath)) {
      const fileStatus = state.gitStatusMap.get(filePath);
      const status = fileStatus.status;
      
      let badgeText = '';
      let badgeClass = '';
      
      if (status === '!!') {
        rowEl.classList.add('git-ignored');
      } else if (status.includes('M')) {
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
        badgeClass = 'untracked';
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
    } else if (state.gitDirStatusMap.has(filePath)) {
      const dirStatuses = state.gitDirStatusMap.get(filePath);
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
        badgeClass = 'untracked';
      } else if (dirStatuses.has('I')) {
        rowEl.classList.add('git-ignored');
      }
      
      if (badgeText) {
        const badgeEl = document.createElement('span');
        badgeEl.className = `git-status-badge ${badgeClass}`;
        badgeEl.textContent = badgeText;
        rowEl.appendChild(badgeEl);
      }
    }
  });
  
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('open');
    if (sidebarOverlay) sidebarOverlay.classList.add('hidden');
  }
}

export function openFile(path) {
  const filename = path.split('/').pop();
  let tab = state.tabs.find(t => t.type === 'editor' && t.path === path);
  if (!tab) {
    tab = {
      id: 'editor-' + path,
      name: filename,
      type: 'editor',
      path: path
    };
    state.tabs.push(tab);
  }
  activateTab(tab.id);
  closeSidebarOnMobile();
}

export function openGitDiff(filePath = '') {
  const tabId = filePath ? `git-diff-${filePath}` : 'git-diff-all';
  const tabName = filePath ? `Diff: ${filePath.split('/').pop()}` : 'Workspace Diff';
  
  let tab = state.tabs.find(t => t.id === tabId);
  if (!tab) {
    tab = {
      id: tabId,
      name: tabName,
      type: 'git-diff',
      path: filePath
    };
    state.tabs.push(tab);
  }
  activateTab(tab.id);
  closeSidebarOnMobile();
}

export async function loadDirectory(dirPath, containerEl) {
  containerEl.innerHTML = `
    <div class="loading-placeholder" style="padding: 4px 8px;">
      <div class="cyber-spinner" style="width: 14px; height: 14px; border-width: 1px;"></div>
      <span style="font-size: 11px;">SCANNING...</span>
    </div>
  `;

  try {
    const response = await fetch(`/api/files/list?path=${encodeURIComponent(dirPath)}&workspacePath=${encodeURIComponent(state.currentWorkspacePath)}`);
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

    let filteredFiles = files;
    if (state.showOnlyGitChanges) {
      filteredFiles = files.filter(file => {
        if (file.isDir) {
          const statuses = state.gitDirStatusMap.get(file.path);
          if (!statuses) return false;
          return Array.from(statuses).some(s => s !== 'I');
        } else {
          const fileStatus = state.gitStatusMap.get(file.path);
          if (!fileStatus) return false;
          return fileStatus.status !== '!!';
        }
      });
    }

    if (filteredFiles.length === 0) {
      containerEl.innerHTML = '<div class="empty-text" style="color: var(--text-muted); padding: 4px 8px; font-style: italic; font-size:11px;">(empty)</div>';
      return;
    }

    filteredFiles.forEach(file => {
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

      if (file.isDir && state.showOnlyGitChanges) {
        state.expandedFolders.add(file.path);
      }
      const isExpanded = state.expandedFolders.has(file.path);
      const folderIcon = isExpanded ? 'folder-open' : 'folder';
      const iconName = file.isDir ? folderIcon : 'file';
      const iconClass = file.isDir ? 'dir-icon' : 'file-icon';

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

        if (isExpanded) {
          loadDirectory(file.path, childrenEl);
        }
      }

      rowEl.addEventListener('click', (e) => {
        e.stopPropagation();
        
        const diffBtn = e.target.closest('.git-diff-inline-btn');
        if (diffBtn) {
          const filePath = diffBtn.getAttribute('data-path');
          openGitDiff(filePath);
          return;
        }

        if (file.isDir) {
          toggleFolder(file.path, childrenEl, rowEl.querySelector('.file-node-icon i'));
        } else {
          document.querySelectorAll('.file-node-row').forEach(r => r.classList.remove('active'));
          rowEl.classList.add('active');
          openFile(file.path);
        }
      });

      containerEl.appendChild(nodeEl);
    });

    applyGitTreeClasses();
    if (window.lucide) {
      window.lucide.createIcons();
    }
  } catch (err) {
    console.error(err);
    containerEl.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 4px; font-size:11px;">NET ERROR</div>`;
  }
}

export function toggleFolder(path, childrenEl, iconEl) {
  if (state.expandedFolders.has(path)) {
    state.expandedFolders.delete(path);
    childrenEl.style.display = 'none';
    childrenEl.innerHTML = '';
    if (iconEl) {
      iconEl.setAttribute('data-lucide', 'folder');
      if (window.lucide) window.lucide.createIcons();
    }
  } else {
    state.expandedFolders.add(path);
    childrenEl.style.display = 'flex';
    loadDirectory(path, childrenEl);
    if (iconEl) {
      iconEl.setAttribute('data-lucide', 'folder-open');
      if (window.lucide) window.lucide.createIcons();
    }
  }
}

export async function refreshFileTree() {
  state.expandedFolders.clear();
  await updateGitStatus();
  const fileTreeContainer = document.getElementById('fileTreeContainer');
  const currentPathLabel = document.getElementById('currentPathLabel');
  loadDirectory('', fileTreeContainer);
  if (currentPathLabel) {
    currentPathLabel.textContent = getWorkspacePrefix() + '/';
  }
}
