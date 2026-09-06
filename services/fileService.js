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
  // Primary source: system .api_keys or process.env (not settings.json)
  const sysApiKeysFile = path.join(sysHome, '.api_keys');
  if (fs.existsSync(sysApiKeysFile)) {
    try {
      const content = fs.readFileSync(sysApiKeysFile, 'utf8');
      const mKey = content.match(/export ANTHROPIC_API_KEY=['"]?([^'"\n\r]+)['"]?/);
      if (mKey && mKey[1]) keys.claude = mKey[1];
      const mUrl = content.match(/export ANTHROPIC_BASE_URL=['"]?([^'"\n\r]+)['"]?/);
      if (mUrl && mUrl[1]) keys.claudeBaseUrl = mUrl[1];
      const mModel = content.match(/export ANTHROPIC_MODEL=['"]?([^'"\n\r]+)['"]?/);
      if (mModel && mModel[1]) keys.claudeModel = mModel[1];
    } catch (e) {}
  }
  if (!keys.claude && process.env.ANTHROPIC_API_KEY) {
    keys.claude = process.env.ANTHROPIC_API_KEY;
  }
  if (!keys.claudeBaseUrl && process.env.ANTHROPIC_BASE_URL) {
    keys.claudeBaseUrl = process.env.ANTHROPIC_BASE_URL;
  }
  if (!keys.claudeModel && process.env.ANTHROPIC_MODEL) {
    keys.claudeModel = process.env.ANTHROPIC_MODEL;
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
 * Ensures Claude Code CLI theme is preset (default 'dark') so that
 * interactive startup theme selection dialog is skipped.
 */
const ensureClaudeSettings = (targetHome) => {
  const home = targetHome || getHomeDir();
  const claudeDir = path.join(home, '.claude');
  if (!fs.existsSync(claudeDir)) {
    try {
      fs.mkdirSync(claudeDir, { recursive: true });
      chownToSudoUser(claudeDir);
    } catch (e) {
      console.warn(`[fileService] Could not create .claude directory in ${home}: ${e.message}`);
    }
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  let changed = false;

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settings = {};
    }
  } else {
    changed = true;
  }

  if (!settings.theme) {
    settings.theme = 'dark';
    changed = true;
  }

  if (!settings.env) {
    settings.env = {};
    changed = true;
  }

  if (settings.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT !== '1') {
    settings.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';
    changed = true;
  }

  if (settings.env.ANTHROPIC_API_KEY) {
    delete settings.env.ANTHROPIC_API_KEY;
    changed = true;
  }

  if (settings.env.ANTHROPIC_AUTH_TOKEN) {
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    changed = true;
  }

  // Keep settings.json clean of sensitive credentials, network URLs, and model locks:
  // Claude Code merges settings.env into process.env at startup, which overrides PTY and shell env.
  // To ensure runtime environment variables (ptyEnv / per-session exports) remain the single source of truth,
  // we strictly purge ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, and ANTHROPIC_MODEL from settings.json.
  if (settings.env.ANTHROPIC_BASE_URL) {
    delete settings.env.ANTHROPIC_BASE_URL;
    changed = true;
  }
  if (settings.env.ANTHROPIC_MODEL) {
    delete settings.env.ANTHROPIC_MODEL;
    changed = true;
  }
  if (settings.env.ANTHROPIC_DEFAULT_MODEL) {
    delete settings.env.ANTHROPIC_DEFAULT_MODEL;
    changed = true;
  }
  if (settings.model) {
    delete settings.model;
    changed = true;
  }

  if (changed) {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      chownToSudoUser(settingsPath);
    } catch (e) {
      console.warn(`[fileService] Could not write settings to ${settingsPath}: ${e.message}`);
    }
  }
};

/**
 * Ensures ~/.codex/config.toml is configured properly for Codex CLI.
 * If LLM Gateway is active and user has not configured a custom Base URL,
 * it routes Codex through the local 127 gateway (e.g. http://127.0.0.1/v1 or http://127.0.0.1:PORT/v1).
 * Also pre-trusts the user home and workspaces to avoid interactive confirmation prompts.
 */
const ensureCodexConfig = (targetHome, customConfig = {}) => {
  const sysHome = getHomeDir();
  const home = targetHome || sysHome;
  const codexDir = path.join(home, '.codex');
  if (!fs.existsSync(codexDir)) {
    try {
      fs.mkdirSync(codexDir, { recursive: true });
      chownToSudoUser(codexDir);
    } catch (e) {
      console.warn(`[ensureCodexConfig] Could not create .codex dir in ${home}: ${e.message}`);
    }
  }

  const configPath = path.join(codexDir, 'config.toml');

  // Determine gateway config
  let gwUrl = null;
  let defaultOpenAiModel = 'glm-5.3-flash';
  try {
    const gwConfig = require('./llmGatewayService').loadConfig();
    if (gwConfig && gwConfig.enabled && gwConfig.injectToTerminal) {
      const { PORT } = require('../config');
      const localPort = PORT || 3000;
      gwUrl = (localPort === 80 || localPort === '80') ? 'http://127.0.0.1/v1' : `http://127.0.0.1:${localPort}/v1`;
      defaultOpenAiModel = gwConfig.defaults?.openaiModel || 'glm-5.3-flash';
    }
  } catch (e) {}

  const targetBaseUrl = customConfig.baseUrl || gwUrl;
  const targetModel = customConfig.model || defaultOpenAiModel;

  if (targetBaseUrl) {
    const isGateway = (targetBaseUrl === gwUrl);
    const providerName = isGateway ? 'deck_gateway' : 'custom_provider';
    const tomlContent = `model_provider = "${providerName}"
model = "${targetModel}"
check_for_update_on_startup = false

[model_providers.${providerName}]
name = "${providerName}"
base_url = "${targetBaseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "chat"

[projects."${home}"]
trust_level = "trusted"

[projects."${PROJECT_ROOT}"]
trust_level = "trusted"
`;
    try {
      if (fs.existsSync(configPath)) {
        const existing = fs.readFileSync(configPath, 'utf8');
        if (existing === tomlContent) {
          return;
        }
      }
      fs.writeFileSync(configPath, tomlContent, 'utf8');
      chownToSudoUser(configPath);
    } catch (e) {
      console.warn(`[ensureCodexConfig] Could not write ${configPath}: ${e.message}`);
    }
  }
};

/**
 * Ensures a directory (or list of directories) is marked as trusted in Claude Code's ~/.claude.json
 * so that the interactive "Trust folder" confirmation dialog is skipped, onboarding is bypassed,
 * and custom API keys are pre-approved so Claude Code never prompts on startup.
 */
const ensureClaudeTrust = (targetPaths, targetHome, extraApiKeyToApprove) => {
  const sysHome = getHomeDir();
  const targetHomeDir = targetHome || sysHome;

  const rawList = Array.isArray(targetPaths) ? targetPaths : (targetPaths ? [targetPaths] : []);
  const pathsToTrust = new Set();
  for (const p of rawList) {
    if (!p) continue;
    try {
      pathsToTrust.add(path.resolve(p));
      if (fs.existsSync(p)) {
        pathsToTrust.add(fs.realpathSync(p));
      }
    } catch (e) {}
  }

  const candidateFiles = new Set();
  if (targetHomeDir) candidateFiles.add(path.join(targetHomeDir, '.claude.json'));
  if (sysHome) candidateFiles.add(path.join(sysHome, '.claude.json'));

  // Collect candidate API keys to pre-approve in customApiKeyResponses
  const candidateKeys = new Set();
  if (extraApiKeyToApprove && typeof extraApiKeyToApprove === 'string') {
    candidateKeys.add(extraApiKeyToApprove.trim());
  }
  if (process.env.ANTHROPIC_API_KEY) candidateKeys.add(process.env.ANTHROPIC_API_KEY.trim());
  if (process.env.ANTHROPIC_AUTH_TOKEN) candidateKeys.add(process.env.ANTHROPIC_AUTH_TOKEN.trim());

  for (const homeDir of [targetHomeDir, sysHome]) {
    if (!homeDir) continue;
    const kf = path.join(homeDir, '.api_keys');
    if (fs.existsSync(kf)) {
      try {
        const content = fs.readFileSync(kf, 'utf8');
        const m1 = content.match(/export ANTHROPIC_API_KEY=['"]?([^'"\n\r]+)['"]?/);
        if (m1 && m1[1]) candidateKeys.add(m1[1].trim());
        const m2 = content.match(/export ANTHROPIC_AUTH_TOKEN=['"]?([^'"\n\r]+)['"]?/);
        if (m2 && m2[1]) candidateKeys.add(m2[1].trim());
      } catch (e) {}
    }
    const sf = path.join(homeDir, '.claude', 'settings.json');
    if (fs.existsSync(sf)) {
      try {
        const sc = JSON.parse(fs.readFileSync(sf, 'utf8'));
        if (sc.env?.ANTHROPIC_API_KEY) candidateKeys.add(String(sc.env.ANTHROPIC_API_KEY).trim());
        if (sc.env?.ANTHROPIC_AUTH_TOKEN) candidateKeys.add(String(sc.env.ANTHROPIC_AUTH_TOKEN).trim());
      } catch (e) {}
    }
  }

  try {
    const gwConfig = require('./llmGatewayService').loadConfig();
    if (gwConfig && gwConfig.virtualKey) candidateKeys.add(gwConfig.virtualKey.trim());
  } catch (e) {}

  const processedRealPaths = new Set();

  for (const configPath of candidateFiles) {
    let realConfigPath = configPath;
    try {
      if (fs.existsSync(configPath)) {
        realConfigPath = fs.realpathSync(configPath);
      }
    } catch (e) {}

    if (processedRealPaths.has(realConfigPath)) continue;
    processedRealPaths.add(realConfigPath);

    let config = {};
    let fileExisted = false;
    if (fs.existsSync(realConfigPath)) {
      fileExisted = true;
      try {
        config = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'));
      } catch (e) {
        config = {};
      }
    }

    if (!config.projects) {
      config.projects = {};
    }
    let changed = !fileExisted;

    if (config.hasCompletedOnboarding !== true) {
      config.hasCompletedOnboarding = true;
      changed = true;
    }

    if (!config.customApiKeyResponses) {
      config.customApiKeyResponses = { approved: [], rejected: [] };
      changed = true;
    }
    if (!Array.isArray(config.customApiKeyResponses.approved)) {
      config.customApiKeyResponses.approved = [];
      changed = true;
    }
    if (!Array.isArray(config.customApiKeyResponses.rejected)) {
      config.customApiKeyResponses.rejected = [];
      changed = true;
    }

    for (const rawKey of candidateKeys) {
      if (rawKey && rawKey.length >= 3) {
        const suffix = rawKey.slice(-20);
        if (!config.customApiKeyResponses.approved.includes(suffix)) {
          config.customApiKeyResponses.approved.push(suffix);
          changed = true;
        }
      }
    }

    if (config.customApiKeyResponses.rejected && config.customApiKeyResponses.rejected.length > 0) {
      const filtered = config.customApiKeyResponses.rejected.filter(r => !config.customApiKeyResponses.approved.includes(r));
      if (filtered.length !== config.customApiKeyResponses.rejected.length) {
        config.customApiKeyResponses.rejected = filtered;
        changed = true;
      }
    }

    for (const p of pathsToTrust) {
      if (!config.projects[p]) {
        config.projects[p] = {};
        changed = true;
      }
      if (config.projects[p].hasTrustDialogAccepted !== true) {
        config.projects[p].hasTrustDialogAccepted = true;
        changed = true;
      }
      if (config.projects[p].hasCompletedProjectOnboarding !== true) {
        config.projects[p].hasCompletedProjectOnboarding = true;
        changed = true;
      }
    }

    if (changed) {
      try {
        const dir = path.dirname(realConfigPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          chownToSudoUser(dir);
        }
        fs.writeFileSync(realConfigPath, JSON.stringify(config, null, 2), 'utf8');
        chownToSudoUser(realConfigPath);
      } catch (e) {
        console.warn(`[fileService] Could not write trust config to ${realConfigPath}: ${e.message}`);
      }
    }
  }
};

/**
 * Global initialization on server startup:
 * Pre-configures Claude settings (theme: dark) and pre-trusts all registered workspaces
 * across the system and for all users.
 */
const initClaudeConfig = () => {
  const sysHome = getHomeDir();
  ensureClaudeSettings(sysHome);
  ensureCodexConfig(sysHome);

  const allPathsToTrust = new Set([PROJECT_ROOT, sysHome]);

  // Global workspaces
  const globalWs = readWorkspaces();
  if (Array.isArray(globalWs)) {
    for (const w of globalWs) {
      if (w && w.path) allPathsToTrust.add(resolveWorkspacePath(w.path));
    }
  }

  // Multi-user home and workspaces
  const userDataDir = path.join(PROJECT_ROOT, 'user_data');
  if (fs.existsSync(userDataDir)) {
    try {
      const userEntries = fs.readdirSync(userDataDir, { withFileTypes: true });
      for (const entry of userEntries) {
        if (entry.isDirectory()) {
          const username = entry.name;
          const uHome = path.join(userDataDir, username, 'home');
          allPathsToTrust.add(uHome);
          ensureClaudeSettings(uHome);
          ensureCodexConfig(uHome);

          const userWs = readWorkspaces(username);
          if (Array.isArray(userWs)) {
            for (const w of userWs) {
              if (w && w.path) {
                const resolved = resolveWorkspacePath(w.path, username);
                allPathsToTrust.add(resolved);
              }
            }
          }
          ensureClaudeTrust(Array.from(allPathsToTrust), uHome);
        }
      }
    } catch (e) {
      console.warn(`[fileService] Error scanning user_data in initClaudeConfig: ${e.message}`);
    }
  }

  // Also scan data/ directory for any workspaces_*.json
  if (fs.existsSync(DATA_DIR)) {
    try {
      const files = fs.readdirSync(DATA_DIR);
      for (const file of files) {
        if (file.startsWith('workspaces_') && file.endsWith('.json')) {
          const username = file.replace(/^workspaces_/, '').replace(/\.json$/, '');
          const wsList = readWorkspaces(username);
          if (Array.isArray(wsList)) {
            for (const w of wsList) {
              if (w && w.path) allPathsToTrust.add(resolveWorkspacePath(w.path, username));
            }
          }
        }
      }
    } catch (e) {}
  }

  ensureClaudeTrust(Array.from(allPathsToTrust), sysHome);
};

/**
 * Ensures ~/.inputrc is properly configured for readline completion.
 * Disables 'disable-completion' and enables helpful completion flags (e.g. show-all-if-ambiguous, completion-ignore-case).
 */
const ensureInputrc = (targetHome) => {
  const sysHome = getHomeDir();
  const home = targetHome || sysHome;
  const inputrcPath = path.join(home, '.inputrc');

  try {
    let content = '';
    if (fs.existsSync(inputrcPath)) {
      content = fs.readFileSync(inputrcPath, 'utf8');
      // If disable-completion on is found, replace it with off
      if (/set\s+disable-completion\s+on/i.test(content)) {
        content = content.replace(/set\s+disable-completion\s+on/gi, 'set disable-completion off');
      }
      if (!/set\s+disable-completion/i.test(content)) {
        content += '\nset disable-completion off\n';
      }
      if (!/set\s+show-all-if-ambiguous/i.test(content)) {
        content += 'set show-all-if-ambiguous on\n';
      }
      if (!/set\s+completion-ignore-case/i.test(content)) {
        content += 'set completion-ignore-case on\n';
      }
    } else {
      content = `# Readline completion configuration (auto-generated by tmux-agent-deck)\nset disable-completion off\nset show-all-if-ambiguous on\nset completion-ignore-case on\n`;
    }
    fs.writeFileSync(inputrcPath, content.trim() + '\n', 'utf8');
    chownToSudoUser(inputrcPath);
  } catch (e) {
    console.warn(`[ensureInputrc] Failed to ensure .inputrc in ${home}: ${e.message}`);
  }
};

/**
 * Ensures ~/.bashrc includes programmable bash completion support.
 */
const ensureBashrc = (targetHome) => {
  const sysHome = getHomeDir();
  const home = targetHome || sysHome;
  const bashrcPath = path.join(home, '.bashrc');

  try {
    let content = '';
    if (fs.existsSync(bashrcPath)) {
      content = fs.readFileSync(bashrcPath, 'utf8');
    } else {
      const skelBashrc = '/etc/skel/.bashrc';
      if (fs.existsSync(skelBashrc)) {
        try {
          content = fs.readFileSync(skelBashrc, 'utf8');
        } catch (e) {}
      }
    }

    // Ensure programmable completion block is present
    if (!content.includes('bash_completion')) {
      const completionBlock = `
# enable programmable completion features
if ! shopt -oq posix; then
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  elif [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
  fi
fi
`;
      content = content.trimEnd() + '\n' + completionBlock;
    }

    fs.writeFileSync(bashrcPath, content.trim() + '\n', 'utf8');
    chownToSudoUser(bashrcPath);
  } catch (e) {
    console.warn(`[ensureBashrc] Failed to ensure .bashrc in ${home}: ${e.message}`);
  }
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
  ensureClaudeSettings(userHome);

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
  ensureCodexConfig(userHome);

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

  const sysKimiDir = path.join(sysHome, '.kimi-code');
  const sysCredentialsDir = path.join(sysKimiDir, 'credentials');
  const sysOauthDir = path.join(sysKimiDir, 'oauth');
  const sysDeviceIdPath = path.join(sysKimiDir, 'device_id');
  const sysConfigPath = path.join(sysKimiDir, 'config.toml');
  const sysTuiPath = path.join(sysKimiDir, 'tui.toml');

  // Seed system home Kimi config from admin if system home Kimi config is missing/incomplete
  if (MULTI_USER_ENABLED && username && userHome !== sysHome) {
    const adminKimiDir = path.join(PROJECT_ROOT, 'user_data', 'admin', 'home', '.kimi-code');
    const adminConfigPath = path.join(adminKimiDir, 'config.toml');
    const adminTuiPath = path.join(adminKimiDir, 'tui.toml');
    const adminDeviceIdPath = path.join(adminKimiDir, 'device_id');
    const adminCredentialsDir = path.join(adminKimiDir, 'credentials');
    const adminOauthDir = path.join(adminKimiDir, 'oauth');

    // Create system .kimi-code structure if missing
    if (!fs.existsSync(sysKimiDir)) {
      try {
        fs.mkdirSync(sysKimiDir, { recursive: true });
        chownToSudoUser(sysKimiDir);
      } catch (e) {}
    }
    if (!fs.existsSync(sysCredentialsDir)) {
      try {
        fs.mkdirSync(sysCredentialsDir, { recursive: true });
        chownToSudoUser(sysCredentialsDir);
      } catch (e) {}
    }
    if (!fs.existsSync(sysOauthDir)) {
      try {
        fs.mkdirSync(sysOauthDir, { recursive: true });
        chownToSudoUser(sysOauthDir);
      } catch (e) {}
    }

    // Seed config.toml
    if (!fs.existsSync(sysConfigPath) && fs.existsSync(adminConfigPath)) {
      try {
        fs.copyFileSync(adminConfigPath, sysConfigPath);
        chownToSudoUser(sysConfigPath);
      } catch (e) {}
    }
    // Seed tui.toml
    if (!fs.existsSync(sysTuiPath) && fs.existsSync(adminTuiPath)) {
      try {
        fs.copyFileSync(adminTuiPath, sysTuiPath);
        chownToSudoUser(sysTuiPath);
      } catch (e) {}
    }
    // Seed device_id
    if (!fs.existsSync(sysDeviceIdPath) && fs.existsSync(adminDeviceIdPath)) {
      try {
        fs.copyFileSync(adminDeviceIdPath, sysDeviceIdPath);
        chownToSudoUser(sysDeviceIdPath);
      } catch (e) {}
    }
    // Seed credentials
    const sysHasCreds = fs.existsSync(path.join(sysCredentialsDir, 'kimi-code.json'));
    if (!sysHasCreds && fs.existsSync(adminCredentialsDir)) {
      try {
        const credFiles = fs.readdirSync(adminCredentialsDir);
        for (const file of credFiles) {
          const src = path.join(adminCredentialsDir, file);
          const dest = path.join(sysCredentialsDir, file);
          if (!fs.lstatSync(src).isSymbolicLink()) {
            fs.copyFileSync(src, dest);
            chownToSudoUser(dest);
          }
        }
      } catch (e) {}
    }
    // Seed oauth
    const sysHasOauth = fs.readdirSync(sysOauthDir).length > 0;
    if (!sysHasOauth && fs.existsSync(adminOauthDir)) {
      try {
        const oauthFiles = fs.readdirSync(adminOauthDir);
        for (const file of oauthFiles) {
          const src = path.join(adminOauthDir, file);
          const dest = path.join(sysOauthDir, file);
          if (!fs.lstatSync(src).isSymbolicLink()) {
            fs.copyFileSync(src, dest);
            chownToSudoUser(dest);
          }
        }
      } catch (e) {}
    }
  }

  // Copy config.toml and tui.toml from system home to userHome
  const userKimiConfigPath = path.join(userKimiDir, 'config.toml');
  const sysKimiConfigExists = fs.existsSync(sysConfigPath);
  let userKimiConfigNeedsSync = !fs.existsSync(userKimiConfigPath);

  if (!userKimiConfigNeedsSync && sysKimiConfigExists) {
    try {
      const userConfig = fs.readFileSync(userKimiConfigPath, 'utf8');
      if (!userConfig.includes('[providers."managed:kimi-code"]') || !userConfig.includes('oauth')) {
        userKimiConfigNeedsSync = true;
      }
    } catch (e) {
      userKimiConfigNeedsSync = true;
    }
  }

  if (sysKimiConfigExists && userKimiConfigNeedsSync) {
    try {
      fs.copyFileSync(sysConfigPath, userKimiConfigPath);
      chownToSudoUser(userKimiConfigPath);
    } catch (e) {
      console.warn(`[userHome] Could not copy kimi config.toml: ${e.message}`);
    }
  }

  const userTuiPath = path.join(userKimiDir, 'tui.toml');
  if (fs.existsSync(sysTuiPath) && !fs.existsSync(userTuiPath)) {
    try {
      fs.copyFileSync(sysTuiPath, userTuiPath);
      chownToSudoUser(userTuiPath);
    } catch (e) {
      console.warn(`[userHome] Could not copy kimi tui.toml: ${e.message}`);
    }
  }

  // Ensure sharing credentials, oauth, and device_id via symlinks if multi-user is active
  if (MULTI_USER_ENABLED && username && userHome !== sysHome) {
    const userCredentialsDir = path.join(userKimiDir, 'credentials');
    const userOauthDir = path.join(userKimiDir, 'oauth');
    const userDeviceIdPath = path.join(userKimiDir, 'device_id');

    const ensureSymlink = (target, linkPath) => {
      let exists = false;
      let isCorrectSymlink = false;
      try {
        const stats = fs.lstatSync(linkPath);
        exists = true;
        if (stats.isSymbolicLink() && fs.readlinkSync(linkPath) === target) {
          isCorrectSymlink = true;
        }
      } catch (e) {}

      if (exists && !isCorrectSymlink) {
        try {
          const stats = fs.lstatSync(linkPath);
          if (stats.isDirectory() && !stats.isSymbolicLink()) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(linkPath);
          }
        } catch (e) {
          console.warn(`[userHome] Could not remove existing file/directory at ${linkPath}: ${e.message}`);
          return;
        }
      }

      if (!isCorrectSymlink) {
        try {
          fs.symlinkSync(target, linkPath);
        } catch (e) {
          console.warn(`[userHome] Could not create symlink ${target} -> ${linkPath}: ${e.message}`);
        }
      }
    };

    if (fs.existsSync(sysCredentialsDir)) {
      ensureSymlink(sysCredentialsDir, userCredentialsDir);
    }
    if (fs.existsSync(sysOauthDir)) {
      ensureSymlink(sysOauthDir, userOauthDir);
    }
    if (fs.existsSync(sysDeviceIdPath)) {
      ensureSymlink(sysDeviceIdPath, userDeviceIdPath);
    }
  } else {
    // If not in multi-user mode, fallback to basic copying if directories don't exist
    const userCredentialsDir = path.join(userKimiDir, 'credentials');
    if (fs.existsSync(sysCredentialsDir) && !fs.existsSync(userCredentialsDir)) {
      try {
        fs.mkdirSync(userCredentialsDir, { recursive: true });
        chownToSudoUser(userCredentialsDir);
        const credFiles = fs.readdirSync(sysCredentialsDir);
        for (const file of credFiles) {
          const src = path.join(sysCredentialsDir, file);
          const dest = path.join(userCredentialsDir, file);
          fs.copyFileSync(src, dest);
          chownToSudoUser(dest);
        }
      } catch (e) {
        console.warn(`[userHome] Could not sync kimi credentials: ${e.message}`);
      }
    }

    const userOauthDir = path.join(userKimiDir, 'oauth');
    if (fs.existsSync(sysOauthDir) && !fs.existsSync(userOauthDir)) {
      try {
        fs.mkdirSync(userOauthDir, { recursive: true });
        chownToSudoUser(userOauthDir);
        const oauthFiles = fs.readdirSync(sysOauthDir);
        for (const file of oauthFiles) {
          const src = path.join(sysOauthDir, file);
          const dest = path.join(userOauthDir, file);
          fs.copyFileSync(src, dest);
          chownToSudoUser(dest);
        }
      } catch (e) {
        console.warn(`[userHome] Could not sync kimi oauth: ${e.message}`);
      }
    }

    const userDeviceIdPath = path.join(userKimiDir, 'device_id');
    if (fs.existsSync(sysDeviceIdPath) && !fs.existsSync(userDeviceIdPath)) {
      try {
        fs.copyFileSync(sysDeviceIdPath, userDeviceIdPath);
        chownToSudoUser(userDeviceIdPath);
      } catch (e) {}
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

  try {
    const userWorkspaces = readWorkspaces(username).map(w => resolveWorkspacePath(w.path, username));
    ensureClaudeTrust([userHome, PROJECT_ROOT, ...userWorkspaces], userHome);
  } catch (e) {}

  ensureInputrc(userHome);
  ensureBashrc(userHome);

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
      if (Array.isArray(workspaces)) {
        const paths = workspaces.map(w => resolveWorkspacePath(w.path, username));
        ensureClaudeTrust(paths, getUserHomeDir(username));
      }
      return true;
    }

    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf8');
    if (Array.isArray(workspaces)) {
      const paths = workspaces.map(w => resolveWorkspacePath(w.path));
      ensureClaudeTrust(paths, getHomeDir());
    }
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
    lines.push(`unset ANTHROPIC_AUTH_TOKEN`);
    if (keys.claudeBaseUrl) {
      lines.push(`export ANTHROPIC_BASE_URL=${shellescapeVal(keys.claudeBaseUrl)}`);
    } else {
      lines.push(`unset ANTHROPIC_BASE_URL`);
    }
    lines.push(`export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`);
  }
  if (keys.claudeModel) {
    lines.push(`export ANTHROPIC_MODEL=${shellescapeVal(keys.claudeModel)}`);
  }
  if (keys.codex) {
    lines.push(`export OPENAI_API_KEY=${shellescapeVal(keys.codex)}`);
    if (keys.codexBaseUrl) {
      lines.push(`export OPENAI_BASE_URL=${shellescapeVal(keys.codexBaseUrl)}`);
      lines.push(`export OPENAI_API_BASE=${shellescapeVal(keys.codexBaseUrl)}`);
    } else {
      lines.push(`unset OPENAI_BASE_URL`);
      lines.push(`unset OPENAI_API_BASE`);
    }
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
    if (!settings.theme) {
      settings.theme = 'dark';
    }
    // Keep settings.json completely free of sensitive API keys and Base URLs:
    // Keys and endpoints are strictly managed via ~/.api_keys and runtime environment variables (ptyEnv).
    // This prevents settings.json.env from overriding shell/PTY environment variables.
    delete settings.env.ANTHROPIC_API_KEY;
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    delete settings.env.ANTHROPIC_BASE_URL;
    delete settings.env.ANTHROPIC_MODEL;
    delete settings.env.ANTHROPIC_DEFAULT_MODEL;
    delete settings.model;
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      chownToSudoUser(settingsPath);
    } catch (err) {
      console.error(`[fileService] Failed to write settings.json for user ${username}:`, err);
    }
  }

  // Pre-approve the Claude API key and trust workspace directories
  try {
    ensureClaudeTrust([userHome, PROJECT_ROOT], userHome, keys.claude);
  } catch (e) {}

  // Update user's private .codex/config.toml
  try {
    ensureCodexConfig(userHome, { baseUrl: keys.codexBaseUrl, model: keys.codexModel });
  } catch (e) {}

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
  getSystemDefaultKeys,
  ensureClaudeSettings,
  ensureCodexConfig,
  ensureClaudeTrust,
  ensureInputrc,
  ensureBashrc,
  initClaudeConfig
};
