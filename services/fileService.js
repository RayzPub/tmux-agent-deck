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

const getSystemDefaultKeys = () => {
  const sysHome = getHomeDir();
  const keys = {};

  // 1. Anthropic / Claude
  const sysClaudeSettings = path.join(sysHome, '.claude', 'settings.json');
  if (fs.existsSync(sysClaudeSettings)) {
    try {
      const data = JSON.parse(fs.readFileSync(sysClaudeSettings, 'utf8'));
      if (data.env && data.env.ANTHROPIC_AUTH_TOKEN) {
        keys.claude = data.env.ANTHROPIC_AUTH_TOKEN;
      }
      if (data.env && data.env.ANTHROPIC_BASE_URL) {
        keys.claudeBaseUrl = data.env.ANTHROPIC_BASE_URL;
      }
      if (data.env && data.env.ANTHROPIC_MODEL) {
        keys.claudeModel = data.env.ANTHROPIC_MODEL;
      }
    } catch (e) {}
  }

  // 2. OpenAI / Codex
  const sysCodexConfig = path.join(sysHome, '.codex', 'config.toml');
  if (fs.existsSync(sysCodexConfig)) {
    try {
      const content = fs.readFileSync(sysCodexConfig, 'utf8');
      const matchApiKey = content.match(/api_key\s*=\s*"([^"]+)"/);
      if (matchApiKey && matchApiKey[1]) {
        keys.codex = matchApiKey[1];
      } else {
        const matchEnvKey = content.match(/env_key\s*=\s*"([^"]+)"/);
        if (matchEnvKey && matchEnvKey[1] && matchEnvKey[1].startsWith('sk-')) {
          keys.codex = matchEnvKey[1];
        }
      }
      
      const matchBaseUrl = content.match(/base_url\s*=\s*"([^"]+)"/);
      if (matchBaseUrl && matchBaseUrl[1]) {
        keys.codexBaseUrl = matchBaseUrl[1];
      }
      
      const matchModel = content.match(/model\s*=\s*"([^"]+)"/);
      if (matchModel && matchModel[1]) {
        keys.codexModel = matchModel[1];
      }
    } catch (e) {}
  }

  return keys;
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
    } catch (e) {
      console.warn(`[userHome] Could not create .claude directory: ${e.message}`);
    }
  }

  // Copy settings.json if missing and exists in system home
  const sysSettingsPath = path.join(sysHome, '.claude', 'settings.json');
  const userSettingsPath = path.join(userClaudeDir, 'settings.json');
  if (fs.existsSync(sysSettingsPath) && !fs.existsSync(userSettingsPath)) {
    try {
      fs.copyFileSync(sysSettingsPath, userSettingsPath);
      chownToSudoUser(userSettingsPath);
    } catch (e) {
      console.warn(`[userHome] Could not copy settings.json: ${e.message}`);
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
    } catch (e) {
      console.warn(`[userHome] Could not create .codex directory: ${e.message}`);
    }
  }

  // Copy config.toml if missing and exists in system home
  const sysCodexConfigPath = path.join(sysHome, '.codex', 'config.toml');
  const userCodexConfigPath = path.join(userCodexDir, 'config.toml');
  if (fs.existsSync(sysCodexConfigPath) && !fs.existsSync(userCodexConfigPath)) {
    try {
      fs.copyFileSync(sysCodexConfigPath, userCodexConfigPath);
      chownToSudoUser(userCodexConfigPath);
    } catch (e) {
      console.warn(`[userHome] Could not copy config.toml: ${e.message}`);
    }
  }

  // 1.3 Initialize/sync user's private .kimi-code directory
  // This handles both new directories and existing ones missing credentials/oauth
  const userKimiDir = path.join(userHome, '.kimi-code');
  let isKimiSymlink = false;
  try {
    const stats = fs.lstatSync(userKimiDir);
    if (stats.isSymbolicLink()) {
      isKimiSymlink = true;
    }
  } catch (e) {
    // Doesn't exist
  }

  if (isKimiSymlink) {
    try {
      fs.unlinkSync(userKimiDir);
    } catch (e) {
      console.warn(`[userHome] Could not remove existing .kimi-code symlink: ${e.message}`);
    }
  }

  // Ensure directory exists
  if (!fs.existsSync(userKimiDir)) {
    try {
      fs.mkdirSync(userKimiDir, { recursive: true });
      chownToSudoUser(userKimiDir);
    } catch (e) {
      console.warn(`[userHome] Could not create .kimi-code directory: ${e.message}`);
    }
  }

  // Sync config.toml from system home if user doesn't have one or has an empty/default one
  const sysKimiConfigPath = path.join(sysHome, '.kimi-code', 'config.toml');
  const userKimiConfigPath = path.join(userKimiDir, 'config.toml');
  const sysKimiConfigExists = fs.existsSync(sysKimiConfigPath);
  let userKimiConfigNeedsSync = !fs.existsSync(userKimiConfigPath);

  // Check if user config is empty/default (missing OAuth config)
  if (!userKimiConfigNeedsSync && sysKimiConfigExists) {
    try {
      const userConfig = fs.readFileSync(userKimiConfigPath, 'utf8');
      // If config doesn't have OAuth provider setup, it needs to be synced
      if (!userConfig.includes('[providers."managed:kimi-code"]') || !userConfig.includes('oauth')) {
        userKimiConfigNeedsSync = true;
      }
    } catch (e) {
      userKimiConfigNeedsSync = true;
    }
  }

  if (sysKimiConfigExists && userKimiConfigNeedsSync) {
    try {
      fs.copyFileSync(sysKimiConfigPath, userKimiConfigPath);
      chownToSudoUser(userKimiConfigPath);
    } catch (e) {
      console.warn(`[userHome] Could not copy kimi config.toml: ${e.message}`);
    }
  }

  // Sync credentials directory from system home if user doesn't have one (for OAuth login)
  const sysCredentialsDir = path.join(sysHome, '.kimi-code', 'credentials');
  const userCredentialsDir = path.join(userKimiDir, 'credentials');
  if (fs.existsSync(sysCredentialsDir) && !fs.existsSync(userCredentialsDir)) {
    try {
      fs.mkdirSync(userCredentialsDir, { recursive: true });
      chownToSudoUser(userCredentialsDir);
      const credFiles = fs.readdirSync(sysCredentialsDir);
      for (const credFile of credFiles) {
        const srcPath = path.join(sysCredentialsDir, credFile);
        const destPath = path.join(userCredentialsDir, credFile);
        fs.copyFileSync(srcPath, destPath);
        chownToSudoUser(destPath);
      }
    } catch (e) {
      console.warn(`[userHome] Could not sync kimi credentials: ${e.message}`);
    }
  }

  // Sync oauth directory from system home if user doesn't have one
  const sysOauthDir = path.join(sysHome, '.kimi-code', 'oauth');
  const userOauthDir = path.join(userKimiDir, 'oauth');
  if (fs.existsSync(sysOauthDir) && !fs.existsSync(userOauthDir)) {
    try {
      fs.mkdirSync(userOauthDir, { recursive: true });
      chownToSudoUser(userOauthDir);
      const oauthFiles = fs.readdirSync(sysOauthDir);
      for (const oauthFile of oauthFiles) {
        const srcPath = path.join(sysOauthDir, oauthFile);
        const destPath = path.join(userOauthDir, oauthFile);
        fs.copyFileSync(srcPath, destPath);
        chownToSudoUser(destPath);
      }
    } catch (e) {
      console.warn(`[userHome] Could not sync kimi oauth: ${e.message}`);
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

  const keysFilePath = path.join(userHome, '.api_keys');
  if (!fs.existsSync(keysFilePath)) {
    try {
      const db = require('./dbService');
      const users = db.getUsers();
      const userObj = users[username.toLowerCase()];
      updateUserKeysFile(username, userObj ? (userObj.apiKeys || {}) : {});
    } catch (e) {
      console.warn(`[userHome] Could not pre-initialize user keys: ${e.message}`);
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

  const userHome = path.join(PROJECT_ROOT, 'user_data', username, 'home');
  if (!fs.existsSync(userHome)) {
    try {
      fs.mkdirSync(userHome, { recursive: true });
      chownToSudoUser(userHome);
    } catch (e) {
      console.warn(`[fileService] Could not create user home directory: ${e.message}`);
    }
  }
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
  if (keys.kimi) {
    lines.push(`export KIMI_API_KEY=${shellescapeVal(keys.kimi)}`);
    lines.push(`export MOONSHOT_API_KEY=${shellescapeVal(keys.kimi)}`);
  }
  if (keys.kimiBaseUrl) {
    lines.push(`export KIMI_BASE_URL=${shellescapeVal(keys.kimiBaseUrl)}`);
    lines.push(`export MOONSHOT_BASE_URL=${shellescapeVal(keys.kimiBaseUrl)}`);
  }
  if (keys.kimiModel) {
    lines.push(`export KIMI_MODEL=${shellescapeVal(keys.kimiModel)}`);
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
    } else if (keys.claude === '') {
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
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

  // Update user's private .kimi-code/config.toml and .kimi/config.toml
  if (keys.kimi) {
    const KimiDirs = [
      path.join(userHome, '.kimi-code'),
      path.join(userHome, '.kimi')
    ];

    for (const userKimiDir of KimiDirs) {
      if (!fs.existsSync(userKimiDir)) {
        try {
          fs.mkdirSync(userKimiDir, { recursive: true });
          chownToSudoUser(userKimiDir);
        } catch (e) {}
      }
      const configPath = path.join(userKimiDir, 'config.toml');
      const kimiBaseUrl = keys.kimiBaseUrl || 'https://api.kimi.com/coding/v1';
      const kimiModel = keys.kimiModel || 'kimi-for-coding';
      const tomlContent = `default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "${kimiBaseUrl.replace(/"/g, '\\"')}"
api_key = "${keys.kimi.replace(/"/g, '\\"')}"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "${kimiModel.replace(/"/g, '\\"')}"
max_context_size = 262144
`;
      try {
        fs.writeFileSync(configPath, tomlContent, 'utf8');
        chownToSudoUser(configPath);
      } catch (err) {
        console.error(`[fileService] Failed to write config.toml at ${configPath} for user ${username}:`, err);
      }
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
  updateUserKeysFile,
  getSystemDefaultKeys
};
