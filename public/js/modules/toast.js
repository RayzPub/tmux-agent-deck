/**
 * Global Toast Notification System
 * Concentric-corner cards with animated SVG status glyphs, dual-theme adaptation,
 * hover pause, stack limit, and prefers-reduced-motion support.
 */

const MAX_TOASTS = 4;
const DEFAULT_DURATIONS = {
  default: 3500,
  info: 3800,
  success: 3200,
  warning: 4500,
  error: 5200,
  loading: 0, // persistent until updated or dismissed
};

const activeToasts = new Map();
let toastCounter = 0;
let viewportEl = null;

function isReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function ensureViewport() {
  if (viewportEl && document.body.contains(viewportEl)) {
    return viewportEl;
  }
  viewportEl = document.getElementById('ccnowToastViewport');
  if (!viewportEl) {
    viewportEl = document.createElement('div');
    viewportEl.id = 'ccnowToastViewport';
    viewportEl.className = 'ccnow-toast-viewport';
    viewportEl.setAttribute('aria-live', 'polite');
    viewportEl.setAttribute('aria-relevant', 'additions text');
    document.body.appendChild(viewportEl);
  }
  return viewportEl;
}

function renderGlyphSvg(type) {
  switch (type) {
    case 'success':
      return `
        <svg class="ccnow-toast-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ccnow-glyph-draw" pathLength="1" d="M6 12.5l4 4 8-9" />
        </svg>
      `;
    case 'error':
      return `
        <svg class="ccnow-toast-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ccnow-glyph-draw" pathLength="1" d="M7.5 7.5l9 9" />
          <path class="ccnow-glyph-draw ccnow-glyph-draw-delay" pathLength="1" d="M16.5 7.5l-9 9" />
        </svg>
      `;
    case 'warning':
      return `
        <svg class="ccnow-toast-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ccnow-glyph-draw" pathLength="1" d="M12 6.5v6.5" />
          <circle class="ccnow-glyph-dot" cx="12" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      `;
    case 'info':
      return `
        <svg class="ccnow-toast-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle class="ccnow-glyph-dot" cx="12" cy="7.2" r="1.4" fill="currentColor" stroke="none" />
          <path class="ccnow-glyph-draw" pathLength="1" d="M12 11.2v6.3" />
        </svg>
      `;
    case 'loading':
      return `
        <svg class="ccnow-toast-svg ccnow-toast-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8" stroke-opacity="0.24" />
          <path d="M12 4a8 8 0 0 1 8 8" />
        </svg>
      `;
    default:
      return `
        <svg class="ccnow-toast-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="ccnow-glyph-draw" pathLength="1" d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9L12 3z" />
        </svg>
      `;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function splitMultiline(message, explicitDescription) {
  const raw = String(message ?? '').trim();
  if (explicitDescription) {
    return { title: raw, description: String(explicitDescription).trim() };
  }
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return { title: raw, description: '' };
  }
  return { title: lines[0], description: lines.slice(1).join(' · ') };
}

function scheduleDismiss(entry) {
  clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.duration || entry.duration <= 0) return;
  entry.startedAt = performance.now();
  entry.timer = setTimeout(() => {
    dismissToast(entry.id);
  }, entry.remaining);
}

function pauseDismiss(entry) {
  if (!entry.timer) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  const elapsed = performance.now() - entry.startedAt;
  entry.remaining = Math.max(400, entry.remaining - elapsed);
}

function buildToastInnerHtml(type, title, description, action) {
  const safeTitle = escapeHtml(title);
  const safeDesc = description ? `<div class="ccnow-toast-desc">${escapeHtml(description)}</div>` : '';
  const actionHtml = action && action.label
    ? `<button type="button" class="ccnow-toast-action">${escapeHtml(action.label)}</button>`
    : '';

  return `
    <span class="ccnow-toast-tile ccnow-toast-tile-${type}">
      ${renderGlyphSvg(type)}
    </span>
    <div class="ccnow-toast-body">
      <div class="ccnow-toast-title">${safeTitle}</div>
      ${safeDesc}
    </div>
    ${actionHtml}
    <button type="button" class="ccnow-toast-close" aria-label="关闭提示" title="关闭">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  `;
}

function bindToastControls(entry) {
  const closeBtn = entry.el.querySelector('.ccnow-toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissToast(entry.id);
    });
  }
  const actionBtn = entry.el.querySelector('.ccnow-toast-action');
  if (actionBtn && entry.action && typeof entry.action.onClick === 'function') {
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        entry.action.onClick();
      } finally {
        dismissToast(entry.id);
      }
    });
  }
}

export function dismissToast(id) {
  const entry = activeToasts.get(id);
  if (!entry || entry.leaving) return;
  entry.leaving = true;
  clearTimeout(entry.timer);
  entry.timer = null;

  const removeNow = () => {
    activeToasts.delete(id);
    if (entry.el && entry.el.parentNode) {
      entry.el.parentNode.removeChild(entry.el);
    }
  };

  if (isReducedMotion()) {
    removeNow();
    return;
  }

  entry.el.classList.remove('is-visible');
  entry.el.classList.add('is-leaving');
  setTimeout(removeNow, 220);
}

export function dismissAllToasts() {
  for (const id of Array.from(activeToasts.keys())) {
    dismissToast(id);
  }
}

export function updateToast(id, message, options = {}) {
  const entry = activeToasts.get(id);
  if (!entry || entry.leaving) {
    return showToast(message, options);
  }
  const type = options.type || entry.type || 'default';
  const { title, description } = splitMultiline(message, options.description);
  const duration = options.duration !== undefined
    ? options.duration
    : (DEFAULT_DURATIONS[type] ?? DEFAULT_DURATIONS.default);

  entry.type = type;
  entry.action = options.action || null;
  entry.duration = duration;
  entry.remaining = duration;

  entry.el.dataset.type = type;
  entry.el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  entry.el.innerHTML = buildToastInnerHtml(type, title, description, entry.action);
  bindToastControls(entry);

  // Subtle tile bump when transitioning from loading -> result
  const tile = entry.el.querySelector('.ccnow-toast-tile');
  if (tile && !isReducedMotion()) {
    tile.classList.add('is-bumping');
    setTimeout(() => tile.classList.remove('is-bumping'), 380);
  }

  scheduleDismiss(entry);
  return id;
}

export function showToast(message, options = {}) {
  const opts = typeof options === 'number' ? { duration: options } : (options || {});
  const type = opts.type || 'default';
  const { title, description } = splitMultiline(message, opts.description);
  const duration = opts.duration !== undefined
    ? opts.duration
    : (DEFAULT_DURATIONS[type] ?? DEFAULT_DURATIONS.default);

  // Deduplicate identical active toast if requested or if same text/type is already visible
  if (opts.id && activeToasts.has(opts.id)) {
    return updateToast(opts.id, message, { ...opts, type, duration });
  }
  for (const existing of activeToasts.values()) {
    if (!existing.leaving && existing.type === type && existing.title === title && existing.description === description) {
      existing.duration = duration;
      existing.remaining = duration;
      scheduleDismiss(existing);
      return existing.id;
    }
  }

  const vp = ensureViewport();

  // Enforce stack limit by dismissing oldest non-loading toast first
  if (activeToasts.size >= MAX_TOASTS) {
    for (const old of activeToasts.values()) {
      if (!old.leaving && old.type !== 'loading') {
        dismissToast(old.id);
        break;
      }
    }
  }

  const id = opts.id || `toast-${++toastCounter}`;
  const card = document.createElement('div');
  card.className = 'ccnow-toast';
  card.dataset.toastId = id;
  card.dataset.type = type;
  card.setAttribute('role', type === 'error' ? 'alert' : 'status');
  card.innerHTML = buildToastInnerHtml(type, title, description, opts.action || null);

  const entry = {
    id,
    type,
    title,
    description,
    action: opts.action || null,
    el: card,
    duration,
    remaining: duration,
    startedAt: 0,
    timer: null,
    leaving: false,
  };

  bindToastControls(entry);

  card.addEventListener('mouseenter', () => pauseDismiss(entry));
  card.addEventListener('mouseleave', () => scheduleDismiss(entry));

  activeToasts.set(id, entry);
  vp.appendChild(card);

  if (isReducedMotion()) {
    card.classList.add('is-visible');
  } else {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        card.classList.add('is-visible');
      });
    });
  }

  scheduleDismiss(entry);
  return id;
}

export const toast = {
  show: (msg, opts) => showToast(msg, { ...(typeof opts === 'object' ? opts : { duration: opts }), type: 'default' }),
  success: (msg, opts) => showToast(msg, { ...(typeof opts === 'object' ? opts : { duration: opts }), type: 'success' }),
  error: (msg, opts) => showToast(msg, { ...(typeof opts === 'object' ? opts : { duration: opts }), type: 'error' }),
  warning: (msg, opts) => showToast(msg, { ...(typeof opts === 'object' ? opts : { duration: opts }), type: 'warning' }),
  info: (msg, opts) => showToast(msg, { ...(typeof opts === 'object' ? opts : { duration: opts }), type: 'info' }),
  loading: (msg, opts) => showToast(msg, { ...(typeof opts === 'object' ? opts : { duration: opts }), type: 'loading', duration: 0 }),
  update: updateToast,
  dismiss: dismissToast,
  dismissAll: dismissAllToasts,
  async promise(promiseOrFn, messages = {}) {
    const id = toast.loading(messages.loading || '处理中...');
    try {
      const result = await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
      const okMsg = typeof messages.success === 'function' ? messages.success(result) : (messages.success || '操作成功');
      updateToast(id, okMsg, { type: 'success' });
      return result;
    } catch (err) {
      const errMsg = typeof messages.error === 'function' ? messages.error(err) : (messages.error || err?.message || '操作失败');
      updateToast(id, errMsg, { type: 'error' });
      throw err;
    }
  },
};

if (typeof window !== 'undefined') {
  window.ccnowToast = toast;
}
