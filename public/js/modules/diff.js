import { state } from './state.js';

let diffLoadingPath = null;
export async function loadGitDiff(path = '') {
  diffLoadingPath = path;
  const container = document.getElementById('diffContentContainer');
  const diffStatusMsg = document.getElementById('diffStatusMsg');
  
  container.innerHTML = `
    <div class="loading-placeholder">
      <div class="cyber-spinner"></div>
      <span>正在生成差异对比 (Diff)...</span>
    </div>
  `;
  diffStatusMsg.textContent = '加载中...';
  
  try {
    const url = `/api/git/diff?workspacePath=${encodeURIComponent(state.currentWorkspacePath)}&path=${encodeURIComponent(path)}`;
    const response = await fetch(url);
    
    if (response.status === 401) {
      window.location.href = '/login';
      return;
    }
    
    const data = await response.json();
    if (diffLoadingPath !== path) return;
    
    if (response.ok) {
      diffStatusMsg.textContent = '';
      parseAndRenderDiff(data.diff);
    } else {
      diffStatusMsg.textContent = '错误';
      container.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 20px; text-align: center;">错误: ${data.error || '获取差异对比失败'}</div>`;
    }
  } catch (err) {
    console.error(err);
    diffStatusMsg.textContent = '网络错误';
    container.innerHTML = `<div class="error-text" style="color: var(--neon-pink); padding: 20px; text-align: center;">网络错误</div>`;
  }
}

export function parseAndRenderDiff(diffText) {
  const container = document.getElementById('diffContentContainer');
  if (!diffText || !diffText.trim()) {
    container.innerHTML = '<div class="diff-empty">当前文件/工作区没有未提交的更改。</div>';
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
