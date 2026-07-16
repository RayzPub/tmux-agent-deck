const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, MULTI_USER_ENABLED } = require('../config');

// Helper: get run-as-user configuration (drops privileges to SUDO_USER if run as root)
const getRunUser = () => {
  if (process.getuid && process.getuid() === 0) {
    // If running as root, check if we were invoked via sudo by a non-root user
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser && sudoUser !== 'root') {
      return sudoUser;
    }
  }
  return null;
};

// Construct the secure, isolated tmux command for a given user
const getTmuxCommandForUser = (username, args) => {
  if (MULTI_USER_ENABLED && username) {
    const runUser = getRunUser() || 'ubuntu';
    const socketPath = `/tmp/tmux_${username}.sock`;
    const userDir = path.join(PROJECT_ROOT, 'user_data', username);
    
    const shellescape = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    
    // We run unshare -m as root, create a unique temp dir, bind-mount the real userDir to it,
    // mount tmpfs over the shared user_data parent directory (hiding other users' folders),
    // recreate userDir, bind-mount the userDir contents back from the temp dir, clean up, and execute tmux.
    const unshareCmd = `TEMP_DIR=$(mktemp -d /tmp/tmux_bind_${username}_XXXXXX) && mount --bind ${shellescape(userDir)} "$TEMP_DIR" && mount -t tmpfs tmpfs ${shellescape(userDir)}/.. && mkdir -p ${shellescape(userDir)} && mount --bind "$TEMP_DIR" ${shellescape(userDir)} && umount "$TEMP_DIR" && rmdir "$TEMP_DIR" && sudo -u ${runUser} tmux -S ${socketPath} ${args.map(shellescape).join(' ')}`;
    
    return {
      cmd: 'unshare',
      args: ['-m', 'bash', '-c', unshareCmd]
    };
  } else {
    const user = getRunUser();
    const cmd = user ? 'sudo' : 'tmux';
    const finalArgs = user ? ['-u', user, 'tmux', ...args] : args;
    return { cmd, args: finalArgs };
  }
};

// Wrap commands for spawn (safe execution)
const execTmux = (args, callback, username = null) => {
  const { cmd, args: finalArgs } = getTmuxCommandForUser(username, args);

  try {
    const proc = spawn(cmd, finalArgs);
    let stdout = '', stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (err) => {
      callback(err, stdout, stderr);
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`exit ${code}`);
        err.code = code;
        callback(err, stdout, stderr);
      } else {
        callback(null, stdout, stderr);
      }
    });
  } catch (err) {
    callback(err, '', '');
  }
};

const execPromise = (args, username = null) => {
  return new Promise((resolve, reject) => {
    execTmux(args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    }, username);
  });
};

// Helper to inject agent-specific local hook configurations into the workspace
const injectAgentHooks = (workspacePath, agent, resolveWorkspacePath) => {
  if (!workspacePath) return;
  const resolvedPath = resolveWorkspacePath(workspacePath);
  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  const binDir = path.resolve(PROJECT_ROOT, 'bin');

  if (agent === 'agy') {
    const agentsDir = path.join(resolvedPath, '.agents');
    const hooksFile = path.join(agentsDir, 'hooks.json');
    try {
      if (!fs.existsSync(agentsDir)) {
        fs.mkdirSync(agentsDir, { recursive: true });
      }
      
      let hooksData = {};
      let hasHooksFile = fs.existsSync(hooksFile);
      if (hasHooksFile) {
        try {
          hooksData = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        } catch (e) {
          hooksData = {};
        }
      }

      let migrated = false;
      // Migrate existing gate configuration from absolute to relative if present
      if (hooksData['deck-notify-gate'] && hooksData['deck-notify-gate'].PreToolUse) {
        hooksData['deck-notify-gate'].PreToolUse.forEach(item => {
          if (item.hooks) {
            item.hooks.forEach(hook => {
              if (hook.command && hook.command.includes('/usr/local/bin/deck-notify')) {
                hook.command = hook.command.replace('/usr/local/bin/deck-notify', 'deck-notify');
                migrated = true;
              }
            });
          }
        });
      }

      // Check if gate is already present
      if (!hooksData['deck-notify-gate']) {
        hooksData['deck-notify-gate'] = {
          enabled: true,
          PreToolUse: [
            {
              matcher: "ask_permission|ask_question",
              hooks: [
                {
                  type: "command",
                  command: "deck-notify 'Agy 智能体请求' 'Agy 正在请求执行工具，可能需要您的确认。'",
                  timeout: 10
                }
              ]
            }
          ]
        };
        migrated = true;
      }

      if (migrated || !hasHooksFile) {
        fs.writeFileSync(hooksFile, JSON.stringify(hooksData, null, 2), 'utf8');
        console.log(`[Hooks Injection] Injected/Updated agy hooks.json in ${resolvedPath}`);
      }
    } catch (err) {
      console.error('Failed to inject agy hooks:', err);
    }
  } else if (agent === 'claude') {
    const claudeDir = path.join(resolvedPath, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');
    try {
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      
      let settingsData = {};
      let hasSettingsFile = fs.existsSync(settingsFile);
      if (hasSettingsFile) {
        try {
          settingsData = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        } catch (e) {
          settingsData = {};
        }
      }

      if (!settingsData.hooks) {
        settingsData.hooks = {};
      }
      if (!settingsData.hooks.PermissionRequest) {
        settingsData.hooks.PermissionRequest = [];
      }

      let migrated = false;
      // Migrate existing settings from absolute to relative
      settingsData.hooks.PermissionRequest.forEach(h => {
        if (h.hooks) {
          h.hooks.forEach(inner => {
            if (inner.command && inner.command.includes('/usr/local/bin/deck-notify')) {
              inner.command = inner.command.replace('/usr/local/bin/deck-notify', 'deck-notify');
              migrated = true;
            }
          });
        }
      });

      const hasDeckNotify = settingsData.hooks.PermissionRequest.some(h => 
        h.hooks && h.hooks.some(inner => inner.command && inner.command.includes('deck-notify'))
      );

      if (!hasDeckNotify) {
        settingsData.hooks.PermissionRequest.push({
          hooks: [
            {
              type: "command",
              command: "deck-notify 'Claude 权限请求' 'Claude 正在等待您的终端授权确认。'"
            }
          ]
        });
        migrated = true;
      }

      if (migrated || !hasSettingsFile) {
        fs.writeFileSync(settingsFile, JSON.stringify(settingsData, null, 2), 'utf8');
        console.log(`[Hooks Injection] Injected/Updated claude settings.local.json in ${resolvedPath}`);
      }
    } catch (err) {
      console.error('Failed to inject claude settings:', err);
    }
  } else if (agent === 'codex') {
    const codexDir = path.join(resolvedPath, '.codex');
    const hooksFile = path.join(codexDir, 'hooks.json');
    try {
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true });
      }

      let hooksData = {};
      let hasHooksFile = fs.existsSync(hooksFile);
      if (hasHooksFile) {
        try {
          hooksData = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        } catch (e) {
          hooksData = {};
        }
      }

      if (!hooksData.hooks) {
        hooksData.hooks = [];
      }

      let migrated = false;
      // Migrate existing settings from absolute to relative
      hooksData.hooks.forEach(h => {
        if (h.command && h.command.includes('/usr/local/bin/deck-notify')) {
          h.command = h.command.replace('/usr/local/bin/deck-notify', 'deck-notify');
          migrated = true;
        }
      });

      const hasDeckNotify = hooksData.hooks.some(h =>
        h.command && h.command.includes('deck-notify')
      );

      if (!hasDeckNotify) {
        hooksData.hooks.push({
          name: "deck-notify-gate",
          events: ["PermissionRequest", "PreToolUse"],
          command: "deck-notify",
          args: ["Codex 权限请求", "Codex 正在等待您的终端授权确认。"],
          timeout: 10
        });
        migrated = true;
      }

      if (migrated || !hasHooksFile) {
        fs.writeFileSync(hooksFile, JSON.stringify(hooksData, null, 2), 'utf8');
        console.log(`[Hooks Injection] Injected/Updated codex hooks.json in ${resolvedPath}`);
      }
    } catch (err) {
      console.error('Failed to inject codex hooks:', err);
    }
  }
};

module.exports = {
  getRunUser,
  execTmux,
  execPromise,
  injectAgentHooks,
  getTmuxCommandForUser
};
