import { state } from './state.js';

export function updateThemeButtonUI(isLight) {
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (!themeToggleBtn) return;
  const textSpan = themeToggleBtn.querySelector('span');
  const icon = themeToggleBtn.querySelector('i, svg');
  if (isLight) {
    if (textSpan) textSpan.textContent = 'MINIMAL';
    if (icon) {
      icon.setAttribute('data-lucide', 'sun');
    }
    themeToggleBtn.classList.add('active');
  } else {
    if (textSpan) textSpan.textContent = 'CYBERPUNK';
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
  const meta = document.getElementById('pwaThemeColor');
  if (meta) {
    // In light mode, make it white (#ffffff) to blend with the light theme header
    // In dark mode, make it cyan (#00f0ff) to match the cyberpunk neon theme color
    meta.setAttribute('content', isLight ? '#ffffff' : '#00f0ff');
  }
}

export function initTheme() {
  const savedTheme = localStorage.getItem('theme-style');
  const isLight = savedTheme === 'light-minimalist';
  if (isLight) {
    document.body.classList.add('light-minimalist');
    updateThemeButtonUI(true);
  } else {
    document.body.classList.remove('light-minimalist');
    updateThemeButtonUI(false);
  }
  updateMetaThemeColor(isLight);
}

export function toggleTheme() {
  const isLight = document.body.classList.toggle('light-minimalist');
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
