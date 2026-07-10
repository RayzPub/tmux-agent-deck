import { state } from './state.js';
import { closeTab, renderTabs } from './tabs.js';
import { refreshFileTree } from './explorer.js';

export function showTipToast(message, duration = 4000) {
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

export function writeToClipboard(text) {
  if (!text) return false;

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
      console.log('Clipboard write succeeded via synchronous copy listener');
      return true;
    }
  } catch (err) {
    console.warn('Synchronous copy event method failed, trying alternative:', err);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => console.log('Clipboard write succeeded via navigator.clipboard'))
      .catch(err => console.error('navigator.clipboard.writeText failed:', err));
    return true;
  }

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
  } catch (err) {
    console.error('Fallback textarea copy failed:', err);
  }
  document.body.removeChild(textArea);

  if (state.currentSession) {
    const cached = state.sessionCache.get(state.currentSession);
    if (cached && cached.term) {
      cached.term.focus();
    }
  }
  return success;
}

export async function pasteFromClipboard() {
  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text && state.currentSession) {
        const cached = state.sessionCache.get(state.currentSession);
        if (cached && cached.socket) {
          cached.socket.emit('terminal-input', text);
        }
        console.log('Paste succeeded via navigator.clipboard');
      }
      return;
    } catch (err) {
      console.warn('navigator.clipboard.readText failed:', err.message || err);
    }
  }

  const text = prompt("📋 PASTE ZONE // 请在下方粘贴您的文本 (Ctrl+V):");
  if (text && state.currentSession) {
    const cached = state.sessionCache.get(state.currentSession);
    if (cached && cached.socket) {
      cached.socket.emit('terminal-input', text);
    }
  }
}

export async function copySelection() {
  if (state.lastSelection && state.lastSelection.trim()) {
    const success = await writeToClipboard(state.lastSelection);
    if (success) {
      console.log('📋 Copied selection successfully');
    }
  }
}

export function reportFocusStatus() {
  const isFocused = document.hasFocus();
  const cached = state.sessionCache.get(state.currentSession);
  if (cached && cached.socket) {
    cached.socket.emit('client-focus', {
      focused: isFocused,
      activeSession: state.currentSession
    });
  }
}

export function fitTerminalFor(sessionName) {
  const cached = state.sessionCache.get(sessionName);
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

export function fitTerminal() {
  if (state.currentSession) {
    fitTerminalFor(state.currentSession);
  }
}

export function attachSession(sessionName) {
  let tab = state.tabs.find(t => t.type === 'terminal' && t.id === sessionName);
  if (!tab) {
    tab = {
      id: sessionName,
      name: sessionName,
      type: 'terminal'
    };
    state.tabs.push(tab);
  }

  if (state.currentSession && state.currentSession !== sessionName) {
    const prevCached = state.sessionCache.get(state.currentSession);
    if (prevCached && prevCached.container) {
      prevCached.container.classList.add('hidden');
    }
  }

  state.activeTabId = sessionName;
  renderTabs();

  state.currentSession = sessionName;
  const activeSessionNameText = document.getElementById('activeSessionName');
  activeSessionNameText.textContent = sessionName;
  reportFocusStatus();
  
  // Auto-scope Explorer to session's working directory
  const sessionObj = state.sessionListCache.find(s => s.name === sessionName);
  if (sessionObj) {
    let matchingWs = null;
    if (sessionObj.workspaceName) {
      matchingWs = state.workspacesList.find(w => w.name.toLowerCase() === sessionObj.workspaceName.toLowerCase());
    }
    if (!matchingWs && sessionObj.path) {
      matchingWs = state.workspacesList.find(w => w.path === sessionObj.path);
    }
    
    const explorerWorkspaceSelect = document.getElementById('explorerWorkspaceSelect');
    if (matchingWs) {
      state.currentWorkspacePath = matchingWs.path;
      explorerWorkspaceSelect.value = matchingWs.path;
      localStorage.setItem('lastWorkspacePath', state.currentWorkspacePath);
      refreshFileTree();
    } else if (sessionObj.path) {
      state.currentWorkspacePath = sessionObj.path;
      let optionExists = Array.from(explorerWorkspaceSelect.options).some(opt => opt.value === sessionObj.path);
      if (!optionExists) {
        const tempOpt = document.createElement('option');
        tempOpt.value = sessionObj.path;
        tempOpt.textContent = `[Session Dir] ${sessionObj.path}`;
        explorerWorkspaceSelect.appendChild(tempOpt);
      }
      explorerWorkspaceSelect.value = sessionObj.path;
      localStorage.setItem('lastWorkspacePath', state.currentWorkspacePath);
      refreshFileTree();
    }
  }

  // Update sessions UI
  const loadSessions = window.deckEvents?.loadSessions;
  if (loadSessions) {
    loadSessions();
  }

  // Show terminal panel
  const welcomePanel = document.getElementById('welcomePanel');
  const editorPanel = document.getElementById('editorPanel');
  const terminalPanel = document.getElementById('terminalPanel');
  const terminalContainer = document.getElementById('terminal-container');

  welcomePanel.classList.add('hidden');
  editorPanel.classList.add('hidden');
  terminalPanel.classList.remove('hidden');

  let cached = state.sessionCache.get(sessionName);
  if (!cached) {
    const container = document.createElement('div');
    container.className = 'terminal-instance-container';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.touchAction = 'none';
    terminalContainer.appendChild(container);

    const sessionSocket = io({
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });

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
        console.log(`Socket reconnected for session: ${sessionName}`);
        sessionTerm.clear();
        setTimeout(() => {
          sessionFitAddon.fit();
          sessionSocket.emit('init-terminal', {
            sessionName: sessionName,
            cols: sessionTerm.cols,
            rows: sessionTerm.rows
          });
          if (sessionName === state.currentSession) {
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
        hideConnectionToast();
        return;
      }
      if (reason === 'io server disconnect') {
        showConnectionToast('Server disconnected. Tap to reconnect.', 'error');
      } else {
        showConnectionToast('Reconnecting...', 'warning');
      }
    });

    sessionSocket.on('reconnect_attempt', (attemptNumber) => {
      showConnectionToast(`Reconnecting... (${attemptNumber}/10)`, 'warning');
    });

    sessionSocket.on('reconnect_failed', () => {
      showConnectionToast('Connection failed. Tap to retry.', 'error');
    });

    const isLight = document.body.classList.contains('light-minimalist');
    const sessionTerm = new Terminal({
      cursorBlink: true,
      cursorStyle: 'underline',
      theme: isLight ? state.themeConstants.LIGHT : state.themeConstants.DARK,
      fontFamily: '"Fira Code", Consolas, Menlo, Courier, monospace',
      fontSize: 14,
      lineHeight: 1.2
    });

    const sessionFitAddon = new FitAddon.FitAddon();
    sessionTerm.loadAddon(sessionFitAddon);
    
    sessionTerm.open(container);

    let lastTouchY = 0;

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY;
      }
    }, { capture: true, passive: false });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        const currentY = e.touches[0].clientY;
        const deltaY = lastTouchY - currentY;
        lastTouchY = currentY;

        const termEl = sessionTerm.element;
        if (termEl) {
          const wheelEvent = new WheelEvent('wheel', {
            deltaY: deltaY * 2,
            bubbles: true,
            cancelable: true
          });
          termEl.dispatchEvent(wheelEvent);
        }
        e.preventDefault();
      }
    }, { capture: true, passive: false });

    let dragStart = null;

    container.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.shiftKey) {
        dragStart = { x: e.clientX, y: e.clientY };
      }
    });

    container.addEventListener('mouseup', (e) => {
      if (dragStart) {
        const dist = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
        if (dist > 15) {
          state.lastDragWithoutShiftTime = Date.now();
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
    state.sessionCache.set(sessionName, cached);

    setTimeout(() => {
      sessionFitAddon.fit();
      sessionSocket.emit('init-terminal', {
        sessionName: sessionName,
        cols: sessionTerm.cols,
        rows: sessionTerm.rows
      });
      setTimeout(loadSessions, 200);
    }, 100);

    sessionTerm.onData(data => {
      if (sessionSocket) {
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

    sessionSocket.on('terminal-output', data => {
      if (sessionTerm) {
        sessionTerm.write(data);
      }
    });

    sessionTerm.onSelectionChange(() => {
      const selection = sessionTerm.getSelection();
      if (selection && selection.trim().length > 0) {
        state.lastSelection = selection;
      }
    });

    sessionTerm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (isCtrlOrCmd && key === 'c' && !e.shiftKey) {
        const selection = sessionTerm.getSelection();
        if (selection && selection.trim().length > 0) {
          writeToClipboard(selection);
          return false;
        } else {
          const timeSinceDrag = Date.now() - state.lastDragWithoutShiftTime;
          if (timeSinceDrag < 4000) {
            showTipToast('💡 提示：tmux 鼠标模式已开启。请按住 Shift 键再用鼠标拖拽选择以进行复制。');
          }
        }
      }
      if (isCtrlOrCmd && key === 'v' && !e.shiftKey) {
        pasteFromClipboard();
        return false;
      }
      return true;
    });

    sessionSocket.on('terminal-exit', () => {
      console.log(`Terminal PTY exited`);
      removeSessionFromCache(sessionName);
      closeTab(sessionName);
      if (loadSessions) {
        loadSessions();
      }
    });

    sessionSocket.on('connect_error', (err) => {
      console.error('Socket Auth Error:', err.message);
      alert('Session connection unauthorized. Redirecting to login.');
      window.location.href = '/login.html';
    });

    container.addEventListener('click', () => {
      if (sessionTerm) {
        sessionTerm.focus();
      }
    });
  } else {
    cached.container.classList.remove('hidden');
    setTimeout(() => {
      if (cached.term) {
        cached.term.focus();
      }
      fitTerminalFor(sessionName);
    }, 50);
  }
}

export function detachSession() {
  if (state.currentSession) {
    closeTab(state.currentSession);
  }
}

export function removeSessionFromCache(name) {
  const cached = state.sessionCache.get(name);
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
    state.sessionCache.delete(name);
  }
}

export function clearSessionCache() {
  for (const name of state.sessionCache.keys()) {
    removeSessionFromCache(name);
  }
}

export function initMobileKeyboard(mobileKeyboardBar) {
  console.log('[MobileKeyboard] Initializing helper keyboard bar. Element:', mobileKeyboardBar);
  if (!mobileKeyboardBar) return;

  const triggerHelperKey = (btn) => {
    const key = btn.getAttribute('data-key');
    console.log('[MobileKeyboard] Helper key triggered:', key);
    if (!key) return;

    if (key === 'ctrl') {
      btn.classList.toggle('active');
      return;
    }

    if (key === 'paste') {
      pasteFromClipboard();
      return;
    }

    const activeSession = state.sessionCache.get(state.currentSession);
    console.log('[MobileKeyboard] activeSession:', activeSession, 'currentSession:', state.currentSession);

    if (key === 'keyboard-toggle') {
      if (activeSession && activeSession.term) {
        activeSession.term.focus();
      }
      return;
    }

    if (key === 'clear') {
      if (activeSession) {
        if (activeSession.term) {
          activeSession.term.clear();
        }
        if (activeSession.socket) {
          // Send Ctrl+L (Form Feed / Clear screen) to PTY
          activeSession.socket.emit('terminal-input', '\x0c');
        }
      }
      return;
    }

    // Send sequence directly
    let seq = '';
    switch (key) {
      case 'esc': seq = '\x1b'; break;
      case 'tab': seq = '\x09'; break;
      case 'enter': seq = '\r'; break;
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

  let touchStartX = 0;
  let touchStartY = 0;
  let touchHasMoved = false;

  // Track touch start to detect dragging/scrolling vs tapping
  mobileKeyboardBar.addEventListener('touchstart', (e) => {
    const btn = e.target.closest('.helper-key');
    if (!btn) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchHasMoved = false;
    // Do NOT preventDefault, letting the mobile browser scroll horizontally natively!
  }, { passive: true });

  mobileKeyboardBar.addEventListener('touchmove', (e) => {
    if (!touchHasMoved) {
      const deltaX = Math.abs(e.touches[0].clientX - touchStartX);
      const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
      // If they drag more than 24 pixels, mark as scrolling/dragging
      if (deltaX > 24 || deltaY > 24) {
        touchHasMoved = true;
      }
    }
  }, { passive: true });

  mobileKeyboardBar.addEventListener('touchend', (e) => {
    const btn = e.target.closest('.helper-key');
    if (!btn) return;

    console.log('[MobileKeyboard] touchend. touchHasMoved:', touchHasMoved);
    if (!touchHasMoved) {
      // It was a short tap (not a drag/scroll gesture)!
      e.preventDefault(); // Prevent focus loss and double tap zoom
      triggerHelperKey(btn);
    }
  });

  mobileKeyboardBar.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('.helper-key');
    if (!btn) return;
    e.preventDefault(); // Prevent focus loss
    triggerHelperKey(btn);
  });
}
