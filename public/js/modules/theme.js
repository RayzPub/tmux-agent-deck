import { state } from './state.js';

export function updateThemeButtonUI(isLight) {
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (!themeToggleBtn) return;
  const textSpan = themeToggleBtn.querySelector('span');
  const icon = themeToggleBtn.querySelector('i, svg');
  if (isLight) {
    if (textSpan) textSpan.textContent = '浅色模式';
    if (icon) {
      icon.setAttribute('data-lucide', 'sun');
    }
    themeToggleBtn.classList.add('active');
  } else {
    if (textSpan) textSpan.textContent = '深色模式';
    if (icon) {
      icon.setAttribute('data-lucide', 'moon');
    }
    themeToggleBtn.classList.remove('active');
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

export function updateMetaThemeColor(isLight) {
  const bg = isLight ? '#ffffff' : '#17191e';
  const meta = document.getElementById('pwaThemeColor') || document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // In light mode: #ffffff; In dark mode: #17191e (matches --c-bg & --c-side)
    meta.setAttribute('content', bg);
    if (meta.parentNode) {
      const clone = meta.cloneNode(true);
      meta.parentNode.replaceChild(clone, meta);
    }
  }
  const statusBarMeta = document.getElementById('appleStatusBarMeta') || document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (statusBarMeta) {
    // In light mode, use 'default' so iOS uses dark icons/text without rendering dark gradient scrim overlay
    // In dark mode, use 'black-translucent' so the dark space theme blends with system status bar
    statusBarMeta.setAttribute('content', isLight ? 'default' : 'black-translucent');
    if (statusBarMeta.parentNode) {
      const statusClone = statusBarMeta.cloneNode(true);
      statusBarMeta.parentNode.replaceChild(statusClone, statusBarMeta);
    }
  }
  if (document.documentElement) {
    document.documentElement.style.removeProperty('background-color');
    document.documentElement.style.colorScheme = isLight ? 'light' : 'dark';
    document.documentElement.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      document.documentElement.style.transform = '';
    });
  }
  if (document.body) {
    document.body.style.removeProperty('background-color');
  }
}

export function initTheme() {
  const savedTheme = localStorage.getItem('theme-style');
  const isLight = savedTheme === 'light-minimalist';
  if (isLight) {
    document.documentElement.classList.add('light-minimalist');
    document.body.classList.add('light-minimalist');
    updateThemeButtonUI(true);
  } else {
    document.documentElement.classList.remove('light-minimalist');
    document.body.classList.remove('light-minimalist');
    updateThemeButtonUI(false);
  }
  updateMetaThemeColor(isLight);
}

export function toggleTheme() {
  const isLight = document.body.classList.toggle('light-minimalist');
  document.documentElement.classList.toggle('light-minimalist', isLight);
  localStorage.setItem('theme-style', isLight ? 'light-minimalist' : 'dark-cyberpunk');
  updateThemeButtonUI(isLight);
  updateMetaThemeColor(isLight);
  
  // Update all terminal instances themes
  for (const cached of state.sessionCache.values()) {
    if (cached && cached.term) {
      cached.term.options.theme = isLight ? state.themeConstants.LIGHT : state.themeConstants.DARK;
    }
  }

  // Update Monaco editor theme
  if (state.editorInstance && typeof monaco !== 'undefined') {
    monaco.editor.setTheme(isLight ? 'vs' : 'cyberTheme');
  }
}
