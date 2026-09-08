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
 * Link visualViewport with mobile bottom controls to prevent soft keyboard occlusion
 * Handles iOS Safari / Android Chrome virtual keyboard events dynamically
 */
export function initVisualViewportLinkage() {
  if (typeof window === 'undefined' || !window.visualViewport) return;

  const mobileControls = document.querySelector('.mobile-bottom-controls');
  const mobileInput = document.getElementById('mobileCommandInput');
  const chatComposer = document.getElementById('chatComposerTextarea');

  let resizeTimer = null;

  const handleViewportChange = () => {
    const vv = window.visualViewport;
    if (!vv) return;

    const layoutHeight = window.innerHeight;
    const visualHeight = vv.height;
    const offsetTop = vv.offsetTop || 0;

    // Calculate keyboard overlap height at the bottom of the layout viewport
    const rawBottomOffset = Math.max(0, layoutHeight - (visualHeight + offsetTop));
    // Threshold to differentiate virtual keyboard vs browser URL bar expansion
    const isKeyboardOpen = rawBottomOffset > 80;
    const bottomOffset = isKeyboardOpen ? Math.round(rawBottomOffset) : 0;

    document.documentElement.style.setProperty('--keyboard-offset', `${bottomOffset}px`);

    if (isKeyboardOpen) {
      document.body.classList.add('keyboard-active');
    } else {
      document.body.classList.remove('keyboard-active');
    }

    if (mobileControls) {
      if (isKeyboardOpen) {
        mobileControls.classList.add('keyboard-open');
        mobileControls.style.bottom = `${bottomOffset}px`;
      } else {
        mobileControls.classList.remove('keyboard-open');
        mobileControls.style.bottom = '0px';
      }

      // Sync measured height to CSS variable
      document.documentElement.style.setProperty(
        '--mobile-controls-height',
        `${mobileControls.offsetHeight}px`
      );
    }

    // Agent chat composer linkage if active
    const agentComposer = document.querySelector('.agent-chat-composer');
    if (agentComposer) {
      if (isKeyboardOpen) {
        agentComposer.style.transform = `translateY(-${bottomOffset}px)`;
      } else {
        agentComposer.style.transform = '';
      }
    }

    // Scroll active element into view smoothly if user is typing
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl === mobileInput ||
        activeEl === chatComposer ||
        (mobileControls && mobileControls.contains(activeEl)))
    ) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) {}
      }, 50);
    }

    // Fit terminal dynamically to visible region
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        fitTerminal();
      } catch (e) {}
    }, 120);
  };

  window.visualViewport.addEventListener('resize', handleViewportChange);
  window.visualViewport.addEventListener('scroll', handleViewportChange);

  // Focus and blur hooks for rapid keyboard transition
  if (mobileInput) {
    mobileInput.addEventListener('focus', () => {
      setTimeout(handleViewportChange, 60);
      setTimeout(handleViewportChange, 260);
    });
    mobileInput.addEventListener('blur', () => {
      setTimeout(handleViewportChange, 60);
      setTimeout(handleViewportChange, 260);
    });
  }

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
          const cleanText = text.trim();
          if (cleanText) {
            cached.socket.emit('terminal-input', cleanText + '\r');
            mobileCommandInput.value = '';
            autoResizeMobileInput(mobileCommandInput);
            mobileCommandInput.blur();
          } else {
            cached.socket.emit('terminal-input', '\r');
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

  // Initialize visualViewport event listeners
  initVisualViewportLinkage();
}
