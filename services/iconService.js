const fs = require('fs');
const path = require('path');
const db = require('./dbService');

const PROJECT_ROOT = path.join(__dirname, '..');
const ICONS_BASE_DIR = path.join(PROJECT_ROOT, 'public', 'icons');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'public', 'images');

/**
 * Get list of all available icon themes
 */
function getThemes() {
  const themesPath = path.join(ICONS_BASE_DIR, 'themes.json');
  if (fs.existsSync(themesPath)) {
    try {
      return JSON.parse(fs.readFileSync(themesPath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse themes.json:', e);
    }
  }

  // Fallback: scan directory
  if (!fs.existsSync(ICONS_BASE_DIR)) return [];
  const dirs = fs.readdirSync(ICONS_BASE_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  const themes = [];
  for (const dir of dirs) {
    const metaPath = path.join(ICONS_BASE_DIR, dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        themes.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
      } catch (err) {}
    }
  }
  return themes;
}

/**
 * Get active icon theme metadata
 */
function getActiveTheme() {
  const settings = db.getSettings();
  const activeId = settings.appIcon || 'shape-diamond';
  const themes = getThemes();
  const matched = themes.find(t => t.id === activeId);
  if (matched) return matched;
  return themes[0] || {
    id: 'shape-diamond',
    name: '赛博菱形',
    preview: '/images/icon-192.png',
    favicon: '/images/favicon.png',
    appleTouchIcon: '/images/apple-touch-icon.png',
    icon192: '/images/icon-192.png',
    icon512: '/images/icon-512.png'
  };
}

/**
 * Set active icon theme and synchronize standard /images/ files
 */
function setActiveTheme(themeId) {
  const themes = getThemes();
  const theme = themes.find(t => t.id === themeId);
  if (!theme) {
    throw new Error(`Icon theme "${themeId}" not found.`);
  }

  const currentSettings = db.getSettings();
  currentSettings.appIcon = themeId;
  db.saveSettings(currentSettings);

  // Sync assets to public/images for maximum compatibility
  const sourceDir = path.join(ICONS_BASE_DIR, themeId);
  const filesToSync = [
    'favicon.png',
    'apple-touch-icon.png',
    'icon-192.png',
    'icon-512.png'
  ];

  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  for (const file of filesToSync) {
    const src = path.join(sourceDir, file);
    const dest = path.join(IMAGES_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  return { success: true, activeTheme: theme, settings: currentSettings };
}

module.exports = {
  getThemes,
  getActiveTheme,
  setActiveTheme
};
