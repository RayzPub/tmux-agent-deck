/**
 * In-Place Confirmation Micro-Interactions
 * Replaces jarring browser native confirm() dialogs with:
 *  1) morphInlineConfirm: button morphs in place into a recessed pill with animated trash-lid icon + check/cancel circles
 *  2) popoverInlineConfirm: anchored lightweight confirmation pill for tight icon toolbars (supports 1-line reassuring note)
 */

const DEFAULT_TIMEOUT_MS = 5000;
const activeMorphs = new WeakMap();
let activePopoverCleanup = null;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trashIconSvg() {
  return `
    <svg class="ic-trash-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <g class="ic-trash-lid">
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </g>
      <path class="ic-trash-bin" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  `;
}

function powerIconSvg() {
  return `
    <svg class="ic-power-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  `;
}

function checkSvg() {
  return `
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  `;
}

function closeSvg() {
  return `
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  `;
}

/**
 * Dismiss any currently open confirm popover
 */
export function closeActiveConfirmPopover() {
  if (typeof activePopoverCleanup === 'function') {
    activePopoverCleanup();
    activePopoverCleanup = null;
  }
}

/**
 * Morph a trigger button in place into a recessed confirmation pill: [ trash-lid | ✓ | ✕ ]
 * Clicking outside, pressing Escape, clicking ✕, or waiting timeoutMs smoothly restores the original button.
 */
export function morphInlineConfirm(triggerEl, options = {}) {
  if (!triggerEl || !triggerEl.parentNode) return;
  if (activeMorphs.has(triggerEl)) {
    return; // Already armed
  }

  const {
    label = '',
    confirmTitle = '确认执行',
    cancelTitle = '取消',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    compact = false,
    onConfirm,
    onCancel,
  } = options;

  const pill = document.createElement('div');
  pill.className = `ic-morph-pill${compact ? ' is-compact' : ''}`;
  pill.setAttribute('role', 'group');
  pill.setAttribute('aria-label', label || confirmTitle);
  pill.innerHTML = `
    <span class="ic-morph-lead" aria-hidden="true">
      ${trashIconSvg()}
      ${label ? `<span class="ic-morph-label">${escapeHtml(label)}</span>` : ''}
    </span>
    <span class="ic-morph-actions">
      <button type="button" class="ic-circle-btn ic-circle-confirm" title="${escapeHtml(confirmTitle)}" aria-label="${escapeHtml(confirmTitle)}">
        ${checkSvg()}
      </button>
      <button type="button" class="ic-circle-btn ic-circle-cancel" title="${escapeHtml(cancelTitle)}" aria-label="${escapeHtml(cancelTitle)}">
        ${closeSvg()}
      </button>
    </span>
  `;

  // Hide trigger cleanly without shifting DOM ownership
  const prevDisplay = triggerEl.style.display;
  triggerEl.style.display = 'none';
  triggerEl.insertAdjacentElement('afterend', pill);

  let cleaned = false;
  let timer = null;

  const restore = (invokeCancel = false) => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onKeyDown, true);
    activeMorphs.delete(triggerEl);

    pill.classList.remove('is-open');
    setTimeout(() => {
      if (pill.parentNode) pill.parentNode.removeChild(pill);
      if (triggerEl && document.body.contains(triggerEl)) {
        triggerEl.style.display = prevDisplay;
      }
    }, 150);

    if (invokeCancel && typeof onCancel === 'function') {
      onCancel();
    }
  };

  const onOutsidePointer = (e) => {
    if (!pill.contains(e.target)) {
      restore(true);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      restore(true);
    }
  };

  const confirmBtn = pill.querySelector('.ic-circle-confirm');
  const cancelBtn = pill.querySelector('.ic-circle-cancel');

  confirmBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    pill.classList.add('is-confirmed');
    try {
      if (typeof onConfirm === 'function') {
        await onConfirm();
      }
    } finally {
      restore(false);
    }
  });

  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    restore(true);
  });

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  activeMorphs.set(triggerEl, { restore });

  requestAnimationFrame(() => {
    pill.classList.add('is-open');
    confirmBtn.focus({ preventScroll: true });
  });

  // Delay outside-click registration past current click tick
  setTimeout(() => {
    if (!cleaned) {
      document.addEventListener('pointerdown', onOutsidePointer, true);
      document.addEventListener('keydown', onKeyDown, true);
    }
  }, 0);

  if (timeoutMs > 0) {
    timer = setTimeout(() => restore(true), timeoutMs);
  }
}

/**
 * Anchored floating confirmation pill for compact icon buttons (e.g. workspace remove, logout)
 * where in-place expansion would clip or wrap the surrounding toolbar.
 */
export function popoverInlineConfirm(anchorEl, options = {}) {
  closeActiveConfirmPopover();
  if (!anchorEl) return;

  const {
    title = '确认执行此操作？',
    description = '',
    confirmLabel = '确认',
    cancelLabel = '取消',
    icon = 'trash', // 'trash' | 'power'
    danger = true,
    timeoutMs = 8000,
    onConfirm,
    onCancel,
  } = options;

  const pop = document.createElement('div');
  pop.className = `ic-popover${danger ? ' is-danger' : ''}`;
  pop.setAttribute('role', 'alertdialog');
  pop.setAttribute('aria-label', title);
  pop.innerHTML = `
    <div class="ic-popover-head">
      <span class="ic-popover-icon" aria-hidden="true">
        ${icon === 'power' ? powerIconSvg() : trashIconSvg()}
      </span>
      <div class="ic-popover-text">
        <div class="ic-popover-title">${escapeHtml(title)}</div>
        ${description ? `<div class="ic-popover-desc">${escapeHtml(description)}</div>` : ''}
      </div>
    </div>
    <div class="ic-popover-footer">
      <button type="button" class="ic-popover-btn ic-popover-cancel">${escapeHtml(cancelLabel)}</button>
      <button type="button" class="ic-popover-btn ic-popover-confirm">${escapeHtml(confirmLabel)}</button>
    </div>
  `;

  document.body.appendChild(pop);

  // Position smartly around anchorEl with viewport clamping
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const margin = 10;
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - popRect.width / 2;

  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - popRect.height - 8);
  }
  if (left < margin) {
    left = margin;
  } else if (left + popRect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - popRect.width - margin);
  }

  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;

  let cleaned = false;
  let timer = null;

  const close = (invokeCancel = false) => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onViewportChange);
    if (activePopoverCleanup === close) {
      activePopoverCleanup = null;
    }
    pop.classList.remove('is-open');
    setTimeout(() => {
      if (pop.parentNode) pop.parentNode.removeChild(pop);
    }, 160);
    if (invokeCancel && typeof onCancel === 'function') {
      onCancel();
    }
  };

  const onOutside = (e) => {
    if (!pop.contains(e.target) && !anchorEl.contains(e.target)) {
      close(true);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  };

  const onViewportChange = () => close(false);

  const confirmBtn = pop.querySelector('.ic-popover-confirm');
  const cancelBtn = pop.querySelector('.ic-popover-cancel');

  confirmBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      if (typeof onConfirm === 'function') {
        await onConfirm();
      }
    } finally {
      close(false);
    }
  });

  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    close(true);
  });

  activePopoverCleanup = close;

  requestAnimationFrame(() => {
    pop.classList.add('is-open');
    confirmBtn.focus({ preventScroll: true });
  });

  setTimeout(() => {
    if (!cleaned) {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onViewportChange);
    }
  }, 0);

  if (timeoutMs > 0) {
    timer = setTimeout(() => close(true), timeoutMs);
  }
}
