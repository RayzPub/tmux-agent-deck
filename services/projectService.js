const fs = require('fs');
const path = require('path');
const { execTmux, getRunUser } = require('./tmuxService');
const { readWorkspaces, resolveWorkspacePath, safeResolve, getUserHomeDir, getHomeDir } = require('./fileService');
const { execCommand } = require('./gitService');
const { findAgentSessionFile, parseAgentChat, findClaudeSessionFile, parseClaudeJsonl, getSessionIdFromPanePid } = require('./agentChatService');
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
function writeProjectMetadata(workspacePath, missionText, options = {}) {
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
  const { atomicWriteJSON } = require('./sqliteService');
  atomicWriteJSON(projectFile, payload);

  // Also sync mission to tasks.json if it exists
  const tasksFile = safeResolve(deckDir, 'tasks.json');
  if (fs.existsSync(tasksFile)) {
    try {
      const raw = fs.readFileSync(tasksFile, 'utf8');
      const tasksData = JSON.parse(raw);
      tasksData.mission = payload.mission;
      tasksData.updatedAt = now;
      if (options && options.clearTasks) {
        tasksData.tasks = [];
      }
      atomicWriteJSON(tasksFile, tasksData);
    } catch (e) {}
  } else if (options && options.clearTasks) {
    try {
      atomicWriteJSON(tasksFile, {
        mission: payload.mission,
        updatedAt: now,
        tasks: []
      });
      const runUser = getRunUser();
      if (runUser && process.getuid && process.getuid() === 0) {
        try {
          const { execSync } = require('child_process');
          execSync(`chown ${runUser}:${runUser} "${tasksFile}"`);
        } catch (e) {}
      }
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
  const { atomicWriteJSON } = require('./sqliteService');
  atomicWriteJSON(tasksFile, payload);
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

    // Check if this is a supported agent session with JSONL logs (Claude Code or Antigravity)
    let effectiveSessionId = agentSessionId;
    if ((agentType === 'agy' || agentType === 'antigravity') && panePid && typeof getSessionIdFromPanePid === 'function') {
      const liveAgyId = getSessionIdFromPanePid(panePid);
      if (liveAgyId) {
        if (effectiveSessionId && liveAgyId !== effectiveSessionId && fullName) {
          execTmux(['set-option', '-t', fullName, '@agent_session_id', liveAgyId], () => {}, effectiveUser);
        }
        effectiveSessionId = liveAgyId;
      }
    }
    const sessionFileInfo = findAgentSessionFile(agentType, workspacePath, effectiveSessionId, panePid, userHome, sysHome);
    if (sessionFileInfo && sessionFileInfo.sessionId && !agentSessionId && fullName) {
      execTmux(['set-option', '-t', fullName, '@agent_session_id', sessionFileInfo.sessionId], () => {}, effectiveUser);
    }
    if (sessionFileInfo && sessionFileInfo.filePath) {
      try {
        const parsed = await parseAgentChat(sessionFileInfo.agentType, sessionFileInfo.filePath, 10);
        if (parsed && parsed.messages && parsed.messages.length > 0) {
          const lastMsg = parsed.messages[parsed.messages.length - 1];
          const lastUserMsg = [...parsed.messages].reverse().find(m => m.role === 'user');
          sessionObj.lastActivity = {
            role: lastMsg.role,
            text: (lastMsg.content || lastMsg.text || '').substring(0, 160),
            userPrompt: lastUserMsg ? (lastUserMsg.content || lastUserMsg.text || '').substring(0, 120) : '',
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

/**
 * Helper: Safe per-user task board username key for SQLite storage
 */
function getTaskBoardUserKey(username) {
  const effectiveUser = username || (MULTI_USER_ENABLED ? 'admin' : 'default');
  return String(effectiveUser || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function readTaskBoardStore(username) {
  const userKey = getTaskBoardUserKey(username);
  try {
    const { getDb } = require('./sqliteService');
    const db = getDb();
    const todoRows = db.prepare(
      'SELECT * FROM task_board_todos WHERE username = ? ORDER BY created_at DESC'
    ).all(userKey);

    const todos = todoRows.map(r => {
      let extra = {};
      try { extra = JSON.parse(r.extra_json || '{}'); } catch (_) {}
      return {
        ...extra,
        id: r.id,
        title: r.title,
        description: r.description || '',
        workspaceName: r.workspace_name || '',
        workspacePath: r.workspace_path || '',
        agentType: r.agent_type || 'agy',
        priority: r.priority || 'medium',
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    });

    const metaRows = db.prepare(
      'SELECT * FROM task_board_card_meta WHERE username = ?'
    ).all(userKey);

    const cardMeta = {};
    for (const r of metaRows) {
      let extra = {};
      try { extra = JSON.parse(r.extra_json || '{}'); } catch (_) {}
      const entry = { ...extra, updatedAt: r.updated_at };
      if (r.custom_title !== null && r.custom_title !== undefined && r.custom_title !== '') {
        entry.customTitle = r.custom_title;
      }
      if (r.pinned) {
        entry.pinned = true;
      }
      cardMeta[r.session_name] = entry;
    }

    return { todos, cardMeta };
  } catch (err) {
    console.error('[ProjectService] Error reading task board from SQLite:', err);
    return { todos: [], cardMeta: {} };
  }
}

function writeTaskBoardStore(username, store) {
  const userKey = getTaskBoardUserKey(username);
  const now = new Date().toISOString();
  const todos = Array.isArray(store.todos) ? store.todos : [];
  const cardMeta = (store.cardMeta && typeof store.cardMeta === 'object') ? store.cardMeta : {};

  const { withTransaction } = require('./sqliteService');
  withTransaction((db) => {
    db.prepare('DELETE FROM task_board_todos WHERE username = ?').run(userKey);
    const insTodo = db.prepare(`
      INSERT INTO task_board_todos (
        id, username, title, description, workspace_name, workspace_path,
        agent_type, priority, extra_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of todos) {
      if (!t || !t.id) continue;
      const { id, title, description, workspaceName, workspacePath, agentType, priority, createdAt, updatedAt, ...extra } = t;
      insTodo.run(
        String(id),
        userKey,
        String(title || ''),
        String(description || ''),
        String(workspaceName || ''),
        String(workspacePath || ''),
        String(agentType || 'agy'),
        String(priority || 'medium'),
        JSON.stringify(extra || {}),
        createdAt || now,
        updatedAt || now
      );
    }

    db.prepare('DELETE FROM task_board_card_meta WHERE username = ?').run(userKey);
    const insMeta = db.prepare(`
      INSERT INTO task_board_card_meta (username, session_name, custom_title, pinned, extra_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [sessionName, meta] of Object.entries(cardMeta)) {
      if (!meta || typeof meta !== 'object') continue;
      const { customTitle, pinned, updatedAt, ...extra } = meta;
      insMeta.run(
        userKey,
        sessionName,
        customTitle !== undefined ? String(customTitle) : null,
        pinned ? 1 : 0,
        JSON.stringify(extra || {}),
        updatedAt || now
      );
    }
  });

  return { todos, cardMeta, updatedAt: now };
}

function upsertTodoItem(username, item) {
  const userKey = getTaskBoardUserKey(username);
  const { getDb } = require('./sqliteService');
  const db = getDb();
  const now = new Date().toISOString();

  let existing = null;
  if (item.id) {
    const row = db.prepare('SELECT * FROM task_board_todos WHERE id = ? AND username = ?').get(String(item.id), userKey);
    if (row) {
      let extra = {};
      try { extra = JSON.parse(row.extra_json || '{}'); } catch (_) {}
      existing = {
        ...extra,
        id: row.id,
        title: row.title,
        description: row.description,
        workspaceName: row.workspace_name,
        workspacePath: row.workspace_path,
        agentType: row.agent_type,
        priority: row.priority,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
  }

  let todo;
  if (existing) {
    todo = { ...existing, ...item, updatedAt: now };
    const { id, title, description, workspaceName, workspacePath, agentType, priority, createdAt, updatedAt, ...extra } = todo;
    db.prepare(`
      UPDATE task_board_todos
      SET title = ?, description = ?, workspace_name = ?, workspace_path = ?,
          agent_type = ?, priority = ?, extra_json = ?, updated_at = ?
      WHERE id = ? AND username = ?
    `).run(
      String(title || ''),
      String(description || ''),
      String(workspaceName || ''),
      String(workspacePath || ''),
      String(agentType || 'agy'),
      String(priority || 'medium'),
      JSON.stringify(extra || {}),
      updatedAt,
      String(id),
      userKey
    );
  } else {
    const id = `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    todo = {
      id,
      title: item.title,
      description: item.description || '',
      workspaceName: item.workspaceName || '',
      workspacePath: item.workspacePath || '',
      agentType: item.agentType || 'agy',
      priority: item.priority || 'medium',
      createdAt: now,
      updatedAt: now
    };
    db.prepare(`
      INSERT INTO task_board_todos (
        id, username, title, description, workspace_name, workspace_path,
        agent_type, priority, extra_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      todo.id,
      userKey,
      String(todo.title || ''),
      String(todo.description || ''),
      String(todo.workspaceName || ''),
      String(todo.workspacePath || ''),
      String(todo.agentType || 'agy'),
      String(todo.priority || 'medium'),
      todo.createdAt,
      todo.updatedAt
    );
  }

  const store = readTaskBoardStore(username);
  return { todo, todos: store.todos };
}

function deleteTodoItem(username, todoId) {
  const userKey = getTaskBoardUserKey(username);
  const { getDb } = require('./sqliteService');
  const db = getDb();
  db.prepare('DELETE FROM task_board_todos WHERE id = ? AND username = ?').run(String(todoId), userKey);
  return readTaskBoardStore(username).todos;
}

function updateCardMeta(username, sessionName, patch) {
  const userKey = getTaskBoardUserKey(username);
  const { getDb } = require('./sqliteService');
  const db = getDb();
  const store = readTaskBoardStore(username);
  const existing = store.cardMeta[sessionName] || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  if (next.customTitle === '') {
    delete next.customTitle;
  }
  if (!next.customTitle && !next.pinned) {
    db.prepare('DELETE FROM task_board_card_meta WHERE username = ? AND session_name = ?').run(userKey, sessionName);
    return {};
  }

  const { customTitle, pinned, updatedAt, ...extra } = next;
  db.prepare(`
    INSERT INTO task_board_card_meta (username, session_name, custom_title, pinned, extra_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, session_name) DO UPDATE SET
      custom_title = excluded.custom_title,
      pinned = excluded.pinned,
      extra_json = excluded.extra_json,
      updated_at = excluded.updated_at
  `).run(
    userKey,
    sessionName,
    customTitle !== undefined ? String(customTitle) : null,
    pinned ? 1 : 0,
    JSON.stringify(extra || {}),
    updatedAt
  );
  return next;
}

/**
 * Detect live agent execution state from captured tmux pane lines
 */
function detectSessionLiveStatus(paneOutput) {
  const nonBlankLines = (paneOutput || '').split('\n').map(l => l.trim()).filter(Boolean);
  const lastFewLines = nonBlankLines.slice(-8);
  const recentText = lastFewLines.join('\n');

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
    /do\s+you\s+want\s+to\s+(proceed|allow|run|continue)/i,
    /escalate_admin/i,
    /enter\s+to\s+continue/i,
    /password\s+for\s+.*?:/i
  ];
  const isWaiting = waitingPatterns.some(p => p.test(recentText));

  const busyPatterns = [
    /esc\s+to\s+interrupt/i,
    /ctrl\+c\s+to\s+interrupt/i,
    /\b(thinking|working|running|generating|analyzing|searching|reading|writing|editing|compacting|retrying|streaming)\b(\.{2,3}|…)/i,
    /\bworking\s*\(\d+s/i,
    /[⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /[✻✽✶✢]\s+\S+.*(…|\.\.\.)/,
    /●\s+(bash|read|write|view|edit|search|grep|glob|tool|run_command)/i,
    /正在(深入思考|思考|生成|执行|压缩|重试|分析|读取|写入|搜索)/
  ];
  const isBusy = busyPatterns.some(p => p.test(recentText));

  if (isWaiting) {
    return { status: 'waiting', statusLabel: '需确认', nonBlankLines };
  }
  if (isBusy) {
    return { status: 'busy', statusLabel: '执行中', nonBlankLines };
  }
  return { status: 'idle', statusLabel: '待命', nonBlankLines };
}

/**
 * Resolve true live execution state for a compute-device session by combining
 * agent-reported live status (OAR / tmux capture-pane) and parsed chat history signals.
 */
function resolveRemoteSessionLiveState(session, chatData) {
  const messages = (chatData && Array.isArray(chatData.messages)) ? chatData.messages : [];
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastUserMsg = [...messages].reverse().find(m => m && m.role === 'user') || null;

  const parseTs = (val) => {
    if (!val) return 0;
    const n = typeof val === 'number' ? val : new Date(val).getTime();
    return Number.isFinite(n) ? n : 0;
  };

  const createdTs = parseTs(session.created) || Date.now();
  const chatUpdatedTs = parseTs(chatData && chatData.lastUpdated);
  const lastMsgTs = parseTs(lastMsg && lastMsg.timestamp);
  const sessionActivityTs = parseTs(session.lastActiveAt);
  const lastActiveAt = Math.max(createdTs, chatUpdatedTs, lastMsgTs, sessionActivityTs);

  const now = Date.now();
  const lastRunningTool = lastMsg && lastMsg.role !== 'user' && Array.isArray(lastMsg.tools)
    ? lastMsg.tools.find(t => t && t.status === 'running')
    : null;
  const lastActivelyThinking = Boolean(
    lastMsg &&
    lastMsg.role !== 'user' &&
    lastMsg.thinking &&
    !lastMsg.content &&
    (!lastMsg.tools || lastMsg.tools.length === 0) &&
    (now - (lastMsgTs || chatUpdatedTs || 0)) < 120000
  );
  const recentPendingUserTurn = Boolean(
    lastMsg &&
    lastMsg.role === 'user' &&
    (chatUpdatedTs || lastMsgTs) &&
    (now - Math.max(chatUpdatedTs, lastMsgTs)) < 90000
  );

  let status = 'idle';
  let statusLabel = '待命';

  if (
    (chatData && chatData.pendingAction) ||
    session.hasPendingAction ||
    session.liveStatus === 'waiting'
  ) {
    status = 'waiting';
    statusLabel = '需确认';
  } else if (
    (chatData && chatData.isGenerating) ||
    session.isGenerating ||
    session.liveStatus === 'busy' ||
    Boolean(lastRunningTool) ||
    lastActivelyThinking ||
    recentPendingUserTurn
  ) {
    status = 'busy';
    statusLabel = '执行中';
  }

  const rawStatusText = String((chatData && chatData.statusText) || session.statusText || '').trim();
  const cleanMsgText = lastMsg
    ? String(lastMsg.content || lastMsg.text || '').replace(/\s+/g, ' ').trim().substring(0, 180)
    : '';
  const cleanUserPrompt = lastUserMsg
    ? String(lastUserMsg.content || lastUserMsg.text || '').replace(/\s+/g, ' ').trim().substring(0, 140)
    : '';

  let activityText = cleanMsgText;
  if (status === 'waiting' && chatData && chatData.pendingAction && chatData.pendingAction.hint) {
    activityText = String(chatData.pendingAction.hint).trim();
  } else if (status === 'busy' && rawStatusText && rawStatusText !== '就绪') {
    activityText = rawStatusText;
  } else if (!activityText && session.paneSnippet) {
    activityText = String(session.paneSnippet).replace(/\s+/g, ' ').trim().substring(0, 140);
  }

  return {
    status,
    statusLabel,
    lastActiveAt,
    lastUserPrompt: cleanUserPrompt,
    lastActivity: activityText
      ? {
          role: lastMsg ? lastMsg.role : 'terminal',
          text: activityText,
          userPrompt: cleanUserPrompt,
          timestamp: lastMsg ? (lastMsg.timestamp || null) : null
        }
      : null
  };
}

/**
 * Clean a raw user prompt into a concise single-line card title
 */
function summarizePromptAsTitle(promptText) {
  if (!promptText) return '';
  const cleaned = String(promptText)
    .replace(/\s+/g, ' ')
    .replace(/^【任务】\s*/, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > 72 ? cleaned.slice(0, 72) + '…' : cleaned;
}

/**
 * Get unified global (or workspace-filtered) Task Board across all sessions
 */
async function getGlobalTaskBoard(username = null, options = {}) {
  const effectiveUser = username || (MULTI_USER_ENABLED ? 'admin' : null);
  const filterWorkspace = (options.workspace || '').trim();
  const deviceId = options.deviceId || 'cloud';
  const store = readTaskBoardStore(effectiveUser);
  const workspaces = readWorkspaces(effectiveUser) || [];

  // Pre-build resolved workspace lookup
  const resolvedWorkspaces = workspaces.map(w => {
    let resolved = '';
    try {
      resolved = resolveWorkspacePath(w.path, effectiveUser).replace(/\/+$/, '');
    } catch (e) {
      resolved = String(w.path || '').replace(/\/+$/, '');
    }
    return {
      name: w.name || path.basename(resolved || w.path || 'default'),
      path: w.path,
      resolvedPath: resolved
    };
  });

  const matchWorkspaceInfo = (wsName, sessionPath) => {
    const normSessionPath = sessionPath ? path.resolve(sessionPath).replace(/\/+$/, '') : '';
    const byName = wsName
      ? resolvedWorkspaces.find(w => w.name.toLowerCase() === wsName.toLowerCase())
      : null;
    if (byName) return byName;
    const byPath = normSessionPath
      ? resolvedWorkspaces.find(w => w.resolvedPath && (w.resolvedPath === normSessionPath || normSessionPath.startsWith(w.resolvedPath + '/')))
      : null;
    if (byPath) return byPath;
    return {
      name: wsName || (normSessionPath ? path.basename(normSessionPath) : '默认工作区'),
      path: sessionPath || '',
      resolvedPath: normSessionPath
    };
  };

  let sessions = [];

  if (deviceId && deviceId !== 'cloud' && Array.isArray(options.remoteSessions)) {
    const sessionMetaService = require('./sessionMetaService');
    const sessionMetaMap = sessionMetaService.getDeviceSessionMetaMap(deviceId);
    const remoteChatMap = options.remoteChatMap instanceof Map ? options.remoteChatMap : new Map();
    // Compute-device sessions (host-admin / docker-sandbox / external)
    sessions = options.remoteSessions.map(s => {
      const name = s.name;
      const wsName = s.workspaceName || s.workspace || (s.path ? path.basename(s.path) : '远程工作区');
      const customMeta = store.cardMeta[name] || {};
      const sessMeta = sessionMetaMap.get(name) || null;
      const metaDisplayTitle = sessMeta
        ? sessionMetaService.getDisplayTitleForSession(name, sessMeta, {
          agentType: s.agentType || 'terminal',
          sessionMode: s.sessionMode || 'hybrid'
        })
        : '';
      const chatData = remoteChatMap.get(name) || null;
      const liveState = resolveRemoteSessionLiveState(s, chatData);
      const promptTitle = liveState.lastUserPrompt ? summarizePromptAsTitle(liveState.lastUserPrompt) : '';
      return {
        name,
        fullName: name,
        attached: Boolean(s.attached),
        created: s.created ? new Date(s.created).toLocaleString() : '',
        createdTimestamp: s.created ? new Date(s.created).getTime() : Date.now(),
        lastActiveAt: liveState.lastActiveAt,
        workspaceName: wsName,
        workspacePath: s.path || s.workspacePath || '',
        agentType: s.agentType || 'terminal',
        agentModel: s.agentModel || s.modelName || '',
        sessionMode: s.sessionMode || 'hybrid',
        status: liveState.status,
        statusLabel: liveState.statusLabel,
        taskTitle: customMeta.customTitle || metaDisplayTitle || promptTitle || name,
        customTitle: customMeta.customTitle || '',
        lastActivity: liveState.lastActivity,
        isRemote: true,
        deviceId
      };
    });
  } else {
    // Local / cloud tmux sessions
    const sessionLines = await new Promise((resolve) => {
      execTmux(
        ['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}|#{session_path}|#{@workspace_name}|#{@agent_type}|#{@agent_model}|#{@agent_session_id}|#{pane_pid}|#{@session_mode}'],
        (err, stdout) => {
          if (err || !stdout) return resolve([]);
          resolve(stdout.trim().split('\n').filter(Boolean));
        },
        effectiveUser
      );
    });

    const prefix = (MULTI_USER_ENABLED && effectiveUser) ? `u_${effectiveUser}_` : '';
    const userHome = getUserHomeDir(effectiveUser);
    const sysHome = getHomeDir();

    const filteredLines = sessionLines.filter(line => {
      const fullName = line.split('|')[0];
      if (MULTI_USER_ENABLED && effectiveUser && !fullName.startsWith(prefix)) {
        return false;
      }
      return true;
    });

    sessions = await Promise.all(filteredLines.map(async (line) => {
      const [fullName, attached, created, sessionPath, wsName, agentType, agentModel, agentSessionId, panePid, rawSessionMode] = line.split('|');
      const shortName = (MULTI_USER_ENABLED && effectiveUser && fullName.startsWith(prefix))
        ? fullName.substring(prefix.length)
        : fullName;
      const wsInfo = matchWorkspaceInfo(wsName, sessionPath);
      const createdTs = (parseInt(created, 10) || 0) * 1000;

      const sessionObj = {
        name: shortName,
        fullName,
        attached: parseInt(attached, 10) > 0,
        created: createdTs ? new Date(createdTs).toLocaleString() : '',
        createdTimestamp: createdTs,
        lastActiveAt: createdTs,
        workspaceName: wsInfo.name,
        workspacePath: wsInfo.resolvedPath || sessionPath || '',
        agentType: agentType || 'terminal',
        agentModel: agentModel || '',
        sessionMode: rawSessionMode || (agentType === 'default' ? 'terminal_only' : 'hybrid'),
        lastActivity: null,
        isRemote: false,
        deviceId: 'cloud'
      };

      // Parse recent agent chat log if available
      let effectiveSessionId = agentSessionId;
      if ((agentType === 'agy' || agentType === 'antigravity') && panePid && typeof getSessionIdFromPanePid === 'function') {
        const liveAgyId = getSessionIdFromPanePid(panePid);
        if (liveAgyId) {
          if (effectiveSessionId && liveAgyId !== effectiveSessionId && fullName) {
            execTmux(['set-option', '-t', fullName, '@agent_session_id', liveAgyId], () => {}, effectiveUser);
          }
          effectiveSessionId = liveAgyId;
        }
      }

      const targetLookupPath = wsInfo.resolvedPath || sessionPath || PROJECT_ROOT;
      const sessionFileInfo = findAgentSessionFile(agentType, targetLookupPath, effectiveSessionId, panePid, userHome, sysHome);
      if (sessionFileInfo && sessionFileInfo.sessionId && !agentSessionId && fullName) {
        execTmux(['set-option', '-t', fullName, '@agent_session_id', sessionFileInfo.sessionId], () => {}, effectiveUser);
      }
      if (sessionFileInfo && sessionFileInfo.filePath) {
        try {
          const parsed = await parseAgentChat(sessionFileInfo.agentType, sessionFileInfo.filePath, 10);
          if (parsed && parsed.messages && parsed.messages.length > 0) {
            const lastMsg = parsed.messages[parsed.messages.length - 1];
            const lastUserMsg = [...parsed.messages].reverse().find(m => m.role === 'user');
            const msgTs = lastMsg.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
            if (msgTs && !isNaN(msgTs)) {
              sessionObj.lastActiveAt = Math.max(sessionObj.lastActiveAt, msgTs);
            }
            sessionObj.lastActivity = {
              role: lastMsg.role,
              text: String(lastMsg.content || lastMsg.text || '').replace(/\s+/g, ' ').trim().substring(0, 180),
              userPrompt: lastUserMsg ? String(lastUserMsg.content || lastUserMsg.text || '').replace(/\s+/g, ' ').trim().substring(0, 140) : '',
              timestamp: lastMsg.timestamp || null
            };
          }
        } catch (err) {}
      }

      // Capture live tmux pane output for real-time status
      const paneOutput = await new Promise((resPane) => {
        execTmux(['capture-pane', '-p', '-t', fullName, '-S', '-15'], (err, out) => {
          resPane(out || '');
        }, effectiveUser);
      });

      const live = detectSessionLiveStatus(paneOutput);
      sessionObj.status = live.status;
      sessionObj.statusLabel = live.statusLabel;

      if (!sessionObj.lastActivity && live.nonBlankLines.length > 0) {
        const paneSnippet = live.nonBlankLines.slice(-3).join(' ');
        sessionObj.lastActivity = {
          role: 'terminal',
          text: paneSnippet.substring(0, 180),
          userPrompt: '',
          timestamp: null
        };
      }

      const customMeta = store.cardMeta[shortName] || {};
      const promptTitle = sessionObj.lastActivity ? summarizePromptAsTitle(sessionObj.lastActivity.userPrompt) : '';
      sessionObj.customTitle = customMeta.customTitle || '';
      sessionObj.taskTitle = customMeta.customTitle || promptTitle || shortName;

      return sessionObj;
    }));
  }

  // Sort: waiting first (urgent), then busy, then idle; within same status by lastActiveAt desc
  sessions.sort((a, b) => {
    const statusWeight = { waiting: 3, busy: 2, idle: 1 };
    const diff = (statusWeight[b.status] || 0) - (statusWeight[a.status] || 0);
    if (diff !== 0) return diff;
    return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
  });

  // Build workspace summary pills with lightweight git info (parallel)
  const wsMap = new Map();
  for (const w of resolvedWorkspaces) {
    wsMap.set(w.name, {
      name: w.name,
      path: w.resolvedPath || w.path,
      sessionCount: 0,
      waitingCount: 0,
      busyCount: 0,
      idleCount: 0,
      todoCount: 0,
      git: { isRepo: false, branch: '', changedFilesCount: 0 }
    });
  }
  for (const s of sessions) {
    if (!wsMap.has(s.workspaceName)) {
      wsMap.set(s.workspaceName, {
        name: s.workspaceName,
        path: s.workspacePath,
        sessionCount: 0,
        waitingCount: 0,
        busyCount: 0,
        idleCount: 0,
        todoCount: 0,
        git: { isRepo: false, branch: '', changedFilesCount: 0 }
      });
    }
    const entry = wsMap.get(s.workspaceName);
    entry.sessionCount += 1;
    if (s.status === 'waiting') entry.waitingCount += 1;
    else if (s.status === 'busy') entry.busyCount += 1;
    else entry.idleCount += 1;
  }
  for (const t of store.todos) {
    if (t.workspaceName && wsMap.has(t.workspaceName)) {
      wsMap.get(t.workspaceName).todoCount += 1;
    }
  }

  const workspaceSummaries = Array.from(wsMap.values());
  if (!deviceId || deviceId === 'cloud') {
    await Promise.all(workspaceSummaries.map(async (ws) => {
      if (!ws.path || !fs.existsSync(ws.path)) return;
      const check = await runGit(['rev-parse', '--is-inside-work-tree'], ws.path);
      if (!check.ok || check.stdout !== 'true') return;
      ws.git.isRepo = true;
      const [branchRes, statusRes] = await Promise.all([
        runGit(['rev-parse', '--abbrev-ref', 'HEAD'], ws.path),
        runGit(['status', '--porcelain'], ws.path)
      ]);
      ws.git.branch = branchRes.ok ? branchRes.stdout : 'HEAD';
      if (statusRes.ok && statusRes.stdout) {
        ws.git.changedFilesCount = statusRes.stdout.split('\n').map(l => l.trim()).filter(Boolean).length;
      }
    }));
  }

  // Apply optional workspace filter
  const filteredSessions = filterWorkspace
    ? sessions.filter(s => s.workspaceName.toLowerCase() === filterWorkspace.toLowerCase())
    : sessions;
  const filteredTodos = filterWorkspace
    ? store.todos.filter(t => !t.workspaceName || t.workspaceName.toLowerCase() === filterWorkspace.toLowerCase())
    : store.todos;

  const waitingCount = filteredSessions.filter(s => s.status === 'waiting').length;
  const busyCount = filteredSessions.filter(s => s.status === 'busy').length;
  const idleCount = filteredSessions.filter(s => s.status === 'idle').length;

  let workspaceStatus = 'empty';
  if (filteredSessions.length > 0) {
    if (waitingCount > 0) workspaceStatus = 'waiting';
    else if (busyCount > 0) workspaceStatus = 'busy';
    else workspaceStatus = 'idle';
  }

  return {
    deviceId,
    filterWorkspace,
    sessions: filteredSessions,
    todos: filteredTodos,
    workspaces: workspaceSummaries,
    summary: {
      totalSessions: filteredSessions.length,
      waitingCount,
      busyCount,
      idleCount,
      todoCount: filteredTodos.length,
      workspaceStatus
    },
    timestamp: Date.now()
  };
}

module.exports = {
  getProjectProgress,
  readProjectMetadata,
  writeProjectMetadata,
  writeProjectTasks,
  dispatchTask,
  getGlobalTaskBoard,
  readTaskBoardStore,
  upsertTodoItem,
  deleteTodoItem,
  updateCardMeta
};
