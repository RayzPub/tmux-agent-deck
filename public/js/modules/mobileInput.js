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

  const currentHeight = textarea.offsetHeight;
  const currentVal = textarea.value || '';
  const prevVal = textarea._prevValue || '';
  textarea._prevValue = currentVal;

  let targetHeight;
  if (currentVal.length < prevVal.length) {
    textarea.style.height = '36px';
    targetHeight = Math.min(Math.max(textarea.scrollHeight, 36), 120);
  } else {
    targetHeight = Math.min(Math.max(textarea.scrollHeight, 36), 120);
  }

  if (Math.abs(targetHeight - currentHeight) > 1) {
    textarea.style.height = `${targetHeight}px`;

    const mobileControls = document.querySelector('.mobile-bottom-controls');
    if (mobileControls) {
      document.documentElement.style.setProperty(
        '--mobile-controls-height',
        `${mobileControls.offsetHeight}px`
      );
    }
  }

  // Enable vertical scroll only if text overflows max-height
  if (textarea.scrollHeight > 120) {
    textarea.style.overflowY = 'auto';
  } else {
    textarea.style.overflowY = 'hidden';
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

let wasKeyboardOpen = false;

/**
 * Synchronize viewport height and virtual keyboard state (iOS Safari / PWA Standalone / Duo Foldable)
 */
export function syncAppViewportHeight() {
  if (typeof window === 'undefined') return;

  const vv = window.visualViewport;
  const winHeight = window.innerHeight;
  const currentHeight = vv ? vv.height : winHeight;
  const diff = winHeight - currentHeight;

  // Keyboard detection iron rule: virtual keyboard can ONLY exist if an editable element currently has focus!
  // This completely eliminates false positive keyboard detection during screen rotation (orientation change)
  // where winHeight and visualViewport differ momentarily during layout inversion.
  const activeEl = document.activeElement;
  const isInputFocused = Boolean(
    activeEl && (
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.isContentEditable
    )
  );

  // On wide/landscape screens (winHeight <= 520px), genuine software keyboard takes >= 90px.
  // Minor address bar/indicator bar variations range between 0-60px and must NOT be treated as a keyboard.
  const minThreshold = winHeight < 520 ? 90 : 110;
  const isKeyboardOpen = isInputFocused && (diff > minThreshold);
  const keyboardHeight = isKeyboardOpen ? Math.max(0, Math.round(diff)) : 0;

  const root = document.documentElement;
  const body = document.body;

  if (isKeyboardOpen) {
    wasKeyboardOpen = true;
    body.classList.add('keyboard-open');
    root.style.setProperty('--app-height', `${Math.round(currentHeight)}px`);
    root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
  } else {
    body.classList.remove('keyboard-open');
    // Remove inline properties so container cleanly falls back to CSS 100dvh / -webkit-fill-available
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--app-width');
    root.style.removeProperty('--keyboard-height');

    // If keyboard was previously open and now closed, aggressively restore WebKit viewport scroll
    if (wasKeyboardOpen) {
      wasKeyboardOpen = false;
      restorePwaViewportScroll();
    }
  }
}

/**
 * Duet-inspired viewport recovery:
 * When virtual keyboard dismisses on iOS Safari / standalone PWA / Duo wide screen,
 * WebKit often leaves window.scrollY displaced upwards with a dead blank zone at the bottom.
 * Reset scrollX and scrollY to 0 and nudge layout reflow across progressive intervals.
 */
export function restorePwaViewportScroll() {
  if (typeof window === 'undefined') return;

  const restore = () => {
    if (window.scrollY !== 0 || window.scrollX !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }
    // Force WebKit synchronous reflow & purge PWA Compositor dead zone
    void document.body.offsetHeight;
    if (document.documentElement && document.documentElement.style.transform !== undefined) {
      document.documentElement.style.transform = 'translateZ(0)';
      requestAnimationFrame(() => {
        document.documentElement.style.transform = '';
      });
    }
  };

  restore();
  [15, 40, 80, 150, 250, 400].forEach((delay) => setTimeout(restore, delay));
}

/**
 * Handle screen orientation, visualViewport & window resize events to maintain responsive sizing & unblocked inputs
 */
export function initVisualViewportLinkage() {
  if (typeof window === 'undefined') return;

  let resizeTimer = null;
  const handleResize = () => {
    syncAppViewportHeight();

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

      // Keep chat message stream pinned to bottom if in chat mode
      const chatMessages = document.getElementById('agentChatMessages');
      const chatContainer = document.getElementById('agentChatContainer');
      if (chatMessages && chatContainer && !chatContainer.classList.contains('hidden')) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }, 60);
  };

  // 1. Visual Viewport API bindings for iOS WebKit & Modern Browsers
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      }
      syncAppViewportHeight();
    });
  }

  // 2. Window and visibility events
  window.addEventListener('resize', handleResize);

  // Aggressive multi-stage orientation recovery for iPhone Duo / Foldables
  window.addEventListener('orientationchange', () => {
    // Stage 1: Immediately purge keyboard classes & dimensions to avoid rotation freeze
    wasKeyboardOpen = false;
    document.body.classList.remove('keyboard-open');
    document.documentElement.style.removeProperty('--app-height');
    document.documentElement.style.removeProperty('--app-width');
    document.documentElement.style.removeProperty('--keyboard-height');
    restorePwaViewportScroll();

    // Stage 2: If an input was active, release it to prevent WebKit rotation dislocation
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      active.blur();
    }

    // Stage 3: Multi-phase reflow as WebKit orientation animation completes
    [50, 150, 300, 500, 800, 1200].forEach((delay) => {
      setTimeout(() => {
        handleResize();
        restorePwaViewportScroll();
      }, delay);
    });
  });

  // Some iOS PWA / foldable builds skip 'resize' after rotation; listen to orientation APIs directly
  const settleAfterRotation = () => {
    [0, 100, 300, 600, 1000].forEach((delay) => setTimeout(handleResize, delay));
  };
  if (window.screen && window.screen.orientation && typeof window.screen.orientation.addEventListener === 'function') {
    window.screen.orientation.addEventListener('change', settleAfterRotation);
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(orientation: landscape)');
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', settleAfterRotation);
  }

  window.addEventListener('pageshow', () => {
    handleResize();
    restorePwaViewportScroll();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleResize();
    }
  });

  // Guard against window scrolling in PWA / flex 100dvh layout
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  // 3. Focusin guard: handle mobile command input tmux copy-mode exit and prevent WebKit scroll drift
  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (target && target.id === 'mobileCommandInput' && state.currentSession) {
      const cached = state.sessionCache.get(state.currentSession);
      if (cached && cached.socket) {
        cached.socket.emit('exit-copy-mode');
      }
    }

    const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (isInput) {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      }

      // Progressive sync as virtual keyboard finishes opening animation
      [30, 100, 250, 400].forEach((delay) => {
        setTimeout(() => {
          syncAppViewportHeight();
          if (window.scrollY !== 0 || window.scrollX !== 0) {
            window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
          }
        }, delay);
      });
    }
  });

  // 4. When mobile virtual keyboard dismisses on any input/textarea, restore viewport scroll
  document.addEventListener('focusout', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
      setTimeout(() => {
        const active = document.activeElement;
        const stillInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
        if (!stillInput) {
          syncAppViewportHeight();
          restorePwaViewportScroll();
        }
      }, 80);
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
