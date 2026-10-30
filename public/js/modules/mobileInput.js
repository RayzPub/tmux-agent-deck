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
 * Detect if running inside PWA standalone mode (aligned with Duet)
 */
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window.navigator && window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  );
}
export const isIosStandalone = isStandalone;

/**
 * Synchronize viewport height (Kept as safe no-op for pure CSS layout)
 */
export function syncAppViewportHeight() {
  // Pure CSS flex layout (100dvh + interactive-widget=resizes-content) handles keyboard height natively.
}

/**
 * Duet-inspired viewport recovery:
 * When virtual keyboard dismisses on iOS Safari / standalone PWA,
 * WebKit often leaves the window scrolled upwards with a blank dead zone.
 * Reset scrollX and scrollY to 0 and nudge layout reflow.
 */
export function restorePwaViewportScroll() {
  if (typeof window === 'undefined') return;

  const restore = () => {
    if (window.scrollY !== 0 || window.scrollX !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
    // Force WebKit synchronous reflow to clear blank void
    void document.body.offsetHeight;
  };

  restore();
  [40, 160, 320].forEach((delay) => setTimeout(restore, delay));
}

/**
 * Handle screen orientation & window resize events to maintain terminal sizing
 */
export function initVisualViewportLinkage() {
  if (typeof window === 'undefined') return;

  let resizeTimer = null;
  const handleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        fitTerminal();
      } catch (e) {}

      if (state.currentSession) {
        const cached = state.sessionCache.get(state.currentSession);
        if (cached && cached.term) {
          cached.term.scrollToBottom();
        }
      }
    }, 120);
  };

  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
  window.addEventListener('pageshow', handleResize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleResize();
    }
  });

  // Exit tmux copy-mode when tapping mobile input
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.id === 'mobileCommandInput' && state.currentSession) {
      const cached = state.sessionCache.get(state.currentSession);
      if (cached && cached.socket) {
        cached.socket.emit('exit-copy-mode');
      }
    }
  });

  // When mobile virtual keyboard dismisses on any input/textarea, restore viewport scroll
  document.addEventListener('focusout', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(() => {
        const active = document.activeElement;
        const stillInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
        if (!stillInput) {
          restorePwaViewportScroll();
        }
      }, 50);
    }
  });
}

/**
 * Completely disable all page zooming & scaling across touch gestures and desktop inputs:
 * 1. Pinch-to-zoom (gesturestart, gesturechange, gestureend, touchmove with >1 fingers)
 * 2. Double-tap to zoom on mobile/tablets
 * 3. Desktop Ctrl + Wheel / Trackpad pinch zoom
 * 4. Ctrl + (+/-) keyboard zoom shortcuts
 */
export function initPreventZoom() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // 1. Prevent iOS Safari gesture zoom (pinch/rotate)
  const preventDefaultGesture = (e) => {
    e.preventDefault();
  };
  document.addEventListener('gesturestart', preventDefaultGesture, { passive: false });
  document.addEventListener('gesturechange', preventDefaultGesture, { passive: false });
  document.addEventListener('gestureend', preventDefaultGesture, { passive: false });

  // 2. Prevent multi-finger touchmove (pinch to zoom)
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // 3. Prevent double-tap to zoom
  let lastTouchEndTime = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEndTime <= 300) {
        const target = e.target;
        const isInteractive =
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            target.tagName === 'BUTTON' ||
            target.tagName === 'A');
        if (!isInteractive) {
          e.preventDefault();
        }
      }
      lastTouchEndTime = now;
    },
    { passive: false }
  );

  // 4. Prevent Ctrl + MouseWheel / Trackpad pinch zoom
  document.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // 5. Prevent Ctrl/Meta + (+ / - / = / 0) keyboard zoom
  document.addEventListener('keydown', (e) => {
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === '+' || e.key === '-' || e.key === '=' || e.keyCode === 187 || e.keyCode === 189)
    ) {
      e.preventDefault();
    }
  });
}

/**
 * iOS Standalone PWA Link Guard: Prevents navigation links from kicking iOS standalone out to Mobile Safari
 */
export function initStandaloneLinkGuard() {
  if (typeof window === 'undefined') return;
  const isStandalone = isIosStandalone();
  if (!isStandalone) return;

  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest('a');
      if (!a || !a.href) return;
      if (a.target && a.target !== '_self') return;
      if (a.getAttribute('href')?.startsWith('#') || a.getAttribute('href')?.startsWith('javascript:')) return;

      try {
        const url = new URL(a.href, window.location.href);
        if (url.origin === window.location.origin) {
          // Internal same-origin link - stay within standalone PWA webview
          e.preventDefault();
          window.location.assign(url.href);
        }
      } catch {
        // Ignore URL parsing errors
      }
    },
    false
  );
}

/**
 * Initialize Mobile Command Input & Controls
 */
export function initMobileInput() {
  // Lock viewport zooming globally
  initPreventZoom();
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

    mobileCommandInput.addEventListener('blur', () => {
      restorePwaViewportScroll();
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

  // Tag standalone PWA mode if detected (aligned with Duet)
  if (isStandalone()) {
    document.body.classList.add('is-ios-pwa', 'is-standalone');
    document.documentElement.setAttribute('data-duet-mode', 'standalone');
  }

  // Intercept internal links in iOS standalone to prevent opening external Mobile Safari
  initStandaloneLinkGuard();

  // Initial viewport dimension synchronization
  syncAppViewportHeight();

  // Initialize visualViewport event listeners
  initVisualViewportLinkage();

  // Render Lucide icons for mobile controls
  if (typeof window !== 'undefined' && window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
