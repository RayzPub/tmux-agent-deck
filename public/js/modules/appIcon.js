import { state } from './state.js';

let availableThemes = [];
let selectedThemeId = null;

export function applyAppIcon(theme) {
  if (!theme) return;
  const themeId = typeof theme === 'string' ? theme : theme.id;
  
  // Update state
  state.appIcon = themeId;

  // 1. Update Favicon & PWA icon links
  const appFavicon = document.getElementById('appFavicon');
  if (appFavicon) {
    appFavicon.href = `/icons/${themeId}/favicon.png?v=${Date.now()}`;
  }
  const appIcon192 = document.getElementById('appIcon192');
  if (appIcon192) {
    appIcon192.href = `/icons/${themeId}/icon-192.png?v=${Date.now()}`;
  }
  const appAppleIcon = document.getElementById('appAppleIcon');
  if (appAppleIcon) {
    appAppleIcon.href = `/icons/${themeId}/apple-touch-icon.png?v=${Date.now()}`;
  }
}

export async function loadAppIcons() {
  try {
    const res = await fetch('/api/app-icons');
    if (res.ok) {
      const data = await res.json();
      availableThemes = data.themes || [];
      if (data.activeTheme) {
        selectedThemeId = data.activeTheme.id;
        applyAppIcon(data.activeTheme);
      }
      return data;
    }
  } catch (err) {
    console.error('Failed to load app icons:', err);
  }
  return null;
}

export function renderAppIconsGrid() {
  const container = document.getElementById('appIconsGrid');
  const hintEl = document.getElementById('appIconThemeHint');
  if (!container) return;

  container.innerHTML = '';
  if (!availableThemes || availableThemes.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 11px; padding: 20px;">暂无可用图标主题</div>';
    return;
  }

  availableThemes.forEach(theme => {
    const isSelected = (theme.id === selectedThemeId);
    const card = document.createElement('div');
    card.className = `app-icon-card ${isSelected ? 'selected' : ''}`;
    card.dataset.themeId = theme.id;

    card.innerHTML = `
      ${isSelected ? '<div class="app-icon-badge"><i data-lucide="check" style="width: 12px; height: 12px; stroke-width: 3;"></i></div>' : ''}
      <img src="${theme.preview || `/icons/${theme.id}/icon-192.png`}" class="app-icon-preview" alt="${theme.name}">
      <div class="app-icon-name">${theme.name}</div>
      <div class="app-icon-sub">${theme.subtitle || ''}</div>
    `;

    card.addEventListener('click', () => {
      selectedThemeId = theme.id;
      renderAppIconsGrid();
      if (hintEl) {
        hintEl.textContent = `已选择: ${theme.name} (点击右侧保存生效)`;
      }
    });

    container.appendChild(card);
  });

  if (hintEl && !hintEl.textContent) {
    const cur = availableThemes.find(t => t.id === selectedThemeId);
    if (cur) {
      hintEl.textContent = `当前图标: ${cur.name}`;
    }
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

export function initAppIconAdminPanel() {
  const tabAppIconsBtn = document.getElementById('tabAppIconsBtn');
  const tabInviteCodesBtn = document.getElementById('tabInviteCodesBtn');
  const tabAgentsBtn = document.getElementById('tabAgentsBtn');
  const tabContentAppIcons = document.getElementById('tabContentAppIcons');
  const tabContentInviteCodes = document.getElementById('tabContentInviteCodes');
  const tabContentAgents = document.getElementById('tabContentAgents');
  const saveAppIconBtn = document.getElementById('saveAppIconBtn');
  const hintEl = document.getElementById('appIconThemeHint');

  if (tabAppIconsBtn && tabContentAppIcons) {
    tabAppIconsBtn.addEventListener('click', async () => {
      tabAppIconsBtn.classList.add('active');
      if (tabInviteCodesBtn) tabInviteCodesBtn.classList.remove('active');
      if (tabAgentsBtn) tabAgentsBtn.classList.remove('active');

      tabContentAppIcons.classList.remove('hidden');
      if (tabContentInviteCodes) tabContentInviteCodes.classList.add('hidden');
      if (tabContentAgents) tabContentAgents.classList.add('hidden');

      await loadAppIcons();
      renderAppIconsGrid();
    });
  }

  if (saveAppIconBtn) {
    saveAppIconBtn.addEventListener('click', async () => {
      if (!selectedThemeId) return;
      saveAppIconBtn.disabled = true;
      const originalText = saveAppIconBtn.innerHTML;
      saveAppIconBtn.innerHTML = '<span class="btn-text">保存中...</span>';

      try {
        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appIcon: selectedThemeId })
        });

        if (res.ok) {
          const savedTheme = availableThemes.find(t => t.id === selectedThemeId);
          if (savedTheme) {
            applyAppIcon(savedTheme);
          }
          if (hintEl) {
            hintEl.textContent = `✅ 应用图标已成功切换为 [ ${savedTheme ? savedTheme.name : selectedThemeId} ]`;
          }
        } else {
          const errData = await res.json();
          alert(errData.error || '保存应用图标失败');
        }
      } catch (err) {
        console.error('Failed to save app icon:', err);
        alert('保存应用图标时发生网络错误');
      } finally {
        saveAppIconBtn.disabled = false;
        saveAppIconBtn.innerHTML = originalText;
      }
    });
  }
}
