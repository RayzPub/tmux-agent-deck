import { state } from './state.js';
import { stopVoiceInput } from './voice.js';
import { fitTerminal } from './terminal.js';

/**
 * Auto-resize the mobile input textarea elastically between 36px and 120px
 * Supports long voice dictation and multi-line command previews
 * @param {HTMLTextAreaElement} textarea
 */
export function autoResizeMobileInput(textarea) {
  if (!textarea) return;
  // Reset height to let scrollHeight compute natural scroll dimensions
  textarea.style.height = 'auto';

  // Constrain between 36px (1 row) and 120px (approx 5 rows)
  const targetHeight = Math.min(Math.max(textarea.scrollHeight, 36), 120);
  textarea.style.height = `${targetHeight}px`;

  // Enable vertical scroll only if text overflows max-height
  if (textarea.scrollHeight > 120) {
    textarea.style.overflowY = 'auto';
  } else {
    textarea.style.overflowY = 'hidden';
  }

  // Update dynamic CSS variable for bottom controls height
  const mobileControls = document.querySelector('.mobile-bottom-controls');
  if (mobileControls) {
    document.documentElement.style.setProperty(
      '--mobile-controls-height',
      `${mobileControls.offsetHeight}px`
    );
  }
}

/**
 * Detect if running inside iOS PWA standalone mode (Add to Home Screen)
 */
export function isIosStandalone() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window.navigator && window.navigator.standalone) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  );
}

/**
 * Synchronize viewport height to CSS custom properties and force WebKit layout reflow.
 * Resolves the notorious iOS Safari & PWA standalone landscape desync and stuck viewport bugs.
 */
export function syncAppViewportHeight() {
  if (typeof window === 'undefined') return;

  const active = document.activeElement;
  const isInputFocused = active && (
    active.id === 'mobileCommandInput' ||
    active.id === 'chatComposerTextarea' ||
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA'
  );

  let currentHeight = window.innerHeight;
  const visualHeight = window.visualViewport ? window.visualViewport.height : currentHeight;

  if (isInputFocused) {
    document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
    document.documentElement.style.setProperty('--app-visual-height', `${visualHeight}px`);
  } else {
    // When keyboard is closed, naturally use 100dvh so layout is NEVER locked to stale pixel dimensions
    document.documentElement.style.setProperty('--app-height', '100dvh');
    document.documentElement.style.setProperty('--app-visual-height', '100dvh');
    document.documentElement.style.setProperty('--keyboard-offset', '0px');
  }

  // Clear any stale inline pixel height locks so CSS 100% / 100dvh applies cleanly
  if (document.documentElement.style.height) document.documentElement.style.height = '';
  if (document.body.style.height) document.body.style.height = '';
}

/**
 * Link visualViewport with mobile bottom controls to prevent soft keyboard occlusion
 * Handles iOS Safari / Android Chrome virtual keyboard events dynamically
 */
export function initVisualViewportLinkage() {
  if (typeof window === 'undefined' || !window.visualViewport) return;

  const mobileControls = document.querySelector('.mobile-bottom-controls');
  const chatComposer = document.getElementById('chatComposerTextarea');

  let resizeTimer = null;

  // Initial sync on mount
  syncAppViewportHeight();

  const handleViewportChange = () => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Strict window scroll guard: keep window.scrollY at 0 so Safari never shifts the layout viewport
    if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }

    syncAppViewportHeight();

    const layoutHeight = window.innerHeight;
    const visualHeight = vv.height;

    // The true software keyboard height is the difference between layout height and visual viewport height
    const keyboardDiff = Math.max(0, layoutHeight - visualHeight);

    const activeEl = document.activeElement;
    const isInputFocused = activeEl && (
      activeEl.id === 'mobileCommandInput' ||
      activeEl.id === 'chatComposerTextarea' ||
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA'
    );

    // Virtual keyboard is ONLY open when an input is actively focused AND height difference > 45px!
    // If no input has focus, keyboard is GUARANTEED closed (never leave residual offset / blank space).
    const isKeyboardOpen = Boolean(isInputFocused && keyboardDiff > 45);
    const bottomOffset = isKeyboardOpen ? Math.round(keyboardDiff) : 0;

    document.documentElement.style.setProperty('--keyboard-offset', `${bottomOffset}px`);

    if (isKeyboardOpen) {
      document.body.classList.remove('keyboard-recovering');
      document.body.classList.add('keyboard-active');
    } else {
      if (document.body.classList.contains('keyboard-active')) {
        document.body.classList.remove('keyboard-active');
        document.body.classList.add('keyboard-recovering');
        setTimeout(() => {
          document.body.classList.remove('keyboard-recovering');
        }, 250);
      }
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    }

    if (mobileControls) {
      if (isKeyboardOpen) {
        mobileControls.classList.add('keyboard-open');
      } else {
        mobileControls.classList.remove('keyboard-open');
      }
      mobileControls.style.bottom = '0px';

      // Sync measured height to CSS variable
      document.documentElement.style.setProperty(
        '--mobile-controls-height',
        `${mobileControls.offsetHeight}px`
      );
    }

    // Agent chat container: page lifts up as a whole on Duo & mobile
    const agentChatContainer = document.getElementById('agentChatContainer');
    const agentComposer = document.querySelector('.agent-chat-composer');
    if (agentComposer) {
      agentComposer.style.transform = '';
    }
    if (agentChatContainer && !agentChatContainer.classList.contains('hidden')) {
      agentChatContainer.style.paddingBottom = '0px';
      const msgStream = document.getElementById('agentChatMessages');
      if (msgStream && isKeyboardOpen) {
        msgStream.scrollTop = msgStream.scrollHeight;
      }
    }

    // Ensure terminal view is pinned to bottom when keyboard toggles
    if (state.currentSession) {
      const cached = state.sessionCache.get(state.currentSession);
      if (cached && cached.term) {
        cached.term.scrollToBottom();
      }
    }

    // Only refit terminal geometry if keyboard is NOT active (preventing TUI reflow while typing)
    if (!isKeyboardOpen) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fitTerminal();
        } catch (e) {}
      }, 150);
    }
  };

  const triggerViewportSync = () => {
    handleViewportChange();
    [40, 100, 200, 320, 480].forEach((delay) => {
      setTimeout(handleViewportChange, delay);
    });
  };

  window.visualViewport.addEventListener('resize', handleViewportChange);
  window.visualViewport.addEventListener('scroll', handleViewportChange);

  const handleOrientationOrResize = () => {
    // When orientation flips or changes, dismiss virtual keyboard if still focused to prevent geometry lock
    const active = document.activeElement;
    const wasInput =
      active &&
      (active.id === 'mobileCommandInput' ||
        active.id === 'chatComposerTextarea' ||
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA');

    if (wasInput) {
      active.blur();
    }

    document.body.classList.remove('keyboard-active');
    document.documentElement.style.setProperty('--keyboard-offset', '0px');
    if (mobileControls) {
      mobileControls.classList.remove('keyboard-open');
    }

    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    // Clear any inline height overrides
    if (document.documentElement.style.height) document.documentElement.style.height = '';
    if (document.body.style.height) document.body.style.height = '';

    syncAppViewportHeight();
    handleViewportChange();
    fitTerminal();
  };

  // Single debounced handler for resize & orientation
  let resizeDebounceTimer = null;
  const debouncedResizeHandler = (delay = 100) => {
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      handleOrientationOrResize();
    }, delay);
  };

  window.addEventListener('resize', () => debouncedResizeHandler(80));
  window.addEventListener('orientationchange', () => debouncedResizeHandler(150));

  // Lifecycle hooks for PWA resume / reopen / tab switch to eradicate top whitespace smoothly
  let pwaResumeDebounceTimer = null;
  const handlePwaReopen = () => {
    if (pwaResumeDebounceTimer) clearTimeout(pwaResumeDebounceTimer);
    pwaResumeDebounceTimer = setTimeout(() => {
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (!isInput) {
        document.body.classList.remove('keyboard-active');
        document.documentElement.style.setProperty('--keyboard-offset', '0px');
        document.documentElement.style.setProperty('--app-height', '100dvh');
        document.documentElement.style.setProperty('--app-visual-height', '100dvh');
      }

      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;

      syncAppViewportHeight();
      handleViewportChange();
      fitTerminal();
    }, 60);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handlePwaReopen();
    }
  });

  window.addEventListener('pageshow', () => {
    handlePwaReopen();
  });

  window.addEventListener('focus', () => {
    handlePwaReopen();
  });

  // Strict scroll lock: in this single-page dashboard, window scroll should ALWAYS be 0
  window.addEventListener(
    'scroll',
    () => {
      if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    },
    { passive: true }
  );

  // Focus and blur hooks for rapid, bulletproof keyboard transition on any input
  document.addEventListener('focusin', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      if (e.target.id === 'mobileCommandInput' && state.currentSession) {
        const cached = state.sessionCache.get(state.currentSession);
        if (cached && cached.socket) {
          cached.socket.emit('exit-copy-mode');
        }
      }
      triggerViewportSync();
    }
  });

  document.addEventListener('focusout', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(() => {
        const active = document.activeElement;
        const stillInput =
          active &&
          (active.id === 'mobileCommandInput' ||
            active.id === 'chatComposerTextarea' ||
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA');

        if (!stillInput) {
          // Immediately tear down keyboard active state to avoid ghost space
          document.body.classList.remove('keyboard-active');
          document.documentElement.style.setProperty('--keyboard-offset', '0px');
          if (mobileControls) {
            mobileControls.classList.remove('keyboard-open');
          }

          // Clear any inline height overrides
          if (document.documentElement.style.height) document.documentElement.style.height = '';
          if (document.body.style.height) document.body.style.height = '';

          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;

          syncAppViewportHeight();

          // Deferred smooth stabilization after virtual keyboard slide-down animation
          setTimeout(() => {
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;

            syncAppViewportHeight();
            handleViewportChange();
            fitTerminal();
          }, 240);
        }
      }, 20);
    }
  });

  // Set initial measured controls height
  if (mobileControls) {
    document.documentElement.style.setProperty(
      '--mobile-controls-height',
      `${mobileControls.offsetHeight || 96}px`
    );
  }
}

/**
 * Initialize Mobile Command Input & Controls
 */
export function initMobileInput() {
  const mobileCommandInput = document.getElementById('mobileCommandInput');
  const mobileSendBtn = document.getElementById('mobileSendBtn');

  if (mobileCommandInput) {
    // Configure mobile input optimization attributes
    mobileCommandInput.setAttribute('autocomplete', 'off');
    mobileCommandInput.setAttribute('autocorrect', 'off');
    mobileCommandInput.setAttribute('autocapitalize', 'off');
    mobileCommandInput.setAttribute('spellcheck', 'false');
    mobileCommandInput.setAttribute('enterkeyhint', 'send');

    // Elastic auto-resize on input events
    mobileCommandInput.addEventListener('input', () => {
      autoResizeMobileInput(mobileCommandInput);
    });

    // Initial resize to single-line baseline
    autoResizeMobileInput(mobileCommandInput);
  }

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
          // Scroll client terminal to bottom before sending
          if (cached.term) {
            cached.term.scrollToBottom();
          }
          const cleanText = text.trim();
          if (cleanText) {
            cached.socket.emit('terminal-input', cleanText + '\r', { exitCopyMode: true });
            mobileCommandInput.value = '';
            autoResizeMobileInput(mobileCommandInput);
            mobileCommandInput.blur();
          } else {
            cached.socket.emit('terminal-input', '\r', { exitCopyMode: true });
            mobileCommandInput.value = '';
            autoResizeMobileInput(mobileCommandInput);
          }
        }
      }
    };

    mobileSendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendMobileCommand();
    });

    mobileCommandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Guard against IME composition confirmation (Chinese Pinyin candidate selection)
        if (e.isComposing || e.keyCode === 229) return;

        // Enter sends command; Shift+Enter inserts newline
        if (!e.shiftKey) {
          e.preventDefault();
          sendMobileCommand();
        }
      }
    });
  }

  // Tag standalone iOS PWA mode if detected
  if (isIosStandalone()) {
    document.body.classList.add('is-ios-pwa');
  }

  // Initial viewport dimension synchronization
  syncAppViewportHeight();

  // Initialize visualViewport event listeners
  initVisualViewportLinkage();

  // Render Lucide icons for mobile controls
  if (typeof window !== 'undefined' && window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
