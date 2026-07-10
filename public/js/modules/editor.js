import { state } from './state.js';
import { updateGitStatus, applyGitTreeClasses } from './explorer.js';

export function getLanguageFromExtension(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': return 'typescript';
    case 'json': return 'json';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'md': case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'sh': case 'bash': return 'shell';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'yml': case 'yaml': return 'yaml';
    case 'xml': return 'xml';
    default: return 'plaintext';
  }
}

let editorLoadingPath = null;
export async function loadEditorFile(path) {
  if (editorLoadingPath === path) return;
  editorLoadingPath = path;
  
  const editorStatusMsg = document.getElementById('editorStatusMsg');
  const editorTextarea = document.getElementById('editorTextarea');

  if (state.editorInstance) {
    state.editorInstance.setValue('');
    state.editorInstance.updateOptions({ readOnly: true });
  } else {
    editorTextarea.textContent = '';
  }
  state.editorDisabled = true;
  editorStatusMsg.textContent = 'LOADING...';
  
  try {
    const response = await fetch(`/api/files/content?path=${encodeURIComponent(path)}&workspacePath=${encodeURIComponent(state.currentWorkspacePath)}`);
    if (response.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const data = await response.json();
    if (response.ok) {
      if (state.editorInstance) {
        state.editorInstance.setValue(data.content);
        state.editorInstance.updateOptions({ readOnly: false });
        const model = state.editorInstance.getModel();
        if (model) {
          const lang = getLanguageFromExtension(path);
          monaco.editor.setModelLanguage(model, lang);
        }
        state.editorInstance.focus();
      } else {
        editorTextarea.textContent = data.content;
      }
      state.editorDisabled = false;
      editorStatusMsg.textContent = '';
    } else {
      editorStatusMsg.textContent = 'LOAD ERROR';
      const msg = `Error loading file: ${data.error || 'Unknown error'}`;
      if (state.editorInstance) {
        state.editorInstance.setValue(msg);
      } else {
        editorTextarea.textContent = msg;
      }
    }
  } catch (err) {
    console.error(err);
    editorStatusMsg.textContent = 'NET ERROR';
    const msg = 'Network error while retrieving file content.';
    if (state.editorInstance) {
      state.editorInstance.setValue(msg);
    } else {
      editorTextarea.textContent = msg;
    }
  } finally {
    editorLoadingPath = null;
  }
}

export async function saveEditorFile() {
  const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.type === 'editor');
  if (!activeTab || state.editorDisabled) return;

  const path = activeTab.path;
  const editorTextarea = document.getElementById('editorTextarea');
  const content = state.editorInstance ? state.editorInstance.getValue() : editorTextarea.textContent;
  const editorStatusMsg = document.getElementById('editorStatusMsg');
  editorStatusMsg.textContent = 'SAVING...';
  
  try {
    const response = await fetch('/api/files/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ workspacePath: state.currentWorkspacePath, filePath: path, content })
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
