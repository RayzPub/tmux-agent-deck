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
  editorStatusMsg.textContent = '加载中...';
  
  try {
    const response = await fetch(`/api/files/content?path=${encodeURIComponent(path)}&workspacePath=${encodeURIComponent(state.currentWorkspacePath)}`);
    if (response.status === 401) {
      window.location.href = '/login';
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
      updatePreviewUI(path);
    } else {
      editorStatusMsg.textContent = '加载失败';
      const msg = `读取文件失败: ${data.error || '未知错误'}`;
      if (state.editorInstance) {
        state.editorInstance.setValue(msg);
      } else {
        editorTextarea.textContent = msg;
      }
      updatePreviewUI(null);
    }
  } catch (err) {
    console.error(err);
    editorStatusMsg.textContent = '网络错误';
    const msg = '获取文件内容时发生网络错误。';
    if (state.editorInstance) {
      state.editorInstance.setValue(msg);
    } else {
      editorTextarea.textContent = msg;
    }
    updatePreviewUI(null);
  } finally {
    editorLoadingPath = null;
  }
}

export function updateMarkdownPreview() {
  const markdownPreview = document.getElementById('markdownPreview');
  if (!markdownPreview || markdownPreview.classList.contains('hidden')) return;
  const content = state.editorInstance ? state.editorInstance.getValue() : '';
  
  // Safeguard: Resolve marked if registered as AMD module
  if (!window.marked && typeof require !== 'undefined') {
    try {
      window.marked = require('marked');
    } catch (e) {
      console.warn('Could not require marked module via AMD:', e);
    }
  }
  
  const theme = document.body.classList.contains('light-minimalist') ? 'vs' : 'cyberTheme';
  markdownPreview.classList.remove('vs', 'cyberTheme', 'vs-dark');
  markdownPreview.classList.add(theme);

  if (window.marked) {
    markdownPreview.style.whiteSpace = 'normal';
    const options = { breaks: true, gfm: true };
    let renderedHtml = '';
    if (window.marked.parse) {
      renderedHtml = window.marked.parse(content, options);
    } else {
      renderedHtml = window.marked(content, options);
    }
    markdownPreview.innerHTML = renderedHtml;

    // 1. Syntax highlight code blocks using monaco colorizer if available
    if (window.monaco && monaco.editor && monaco.editor.colorize) {
      const codeElements = markdownPreview.querySelectorAll('pre code');
      codeElements.forEach(codeEl => {
        let lang = 'plaintext';
        const classes = codeEl.className.split(' ');
        for (const cls of classes) {
          if (cls.startsWith('language-')) {
            lang = cls.replace('language-', '');
            break;
          }
        }
        
        const codeText = codeEl.textContent;
        monaco.editor.colorize(codeText, lang, { tabSize: 2, theme: theme }).then(html => {
          codeEl.innerHTML = html;
          codeEl.classList.add('monaco-colored');
        });
      });
    }

    // 2. Add copy buttons to pre blocks
    const preElements = markdownPreview.querySelectorAll('pre');
    preElements.forEach(preEl => {
      if (preEl.parentElement.classList.contains('code-block-wrapper')) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      preEl.parentNode.insertBefore(wrapper, preEl);
      wrapper.appendChild(preEl);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-code-btn';
      copyBtn.innerHTML = '<i data-lucide="copy"></i>';
      copyBtn.title = '复制代码';
      wrapper.appendChild(copyBtn);

      copyBtn.addEventListener('click', () => {
        const codeEl = preEl.querySelector('code');
        const text = codeEl ? codeEl.textContent : preEl.textContent;
        
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.innerHTML = '<i data-lucide="check" style="color: var(--neon-green) !important;"></i>';
          if (window.lucide) window.lucide.createIcons();
          setTimeout(() => {
            copyBtn.innerHTML = '<i data-lucide="copy"></i>';
            if (window.lucide) window.lucide.createIcons();
          }, 2000);
        }).catch(err => {
          console.error('Failed to copy: ', err);
        });
      });
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  } else {
    markdownPreview.style.whiteSpace = 'pre-wrap';
    markdownPreview.textContent = content;
  }
}

// Build the iframe URL for previewing an HTML file. The URL path mirrors the
// on-disk relative path so relative references (images, CSS, JS) resolve.
export function buildHtmlPreviewUrl(relPath, cacheBust) {
  const ws = state.currentWorkspacePath || '';
  const token = ws
    ? btoa(unescape(encodeURIComponent(ws))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : '~';
  const encodedPath = relPath.split('/').map(encodeURIComponent).join('/');
  return `/api/preview/${token}/${encodedPath}${cacheBust ? `?t=${Date.now()}` : ''}`;
}

export function updateHtmlPreview(path, cacheBust) {
  const htmlPreviewFrame = document.getElementById('htmlPreviewFrame');
  if (!htmlPreviewFrame || htmlPreviewFrame.classList.contains('hidden')) return;
  if (!path) return;
  htmlPreviewFrame.src = buildHtmlPreviewUrl(path, cacheBust);
}

export function updatePreviewUI(path) {
  const previewSplitBtnGroup = document.getElementById('previewSplitBtnGroup');
  const previewDropdownTrigger = document.getElementById('previewDropdownTrigger');
  const previewDropdownMenu = document.getElementById('previewDropdownMenu');
  const togglePreviewBtn = document.getElementById('togglePreviewBtn');
  const markdownPreview = document.getElementById('markdownPreview');
  const htmlPreviewFrame = document.getElementById('htmlPreviewFrame');
  const editorTextarea = document.getElementById('editorTextarea');
  const saveFileBtn = document.getElementById('saveFileBtn');
  if (!previewSplitBtnGroup) return;

  const lang = path ? getLanguageFromExtension(path) : null;
  const isMd = lang === 'markdown';
  const isHtml = lang === 'html';

  // Hide the dropdown menu when resetting the UI
  if (previewDropdownMenu) {
    previewDropdownMenu.classList.add('hidden');
  }

  if (!isMd && !isHtml) {
    previewSplitBtnGroup.classList.add('hidden');
    if (markdownPreview) markdownPreview.classList.add('hidden');
    if (htmlPreviewFrame) htmlPreviewFrame.classList.add('hidden');
    if (editorTextarea) {
      editorTextarea.classList.remove('hidden');
    }
    if (saveFileBtn) {
      saveFileBtn.classList.remove('hidden');
    }
  } else {
    previewSplitBtnGroup.classList.remove('hidden');
    
    // Toggle single-btn layout vs split-btn layout
    if (previewDropdownTrigger) {
      previewDropdownTrigger.classList.toggle('hidden', !isHtml);
    }
    previewSplitBtnGroup.classList.toggle('single-btn', !isHtml);

    // Toggle icon and text dynamically
    const iconEl = togglePreviewBtn.querySelector('i, svg');
    const textEl = togglePreviewBtn.querySelector('span');
    if (iconEl) {
      const newIcon = document.createElement('i');
      newIcon.setAttribute('data-lucide', state.previewActive ? 'code' : 'eye');
      iconEl.parentNode.replaceChild(newIcon, iconEl);
    }
    if (textEl) {
      textEl.textContent = state.previewActive ? '编辑器' : '预览';
    }
    if (window.lucide) {
      window.lucide.createIcons();
    }

    if (state.previewActive) {
      togglePreviewBtn.classList.add('active');
      if (markdownPreview) {
        markdownPreview.classList.toggle('hidden', !isMd);
      }
      if (isMd) {
        updateMarkdownPreview();
      }
      if (htmlPreviewFrame) {
        htmlPreviewFrame.classList.toggle('hidden', !isHtml);
      }
      if (isHtml) {
        updateHtmlPreview(path);
      }
      if (editorTextarea) {
        editorTextarea.classList.add('hidden');
      }
      if (saveFileBtn) {
        saveFileBtn.classList.add('hidden');
      }
    } else {
      togglePreviewBtn.classList.remove('active');
      if (markdownPreview) markdownPreview.classList.add('hidden');
      if (htmlPreviewFrame) htmlPreviewFrame.classList.add('hidden');
      if (editorTextarea) {
        editorTextarea.classList.remove('hidden');
      }
      if (saveFileBtn) {
        saveFileBtn.classList.remove('hidden');
      }
    }
  }

  if (state.editorInstance) {
    setTimeout(() => {
      state.editorInstance.layout();
    }, 50);
  }
}

export async function saveEditorFile() {
  const activeTab = state.tabs.find(t => t.id === state.activeTabId && t.type === 'editor');
  if (!activeTab || state.editorDisabled) return;

  const path = activeTab.path;
  const editorTextarea = document.getElementById('editorTextarea');
  const content = state.editorInstance ? state.editorInstance.getValue() : editorTextarea.textContent;
  const editorStatusMsg = document.getElementById('editorStatusMsg');
  editorStatusMsg.textContent = '保存中...';
  
  try {
    const response = await fetch('/api/files/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ workspacePath: state.currentWorkspacePath, filePath: path, content })
    });

    if (response.status === 401) {
      window.location.href = '/login';
      return;
    }

    const data = await response.json();
    if (response.ok && data.success) {
      editorStatusMsg.textContent = '已保存';
      // Refresh the HTML preview iframe so it reflects the saved content
      if (state.previewActive && getLanguageFromExtension(path) === 'html') {
        updateHtmlPreview(path, true);
      }
      updateGitStatus().then(() => {
        applyGitTreeClasses();
      });
      setTimeout(() => {
        if (editorStatusMsg.textContent === '已保存') {
          editorStatusMsg.textContent = '';
        }
      }, 2000);
    } else {
      editorStatusMsg.textContent = '保存失败';
      alert('保存文件失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    console.error(err);
    editorStatusMsg.textContent = '网络错误';
    alert('保存文件时发生网络错误。');
  }
}
