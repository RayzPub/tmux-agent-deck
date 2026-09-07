const fs = require('fs');
const path = require('path');
const { execTmux, getRunUser } = require('./tmuxService');
const { readWorkspaces, resolveWorkspacePath, safeResolve, getUserHomeDir, getHomeDir } = require('./fileService');
const { execCommand } = require('./gitService');
const { findClaudeSessionFile, parseClaudeJsonl, getSessionIdFromPanePid } = require('./agentChatService');
const { MULTI_USER_ENABLED, PROJECT_ROOT } = require('../config');

/**
 * Ensure .deck/deck_task_spec.md exists in the workspace .deck folder
 */
function ensureDeckSpecFile(workspacePath) {
  try {
    const deckDir = safeResolve(workspacePath, '.deck');
    if (!fs.existsSync(deckDir)) {
      fs.mkdirSync(deckDir, { recursive: true });
      const runUser = getRunUser();
      if (runUser && process.getuid && process.getuid() === 0) {
        try {
          const { execSync } = require('child_process');
          execSync(`chown -R ${runUser}:${runUser} "${deckDir}"`);
        } catch (e) {}
      }
    }

    const targetSpecFile = safeResolve(deckDir, 'deck_task_spec.md');
    if (!fs.existsSync(targetSpecFile)) {
      const templateSpecFile = path.join(PROJECT_ROOT, 'docs', 'deck_task_spec.md');
      if (fs.existsSync(templateSpecFile)) {
        fs.copyFileSync(templateSpecFile, targetSpecFile);
        const runUser = getRunUser();
        if (runUser && process.getuid && process.getuid() === 0) {
          try {
            const { execSync } = require('child_process');
            execSync(`chown ${runUser}:${runUser} "${targetSpecFile}"`);
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    // Non-critical, ignore
  }
}

/**
 * Execute Git command asynchronously with Promise
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execCommand('git', args, cwd, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: '', stderr: (stderr || err.message).trim() });
      } else {
        resolve({ ok: true, stdout: (stdout || '').trim(), stderr: '' });
      }
    });
  });
}

/**
 * Read .deck/tasks.json or .deck/project.json mission file from workspace root safely
 */
function readProjectMetadata(workspacePath) {
  let mission = '';
  let updatedAt = null;
  let tasks = [];

  // Automatically ensure .deck/deck_task_spec.md exists in this workspace
  ensureDeckSpecFile(workspacePath);

  try {
    const deckDir = safeResolve(workspacePath, '.deck');
    const tasksFile = safeResolve(deckDir, 'tasks.json');
    const projectFile = safeResolve(deckDir, 'project.json');

    // 1. First check if tasks.json exists (richer spec)
    if (fs.existsSync(tasksFile)) {
      const raw = fs.readFileSync(tasksFile, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.mission === 'string') mission = data.mission;
      if (Array.isArray(data.tasks)) tasks = data.tasks;
      if (data.updatedAt) updatedAt = data.updatedAt;
    }

    // 2. Fall back to project.json if mission is empty
    if (!mission && fs.existsSync(projectFile)) {
      const raw = fs.readFileSync(projectFile, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.mission === 'string') mission = data.mission;
      if (!updatedAt && data.updatedAt) updatedAt = data.updatedAt;
    }
  } catch (err) {
    // ignore
  }

  return { mission, updatedAt, tasks };
}

/**
 * Write .deck/project.json mission file safely
 */
function writeProjectMetadata(workspacePath, missionText) {
  const deckDir = safeResolve(workspacePath, '.deck');
  if (!fs.existsSync(deckDir)) {
    fs.mkdirSync(deckDir, { recursive: true });
    const runUser = getRunUser();
    if (runUser && process.getuid && process.getuid() === 0) {
      try {
        const { execSync } = require('child_process');
        execSync(`chown -R ${runUser}:${runUser} "${deckDir}"`);
      } catch (e) {}
    }
  }

  const projectFile = safeResolve(deckDir, 'project.json');
  const now = new Date().toISOString();
  const payload = {
    mission: String(missionText || '').trim(),
    updatedAt: now
  };
  fs.writeFileSync(projectFile, JSON.stringify(payload, null, 2), 'utf8');

  // Also sync mission to tasks.json if it exists
  const tasksFile = safeResolve(deckDir, 'tasks.json');
  if (fs.existsSync(tasksFile)) {
    try {
      const raw = fs.readFileSync(tasksFile, 'utf8');
      const tasksData = JSON.parse(raw);
      tasksData.mission = payload.mission;
      tasksData.updatedAt = now;
      fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2), 'utf8');
    } catch (e) {}
  }

  return payload;
}

/**
 * Save tasks list to .deck/tasks.json safely
 */
function writeProjectTasks(workspacePath, tasks, missionText = null) {
  const deckDir = safeResolve(workspacePath, '.deck');
  if (!fs.existsSync(deckDir)) {
    fs.mkdirSync(deckDir, { recursive: true });
    const runUser = getRunUser();
    if (runUser && process.getuid && process.getuid() === 0) {
      try {
        const { execSync } = require('child_process');
        execSync(`chown -R ${runUser}:${runUser} "${deckDir}"`);
      } catch (e) {}
    }
  }

  const existingMeta = readProjectMetadata(workspacePath);
  const now = new Date().toISOString();
  const payload = {
    mission: missionText !== null ? String(missionText).trim() : existingMeta.mission,
    updatedAt: now,
    tasks: Array.isArray(tasks) ? tasks : []
  };

  const tasksFile = safeResolve(deckDir, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Get comprehensive project progression data for a given workspace
 */
async function getProjectProgress(workspaceIdentifier, username = null) {
  const effectiveUser = username || (MULTI_USER_ENABLED ? 'admin' : null);
  let workspacePath;
  let workspaceName = workspaceIdentifier;

  const workspaces = readWorkspaces(effectiveUser);
  const matchedWs = workspaces.find(w => 
    (w.name && w.name.toLowerCase() === workspaceIdentifier.toLowerCase()) ||
    (w.path && (w.path === workspaceIdentifier || resolveWorkspacePath(w.path, effectiveUser) === path.resolve(workspaceIdentifier)))
  );

  if (matchedWs) {
    workspaceName = matchedWs.name;
    workspacePath = resolveWorkspacePath(matchedWs.path, effectiveUser);
  } else {
    // Fallback: test if workspaceIdentifier can be resolved to an existing directory
    const candidate = resolveWorkspacePath(workspaceIdentifier, effectiveUser);
    if (candidate && fs.existsSync(candidate)) {
      workspacePath = candidate;
      workspaceName = path.basename(candidate);
    } else {
      throw new Error(`Workspace "${workspaceIdentifier}" not found`);
    }
  }

  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path "${workspacePath}" does not exist on disk`);
  }

  // 1. Read Project Mission
  const metadata = readProjectMetadata(workspacePath);

  // 2. Query Git status
  let git = {
    isRepo: false,
    branch: '',
    changedFilesCount: 0,
    recentCommits: []
  };

  const isGitRepoCheck = await runGit(['rev-parse', '--is-inside-work-tree'], workspacePath);
  if (isGitRepoCheck.ok && isGitRepoCheck.stdout === 'true') {
    git.isRepo = true;

    // Get current branch
    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath);
    git.branch = branchRes.ok ? branchRes.stdout : 'HEAD';

    // Get changed files count
    const statusRes = await runGit(['status', '--porcelain'], workspacePath);
    if (statusRes.ok) {
      const lines = statusRes.stdout.split('\n').map(l => l.trim()).filter(Boolean);
      git.changedFilesCount = lines.length;
    }

    // Get recent commits (up to 5)
    const logRes = await runGit(['log', '-n', '5', '--pretty=format:%h||%s||%an||%cr'], workspacePath);
    if (logRes.ok && logRes.stdout) {
      git.recentCommits = logRes.stdout.split('\n').filter(Boolean).map(line => {
        const [hash, subject, author, relativeTime] = line.split('||');
        return { hash, subject, author, relativeTime };
      });
    }
  }

  // 3. Query all Tmux sessions and filter for this workspace
  const sessionList = await new Promise((resolve) => {
    execTmux(
      ['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}|#{session_path}|#{@workspace_name}|#{@agent_type}|#{@agent_model}|#{@agent_session_id}|#{pane_pid}'],
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const rawLines = stdout.trim().split('\n').filter(Boolean);
        resolve(rawLines);
      },
      effectiveUser
    );
  });

  const prefix = (MULTI_USER_ENABLED && effectiveUser) ? `u_${effectiveUser}_` : '';
  const userHome = getUserHomeDir(effectiveUser);
  const sysHome = getHomeDir();

  const sessions = [];

  for (const line of sessionList) {
    const [fullName, attached, created, sessionPath, wsName, agentType, agentModel, agentSessionId, panePid] = line.split('|');

    // Filter by user if multi-user
    if (MULTI_USER_ENABLED && effectiveUser) {
      if (!fullName.startsWith(prefix)) continue;
    }

    // Check if session belongs to this workspace
    const normalizedWsPath = path.resolve(workspacePath).replace(/\/+$/, '');
    const normalizedSessionPath = sessionPath ? path.resolve(sessionPath).replace(/\/+$/, '') : '';

    const matchesWorkspace = (wsName && wsName.toLowerCase() === workspaceName.toLowerCase()) ||
                             (normalizedSessionPath && normalizedSessionPath === normalizedWsPath);

    if (!matchesWorkspace) continue;

    const shortName = (MULTI_USER_ENABLED && effectiveUser && fullName.startsWith(prefix))
      ? fullName.substring(prefix.length)
      : fullName;

    const sessionObj = {
      name: shortName,
      fullName,
      attached: parseInt(attached, 10) > 0,
      created: new Date(parseInt(created, 10) * 1000).toLocaleString(),
      createdTimestamp: parseInt(created, 10) * 1000,
      agentType: agentType || 'terminal',
      agentModel: agentModel || '',
      lastActivity: null
    };

    // Check if this is a Claude Code session with JSONL logs
    const sessionFileInfo = findClaudeSessionFile(workspacePath, agentSessionId, panePid, userHome, sysHome);
    if (sessionFileInfo && sessionFileInfo.filePath) {
      try {
        const parsed = await parseClaudeJsonl(sessionFileInfo.filePath, 10);
        if (parsed && parsed.messages && parsed.messages.length > 0) {
          const lastMsg = parsed.messages[parsed.messages.length - 1];
          const lastUserMsg = [...parsed.messages].reverse().find(m => m.role === 'user');
          sessionObj.lastActivity = {
            role: lastMsg.role,
            text: (lastMsg.text || '').substring(0, 160),
            userPrompt: lastUserMsg ? (lastUserMsg.text || '').substring(0, 120) : '',
            timestamp: lastMsg.timestamp || null
          };
        }
      } catch (err) {}
    }

    // Capture live terminal pane output to detect real-time execution status
    const paneOutput = await new Promise((resPane) => {
      execTmux(['capture-pane', '-p', '-t', fullName, '-S', '-15'], (err, out) => {
        resPane(out || '');
      }, effectiveUser);
    });

    const nonBlankLines = paneOutput.split('\n').map(l => l.trim()).filter(Boolean);
    const lastFewLines = nonBlankLines.slice(-6);
    const recentText = lastFewLines.join('\n');

    // 1. Check if waiting for user confirmation / permission
    const waitingPatterns = [
      /\[y\/N\]/i,
      /\[Y\/n\]/i,
      /\[y\/n\]/i,
      /\(y\/n\)/i,
      /allow\s+.*?\?/i,
      /confirm\s+.*?\?/i,
      /please\s+authorize/i,
      /authorize\s+.*?\?/i,
      /waiting\s+for\s+(approval|input|feedback)/i,
      /escalate_admin/i,
      /enter\s+to\s+continue/i,
      /password\s+for\s+.*?:/i
    ];
    const isWaiting = waitingPatterns.some(p => p.test(recentText));

    // 2. Check if actively executing a task
    const busyPatterns = [
      /thinking\.\.\./i,
      /working\.\.\./i,
      /running\.\.\./i,
      /ctrl\+c\s+to\s+interrupt/i,
      /[⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
      /●\s+(bash|read|write|view|tool)/i
    ];
    const isBusy = busyPatterns.some(p => p.test(recentText));

    if (isWaiting) {
      sessionObj.status = 'waiting';
      sessionObj.statusLabel = '等待确认';
    } else if (isBusy) {
      sessionObj.status = 'busy';
      sessionObj.statusLabel = '执行中';
    } else {
      sessionObj.status = 'idle';
      sessionObj.statusLabel = '空闲就绪';
    }

    // Fallback snippet for terminal activity display
    if (!sessionObj.lastActivity) {
      const paneSnippet = nonBlankLines.slice(-3).join(' ');
      if (paneSnippet) {
        sessionObj.lastActivity = {
          role: 'terminal',
          text: paneSnippet.substring(0, 160),
          timestamp: null
        };
      }
    }

    sessions.push(sessionObj);
  }

  // Sort sessions: busy first, then waiting, then attached, then by creation date descending
  sessions.sort((a, b) => {
    const statusWeight = { busy: 3, waiting: 2, idle: 1 };
    const diff = (statusWeight[b.status] || 0) - (statusWeight[a.status] || 0);
    if (diff !== 0) return diff;
    if (a.attached !== b.attached) return a.attached ? -1 : 1;
    return b.createdTimestamp - a.createdTimestamp;
  });

  // Calculate overall workspace status
  let workspaceStatus = 'empty';
  if (sessions.length > 0) {
    if (sessions.some(s => s.status === 'busy')) {
      workspaceStatus = 'busy';
    } else if (sessions.some(s => s.status === 'waiting')) {
      workspaceStatus = 'waiting';
    } else {
      workspaceStatus = 'idle';
    }
  }

  return {
    workspaceName,
    workspacePath,
    workspaceStatus,
    git,
    mission: metadata.mission,
    missionUpdatedAt: metadata.updatedAt,
    tasks: metadata.tasks || [],
    sessions,
    timestamp: Date.now()
  };
}

/**
 * Dispatch a task / prompt directly to an agent session with optional context cleaning
 */
async function dispatchTask(workspaceIdentifier, sessionName, promptText, username = null, options = {}) {
  if (!promptText || !promptText.trim()) {
    throw new Error('任务指令内容不能为空');
  }

  const effectiveUser = username || (MULTI_USER_ENABLED ? 'admin' : null);
  const prefix = (MULTI_USER_ENABLED && effectiveUser) ? `u_${effectiveUser}_` : '';
  let physicalSession = sessionName;
  if (MULTI_USER_ENABLED && effectiveUser && !sessionName.startsWith(prefix)) {
    physicalSession = `${prefix}${sessionName}`;
  }

  // Verify session exists in tmux
  const sessionInfo = await new Promise((resolve) => {
    execTmux(['display-message', '-p', '-t', physicalSession, '#{session_name}|#{@agent_type}'], (err, stdout) => {
      if (err) return resolve(null);
      const [name, agentType] = (stdout || '').trim().split('|');
      resolve({ name, agentType: (agentType || '').toLowerCase() });
    }, effectiveUser);
  });

  if (!sessionInfo) {
    throw new Error(`目标会话 "${sessionName}" 不存在或已退出`);
  }

  const { clearHistory } = options;

  // 1. If clearHistory is requested, send CLI-specific clear command first
  if (clearHistory) {
    let cleanCmd = '/clear';
    if (sessionInfo.agentType === 'codex') {
      cleanCmd = '/new';
    } else if (sessionInfo.agentType === 'claude') {
      cleanCmd = '/clear';
    } else if (sessionInfo.agentType === 'agy' || sessionInfo.agentType === 'antigravity') {
      cleanCmd = '/clear';
    } else {
      cleanCmd = 'clear';
    }

    await new Promise((resolve) => {
      execTmux(['send-keys', '-t', physicalSession, '-l', cleanCmd], () => {
        execTmux(['send-keys', '-t', physicalSession, 'Enter'], () => {
          // Wait briefly for terminal agent to reset its session context
          setTimeout(resolve, 300);
        }, effectiveUser);
      }, effectiveUser);
    });
  }

  // 2. Send literal prompt string followed by Enter key
  await new Promise((resolve, reject) => {
    execTmux(['send-keys', '-t', physicalSession, '-l', promptText.trim()], (err) => {
      if (err) return reject(err);
      execTmux(['send-keys', '-t', physicalSession, 'Enter'], (err2) => {
        if (err2) return reject(err2);
        resolve(true);
      }, effectiveUser);
    }, effectiveUser);
  });

  return {
    success: true,
    sessionName,
    clearedHistory: !!clearHistory,
    dispatchedAt: new Date().toISOString()
  };
}

module.exports = {
  getProjectProgress,
  writeProjectMetadata,
  writeProjectTasks,
  dispatchTask
};
