const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PROJECT_ROOT, MULTI_USER_ENABLED } = require('../config');
const { getRunUser } = require('./tmuxService');

const chownToSudoUser = (dirPath) => {
  const runUser = getRunUser();
  if (runUser && process.env.USER === 'root') {
    try {
      execSync(`chown -R ${runUser}:${runUser} "${dirPath}"`);
    } catch (err) {
      console.warn(`[fileService] Could not chown ${dirPath} to ${runUser}: ${err.message}`);
    }
  }
};

const WORKSPACES_FILE = path.join(PROJECT_ROOT, 'workspaces.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const getHomeDir = () => {
  const runUser = getRunUser();
  if (runUser) {
    return `/home/${runUser}`;
  }
  return process.env.HOME || require('os').homedir();
};

const getUserWorkspaceRoot = (username) => {
  if (MULTI_USER_ENABLED && username) {
    const userRoot = path.join(PROJECT_ROOT, 'workspaces', username);
    if (!fs.existsSync(userRoot)) {
      fs.mkdirSync(userRoot, { recursive: true });
      chownToSudoUser(userRoot);
    }
    return userRoot;
  }
  return PROJECT_ROOT;
};

const getDefaultWorkspacePath = (username) => {
  const p = (MULTI_USER_ENABLED && username)
    ? path.join(PROJECT_ROOT, 'workspaces', username, 'default')
    : path.join(PROJECT_ROOT, 'workspaces', 'default');
    
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
    chownToSudoUser(p);
  }
  return p;
};

/**
 * Returns the per-user HOME directory (user_data/[username]/home).
 * This is set as $HOME when launching agent sessions so agents can write
 * their own config (shell history, local overrides) without polluting the
 * system home and without exposing config files in the workspace file browser.
 *
 * On first call it bootstraps the directory and creates read-only symlinks
 * for agent config directories (e.g. .claude, .agy) pointing to the
 * equivalent dirs in the real system home. This way agents find their API
 * keys and settings without the files being accessible via the workspace
 * file explorer.
 */
const getUserHomeDir = (username) => {
  const sysHome = getHomeDir();
  if (!MULTI_USER_ENABLED || !username) return sysHome;

  const userHome = path.join(PROJECT_ROOT, 'user_data', username, 'home');
  if (!fs.existsSync(userHome)) {
    fs.mkdirSync(userHome, { recursive: true });
    chownToSudoUser(path.join(PROJECT_ROOT, 'user_data', username));
  }

  // Suppress Ubuntu sudo hint and MOTD messages for new shells
  const sudoHintFile = path.join(userHome, '.sudo_as_admin_successful');
  if (!fs.existsSync(sudoHintFile)) {
    try {
      fs.writeFileSync(sudoHintFile, '');
      chownToSudoUser(sudoHintFile);
    } catch (e) {
      console.warn(`[userHome] Could not create .sudo_as_admin_successful: ${e.message}`);
    }
  }

  const hushloginFile = path.join(userHome, '.hushlogin');
  if (!fs.existsSync(hushloginFile)) {
    try {
      fs.writeFileSync(hushloginFile, '');
      chownToSudoUser(hushloginFile);
    } catch (e) {
      console.warn(`[userHome] Could not create .hushlogin: ${e.message}`);
    }
  }

  // Config dirs/files to symlink from sysHome into userHome.
  // These are read-only for the agent (symlink source is owned by root/ubuntu).
  // Users cannot see them via the workspace file browser.
  // Note: We DO NOT symlink the whole .claude folder anymore to prevent history/session sharing
  // and to allow users to customize their own proxy baseurl, token, and settings.
  
  // 1. Initialize user's private .claude directory
  const userClaudeDir = path.join(userHome, '.claude');
  let isSymlink = false;
  try {
    const stats = fs.lstatSync(userClaudeDir);
    if (stats.isSymbolicLink()) {
      isSymlink = true;
    }
  } catch (e) {
    // Doesn't exist
  }

  if (isSymlink) {
    try {
      fs.unlinkSync(userClaudeDir);
    } catch (e) {
      console.warn(`[userHome] Could not remove existing .claude symlink: ${e.message}`);
    }
  }

  if (!fs.existsSync(userClaudeDir)) {
    try {
      fs.mkdirSync(userClaudeDir, { recursive: true });
      chownToSudoUser(userClaudeDir);
      
      const sysSettingsPath = path.join(sysHome, '.claude', 'settings.json');
      const userSettingsPath = path.join(userClaudeDir, 'settings.json');
      if (fs.existsSync(sysSettingsPath)) {
        fs.copyFileSync(sysSettingsPath, userSettingsPath);
        chownToSudoUser(userSettingsPath);
      }
    } catch (e) {
      console.warn(`[userHome] Could not initialize private .claude directory: ${e.message}`);
    }
  }

  // 1.2 Initialize user's private .codex directory
  const userCodexDir = path.join(userHome, '.codex');
  let isCodexSymlink = false;
  try {
    const stats = fs.lstatSync(userCodexDir);
    if (stats.isSymbolicLink()) {
      isCodexSymlink = true;
    }
  } catch (e) {
    // Doesn't exist
  }

  if (isCodexSymlink) {
    try {
      fs.unlinkSync(userCodexDir);
    } catch (e) {
      console.warn(`[userHome] Could not remove existing .codex symlink: ${e.message}`);
    }
  }

  if (!fs.existsSync(userCodexDir)) {
    try {
      fs.mkdirSync(userCodexDir, { recursive: true });
      chownToSudoUser(userCodexDir);
      
      const sysSettingsPath = path.join(sysHome, '.codex', 'config.toml');
      const userSettingsPath = path.join(userCodexDir, 'config.toml');
      if (fs.existsSync(sysSettingsPath)) {
        fs.copyFileSync(sysSettingsPath, userSettingsPath);
        chownToSudoUser(userSettingsPath);
      }
    } catch (e) {
      console.warn(`[userHome] Could not initialize private .codex directory: ${e.message}`);
    }
  }

  // 2. Symlink other config files
  const configTargets = ['.agy', '.claude.json', '.config/anthropic', '.local/share/agy', '.gemini'];
  for (const rel of configTargets) {
    const src = path.join(sysHome, rel);
    const dest = path.join(userHome, rel);

    // Skip if source doesn't exist yet
    if (!fs.existsSync(src)) continue;

    // Skip if dest already exists (file, dir, or symlink)
    let destExists = false;
    try { fs.lstatSync(dest); destExists = true; } catch { /* not found */ }
    if (destExists) continue;

    try {
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        chownToSudoUser(destDir);
      }
      fs.symlinkSync(src, dest);
      // Ensure the symlink file itself is owned by root/ubuntu but we need to chown userHome just in case
    } catch (e) {
      // Non-fatal: agent will just not find pre-existing config
      console.warn(`[userHome] Could not symlink ${src} -> ${dest}: ${e.message}`);
    }
  }

  return userHome;
};

const resolveWorkspacePath = (p, username) => {
  if (!p) return '';
  
  if (MULTI_USER_ENABLED && username) {
    const userRoot = getUserWorkspaceRoot(username);

    // Resolve relative to userRoot (sandbox root)
    let target;
    if (path.isAbsolute(p)) {
      target = path.resolve(p);
    } else if (p.startsWith('~/') || p === '~') {
      const home = (username === 'admin') ? getHomeDir() : userRoot;
      target = p.startsWith('~/') ? path.resolve(p.replace('~', home)) : home;
    } else {
      target = path.resolve(userRoot, p);
    }

    // Sandbox check: only restrict regular users, let admin bypass
    if (username !== 'admin') {
      const relative = path.relative(userRoot, target);
      const isSafe = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (!isSafe) {
        return userRoot; // fallback to sandbox root
      }
    }
    return target;
  }

  let resolved = p;
  if (p.startsWith('~/') || p === '~') {
    resolved = p.replace('~', getHomeDir());
  }
  return path.resolve(resolved);
};

const readWorkspaces = (username) => {
  try {
    if (MULTI_USER_ENABLED && username) {
      const userWorkspacesFile = path.join(DATA_DIR, `workspaces_${username}.json`);
      if (fs.existsSync(userWorkspacesFile)) {
        const list = JSON.parse(fs.readFileSync(userWorkspacesFile, 'utf8'));
        if (Array.isArray(list)) {
          return list;
        }
      }

      // Auto-initialize with default workspace folder
      const defaultWorkspacePath = path.join(PROJECT_ROOT, 'workspaces', username, 'default');
      const defaultWorkspaces = [{ name: 'default', path: defaultWorkspacePath }];
      writeWorkspaces(defaultWorkspaces, username);

      if (!fs.existsSync(defaultWorkspacePath)) {
        fs.mkdirSync(defaultWorkspacePath, { recursive: true });
        chownToSudoUser(path.join(PROJECT_ROOT, 'workspaces', username));
      }
      return defaultWorkspaces;
    }

    if (fs.existsSync(WORKSPACES_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading workspaces file:', err);
  }
  return [];
};

const writeWorkspaces = (workspaces, username) => {
  try {
    if (MULTI_USER_ENABLED && username) {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const userWorkspacesFile = path.join(DATA_DIR, `workspaces_${username}.json`);
      fs.writeFileSync(userWorkspacesFile, JSON.stringify(workspaces, null, 2), 'utf8');
      return true;
    }

    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing workspaces file:', err);
    return false;
  }
};

const safeResolve = (workspacePath, reqPath, username) => {
  // Resolve the workspace root — may be an arbitrary registered absolute path
  const root = workspacePath ? resolveWorkspacePath(workspacePath, username) : getDefaultWorkspacePath(username);
  const resolved = path.resolve(root, reqPath || '.');
  
  // If username is admin, we allow accessing upper directories (bypass containment check)
  if (username === 'admin') {
    return resolved;
  }
  
  // Containment check: resolved file must be inside the workspace root itself
  const relative = path.relative(root, resolved);
  const isSafe = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  
  if (!isSafe) {
    throw new Error('Access denied: Out of workspace root');
  }
  return resolved;
};

const ensureBashrcSourcesApiKeys = (userHome) => {
  const bashrcPath = path.join(userHome, '.bashrc');
  const sourceLine = '[ -f ~/.api_keys ] && . ~/.api_keys';
  
  let content = '';
  if (fs.existsSync(bashrcPath)) {
    try {
      content = fs.readFileSync(bashrcPath, 'utf8');
    } catch (e) {}
  }
  
  if (!content.includes('.api_keys')) {
    try {
      fs.writeFileSync(bashrcPath, content.trim() + '\n' + sourceLine + '\n', 'utf8');
      chownToSudoUser(bashrcPath);
    } catch (err) {
      console.warn(`[fileService] Failed to append source line to .bashrc: ${err.message}`);
    }
  }
};

const updateUserKeysFile = (username, keys) => {
  if (!MULTI_USER_ENABLED || !username) return;

  const userHome = getUserHomeDir(username);
  const keysFilePath = path.join(userHome, '.api_keys');

  let lines = [];
  const shellescapeVal = (val) => {
    return "'" + val.replace(/'/g, "'\\''") + "'";
  };

  if (keys.claude) {
    lines.push(`export ANTHROPIC_API_KEY=${shellescapeVal(keys.claude)}`);
  }
  if (keys.claudeBaseUrl) {
    lines.push(`export ANTHROPIC_BASE_URL=${shellescapeVal(keys.claudeBaseUrl)}`);
  }
  if (keys.claudeModel) {
    lines.push(`export ANTHROPIC_MODEL=${shellescapeVal(keys.claudeModel)}`);
  }
  if (keys.codex) {
    lines.push(`export OPENAI_API_KEY=${shellescapeVal(keys.codex)}`);
  }
  if (keys.codexBaseUrl) {
    lines.push(`export OPENAI_BASE_URL=${shellescapeVal(keys.codexBaseUrl)}`);
    lines.push(`export OPENAI_API_BASE=${shellescapeVal(keys.codexBaseUrl)}`);
  }
  if (keys.codexModel) {
    lines.push(`export OPENAI_MODEL=${shellescapeVal(keys.codexModel)}`);
    lines.push(`export CODEX_MODEL=${shellescapeVal(keys.codexModel)}`);
  }

  try {
    fs.writeFileSync(keysFilePath, lines.join('\n') + '\n', 'utf8');
    chownToSudoUser(keysFilePath);
    ensureBashrcSourcesApiKeys(userHome);
  } catch (err) {
    console.error(`[fileService] Failed to write .api_keys for user ${username}:`, err);
  }

  // Update user's private .claude/settings.json
  const userClaudeDir = path.join(userHome, '.claude');
  if (fs.existsSync(userClaudeDir)) {
    const settingsPath = path.join(userClaudeDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {}
    }
    if (!settings.env) {
      settings.env = {};
    }
    if (keys.claude) {
      settings.env.ANTHROPIC_AUTH_TOKEN = keys.claude;
    }
    if (keys.claudeBaseUrl) {
      settings.env.ANTHROPIC_BASE_URL = keys.claudeBaseUrl;
    } else if (keys.claudeBaseUrl === '') {
      delete settings.env.ANTHROPIC_BASE_URL;
    }
    if (keys.claudeModel) {
      settings.model = keys.claudeModel;
      settings.env.ANTHROPIC_MODEL = keys.claudeModel;
    } else if (keys.claudeModel === '') {
      delete settings.model;
      delete settings.env.ANTHROPIC_MODEL;
    }
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      chownToSudoUser(settingsPath);
    } catch (err) {
      console.error(`[fileService] Failed to write settings.json for user ${username}:`, err);
    }
  }

  // Update user's private .codex/config.toml
  const userCodexDir = path.join(userHome, '.codex');
  if (fs.existsSync(userCodexDir)) {
    const configPath = path.join(userCodexDir, 'config.toml');
    let content = '';
    if (fs.existsSync(configPath)) {
      try {
        content = fs.readFileSync(configPath, 'utf8');
      } catch (e) {}
    }
    
    let lines = content.split('\n');
    let hasApiKey = false;
    let hasBaseUrl = false;
    let hasModel = false;
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('api_key =') || lines[i].trim().startsWith('api_key=')) {
        if (keys.codex) {
          lines[i] = `api_key = "${keys.codex.replace(/"/g, '\\"')}"`;
        }
        hasApiKey = true;
      }
      if (lines[i].trim().startsWith('base_url =') || lines[i].trim().startsWith('base_url=')) {
        if (keys.codexBaseUrl) {
          lines[i] = `base_url = "${keys.codexBaseUrl.replace(/"/g, '\\"')}"`;
        } else if (keys.codexBaseUrl === '') {
          lines[i] = '';
        }
        hasBaseUrl = true;
      }
      if (lines[i].trim().startsWith('model =') || lines[i].trim().startsWith('model=')) {
        if (keys.codexModel) {
          lines[i] = `model = "${keys.codexModel.replace(/"/g, '\\"')}"`;
        } else if (keys.codexModel === '') {
          lines[i] = '';
        }
        hasModel = true;
      }
    }
    
    if (!hasApiKey && keys.codex) {
      lines.push(`api_key = "${keys.codex.replace(/"/g, '\\"')}"`);
    }
    if (!hasBaseUrl && keys.codexBaseUrl) {
      lines.push(`base_url = "${keys.codexBaseUrl.replace(/"/g, '\\"')}"`);
    }
    if (!hasModel && keys.codexModel) {
      lines.push(`model = "${keys.codexModel.replace(/"/g, '\\"')}"`);
    }
    
    try {
      fs.writeFileSync(configPath, lines.filter(l => l !== '').join('\n') + '\n', 'utf8');
      chownToSudoUser(configPath);
    } catch (err) {
      console.error(`[fileService] Failed to write config.toml for user ${username}:`, err);
    }
  }
};

module.exports = {
  PROJECT_ROOT,
  WORKSPACES_FILE,
  getHomeDir,
  resolveWorkspacePath,
  readWorkspaces,
  writeWorkspaces,
  safeResolve,
  getUserWorkspaceRoot,
  getUserHomeDir,
  getDefaultWorkspacePath,
  updateUserKeysFile
};
