/**
 * Terminal Dispatcher Module (发送到终端)
 * Unifies all interactive task execution into a single, clean "Send to Terminal" workflow.
 * Reuses standard tab terminal sessions:
 * 1. Target session selection (AGY, Claude, Codex, Kimi, Terminal, or new session).
 * 2. Pre-fill / edit multiline prompt with Ctrl+Enter shortcut.
 * 3. Clear context option (/clear for Claude/AGY, /new for Codex).
 * 4. Dispatches directly and switches to the target terminal tab.
 */

import { state } from './state.js';
import { attachSession, writeToClipboard } from './terminal.js';
import { updateProjectTabStatus } from './tabs.js';

/**
 * Open the unified "发送到终端" modal
 */
export function openDispatchModal(options = {}) {
  const {
    workspaceIdentifier,
    sessions = [],
    tasks = [],
    defaultPrompt = '',
    title = '发送任务到终端工位',
    subtitle = '选择目标工位，微调指令后直接派发执行并切换到终端',
    mode = 'custom', // 'decompose' | 'refine' | 'dispatch' | 'free'
    selectedTask = null,
    defaultClearHistory = false,
    onSuccess = null
  } = options;

  let overlay = document.getElementById('promptStagingModalOverlay');
  if (overlay) overlay.remove();

  // Find best default session:
  // 1. If currently attached session exists in list, or
  // 2. An AGY / Antigravity session, or
  // 3. First idle session, or
  // 4. First session in list
  let recommendedSession = '';
  if (sessions && sessions.length > 0) {
    const agySession = sessions.find(s => {
      const t = (s.agentType || '').toLowerCase();
      const n = (s.name || '').toLowerCase();
      return t === 'agy' || t === 'antigravity' || n.includes('agy') || n.includes('antigravity');
    });
    if (agySession) {
      recommendedSession = agySession.name;
    } else {
      const idleSession = sessions.find(s => s.status !== 'busy');
      recommendedSession = idleSession ? idleSession.name : sessions[0].name;
    }
  }

  overlay = document.createElement('div');
  overlay.id = 'promptStagingModalOverlay';
  overlay.className = 'prompt-staging-modal-overlay';
  overlay.innerHTML = `
    <div class="prompt-staging-card" role="dialog" aria-modal="true">
      <div class="prompt-staging-header">
        <div class="prompt-staging-title-group">
          <div class="prompt-staging-title">
            <i data-lucide="send" style="width: 16px; height: 16px; color: var(--neon-cyan, #00f0ff);"></i>
            <span>${escapeHtml(title)}</span>
          </div>
          <div class="prompt-staging-subtitle">${escapeHtml(subtitle)}</div>
        </div>
        <button class="prompt-staging-close-btn" id="stagingModalCloseBtn" title="关闭 (Esc)">
          <i data-lucide="x" style="width: 16px; height: 16px;"></i>
        </button>
      </div>

      <div class="prompt-staging-body">
        <!-- Target Session Selector -->
        <div class="staging-field-group">
          <label class="staging-label" for="stagingTargetSessionSelect">
            <i data-lucide="terminal" style="width: 13px; height: 13px;"></i>
            <span>目标协同工位</span>
          </label>
          <div class="staging-select-wrapper">
            <select id="stagingTargetSessionSelect" class="staging-session-select">
              ${sessions.map(s => {
                const isSelected = s.name === recommendedSession;
                const status = s.status || 'idle';
                const statusIcon = status === 'busy' ? '⚡ 执行中' : (status === 'waiting' ? '🟡 等待确认' : '🟢 空闲就绪');
                const brand = (s.agentType || 'Terminal').toUpperCase();
                return `<option value="${escapeHtml(s.name)}" data-agent-type="${escapeHtml(s.agentType || '')}" data-status="${status}" ${isSelected ? 'selected' : ''}>
                  ${escapeHtml(s.name)} [${brand} · ${statusIcon}]
                </option>`;
              }).join('')}
              <option value="__new__">➕ 启动新建会话...</option>
            </select>
          </div>
          <div class="staging-session-hint" id="stagingSessionHint">
            💡 支持任意智能体或普通终端，派发后自动平滑跳转。
          </div>
        </div>

        <!-- Prompt Content Editor -->
        <div class="staging-field-group">
          <div class="staging-label-row">
            <label class="staging-label" for="stagingModalPromptText">
              <i data-lucide="edit-3" style="width: 13px; height: 13px;"></i>
              <span>执行指令内容 (支持自由编辑、复制)</span>
            </label>
            ${defaultPrompt ? `
              <button id="stagingModalResetBtn" class="staging-text-btn" title="恢复预设模板">
                <i data-lucide="rotate-ccw" style="width: 11px; height: 11px;"></i>
                <span>重置模板</span>
              </button>
            ` : ''}
          </div>
          <textarea id="stagingModalPromptText" class="staging-modal-textarea" rows="7" placeholder="在此输入要发送给智能体终端的具体任务指令（支持换行与鼠标多选）...">${escapeHtml(defaultPrompt)}</textarea>
        </div>

        <!-- Options: Clear Context & Clear Stale Tasks -->
        <div class="staging-options-row">
          <label class="staging-checkbox-label" title="开启后派发前将主动清理会话历史（Claude/AGY 执行 /clear，Codex 执行 /new）">
            <input type="checkbox" id="stagingModalClearCheck" ${defaultClearHistory ? 'checked' : ''}>
            <span class="staging-checkbox-custom"></span>
            <span class="staging-checkbox-text">派发前清理上下文</span>
            <span class="staging-clean-hint" id="stagingModalCleanCmdHint">(执行 /clear)</span>
          </label>
          ${(mode === 'decompose' && tasks && tasks.length > 0) ? `
            <label class="staging-checkbox-label" title="开启后派发前将自动清空大盘现有的旧任务，避免与新目标拆解出的任务混淆">
              <input type="checkbox" id="stagingModalClearTasksCheck" checked>
              <span class="staging-checkbox-custom"></span>
              <span class="staging-checkbox-text">派发前清空大盘旧任务 (${tasks.length} 项)</span>
            </label>
          ` : ''}
        </div>

        <!-- Feedback & Status Bar -->
        <div class="staging-feedback-bar ready" id="stagingModalFeedbackBar">
          <i data-lucide="info" style="width: 13px; height: 13px; flex-shrink: 0;"></i>
          <span id="stagingModalFeedbackText">准备就绪：点击「发送到终端」或按 Ctrl+Enter 立即派发并切换到工位。</span>
        </div>
      </div>

      <div class="prompt-staging-footer">
        <div class="staging-footer-left">
          <button id="stagingModalCopyBtn" class="staging-footer-btn outline" title="复制指令到剪贴板">
            <i data-lucide="copy" style="width: 13px; height: 13px;"></i>
            <span>复制指令</span>
          </button>
        </div>
        <div class="staging-footer-right">
          <button id="stagingModalCancelBtn" class="staging-footer-btn outline" title="取消">
            <span>取消</span>
          </button>
          <button id="stagingModalDispatchBtn" class="staging-footer-btn primary" title="立即发送指令并前往工位 (Ctrl+Enter)">
            <i data-lucide="send" style="width: 13px; height: 13px;"></i>
            <span class="btn-text">发送到终端</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  if (window.lucide) {
    window.lucide.createIcons();
  }

  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      close();
    }
  };
  window.addEventListener('keydown', handleEsc);

  const close = () => {
    window.removeEventListener('keydown', handleEsc);
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 200);
  };

  const closeBtn = overlay.querySelector('#stagingModalCloseBtn');
  const cancelBtn = overlay.querySelector('#stagingModalCancelBtn');
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancelBtn) cancelBtn.addEventListener('click', close);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const sessionSelect = overlay.querySelector('#stagingTargetSessionSelect');
  const promptTextarea = overlay.querySelector('#stagingModalPromptText');
  const resetBtn = overlay.querySelector('#stagingModalResetBtn');
  const copyBtn = overlay.querySelector('#stagingModalCopyBtn');
  const dispatchBtn = overlay.querySelector('#stagingModalDispatchBtn');
  const clearCheck = overlay.querySelector('#stagingModalClearCheck');
  const cleanHint = overlay.querySelector('#stagingModalCleanCmdHint');
  const feedbackBar = overlay.querySelector('#stagingModalFeedbackBar');
  const feedbackText = overlay.querySelector('#stagingModalFeedbackText');
  const sessionHint = overlay.querySelector('#stagingSessionHint');

  // Update clear command hint based on selected agent
  const updateCleanHint = () => {
    if (!cleanHint || !sessionSelect) return;
    const opt = sessionSelect.options[sessionSelect.selectedIndex];
    const agentType = opt ? (opt.getAttribute('data-agent-type') || '').toLowerCase() : '';
    if (agentType === 'codex') {
      cleanHint.textContent = '(执行 /new)';
    } else if (agentType === 'claude' || agentType === 'agy' || agentType === 'antigravity') {
      cleanHint.textContent = '(执行 /clear)';
    } else {
      cleanHint.textContent = '(执行 clear)';
    }
  };

  const updateSessionStatusHint = () => {
    if (!sessionSelect) return;
    const val = sessionSelect.value;
    if (val === '__new__') {
      sessionHint.innerHTML = '<span>💡 点击发送后，将自动弹出新建会话窗口并将指令填入启动项。</span>';
      return;
    }
    const opt = sessionSelect.options[sessionSelect.selectedIndex];
    const status = opt ? opt.getAttribute('data-status') : 'idle';
    if (status === 'busy') {
      sessionHint.innerHTML = `<span style="color: var(--neon-pink, #ff007f);">⚠️ 选中的工位 [${escapeHtml(val)}] 当前正在执行中，派发可能会打断当前任务或进入排队。</span>`;
      if (dispatchBtn) {
        dispatchBtn.classList.add('busy-warn');
        const textSpan = dispatchBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = '⚠️ 确认插队发送';
      }
    } else if (status === 'waiting') {
      sessionHint.innerHTML = `<span style="color: var(--neon-yellow, #ffe600);">🟡 选中的工位 [${escapeHtml(val)}] 正在等待确认。</span>`;
      if (dispatchBtn) {
        dispatchBtn.classList.remove('busy-warn');
        const textSpan = dispatchBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = '发送到终端';
      }
    } else {
      sessionHint.innerHTML = `<span>🟢 选中的工位 [${escapeHtml(val)}] 空闲就绪。</span>`;
      if (dispatchBtn) {
        dispatchBtn.classList.remove('busy-warn');
        const textSpan = dispatchBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = '发送到终端';
      }
    }
  };

  updateCleanHint();
  updateSessionStatusHint();

  // Handle Session Change
  if (sessionSelect) {
    sessionSelect.addEventListener('change', () => {
      const val = sessionSelect.value;
      if (val === '__new__') {
        const newSessionBtn = document.getElementById('newSessionBtn');
        if (newSessionBtn) {
          close();
          newSessionBtn.click();
        }
        return;
      }
      updateCleanHint();
      updateSessionStatusHint();
    });
  }

  // Reset Template
  if (resetBtn && promptTextarea) {
    resetBtn.addEventListener('click', () => {
      promptTextarea.value = defaultPrompt;
      promptTextarea.focus();
    });
  }

  // Copy Prompt
  if (copyBtn && promptTextarea) {
    copyBtn.addEventListener('click', async () => {
      const text = promptTextarea.value;
      if (!text) return;
      await writeToClipboard(text);
      feedbackBar.className = 'staging-feedback-bar success';
      feedbackText.textContent = '✅ 指令已复制到剪贴板！';
      setTimeout(() => {
        feedbackBar.className = 'staging-feedback-bar ready';
        feedbackText.textContent = '准备就绪：点击「发送到终端」或按 Ctrl+Enter 立即派发并切换到工位。';
      }, 2500);
    });
  }

  // Execute Dispatch Action
  const executeDispatch = async () => {
    const text = promptTextarea.value.trim();
    const targetSession = sessionSelect.value;
    const clearHistory = clearCheck ? clearCheck.checked : false;

    if (!text) {
      promptTextarea.focus();
      return;
    }
    if (targetSession === '__new__') {
      close();
      document.getElementById('newSessionBtn')?.click();
      return;
    }

    const clearTasksCheck = overlay.querySelector('#stagingModalClearTasksCheck');
    const shouldClearTasks = clearTasksCheck ? clearTasksCheck.checked : false;

    dispatchBtn.disabled = true;
    const textSpan = dispatchBtn.querySelector('.btn-text');
    if (textSpan) textSpan.textContent = '正在发送...';

    try {
      if (shouldClearTasks && workspaceIdentifier) {
        try {
          await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/project-tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks: [] })
          });
        } catch (clearErr) {
          console.error('Failed to clear old tasks prior to dispatch:', clearErr);
        }
      }

      if (workspaceIdentifier) {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceIdentifier)}/dispatch-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionName: targetSession, promptText: text, clearHistory })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
      } else {
        const cached = state.sessionCache.get(targetSession);
        if (cached && cached.socket && cached.socket.connected) {
          if (clearHistory) {
            cached.socket.emit('terminal-input', '\x03\x05\x15/clear\n');
          }
          cached.socket.emit('terminal-input', text + '\n');
        }
      }

      updateProjectTabStatus('busy');
      close();
      attachSession(targetSession);

      if (typeof onSuccess === 'function') {
        onSuccess();
      }
    } catch (err) {
      feedbackBar.className = 'staging-feedback-bar warning';
      feedbackText.textContent = `❌ 发送失败: ${err.message}`;
      dispatchBtn.disabled = false;
      if (textSpan) textSpan.textContent = '重试发送';
    }
  };

  if (dispatchBtn) {
    dispatchBtn.addEventListener('click', executeDispatch);
  }

  if (promptTextarea) {
    promptTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        executeDispatch();
      }
    });
  }

  // Auto-focus textarea
  setTimeout(() => {
    if (promptTextarea) {
      promptTextarea.focus();
      promptTextarea.setSelectionRange(promptTextarea.value.length, promptTextarea.value.length);
    }
  }, 100);
}

// Backward compatibility aliases
export const openPromptStagingModal = openDispatchModal;

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
