/**
 * Inline AI Status Controller & Semantic Animated SVG Icons
 * Provides stage-specific micro-animated SVG icons (thinking, researching, analyzing,
 * writing, waiting, done, error), continuous tabular-nums elapsed timer across working
 * stages, blur-swap label transitions, and quiet auto-hide when idle.
 */

const ACTIVE_STAGES = new Set([
  'thinking',
  'researching',
  'analyzing',
  'writing',
  'working',
  'compacting',
  'waiting',
]);

const DONE_HOLD_MS = 3500;
const ERROR_HOLD_MS = 5000;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatElapsedSeconds(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}m ${rem}s`;
}

/**
 * Map a tool name to a semantic AI status stage
 */
export function inferToolStage(toolName = '') {
  const name = String(toolName).toLowerCase();
  if (/(read|grep|glob|search|web|fetch|find|list|ls|view|inspect|browse|doc|cat)/.test(name)) {
    return 'researching';
  }
  if (/(write|edit|patch|replace|create|save|notebook|insert|append)/.test(name)) {
    return 'writing';
  }
  if (/(bash|exec|shell|run|test|cmd|terminal|command|build|lint)/.test(name)) {
    return 'analyzing';
  }
  return 'analyzing';
}

/**
 * Render semantic animated SVG icon for an AI status stage
 */
export function renderAiStatusIconSvg(stage = 'thinking', size = 16) {
  const s = Number(size) || 16;
  switch (stage) {
    case 'thinking':
    case 'compacting':
      return `
        <svg class="ai-st-svg ai-st-svg-thinking" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" aria-hidden="true">
          <path class="ai-st-sparkle-main" fill="currentColor" d="M10.5 4Q11.5 11 18.5 12Q11.5 13 10.5 20Q9.5 13 2.5 12Q9.5 11 10.5 4Z" />
          <path class="ai-st-sparkle-twinkle" fill="currentColor" d="M18.5 2.5Q18.9 5.1 21.5 5.5Q18.9 5.9 18.5 8.5Q18.1 5.9 15.5 5.5Q18.1 5.1 18.5 2.5Z" />
        </svg>
      `;
    case 'researching':
      return `
        <svg class="ai-st-svg ai-st-svg-researching" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <g class="ai-st-lens-orbit">
            <circle cx="10.5" cy="10.5" r="5.3" stroke-width="2.2" />
            <path d="M14.7 14.7L19 19" stroke-width="2.4" />
          </g>
        </svg>
      `;
    case 'analyzing':
      return `
        <svg class="ai-st-svg ai-st-svg-analyzing" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
          <line class="ai-st-bar ai-st-bar-1" x1="6" y1="6" x2="6" y2="19" stroke-width="3" />
          <line class="ai-st-bar ai-st-bar-2" x1="12" y1="6" x2="12" y2="19" stroke-width="3" />
          <line class="ai-st-bar ai-st-bar-3" x1="18" y1="6" x2="18" y2="19" stroke-width="3" />
        </svg>
      `;
    case 'writing':
    case 'working':
      return `
        <svg class="ai-st-svg ai-st-svg-writing" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ai-st-wave" pathLength="1" d="M3.5 18.5c2.2-1.8 4.4 1.8 6.6 0s4.4 1.8 6.6 0 2.5-.6 3.8 0" stroke-width="2.1" />
          <path class="ai-st-pen" d="M16.5 4.2l3.3 3.3-8.6 8.6-3.8.5.5-3.8 8.6-8.6z" stroke-width="1.9" />
        </svg>
      `;
    case 'waiting':
      return `
        <svg class="ai-st-svg ai-st-svg-waiting" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle class="ai-st-ring-pulse" cx="12" cy="12" r="8" stroke-width="2" />
          <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        </svg>
      `;
    case 'done':
      return `
        <svg class="ai-st-svg ai-st-svg-done" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ai-st-draw" pathLength="1" d="M5 12.5L10 17.5L19 7" stroke-width="2.5" />
        </svg>
      `;
    case 'error':
      return `
        <svg class="ai-st-svg ai-st-svg-error" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ai-st-draw" pathLength="1" d="M7 7L17 17" stroke-width="2.5" />
          <path class="ai-st-draw ai-st-draw-delay" pathLength="1" d="M17 7L7 17" stroke-width="2.5" />
        </svg>
      `;
    default:
      return '';
  }
}

/**
 * Create a controller managing the inline AI status pill above the chat composer.
 */
export function createInlineAiStatusController(getRootEl) {
  let currentStage = 'idle';
  let currentLabel = '';
  let currentDetail = '';
  let wasActive = false;
  let hasRun = false;
  let startedAt = 0;
  let elapsedSec = 0;
  let tickTimer = null;
  let hideTimer = null;
  let sessionKey = null;

  function stopTimers() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function renderTimerNode(root) {
    const timerEl = root.querySelector('.ai-status-timer');
    if (!timerEl) return;
    if (!hasRun) {
      timerEl.textContent = '';
      timerEl.classList.add('hidden');
      return;
    }
    timerEl.textContent = formatElapsedSeconds(elapsedSec);
    timerEl.classList.remove('hidden');
  }

  function startTicking() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (!startedAt) return;
      elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      const root = getRootEl();
      if (root) renderTimerNode(root);
    }, 1000);
  }

  function hideImmediately() {
    stopTimers();
    currentStage = 'idle';
    currentLabel = '';
    currentDetail = '';
    wasActive = false;
    hasRun = false;
    startedAt = 0;
    elapsedSec = 0;
    const root = getRootEl();
    if (root) {
      root.classList.remove('is-visible', 'is-active', 'is-shimmer');
      root.dataset.stage = 'idle';
    }
  }

  function reset(nextSessionKey = null) {
    if (nextSessionKey !== null && nextSessionKey === sessionKey) return;
    sessionKey = nextSessionKey;
    hideImmediately();
  }

  function setStatus(stage, label, detail = '') {
    const root = getRootEl();
    if (!root) return;

    const normalized = stage || 'idle';
    const isActive = ACTIVE_STAGES.has(normalized);

    // If session is idle/ready and never actively ran in this view, stay quietly hidden
    if ((normalized === 'idle' || normalized === 'ready') && !wasActive && !hasRun) {
      hideImmediately();
      return;
    }

    // Transitioning from active -> ready/idle becomes a brief "done" summary with frozen duration
    let effectiveStage = normalized;
    let effectiveLabel = label;
    if ((normalized === 'idle' || normalized === 'ready') && (wasActive || hasRun)) {
      if (currentStage === 'done') {
        return; // Already showing done state waiting to auto-hide
      }
      effectiveStage = 'done';
      effectiveLabel = label && label !== '就绪' ? label : '已完成';
    }

    const effectiveActive = ACTIVE_STAGES.has(effectiveStage);

    // Start fresh elapsed timer when entering active state from inactive
    if (effectiveActive && !wasActive) {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      startedAt = Date.now();
      elapsedSec = 0;
      hasRun = true;
      wasActive = true;
      startTicking();
    } else if (effectiveActive && wasActive) {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      startTicking();
    } else if (!effectiveActive) {
      // Settled into done or error
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      if (startedAt) {
        elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      }
      wasActive = false;
    }

    const stageChanged = effectiveStage !== currentStage;
    const labelChanged = effectiveLabel !== currentLabel;
    const detailChanged = detail !== currentDetail;

    currentStage = effectiveStage;
    currentLabel = effectiveLabel;
    currentDetail = detail;

    root.dataset.stage = effectiveStage;
    root.classList.add('is-visible');
    root.classList.toggle('is-active', effectiveActive);
    root.classList.toggle('is-shimmer', effectiveActive && effectiveStage !== 'waiting');

    const iconSlot = root.querySelector('.ai-status-icon-slot');
    if (iconSlot && stageChanged) {
      iconSlot.innerHTML = renderAiStatusIconSvg(effectiveStage, 15);
      iconSlot.classList.remove('is-pop');
      void iconSlot.offsetWidth;
      iconSlot.classList.add('is-pop');
    }

    const labelSlot = root.querySelector('.ai-status-label');
    if (labelSlot && (labelChanged || stageChanged)) {
      labelSlot.textContent = effectiveLabel || '';
      labelSlot.classList.remove('is-swap');
      void labelSlot.offsetWidth;
      labelSlot.classList.add('is-swap');
    }

    const detailSlot = root.querySelector('.ai-status-detail');
    if (detailSlot && (detailChanged || stageChanged)) {
      if (detail) {
        detailSlot.textContent = detail;
        detailSlot.classList.remove('hidden');
      } else {
        detailSlot.textContent = '';
        detailSlot.classList.add('hidden');
      }
    }

    renderTimerNode(root);

    // Schedule quiet auto-collapse for terminal states (done / error)
    if (effectiveStage === 'done' || effectiveStage === 'error') {
      if (hideTimer) clearTimeout(hideTimer);
      const holdMs = effectiveStage === 'error' ? ERROR_HOLD_MS : DONE_HOLD_MS;
      hideTimer = setTimeout(() => {
        hideImmediately();
      }, holdMs);
    }
  }

  return {
    setStatus,
    reset,
    hide: hideImmediately,
    getStage: () => currentStage,
  };
}
