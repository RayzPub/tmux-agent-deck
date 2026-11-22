const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { hasCommand, resolveBaseDir, tmuxArgs } = require('./config');
const { tryRequireOptional } = require('./depsManager');
const sessionRegistry = require('./sessionRegistry');

// Active interactive PTY / terminal sessions: termId -> { write, resize, kill }
const activeTerminals = new Map();

function cleanupAllTerminals() {
  for (const [, term] of activeTerminals.entries()) {
    try { term.kill(); } catch (e) {}
  }
  activeTerminals.clear();
}

function readTmuxSessionMeta(sessionName) {
  // 1. Check tmux-free Pure Chat OAR registry first
  const pureChat = sessionRegistry.getPureChatSession(sessionName);
  if (pureChat) {
    return {
      workspacePath: (pureChat.workspacePath && fs.existsSync(pureChat.workspacePath))
        ? pureChat.workspacePath
        : (process.env.CCNOW_DEFAULT_WORKSPACE || process.cwd()),
      agentType: pureChat.agentType || 'claude',
      sessionMode: 'chat_only',
      model: pureChat.agentModel || pureChat.modelName || ''
    };
  }

  // 2. Fall back to tmux metadata for terminal / hybrid / legacy sessions
  let workspacePath = process.env.CCNOW_DEFAULT_WORKSPACE || process.cwd();
  let agentType = 'claude';
  let sessionMode = 'hybrid';
  let model = '';
  if (hasCommand('tmux') && sessionName) {
    try {
      const fmt = '#{session_path}|#{@agent_type}|#{@session_mode}|#{@agent_model}';
      const out = execFileSync('tmux', tmuxArgs(['display-message', '-p', '-t', sessionName, fmt]), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      const parts = out.split('|');
      if (parts[0] && fs.existsSync(parts[0])) workspacePath = parts[0];
      if (parts[1] && parts[1].trim()) agentType = parts[1].trim();
      if (parts[2] && parts[2].trim()) sessionMode = parts[2].trim();
      if (parts[3] && parts[3].trim()) model = parts[3].trim();
    } catch (_) {}
  }
  return { workspacePath, agentType, sessionMode, model };
}

async function handleListSessions(send, reqId) {
  const hasTmux = hasCommand('tmux');
  const sessions = [];
  const seenNames = new Set();

  if (hasTmux) {
    try {
      const fmt = '#{session_name}|#{session_windows}|#{session_created}|#{?session_attached,1,0}|#{session_path}|#{@workspace_name}|#{@agent_type}|#{@agent_model}|#{@session_mode}|#{@agent_session_id}';
      const { stdout } = await execFileAsync('tmux', tmuxArgs(['list-sessions', '-F', fmt]), {
        encoding: 'utf8'
      });
      const lines = (stdout || '').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 1 && parts[0]) {
          const agentType = parts[6] || '';
          const rawMode = parts[8] || '';
          const sessionMode = rawMode || (agentType === 'default' ? 'terminal_only' : 'hybrid');
          seenNames.add(parts[0]);
          sessions.push({
            name: parts[0],
            windows: parseInt(parts[1], 10) || 1,
            created: parseInt(parts[2], 10) * 1000 || Date.now(),
            attached: parts[3] === '1',
            path: parts[4] || '',
            workspaceName: parts[5] || '',
            agentType,
            agentModel: parts[7] || '',
            sessionMode,
            agentSessionId: parts[9] || '',
            isRemote: true
          });
        }
      }
    } catch (e) {
      // No tmux server or zero active sessions
    }
  }

  // Merge tmux-free OAR Pure Chat sessions from ~/.ccnow/sessions.json
  for (const s of sessionRegistry.listPureChatSessions()) {
    if (!seenNames.has(s.name)) {
      seenNames.add(s.name);
      sessions.push(s);
    }
  }

  // Non-tmux hosts still expose a default terminal shell if no terminal session exists
  if (!hasTmux && !sessions.some(s => s.sessionMode !== 'chat_only')) {
    sessions.push({
      name: 'default',
      windows: 1,
      created: Date.now(),
      attached: true,
      sessionMode: 'terminal_only',
      agentType: 'default',
      isRemote: true
    });
  }

  send({ action: 'tmux:sessions_list', reqId, sessions });
}

function handleNewSession(send, reqId, msg, getDeviceOarManager) {
  const { sessionName, seqId, workspace, workspaceName, sessionMode, agentModel, modelName } = msg;
  const agent = msg.agent || msg.agentType || 'default';
  const targetMode = sessionMode || (agent === 'default' ? 'terminal_only' : 'hybrid');
  const hasTmux = hasCommand('tmux');
  const targetDir = resolveBaseDir(workspace);
  const fallbackBase = targetMode === 'chat_only'
    ? `oar-${agent !== 'default' ? agent : 'claude'}`
    : (agent !== 'default' ? agent : 'shell');
  const baseName = String(sessionName || '').replace(/[^a-zA-Z0-9_-]/g, '') || (seqId ? `${fallbackBase}-${seqId}` : fallbackBase);

  // Helper to deduplicate against both sessionRegistry and tmux sessions
  const existingSet = new Set(Object.keys(sessionRegistry.readRegistry()));
  if (hasTmux) {
    try {
      const existingOut = execFileSync('tmux', tmuxArgs(['list-sessions', '-F', '#{session_name}']), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      for (const n of existingOut.trim().split('\n').filter(Boolean)) existingSet.add(n);
    } catch (_) {}
  }
  let finalName = baseName;
  if (existingSet.has(finalName)) {
    if (seqId && !existingSet.has(`${baseName}-${seqId}`)) {
      finalName = `${baseName}-${seqId}`;
    } else {
      let idx = Math.max(2, Number(seqId) || 2);
      while (existingSet.has(`${baseName}-${idx}`)) idx++;
      finalName = `${baseName}-${idx}`;
    }
  }

  // 1. Pure Chat Mode (OAR): 100% tmux-free! Persisted in ~/.ccnow/sessions.json
  if (targetMode === 'chat_only') {
    try {
      const effectiveAgent = agent !== 'default' ? agent : 'claude';
      sessionRegistry.upsertPureChatSession(finalName, {
        seqId: seqId || undefined,
        workspacePath: targetDir,
        workspaceName: workspaceName ? String(workspaceName) : '',
        agentType: effectiveAgent,
        agentModel: agentModel ? String(agentModel) : '',
        modelName: modelName ? String(modelName) : '',
        created: Date.now()
      });

      const oarMgr = getDeviceOarManager();
      if (oarMgr) {
        oarMgr.deleteSession(finalName);
        oarMgr.getOrCreateSession(finalName, {
          agentType: effectiveAgent,
          workspacePath: targetDir,
          model: agentModel || modelName || ''
        });
      }

      send({ action: 'tmux:new_session_result', reqId, success: true, sessionName: finalName });
      return;
    } catch (e) {
      send({ action: 'tmux:new_session_result', reqId, error: e.message });
      return;
    }
  }

  // 2. Terminal / Hybrid Mode: backed by tmux when available
  if (hasTmux && finalName) {
    try {
      execFileSync('tmux', tmuxArgs(['new-session', '-d', '-s', finalName, '-c', targetDir]), { stdio: 'ignore' });

      let agentSessionId = '';
      if (agent === 'claude') {
        agentSessionId = crypto.randomUUID();
      }

      const tmuxOptions = [
        ['status', 'off'],
        ['mouse', 'on'],
        ['@session_mode', targetMode],
        ['@agent_type', agent]
      ];
      if (seqId) tmuxOptions.push(['@session_seq_id', String(seqId)]);
      if (workspaceName) tmuxOptions.push(['@workspace_name', String(workspaceName)]);
      if (agentSessionId) tmuxOptions.push(['@agent_session_id', agentSessionId]);
      if (agentModel) tmuxOptions.push(['@agent_model', String(agentModel)]);

      for (const [optKey, optVal] of tmuxOptions) {
        try {
          execFileSync('tmux', tmuxArgs(['set-option', '-t', finalName, optKey, optVal]), { stdio: 'ignore' });
        } catch (_) {}
      }

      if (agent && agent !== 'default' && agent !== 'terminal') {
        let agentCmd = String(agent).replace(/"/g, '');
        if (agent === 'agy') {
          agentCmd = 'agy --dangerously-skip-permissions';
        } else if (agent === 'claude') {
          const parts = [
            'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1',
            'claude', '--session-id', agentSessionId, '--permission-mode', 'auto'
          ];
          if (modelName) parts.push('--model', String(modelName));
          agentCmd = parts.join(' ');
        } else if (agent === 'codex') {
          const parts = ['codex', '-c', 'check_for_update=false', '-c', 'update_on_startup=false'];
          if (modelName) parts.push('--model', String(modelName));
          agentCmd = parts.join(' ');
        }
        try {
          execFileSync('tmux', tmuxArgs(['send-keys', '-t', finalName, agentCmd, 'C-m']), { stdio: 'ignore' });
        } catch (_) {}
      }

      send({ action: 'tmux:new_session_result', reqId, success: true, sessionName: finalName });
      return;
    } catch (e) {
      send({ action: 'tmux:new_session_result', reqId, error: e.message });
      return;
    }
  }
  send({ action: 'tmux:new_session_result', reqId, success: true, sessionName: finalName });
}

function handleKillSession(send, reqId, sessionName, getDeviceOarManager) {
  const wasPureChat = sessionRegistry.deletePureChatSession(sessionName);
  const oarMgr = getDeviceOarManager();
  if (oarMgr && sessionName) {
    try { oarMgr.deleteSession(sessionName); } catch (_) {}
  }
  if (!wasPureChat && hasCommand('tmux') && sessionName) {
    try {
      execFileSync('tmux', tmuxArgs(['kill-session', '-t', sessionName]), { stdio: 'ignore' });
    } catch (e) {}
  }
  send({ action: 'tmux:kill_session_result', reqId, success: true });
}

function handleSendKeys(send, reqId, msg) {
  const { sessionName, text, clearHistory, exitCopyMode } = msg || {};
  if (!hasCommand('tmux') || !sessionName) {
    return send({ action: 'tmux:send_keys_result', reqId, success: false, error: 'tmux or sessionName unavailable' });
  }
  try {
    if (exitCopyMode) {
      try { execFileSync('tmux', tmuxArgs(['copy-mode', '-q', '-t', sessionName]), { stdio: 'ignore' }); } catch (_) {}
    }
    if (clearHistory) {
      execFileSync('tmux', tmuxArgs(['send-keys', '-t', sessionName, '/clear', 'C-m']), { stdio: 'ignore' });
    }
    if (typeof text === 'string' && text.length > 0) {
      execFileSync('tmux', tmuxArgs(['send-keys', '-t', sessionName, '-l', text]), { stdio: 'ignore' });
      execFileSync('tmux', tmuxArgs(['send-keys', '-t', sessionName, 'C-m']), { stdio: 'ignore' });
    }
    send({ action: 'tmux:send_keys_result', reqId, success: true });
  } catch (e) {
    send({ action: 'tmux:send_keys_result', reqId, success: false, error: e.message });
  }
}

function handleOpenTerminal(send, msg) {
  const { termId, sessionName, cols = 80, rows = 24 } = msg;

  // Guard: tmux-free Pure Chat OAR sessions have no tmux PTY; do not spawn tmux attach or emit term:exit
  if (sessionName && sessionRegistry.getPureChatSession(sessionName)) {
    console.log(`💬 [Terminal PTY] Skipping PTY attach for tmux-free OAR session '${sessionName}'`);
    return;
  }

  if (activeTerminals.has(termId)) {
    try { activeTerminals.get(termId).kill(); } catch (e) {}
    activeTerminals.delete(termId);
  }

  console.log(`🖥️ [Terminal PTY] Spawning session '${sessionName}' for termId: ${termId} (${cols}x${rows})`);

  const hasTmux = hasCommand('tmux');
  const hasPython = hasCommand('python3');
  const userShell = process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');

  let targetCmd = userShell;
  let targetArgs = [];

  if (hasTmux && sessionName) {
    targetCmd = 'tmux';
    targetArgs = tmuxArgs(['attach-session', '-t', sessionName]);
  }

  let ptyHandler = null;

  // Method 1: node-pty (two-tier lookup: standard node_modules -> ~/.ccnow/node_modules)
  const nodePty = tryRequireOptional('node-pty');
  if (nodePty) {
    try {
      const ptyProcess = nodePty.spawn(targetCmd, targetArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
      });

      ptyProcess.onData((data) => {
        send({ action: 'term:output', termId, data });
      });

      ptyProcess.onExit(() => {
        activeTerminals.delete(termId);
        send({ action: 'term:exit', termId });
      });

      ptyHandler = {
        write: (d) => ptyProcess.write(d),
        resize: (c, r) => ptyProcess.resize(c, r),
        kill: () => ptyProcess.kill()
      };
    } catch (e) {
      // Fallback to Python 3 PTY or child_process
    }
  }

  // Method 2: Python 3 POSIX PTY Bridge
  if (!ptyHandler && hasPython) {
    const fullCmdList = [targetCmd, ...targetArgs];
    const pyScript = `import pty, os, sys\npty.spawn(${JSON.stringify(fullCmdList)})\n`;
    const pyProcess = spawn('python3', ['-c', pyScript], {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
    });

    pyProcess.stdout.on('data', (chunk) => send({ action: 'term:output', termId, data: chunk.toString() }));
    pyProcess.stderr.on('data', (chunk) => send({ action: 'term:output', termId, data: chunk.toString() }));
    pyProcess.on('close', () => {
      activeTerminals.delete(termId);
      send({ action: 'term:exit', termId });
    });

    ptyHandler = {
      write: (d) => { if (pyProcess.stdin.writable) pyProcess.stdin.write(d); },
      resize: () => {},
      kill: () => { try { pyProcess.kill('SIGTERM'); } catch (err) {} }
    };
  }

  // Method 3: Standard ChildProcess Spawn Fallback
  if (!ptyHandler) {
    const shProcess = spawn(targetCmd, targetArgs, {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    shProcess.stdout.on('data', (chunk) => send({ action: 'term:output', termId, data: chunk.toString() }));
    shProcess.stderr.on('data', (chunk) => send({ action: 'term:output', termId, data: chunk.toString() }));
    shProcess.on('close', () => {
      activeTerminals.delete(termId);
      send({ action: 'term:exit', termId });
    });

    ptyHandler = {
      write: (d) => { if (shProcess.stdin.writable) shProcess.stdin.write(d); },
      resize: () => {},
      kill: () => { try { shProcess.kill('SIGKILL'); } catch (err) {} }
    };
  }

  activeTerminals.set(termId, ptyHandler);
}

function handleTerminalInput(msg) {
  const term = activeTerminals.get(msg.termId);
  if (term && term.write) term.write(msg.data);
}

function handleTerminalResize(msg) {
  const term = activeTerminals.get(msg.termId);
  if (term && term.resize) term.resize(msg.cols, msg.rows);
}

function handleTerminalClose(msg) {
  const term = activeTerminals.get(msg.termId);
  if (term) {
    term.kill();
    activeTerminals.delete(msg.termId);
  }
}

module.exports = {
  activeTerminals,
  cleanupAllTerminals,
  readTmuxSessionMeta,
  handleListSessions,
  handleNewSession,
  handleKillSession,
  handleSendKeys,
  handleOpenTerminal,
  handleTerminalInput,
  handleTerminalResize,
  handleTerminalClose
};
