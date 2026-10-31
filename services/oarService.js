const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PROJECT_ROOT } = require('../config');
const { getRunUser } = require('./tmuxService');
const { getUserHomeDir, getHomeDir } = require('./fileService');

// In-memory active OAR sessions map: sessionKey -> sessionState
const activeOarSessions = new Map();

/**
 * Lazy import helper for ES module @botiverse/oar inside CommonJS
 */
let oarModulePromise = null;
function getOarModule() {
  if (!oarModulePromise) {
    oarModulePromise = import('@botiverse/oar').catch(err => {
      console.warn('[OAR] Failed to import @botiverse/oar:', err.message);
      return null;
    });
  }
  return oarModulePromise;
}

/**
 * Locate CLI executable path across common locations
 */
function getAgentPath(agentName, sysHome) {
  const nodeBinDir = path.dirname(process.execPath);
  const localNodePath = path.join(nodeBinDir, agentName);
  if (fs.existsSync(localNodePath)) return localNodePath;

  const candidates = [
    `${sysHome || '/home/ubuntu'}/.local/bin/${agentName}`,
    `/usr/local/bin/${agentName}`,
    `/usr/bin/${agentName}`
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return agentName;
}

/**
 * Resolve OAR sessions storage directory for a specific user
 */
function getOarStorageDir(username) {
  const user = username || 'default';
  const dir = path.join(PROJECT_ROOT, 'user_data', user, 'oar_sessions');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }
  return dir;
}

/**
 * Get session storage file path
 */
function getSessionStorageFile(username, sessionName) {
  const dir = getOarStorageDir(username);
  const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safeName}.json`);
}

/**
 * Load persisted session data (with backward-compatible DSML cleanup)
 */
function loadPersistedSession(username, sessionName) {
  const file = getSessionStorageFile(username, sessionName);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.messages)) {
        for (const m of data.messages) {
          if (m.role === 'assistant' && typeof m.content === 'string' && (m.content.includes('DSML') || m.content.includes('<tool_call>'))) {
            const { cleanText, tools } = parseToolCallsFromOutput(m.content);
            if (tools.length > 0) {
              m.content = cleanText || '（已完成工具调用）';
              if (!m.tools || m.tools.length === 0) {
                m.tools = tools;
              }
            }
          }
        }
      }
      return data;
    } catch (e) {
      console.error('[OAR] Failed to load session JSON:', e.message);
    }
  }
  return null;
}

/**
 * Save session data to disk
 */
function savePersistedSession(username, sessionName, data) {
  try {
    const file = getSessionStorageFile(username, sessionName);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[OAR] Failed to save session JSON:', e.message);
  }
}

/**
 * Parse structured tool calls from raw model text (DeepSeek DSML, XML, or standard tool_calls)
 */
function parseToolCallsFromOutput(content, rawToolCalls = null) {
  const tools = [];
  let cleanText = typeof content === 'string' ? content : '';

  // 1. Check standard OpenAI tool_calls
  if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
    for (const tc of rawToolCalls) {
      let args = tc.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) {}
      }
      tools.push({
        id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
        name: tc.function?.name || 'bash',
        input: args
      });
    }
  }

  // 2. Check DeepSeek DSML format: <｜｜DSML｜｜ calls> ... </｜｜DSML｜｜ calls>
  const dsmlRegex = /<[|｜]{1,2}DSML[|｜]{1,2}\s*calls>([\s\S]*?)<\/[|｜]{1,2}DSML[|｜]{1,2}\s*calls>/gi;
  const invokeRegex = /<[|｜]{1,2}DSML[|｜]{1,2}\s*invoke\s+name="([^"]+)">([\s\S]*?)<\/[|｜]{1,2}DSML[|｜]{1,2}\s*invoke>/gi;
  const paramRegex = /<[|｜]{1,2}DSML[|｜]{1,2}\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[|｜]{1,2}DSML[|｜]{1,2}\s*parameter>/gi;

  let match;
  while ((match = dsmlRegex.exec(cleanText)) !== null) {
    const callsBody = match[1];
    let invMatch;
    while ((invMatch = invokeRegex.exec(callsBody)) !== null) {
      const toolName = invMatch[1];
      const invBody = invMatch[2];
      const params = {};
      let pMatch;
      while ((pMatch = paramRegex.exec(invBody)) !== null) {
        params[pMatch[1]] = pMatch[2].trim();
      }
      tools.push({
        id: `call_${Math.random().toString(36).slice(2, 9)}`,
        name: toolName,
        input: params
      });
    }
  }

  // Clean DSML tags from prose content
  cleanText = cleanText.replace(dsmlRegex, '').trim();

  // 3. Check XML style <tool_call>...</tool_call>
  const xmlToolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let xmlMatch;
  while ((xmlMatch = xmlToolRegex.exec(cleanText)) !== null) {
    try {
      const parsed = JSON.parse(xmlMatch[1].trim());
      tools.push({
        id: `call_${Math.random().toString(36).slice(2, 9)}`,
        name: parsed.name || 'bash',
        input: parsed.arguments || parsed.parameters || parsed.input || {}
      });
    } catch (e) {}
  }
  cleanText = cleanText.replace(xmlToolRegex, '').trim();

  // 4. Check <bash>...</bash> or <sh>...</sh>
  const bashTagRegex = /<(?:bash|sh|execute_bash)>([\s\S]*?)<\/(?:bash|sh|execute_bash)>/gi;
  let bMatch;
  while ((bMatch = bashTagRegex.exec(cleanText)) !== null) {
    const cmd = bMatch[1].trim();
    if (cmd) {
      tools.push({
        id: `call_${Math.random().toString(36).slice(2, 9)}`,
        name: 'bash',
        input: { command: cmd }
      });
    }
  }
  cleanText = cleanText.replace(bashTagRegex, '').trim();

  return { cleanText, tools };
}

/**
 * Execute a tool safely in the target workspace directory
 */
function executeTool(tool, workspacePath) {
  return new Promise((resolve) => {
    const toolName = (tool.name || '').toLowerCase();
    const input = tool.input || {};
    const command = input.command || input.cmd || (typeof input === 'string' ? input : null);

    if (toolName === 'bash' || toolName === 'sh' || toolName === 'terminal' || toolName === 'exec') {
      if (!command) {
        return resolve({ success: false, output: 'Error: No command specified for bash tool' });
      }

      const user = getRunUser();
      let finalCmd = 'bash';
      let finalArgs = ['-c', command];

      if (user && process.getuid && process.getuid() === 0) {
        finalCmd = 'sudo';
        finalArgs = ['-u', user, 'bash', '-c', command];
      }

      const cwd = (workspacePath && fs.existsSync(workspacePath)) ? workspacePath : process.cwd();

      try {
        const proc = spawn(finalCmd, finalArgs, {
          cwd,
          timeout: 30000,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            PATH: `${path.resolve(PROJECT_ROOT, 'bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`
          }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('error', (err) => {
          resolve({ success: false, output: `Execution error: ${err.message}` });
        });

        proc.on('close', (code) => {
          const combined = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).trim();
          const truncated = combined.length > 4000 ? combined.slice(0, 4000) + '\n...(truncated)' : (combined || '(Command finished with no output)');
          resolve({
            success: code === 0,
            output: truncated
          });
        });
      } catch (err) {
        resolve({ success: false, output: `Spawn error: ${err.message}` });
      }
    } else {
      resolve({ success: false, output: `Unsupported tool: ${toolName}` });
    }
  });
}

/**
 * Execute native Antigravity CLI directly using official Antigravity/Google account quota
 */
function runAgyCli(prompt, conversationId, workspacePath, username, abortSignal) {
  return new Promise((resolve, reject) => {
    const userHome = getUserHomeDir(username);
    const sysHome = getHomeDir();

    const agyBin = getAgentPath('agy', sysHome);
    const args = [
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--print', prompt
    ];
    if (conversationId) {
      args.push('--conversation', conversationId);
    }

    const runUser = getRunUser();
    let finalCmd = agyBin;
    let finalArgs = args;

    if (runUser && process.getuid && process.getuid() === 0) {
      finalCmd = 'sudo';
      finalArgs = ['-u', runUser, agyBin, ...args];
    }

    const binDir = path.resolve(PROJECT_ROOT, 'bin');
    const nodeBinDir = path.dirname(process.execPath);
    const sysLocalBin = path.join(sysHome, '.local', 'bin');

    const env = {
      ...process.env,
      HOME: userHome,
      PATH: `${binDir}:${nodeBinDir}:${sysLocalBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`
    };

    const cwd = (workspacePath && fs.existsSync(workspacePath)) ? workspacePath : process.cwd();

    const proc = spawn(finalCmd, finalArgs, {
      cwd,
      env,
      signal: abortSignal
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => {
      if (err.name === 'AbortError') {
        return resolve({ aborted: true, response: '(已中止当前生成)' });
      }
      reject(err);
    });

    proc.on('close', code => {
      try {
        const json = JSON.parse(stdout.trim());
        resolve(json);
      } catch (e) {
        if (stdout.trim()) {
          resolve({ response: stdout.trim(), raw: stdout, stderr, code });
        } else {
          resolve({ response: `[Antigravity 进程退出码 ${code}]: ${stderr || '未收到输出'}`, code, stderr });
        }
      }
    });
  });
}

/**
 * Execute native Claude Code CLI directly using official Claude Code account/token quota
 */
function runClaudeCli(prompt, sessionId, workspacePath, username, abortSignal) {
  return new Promise((resolve, reject) => {
    const userHome = getUserHomeDir(username);
    const sysHome = getHomeDir();

    const claudeBin = getAgentPath('claude', sysHome);
    const targetSessionId = sessionId || require('crypto').randomUUID();

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--resume', targetSessionId
    ];

    const runUser = getRunUser();
    let finalCmd = claudeBin;
    let finalArgs = args;

    if (runUser && process.getuid && process.getuid() === 0) {
      finalCmd = 'sudo';
      finalArgs = ['-u', runUser, claudeBin, ...args];
    }

    const binDir = path.resolve(PROJECT_ROOT, 'bin');
    const nodeBinDir = path.dirname(process.execPath);
    const sysLocalBin = path.join(sysHome, '.local', 'bin');

    const env = {
      ...process.env,
      HOME: userHome,
      PATH: `${binDir}:${nodeBinDir}:${sysLocalBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`
    };

    const cwd = (workspacePath && fs.existsSync(workspacePath)) ? workspacePath : process.cwd();

    const proc = spawn(finalCmd, finalArgs, {
      cwd,
      env,
      signal: abortSignal
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => {
      if (err.name === 'AbortError') {
        return resolve({ aborted: true, response: '(已中止当前生成)', session_id: targetSessionId });
      }
      reject(err);
    });

    proc.on('close', code => {
      try {
        const json = JSON.parse(stdout.trim());
        resolve({
          ...json,
          session_id: json.session_id || targetSessionId,
          response: json.result || json.response || stdout.trim()
        });
      } catch (e) {
        if (stdout.trim()) {
          resolve({ response: stdout.trim(), session_id: targetSessionId, raw: stdout, stderr, code });
        } else {
          resolve({ response: `[Claude 进程退出码 ${code}]: ${stderr || '未收到输出'}`, session_id: targetSessionId, code, stderr });
        }
      }
    });
  });
}

/**
 * =========================================================================
 * OAR Standard Runtime Extensions (Extending OAR via defineRuntime & Registry)
 * =========================================================================
 * Formally extends @botiverse/oar standard contracts with native adapters,
 * preserving official account quotas and unifying Session controlling & observing.
 */
let deckRegistryPromise = null;
async function getDeckRuntimeRegistry() {
  if (deckRegistryPromise) return deckRegistryPromise;

  const oar = await getOarModule();
  if (!oar || !oar.defineRuntime || !oar.createRuntimeRegistry) {
    return null;
  }

  // 1. Antigravity Native OAR Adapter (Official Account & Quota)
  const antigravityNativeRuntime = oar.defineRuntime({
    id: 'antigravity',
    brand: { name: 'Antigravity (Official)', icon: null },
    installation: async () => {
      const sysHome = getHomeDir();
      const p = getAgentPath('agy', sysHome);
      return fs.existsSync(p)
        ? { kind: 'available', via: 'executable', command: p }
        : { kind: 'not_found' };
    },
    session: async (installation, sessionOpts = {}) => {
      let isRunning = false;
      let activeController = null;
      let currentConversationId = sessionOpts.conversationId || null;
      let lastUsage = null;
      const observers = new Set();

      const notifyObservers = (event) => {
        for (const obs of observers) {
          try { obs(event); } catch (e) {}
        }
      };

      return {
        placement: 'process',
        prompt: async (input, promptOpts = {}) => {
          isRunning = true;
          activeController = new AbortController();
          notifyObservers({ type: 'turn_started', input });

          try {
            const res = await runAgyCli(
              input,
              currentConversationId,
              sessionOpts.workspacePath || process.cwd(),
              sessionOpts.username || 'admin',
              activeController.signal
            );

            if (res && res.conversation_id) {
              currentConversationId = res.conversation_id;
            }
            if (res && res.usage) {
              lastUsage = res.usage;
            }

            const reply = (res && (res.response || res.result)) || (typeof res === 'string' ? res : '');
            notifyObservers({ type: 'text_delta', text: reply });
            notifyObservers({ type: 'turn_completed', reply, usage: lastUsage });

            return {
              kind: 'accepted',
              conversationId: currentConversationId,
              reply,
              usage: lastUsage,
              raw: res
            };
          } catch (err) {
            notifyObservers({ type: 'turn_error', error: err.message });
            return {
              kind: 'rejected',
              reason: err.message
            };
          } finally {
            isRunning = false;
            activeController = null;
          }
        },
        abort: async () => {
          if (activeController) {
            activeController.abort();
            isRunning = false;
            notifyObservers({ type: 'aborted' });
            return { kind: 'accepted' };
          }
          return { kind: 'rejected', reason: 'no_active_turn' };
        },
        status: () => (isRunning ? 'running' : 'idle'),
        usage: () => ({ kind: 'value', value: lastUsage }),
        model: () => ({ kind: 'value', value: 'gemini-3.8-flash' }),
        events: (observer) => {
          observers.add(observer);
          return () => observers.delete(observer);
        },
        dispose: async () => {
          observers.clear();
        }
      };
    }
  });

  // 2. Claude Code Native OAR Adapter (Official Account & Quota)
  const claudeNativeRuntime = oar.defineRuntime({
    id: 'claude',
    brand: { name: 'Claude Code (Official)', icon: null },
    installation: async () => {
      const sysHome = getHomeDir();
      const p = getAgentPath('claude', sysHome);
      return fs.existsSync(p)
        ? { kind: 'available', via: 'executable', command: p }
        : { kind: 'not_found' };
    },
    session: async (installation, sessionOpts = {}) => {
      let isRunning = false;
      let activeController = null;
      let currentSessionId = sessionOpts.claudeSessionId || null;
      let lastUsage = null;
      const observers = new Set();

      const notifyObservers = (event) => {
        for (const obs of observers) {
          try { obs(event); } catch (e) {}
        }
      };

      return {
        placement: 'process',
        prompt: async (input, promptOpts = {}) => {
          isRunning = true;
          activeController = new AbortController();
          notifyObservers({ type: 'turn_started', input });

          try {
            const res = await runClaudeCli(
              input,
              currentSessionId,
              sessionOpts.workspacePath || process.cwd(),
              sessionOpts.username || 'admin',
              activeController.signal
            );

            if (res && res.session_id) {
              currentSessionId = res.session_id;
            }
            if (res && res.usage) {
              lastUsage = res.usage;
            }

            const reply = (res && (res.response || res.result)) || (typeof res === 'string' ? res : '');
            notifyObservers({ type: 'text_delta', text: reply });
            notifyObservers({ type: 'turn_completed', reply, usage: lastUsage });

            return {
              kind: 'accepted',
              sessionId: currentSessionId,
              reply,
              usage: lastUsage,
              raw: res
            };
          } catch (err) {
            notifyObservers({ type: 'turn_error', error: err.message });
            return {
              kind: 'rejected',
              reason: err.message
            };
          } finally {
            isRunning = false;
            activeController = null;
          }
        },
        abort: async () => {
          if (activeController) {
            activeController.abort();
            isRunning = false;
            notifyObservers({ type: 'aborted' });
            return { kind: 'accepted' };
          }
          return { kind: 'rejected', reason: 'no_active_turn' };
        },
        status: () => (isRunning ? 'running' : 'idle'),
        usage: () => ({ kind: 'value', value: lastUsage }),
        model: () => ({ kind: 'value', value: 'claude-3-7-sonnet' }),
        events: (observer) => {
          observers.add(observer);
          return () => observers.delete(observer);
        },
        dispose: async () => {
          observers.clear();
        }
      };
    }
  });

  deckRegistryPromise = oar.createRuntimeRegistry([
    antigravityNativeRuntime,
    claudeNativeRuntime
  ]);

  return deckRegistryPromise;
}

/**
 * Initialize or get an OAR session
 */
async function getOrCreateSession(username, sessionName, options = {}) {
  const sessionKey = `${username || 'default'}:${sessionName}`;
  if (activeOarSessions.has(sessionKey)) {
    const existing = activeOarSessions.get(sessionKey);
    if (options.workspacePath) existing.workspacePath = options.workspacePath;
    if (options.agentType) existing.agentType = options.agentType;
    if (options.model) existing.model = options.model;
    return existing;
  }

  // Try to load persisted data
  const persisted = loadPersistedSession(username, sessionName);
  const sessionData = persisted || {
    sessionName,
    username: username || 'default',
    agentType: options.agentType || 'agy',
    workspacePath: options.workspacePath || process.cwd(),
    model: options.model || '',
    conversationId: null,
    claudeSessionId: null,
    createdAt: Date.now(),
    messages: [
      {
        id: 'msg-welcome',
        role: 'assistant',
        content: `👋 您好！已进入 **OAR 纯会话模式**。\n当前智能体：\`${options.agentType || 'agy'}\`\n工作区：\`${options.workspacePath || process.cwd()}\`\n本模式由 Open Agent Runtime 规范标准扩展直接驱动，使用官方原生套餐与模型，无终端黑盒按键盲发与错位。`,
        timestamp: Date.now()
      }
    ]
  };

  const oarSession = {
    ...sessionData,
    conversationId: (persisted && persisted.conversationId) || null,
    claudeSessionId: (persisted && persisted.claudeSessionId) || null,
    isGenerating: false,
    currentController: null,
    subscribers: new Set()
  };

  activeOarSessions.set(sessionKey, oarSession);
  return oarSession;
}

/**
 * Send user message to OAR session and stream/await response
 */
async function sendUserMessage(username, sessionName, userText, onChunk = null) {
  const sess = await getOrCreateSession(username, sessionName);
  if (!userText || !userText.trim()) {
    throw new Error('Message content cannot be empty');
  }

  const userMsgId = `msg-user-${Date.now()}`;
  const assistantMsgId = `msg-asst-${Date.now()}`;

  // Add user message
  const userMsg = {
    id: userMsgId,
    role: 'user',
    content: userText.trim(),
    timestamp: Date.now()
  };
  sess.messages.push(userMsg);

  // Initialize placeholder assistant message
  const assistantMsg = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    thinking: '',
    tool_calls: [],
    timestamp: Date.now()
  };
  sess.messages.push(assistantMsg);
  sess.isGenerating = true;

  const updatePersistence = () => {
    savePersistedSession(username, sessionName, {
      sessionName: sess.sessionName,
      username: sess.username,
      agentType: sess.agentType,
      workspacePath: sess.workspacePath,
      model: sess.model,
      conversationId: sess.conversationId,
      claudeSessionId: sess.claudeSessionId,
      createdAt: sess.createdAt,
      messages: sess.messages
    });
  };

  updatePersistence();

  // AbortController for cancellation
  const abortCtrl = new AbortController();
  sess.currentController = abortCtrl;

  try {
    let handled = false;
    const isAgy = (sess.agentType === 'agy' || sess.agentType === 'antigravity');
    const isClaude = (sess.agentType === 'claude');
    const hasCustomGatewayModel = sess.model && sess.model !== 'default';

    // 1. Execute via OAR Standard Runtime Registry (Native Official Adapter)
    const deckRegistry = await getDeckRuntimeRegistry();
    if (deckRegistry && !hasCustomGatewayModel && (isAgy || isClaude)) {
      const runtimeId = isAgy ? 'antigravity' : 'claude';
      const runtime = deckRegistry.get(runtimeId);

      if (runtime) {
        console.log(`[OAR] Dispatching through OAR standard runtime: "${runtimeId}" for session "${sessionName}"...`);
        const sessionAdapter = await runtime.session(null, {
          workspacePath: sess.workspacePath,
          username: sess.username,
          conversationId: sess.conversationId,
          claudeSessionId: sess.claudeSessionId
        });

        // Bind OAR observer
        sessionAdapter.events((evt) => {
          if (onChunk) onChunk(evt);
        });

        const outcome = await sessionAdapter.prompt(userText.trim());
        if (outcome && outcome.kind === 'accepted') {
          if (outcome.conversationId) sess.conversationId = outcome.conversationId;
          if (outcome.sessionId) sess.claudeSessionId = outcome.sessionId;
          if (outcome.usage) assistantMsg.usage = outcome.usage;
          assistantMsg.content = outcome.reply || '（已完成交互）';
          handled = true;
        } else if (outcome && outcome.kind === 'rejected') {
          assistantMsg.content = `[OAR 运行时反馈]: ${outcome.reason || '任务已中止或未接收'}`;
          handled = true;
        }
      }
    }

    // 2. Fallback: LLM Gateway / Custom Provider with ReAct multi-turn loop
    if (!handled) {
      const llmGatewayService = require('./llmGatewayService');
      const gwConfig = llmGatewayService.loadConfig();

      if (gwConfig && gwConfig.enabled && gwConfig.providers) {
        const { PORT } = require('../config');
        const localPort = PORT || 3000;
        const gwBaseUrl = (localPort === 80 || localPort === '80') ? 'http://127.0.0.1/v1' : `http://127.0.0.1:${localPort}/v1`;

        const systemPrompt = `You are a high-performance coding agent running inside the OAR (Open Agent Runtime) environment of tmux-agent-deck.
Current workspace directory: ${sess.workspacePath}
Agent mode: Pure Chat (OAR Driven).

Critical Operating Guidelines:
1. The workspace and tool environment are ALREADY verified, healthy, and operational. DO NOT blindly output exploratory phrases like "先确认一下工具是否恢复" or run exploratory pwd/ls on simple greetings, discussions, or non-coding queries.
2. Only invoke tools when specifically required to inspect codebase files, edit code, run builds/tests, or fulfill the user's specific request.
3. Supported tools:
   - bash: execute shell commands in the workspace directory. Command parameters can be provided via standard tool_calls or DSML/XML invocations.
4. When executing commands, the system will run them in the workspace and supply the exact output. Once output is received, synthesize and provide a concise, direct, helpful final answer to the user.
5. Always respond in the language used by the user (typically Chinese).`;

        const messagesPayload = [
          { role: 'system', content: systemPrompt },
          ...sess.messages.slice(-8, -1).map(m => ({
            role: m.role,
            content: m.content
          })),
          { role: 'user', content: userText.trim() }
        ];

        const defaultModel = gwConfig.defaults?.openaiModel || gwConfig.defaults?.anthropicModel || 'deepseek/deepseek-flash';
        const targetModel = sess.model || defaultModel;

        let currentIteration = 0;
        const maxIterations = 4;
        const accumulatedTools = [];
        let finalCleanResponse = '';

        while (currentIteration < maxIterations) {
          currentIteration++;

          const fetchRes = await fetch(`${gwBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${gwConfig.virtualKey || 'sk-deck-local'}`
            },
            body: JSON.stringify({
              model: targetModel,
              messages: messagesPayload,
              stream: false
            }),
            signal: abortCtrl.signal
          });

          if (!fetchRes.ok) {
            const errText = await fetchRes.text();
            console.warn('[OAR] Gateway returned error:', fetchRes.status, errText);
            break;
          }

          const completion = await fetchRes.json();
          const choice = completion.choices?.[0];
          const rawContent = choice?.message?.content || '';
          const rawToolCalls = choice?.message?.tool_calls || [];

          // Parse tool calls (DSML or OpenAI standard format)
          const { cleanText, tools } = parseToolCallsFromOutput(rawContent, rawToolCalls);

          if (tools.length === 0) {
            finalCleanResponse = cleanText || rawContent || '（智能体未返回文本）';
            handled = true;
            break;
          }

          for (const t of tools) {
            accumulatedTools.push(t);
          }
          assistantMsg.tools = [...accumulatedTools];

          let toolOutputsCombined = '';
          for (const t of tools) {
            const execRes = await executeTool(t, sess.workspacePath);
            t.output = execRes.output;
            const cmdName = t.input?.command || t.input?.description || t.name;
            toolOutputsCombined += `[Tool ${t.name} (${cmdName}) Output]:\n${execRes.output}\n\n`;
          }

          messagesPayload.push({
            role: 'assistant',
            content: rawContent
          });

          messagesPayload.push({
            role: 'user',
            content: `[System Environment - Workspace: "${sess.workspacePath}"]\nTool execution completed with results:\n${toolOutputsCombined.trim()}\n\nPlease synthesize the results and continue to solve the user's request.`
          });

          if (cleanText) {
            finalCleanResponse = cleanText;
            assistantMsg.content = cleanText;
          }
        }

        if (handled || finalCleanResponse) {
          assistantMsg.content = finalCleanResponse || '（已完成工具执行与响应）';
          assistantMsg.tools = accumulatedTools;
          handled = true;
        }
      }
    }

    if (!handled) {
      assistantMsg.content = `[OAR 引擎响应]\n已收到指令: "${userText}"\n\n当前工作空间: \`${sess.workspacePath}\`\n智能体类型: \`${sess.agentType}\`\n\n💡 提示: OAR 纯会话引擎已成功就绪并托管该会话。`;
    }

    if (onChunk) {
      onChunk({
        type: 'done',
        message: assistantMsg
      });
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      assistantMsg.content += '\n\n*(操作已由用户手动中止)*';
    } else {
      assistantMsg.content = `❌ [OAR 运行时异常]: ${err.message}`;
    }
  } finally {
    sess.isGenerating = false;
    sess.currentController = null;
    updatePersistence();
  }

  return assistantMsg;
}

/**
 * Abort active generation for an OAR session
 */
function abortSession(username, sessionName) {
  const sessionKey = `${username || 'default'}:${sessionName}`;
  const sess = activeOarSessions.get(sessionKey);
  if (sess && sess.currentController) {
    sess.currentController.abort();
    sess.isGenerating = false;
    return true;
  }
  return false;
}

/**
 * Clear OAR session context (messages and state)
 */
async function clearSession(username, sessionName) {
  const sess = await getOrCreateSession(username, sessionName);
  if (sess.currentController) {
    try { sess.currentController.abort(); } catch (e) {}
    sess.currentController = null;
  }
  sess.messages = [];
  sess.isGenerating = false;
  sess.conversationId = crypto.randomUUID();
  sess.claudeSessionId = crypto.randomUUID();
  savePersistedSession(username, sessionName, {
    sessionName: sess.sessionName,
    username: sess.username,
    agentType: sess.agentType,
    workspacePath: sess.workspacePath,
    model: sess.model,
    conversationId: sess.conversationId,
    claudeSessionId: sess.claudeSessionId,
    createdAt: sess.createdAt,
    messages: []
  });
  return sess;
}

/**
 * Delete OAR session
 */
function deleteOarSession(username, sessionName) {
  const sessionKey = `${username || 'default'}:${sessionName}`;
  activeOarSessions.delete(sessionKey);
  const file = getSessionStorageFile(username, sessionName);
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch (e) {}
  }
}

module.exports = {
  getOarModule,
  getDeckRuntimeRegistry,
  getOrCreateSession,
  sendUserMessage,
  abortSession,
  clearSession,
  deleteOarSession,
  loadPersistedSession
};
