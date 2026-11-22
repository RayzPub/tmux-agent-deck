import { state } from './state.js';

/**
 * Safely escape HTML special characters for dynamic text insertion
 */
export function escapeHtmlText(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve the human-readable display title for a session from cache (falling back to technical sessionName)
 */
export function getSessionDisplayTitle(sessionName, sessionList = state.sessionListCache) {
  if (!sessionName) return '';
  if (Array.isArray(sessionList)) {
    const found = sessionList.find(s => s && s.name === sessionName);
    if (found) {
      if (found.displayTitle && found.displayTitle.trim()) return found.displayTitle.trim();
      if (found.title && found.title.trim()) return found.title.trim();
    }
  }
  return sessionName;
}

/**
 * Synchronize an updated session display title across sessionListCache, sidebar card, workspace tabs, and headers
 */
export function syncSessionDisplayTitle(sessionName, newDisplayTitle, metaPatch = {}) {
  if (!sessionName || !newDisplayTitle) return;
  const cleanTitle = String(newDisplayTitle).trim();
  if (!cleanTitle) return;

  // 1. Update sessionListCache
  let changed = false;
  if (Array.isArray(state.sessionListCache)) {
    const target = state.sessionListCache.find(s => s && s.name === sessionName);
    if (target) {
      if (target.displayTitle !== cleanTitle) changed = true;
      target.displayTitle = cleanTitle;
      if (metaPatch.title !== undefined) target.title = metaPatch.title;
      if (metaPatch.autoTitle !== undefined) target.autoTitle = Boolean(metaPatch.autoTitle);
      if (metaPatch.titleSource !== undefined) target.titleSource = metaPatch.titleSource;
      if (metaPatch.seqId !== undefined && metaPatch.seqId !== null) target.seqId = metaPatch.seqId;
    }
  }

  // 2. Update workspace tab object + live tab DOM
  let tabUpdated = false;
  if (Array.isArray(state.tabs)) {
    const tab = state.tabs.find(t => t.type === 'terminal' && t.id === sessionName);
    if (tab && tab.name !== cleanTitle) {
      tab.name = cleanTitle;
      tabUpdated = true;
    }
  }

  const workspaceTabs = document.getElementById('workspaceTabs');
  if (workspaceTabs) {
    const tabEls = workspaceTabs.querySelectorAll('.workspace-tab.terminal-tab');
    tabEls.forEach(el => {
      if (el.getAttribute('data-id') === sessionName) {
        const labelSpan = el.querySelector('span');
        if (labelSpan && labelSpan.textContent !== cleanTitle) {
          labelSpan.textContent = cleanTitle;
        }
        el.setAttribute('title', `${cleanTitle} (${sessionName})`);
      }
    });
  }

  if (tabUpdated) {
    try {
      localStorage.setItem('deckTabs', JSON.stringify(state.tabs));
    } catch (_) {}
  }

  // 3. Update sidebar session card in-place without flashing DOM
  const sessionList = document.getElementById('sessionList');
  if (sessionList) {
    const cards = sessionList.querySelectorAll('.session-card');
    cards.forEach(card => {
      if (card.dataset.sessionName === sessionName) {
        const nameEl = card.querySelector('.session-name');
        if (nameEl && nameEl.textContent !== cleanTitle) {
          nameEl.textContent = cleanTitle;
          nameEl.setAttribute('title', `${cleanTitle} (ID: ${sessionName})`);
        }
      }
    });
  }

  // 4. Update active terminal header
  if (state.currentSession === sessionName) {
    const activeNameEl = document.getElementById('activeSessionName');
    if (activeNameEl && activeNameEl.textContent !== cleanTitle) {
      activeNameEl.textContent = cleanTitle;
      activeNameEl.setAttribute('title', `会话 ID: ${sessionName}`);
    }
  }

  return changed || tabUpdated;
}

/**
 * Automatically calculates the next available session name with an auto-incrementing serial number.
 * Supports styles:
 * - Hyphenated: dev-1 -> dev-2, shell -> shell-2
 * - Underscore: dev_1 -> dev_2
 * - Direct digits: agy2 -> agy3, cctest -> cctest3 (when existing sessions follow unseparated numbers)
 * - Retains words like win11 or gpt4 as base (win11 -> win11-2) unless the word without digits is an existing base
 */
export function getNextAvailableSessionName(requestedName, existingNames = []) {
  if (!requestedName) requestedName = 'session';
  const nameSet = new Set(existingNames);
  if (!nameSet.has(requestedName)) {
    return requestedName;
  }

  const matchSep = requestedName.match(/^(.*?)([-_])(\d+)$/);
  const matchNoSep = requestedName.match(/^(.*?)(\d+)$/);

  let base = requestedName;
  let sep = '-';
  let startNum = 2;

  if (matchSep) {
    base = matchSep[1] || requestedName;
    sep = matchSep[2];
    startNum = parseInt(matchSep[3], 10) + 1;
  } else if (matchNoSep && nameSet.has(matchNoSep[1])) {
    base = matchNoSep[1];
    sep = '';
    startNum = parseInt(matchNoSep[2], 10) + 1;
  } else {
    base = requestedName;
    const hasUnseparated = existingNames.some(n => new RegExp(`^${base}\\d+$`).test(n));
    const hasUnderscore = existingNames.some(n => new RegExp(`^${base}_\\d+$`).test(n));
    if (hasUnseparated) {
      sep = '';
    } else if (hasUnderscore) {
      sep = '_';
    } else {
      sep = '-';
    }
    startNum = 2;
  }

  let num = startNum;
  while (nameSet.has(`${base}${sep}${num}`)) {
    num++;
  }
  return `${base}${sep}${num}`;
}
