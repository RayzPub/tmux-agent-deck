const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PROJECT_ROOT } = require('../config');
const { getRunUser } = require('./tmuxService');
const { getUserHomeDir, getHomeDir } = require('./fileService');

// In-memory active OAR sessions map: sessionKey -> sessionState
const activeOarSessions = new Map();

// Runtime id mapping from tmux-agent-deck agentType to @botiverse/oar runtime id
const AGENT_TO_OAR_RUNTIME = {
  agy: 'antigravity',
  antigravity: 'antigravity',
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  codex: 'codex',
  'codex-cli': 'codex',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  'kimi-cli': 'kimi',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  qwen: 'qwen',
  qoder: 'qoder',
  codebuddy: 'codebuddy',
  dsh: 'dsh',
  devin: 'devin',
  factory: 'factory'
};

// Export name mapping for per-runtime subpath imports (@botiverse/oar/runtimes/<id>)
const RUNTIME_EXPORT_NAME = {
  antigravity: 'antigravityRuntime',
  claude: 'claudeRuntime',
  codex: 'codexRuntime',
  kimi: 'kimiRuntime',
  pi: 'piRuntime',
  grok: 'grokRuntime',
  opencode: 'opencodeRuntime',
  qwen: 'qwenRuntime',
  qoder: 'qoderRuntime',
  codebuddy: 'codebuddyRuntime',
  dsh: 'dshRuntime',
  devin: 'devinRuntime',
  factory: 'factoryRuntime'
};

const OAR_RETAINED_BYTES = 8 * 1024 * 1024; // 8MB ring buffer limit per live session
const SUPPORTED_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Lazy import helper for root @botiverse/oar ES module inside CommonJS
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
 * Lazy import helper for lightweight @botiverse/oar/capabilities
 */
let oarCapabilitiesPromise = null;
function getOarCapabilitiesModule() {
  if (!oarCapabilitiesPromise) {
    oarCapabilitiesPromise = import('@botiverse/oar/capabilities').catch(() => null);
  }
  return oarCapabilitiesPromise;
}

/**
 * Lazy per-runtime subpath loader (@botiverse/oar/runtimes/<id>)
 * Keeps memory footprint low (~1-2.5MB per runtime vs ~50MB for root import)
 */
const runtimeModuleCache = new Map();
async function loadBuiltinOarRuntime(runtimeId) {
  if (!runtimeId || !RUNTIME_EXPORT_NAME[runtimeId]) return null;
  if (runtimeModuleCache.has(runtimeId)) {
    return runtimeModuleCache.get(runtimeId);
  }
  const loader = (async () => {
    try {
      const mod = await import(`@botiverse/oar/runtimes/${runtimeId}`);
      const exportName = RUNTIME_EXPORT_NAME[runtimeId];
      return mod[exportName] || null;
    } catch (err) {
      console.warn(`[OAR] Failed to load built-in runtime "${runtimeId}":`, err.message);
      return null;
    }
  })();
  runtimeModuleCache.set(runtimeId, loader);
  return loader;
}

/**
 * Resolve agentType string to OAR built-in runtime id
 */
function resolveOarRuntimeId(agentType) {
  if (!agentType) return 'claude';
  const normalized = String(agentType).trim().toLowerCase();
  return AGENT_TO_OAR_RUNTIME[normalized] || null;
}

/**
 * Build user-scoped environment overlay with full CLI PATH
 */
function buildUserEnv(username) {
  const userHome = getUserHomeDir(username);
  const sysHome = getHomeDir();
  let osHome = '';
  try { osHome = os.userInfo().homedir || ''; } catch (e) {}
  const binDir = path.resolve(PROJECT_ROOT, 'bin');
  const nodeBinDir = path.dirname(process.execPath);

  const pathParts = [
    binDir,
    nodeBinDir,
    path.join(userHome, '.local', 'bin'),
    path.join(userHome, '.kimi-code', 'bin'),
    path.join(sysHome, '.local', 'bin'),
    path.join(sysHome, '.kimi-code', 'bin'),
    osHome ? path.join(osHome, '.local', 'bin') : '',
    osHome ? path.join(osHome, '.kimi-code', 'bin') : '',
    '/home/ubuntu/.local/bin',
    process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
  ];
  const dedupedPath = Array.from(new Set(pathParts.filter(Boolean))).join(':');

  return {
    HOME: userHome,
    PATH: dedupedPath
  };
}

/**
 * Ensure process.env.PATH includes common agent CLI directories so OAR's
 * installation() probes can discover agy / claude / codex / kimi reliably.
 */
function ensureDiscoveryPath(username) {
  const userEnv = buildUserEnv(username);
  if (process.env.PATH !== userEnv.PATH) {
    process.env.PATH = userEnv.PATH;
  }
  return userEnv;
}

/**
 * Locate CLI executable path across common locations (fallback helper)
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
    const { atomicWriteJSON } = require('./sqliteService');
    atomicWriteJSON(file, data);
  } catch (e) {
    console.error('[OAR] Failed to save session JSON:', e.message);
  }
}

/**
 * Persist current in-memory session state
 */
function persistSessionState(sess) {
  if (!sess) return;
  savePersistedSession(sess.username, sess.sessionName, {
    sessionName: sess.sessionName,
    username: sess.username,
    agentType: sess.agentType,
    workspacePath: sess.workspacePath,
    model: sess.model,
    activeModel: sess.activeModel || null,
    oarSessionId: sess.oarSessionId || null,
    conversationId: sess.conversationId || null,
    claudeSessionId: sess.claudeSessionId || null,
    usage: sess.usage || null,
    contextUsage: sess.contextUsage || null,
    createdAt: sess.createdAt,
    lastUpdated: sess.lastUpdated,
    messages: sess.messages
  });
}

/**
 * Parse structured tool calls from raw model text (DeepSeek DSML, XML, or standard tool_calls)
 */
function parseToolCallsFromOutput(content, rawToolCalls = null) {
  const tools = [];
  let cleanText = typeof content === 'string' ? content : '';

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
  cleanText = cleanText.replace(dsmlRegex, '').trim();

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
 * Execute a tool safely in the target workspace directory (used by Gateway ReAct fallback)
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
 * Parse tool input string safely into structured object or summary
 */
function parseToolInput(rawInput) {
  if (rawInput == null) return {};
  if (typeof rawInput === 'object') return rawInput;
  const str = String(rawInput).trim();
  if (!str) return {};
  if (str.startsWith('{') || str.startsWith('[')) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return { raw: str };
    }
  }
  return { command: str };
}

/**
 * Extract plain text summary from OAR ToolOutputPart[]
 */
function summarizeToolOutput(contentParts) {
  if (!Array.isArray(contentParts) || contentParts.length === 0) return '';
  const chunks = [];
  for (const part of contentParts) {
    if (!part) continue;
    if (part.kind === 'text' && typeof part.text === 'string') {
      chunks.push(part.text);
    } else if (part.kind === 'image') {
      chunks.push(`[image: ${part.mediaType || 'image'}]`);
    } else if (typeof part === 'string') {
      chunks.push(part);
    }
  }
  const combined = chunks.join('\n').trim();
  return combined.length > 4000 ? combined.slice(0, 4000) + '\n...(truncated)' : combined;
}

/**
 * Bump session lastUpdated monotonically so frontend polling never skips updates
 */
function touchSession(sess) {
  const now = Date.now();
  sess.lastUpdated = (sess.lastUpdated && now <= sess.lastUpdated) ? sess.lastUpdated + 1 : now;
}

/**
 * Bind OAR 0.128.1 real-time Event stream to our session state
 */
function attachLiveSessionEvents(sess, liveSession) {
  if (typeof sess.unsubscribeEvents === 'function') {
    try { sess.unsubscribeEvents(); } catch (e) {}
    sess.unsubscribeEvents = null;
  }

  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistSessionState(sess);
    }, 600);
  };

  const getOrEnsureActiveAssistantMsg = () => {
    if (sess.activeAssistantMsg) return sess.activeAssistantMsg;
    const last = sess.messages[sess.messages.length - 1];
    if (last && last.role === 'assistant') {
      sess.activeAssistantMsg = last;
      return last;
    }
    const msg = {
      id: `msg-asst-${Date.now()}`,
      role: 'assistant',
      content: '',
      thinking: '',
      tools: [],
      timestamp: Date.now()
    };
    sess.messages.push(msg);
    sess.activeAssistantMsg = msg;
    return msg;
  };

  const unsubscribe = liveSession.events((event) => {
    if (!event || !event.kind) return;
    // Focus root agent events for main conversation stream
    const isRoot = !Array.isArray(event.agentPath) || event.agentPath.length === 0;

    switch (event.kind) {
      case 'turn_started':
      case 'turn_active': {
        if (isRoot) {
          sess.isGenerating = true;
          sess.statusText = 'OAR 智能体思考中...';
          touchSession(sess);
        }
        break;
      }

      case 'reasoning': {
        if (isRoot && event.content && event.content.kind === 'text' && event.content.text) {
          const msg = getOrEnsureActiveAssistantMsg();
          msg.thinking = (msg.thinking || '') + event.content.text;
          sess.statusText = '正在深入思考...';
          touchSession(sess);
          schedulePersist();
        }
        break;
      }

      case 'text_delta': {
        if (isRoot && event.text) {
          const msg = getOrEnsureActiveAssistantMsg();
          msg.content = (msg.content || '') + event.text;
          sess.statusText = '正在生成回复...';
          touchSession(sess);
          schedulePersist();
        }
        break;
      }

      case 'tool_call_started': {
        if (isRoot) {
          const msg = getOrEnsureActiveAssistantMsg();
          if (!Array.isArray(msg.tools)) msg.tools = [];
          const toolName = event.toolName || event.tool || 'tool';
          let toolEntry = msg.tools.find(t => t.id === event.callId);
          if (!toolEntry) {
            toolEntry = {
              id: event.callId,
              name: toolName,
              server: event.server || undefined,
              input: parseToolInput(event.input),
              _rawInputBuffer: typeof event.input === 'string' ? event.input : '',
              status: 'running'
            };
            msg.tools.push(toolEntry);
          } else {
            toolEntry.name = toolName;
            if (event.input) toolEntry.input = parseToolInput(event.input);
            toolEntry.status = 'running';
          }
          sess.statusText = `正在执行工具: ${toolName}...`;
          touchSession(sess);
          schedulePersist();
        }
        break;
      }

      case 'tool_call_input_delta': {
        if (isRoot && event.callId && event.delta) {
          const msg = getOrEnsureActiveAssistantMsg();
          const toolEntry = Array.isArray(msg.tools) ? msg.tools.find(t => t.id === event.callId) : null;
          if (toolEntry) {
            toolEntry._rawInputBuffer = (toolEntry._rawInputBuffer || '') + event.delta;
            toolEntry.input = parseToolInput(toolEntry._rawInputBuffer);
            touchSession(sess);
          }
        }
        break;
      }

      case 'tool_call_input': {
        if (isRoot && event.callId) {
          const msg = getOrEnsureActiveAssistantMsg();
          const toolEntry = Array.isArray(msg.tools) ? msg.tools.find(t => t.id === event.callId) : null;
          if (toolEntry) {
            toolEntry._rawInputBuffer = typeof event.input === 'string' ? event.input : '';
            toolEntry.input = parseToolInput(event.input);
            touchSession(sess);
            schedulePersist();
          }
        }
        break;
      }

      case 'tool_call_ended': {
        if (isRoot && event.callId) {
          const msg = getOrEnsureActiveAssistantMsg();
          const toolEntry = Array.isArray(msg.tools) ? msg.tools.find(t => t.id === event.callId) : null;
          if (toolEntry) {
            delete toolEntry._rawInputBuffer;
            toolEntry.status = event.result || 'ok';
            if (event.exitCode !== undefined && event.exitCode !== null) {
              toolEntry.exitCode = event.exitCode;
            }
            const outSummary = summarizeToolOutput(event.content);
            if (outSummary) toolEntry.output = outSummary;
            if (Array.isArray(event.fileChanges) && event.fileChanges.length > 0) {
              toolEntry.fileChanges = event.fileChanges;
            }
            touchSession(sess);
            schedulePersist();
          }
        }
        break;
      }

      case 'usage': {
        if (event.usage) {
          if (event.usage.total || event.usage.tokens) {
            sess.usage = event.usage.total || event.usage.tokens;
          }
          if (event.usage.context) {
            sess.contextUsage = event.usage.context;
          }
          if (sess.activeAssistantMsg && (event.usage.total || event.usage.tokens)) {
            sess.activeAssistantMsg.usage = event.usage.total || event.usage.tokens;
          }
          touchSession(sess);
        }
        break;
      }

      case 'model': {
        if (isRoot && event.model) {
          sess.activeModel = event.model;
          touchSession(sess);
        }
        break;
      }

      case 'compaction_started': {
        if (isRoot) {
          sess.statusText = '正在压缩上下文...';
          touchSession(sess);
        }
        break;
      }

      case 'compaction_ended': {
        if (isRoot) {
          sess.statusText = event.outcome === 'completed' ? '上下文压缩完成' : '就绪';
          touchSession(sess);
        }
        break;
      }

      case 'retry': {
        if (isRoot) {
          sess.statusText = `正在重试 (第 ${event.attempt} 次)...`;
          touchSession(sess);
        }
        break;
      }

      case 'turn_ended': {
        if (isRoot) {
          const msg = sess.activeAssistantMsg;
          if (msg) {
            // Strip temporary buffers from tools
            if (Array.isArray(msg.tools)) {
              for (const t of msg.tools) {
                delete t._rawInputBuffer;
                if (t.status === 'running') t.status = 'ok';
              }
            }
            if (event.forkAnchor) {
              msg.forkAnchor = event.forkAnchor;
            }
            const outcome = event.outcome;
            if (outcome && outcome.kind === 'aborted') {
              if (!msg.content) {
                msg.content = '*(已中止当前生成)*';
              } else if (!msg.content.includes('已中止')) {
                msg.content += '\n\n*(操作已由用户手动中止)*';
              }
            } else if (outcome && outcome.kind === 'failed') {
              const reason = outcome.message || outcome.failure || '执行失败';
              if (!msg.content) {
                msg.content = `❌ [OAR 运行时异常]: ${reason}`;
              } else {
                msg.content += `\n\n❌ [异常]: ${reason}`;
              }
            } else if (!msg.content && (!msg.tools || msg.tools.length === 0)) {
              msg.content = '（已完成交互）';
            }
          }
          sess.isGenerating = false;
          sess.statusText = '就绪';
          sess.activeAssistantMsg = null;
          touchSession(sess);
          if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          persistSessionState(sess);
        }
        break;
      }

      case 'exited': {
        if (isRoot) {
          console.log(`[OAR] Live session process exited for "${sess.sessionName}" (code=${event.code ?? 'n/a'})`);
          if (sess.liveSession === liveSession) {
            sess.liveSession = null;
            sess.liveRuntimeId = null;
            sess.unsubscribeEvents = null;
          }
          if (sess.isGenerating) {
            sess.isGenerating = false;
            sess.statusText = '就绪';
            if (sess.activeAssistantMsg && !sess.activeAssistantMsg.content) {
              sess.activeAssistantMsg.content = '*(底层运行时进程已退出，下次发送消息将自动恢复会话)*';
            }
            sess.activeAssistantMsg = null;
            touchSession(sess);
            persistSessionState(sess);
          }
        }
        break;
      }

      default:
        break;
    }
  }, { coalesceText: { maxHoldMs: 120 } });

  sess.unsubscribeEvents = unsubscribe;
}

/**
 * Open or reuse a live @botiverse/oar 0.128.1 built-in Runtime Session
 */
async function ensureLiveOarSession(sess) {
  const runtimeId = resolveOarRuntimeId(sess.agentType);
  if (!runtimeId) return null;

  // Reuse existing live session if same runtime
  if (sess.liveSession && sess.liveRuntimeId === runtimeId) {
    return sess.liveSession;
  }

  // If switching runtime, dispose old live session first
  if (sess.liveSession) {
    await disposeLiveSession(sess);
  }

  const runtime = await loadBuiltinOarRuntime(runtimeId);
  if (!runtime || typeof runtime.session !== 'function') {
    return null;
  }

  const userEnv = ensureDiscoveryPath(sess.username);
  let installation = null;
  try {
    installation = await runtime.installation?.();
  } catch (err) {
    console.warn(`[OAR] installation() failed for "${runtimeId}":`, err.message);
    return null;
  }

  if (!installation || installation.kind !== 'available') {
    console.warn(`[OAR] Built-in runtime "${runtimeId}" not available:`, installation?.kind || 'unknown', installation?.detail || '');
    return null;
  }

  const capsMod = await getOarCapabilitiesModule();
  const preCaps = capsMod?.installedSessionCapabilities
    ? capsMod.installedSessionCapabilities(runtime, installation)
    : {};
  const refused = preCaps?.refusedSessionOptions || runtime.refusedSessionOptions || {};

  const cwd = (sess.workspacePath && fs.existsSync(sess.workspacePath)) ? sess.workspacePath : process.cwd();

  const buildOptions = ({ includeResume = true, includeModel = true } = {}) => {
    const opts = {
      cwd,
      retainedBytes: OAR_RETAINED_BYTES
    };
    if (!refused.env) {
      opts.env = userEnv;
    }
    if (includeResume && sess.oarSessionId) {
      opts.resume = sess.oarSessionId;
    }
    // Only pass model if user explicitly picked a non-gateway native model
    if (includeModel && sess.model && sess.model !== 'default' && !sess.model.includes('/')) {
      opts.model = sess.model;
    }
    return opts;
  };

  let liveSession = null;
  try {
    liveSession = await runtime.session(installation, buildOptions({ includeResume: true, includeModel: true }));
  } catch (err) {
    const errName = err?.name || '';
    const isResumeErr = errName === 'SessionNotFoundError' || errName === 'SessionUnavailableError' || errName === 'ResumeCwdError' || (errName === 'UnsupportedOptionError' && err?.option === 'cwd');
    const isModelErr = errName === 'ModelConfirmationError' || (errName === 'UnsupportedOptionError' && err?.option === 'model');

    if (isResumeErr || isModelErr) {
      console.warn(`[OAR] Retrying open for "${runtimeId}" after ${errName}: ${err.message}`);
      if (isResumeErr) sess.oarSessionId = null;
      try {
        liveSession = await runtime.session(installation, buildOptions({
          includeResume: !isResumeErr,
          includeModel: !isModelErr
        }));
      } catch (retryErr) {
        console.warn(`[OAR] Retry open failed for "${runtimeId}":`, retryErr.message);
        return null;
      }
    } else {
      console.warn(`[OAR] Failed to open native session for "${runtimeId}":`, err.message);
      return null;
    }
  }

  sess.liveSession = liveSession;
  sess.liveRuntimeId = runtimeId;
  sess.oarSessionId = liveSession.id || sess.oarSessionId;
  sess.oarCapabilities = {
    runtimeId,
    version: installation.version || null,
    steer: typeof liveSession.steer === 'function',
    withdraw: typeof liveSession.withdraw === 'function',
    compact: typeof liveSession.compact === 'function',
    images: Boolean(liveSession.capabilities?.images),
    durableQueue: Boolean(liveSession.capabilities?.queue?.durable),
    placement: liveSession.placement || null
  };

  const reportedModel = liveSession.model?.()?.value;
  if (reportedModel) {
    sess.activeModel = reportedModel;
  }

  attachLiveSessionEvents(sess, liveSession);
  touchSession(sess);
  persistSessionState(sess);

  console.log(`[OAR] Opened live "${runtimeId}" session (${liveSession.id}) for "${sess.sessionName}" | steer=${sess.oarCapabilities.steer} images=${sess.oarCapabilities.images} compact=${sess.oarCapabilities.compact}`);
  return liveSession;
}

/**
 * Safely dispose a live OAR session
 */
async function disposeLiveSession(sess) {
  if (!sess) return;
  if (typeof sess.unsubscribeEvents === 'function') {
    try { sess.unsubscribeEvents(); } catch (e) {}
    sess.unsubscribeEvents = null;
  }
  const live = sess.liveSession;
  sess.liveSession = null;
  sess.liveRuntimeId = null;
  if (live && typeof live.dispose === 'function') {
    try {
      await live.dispose();
    } catch (e) {
      console.warn('[OAR] Error disposing live session:', e.message);
    }
  }
}

/**
 * Probe available built-in OAR runtimes and their capabilities on this host
 */
async function listAvailableRuntimes(username = null) {
  ensureDiscoveryPath(username);
  const oar = await getOarModule();
  if (!oar || !oar.defaultRuntimes) return [];
  const capsMod = await getOarCapabilitiesModule();

  const results = [];
  for (const rt of oar.defaultRuntimes.list()) {
    try {
      const inst = await rt.installation?.();
      const available = inst?.kind === 'available';
      const caps = (available && capsMod?.installedSessionCapabilities)
        ? capsMod.installedSessionCapabilities(rt, inst)
        : null;
      results.push({
        id: rt.id,
        name: rt.brand?.name || rt.id,
        kind: inst?.kind || 'unknown',
        available,
        version: inst?.version || null,
        command: inst?.command || null,
        execution: rt.execution || null,
        capabilities: caps ? {
          steer: Boolean(caps.steer),
          images: Boolean(caps.images),
          manualCompaction: caps.manualCompaction?.kind === 'supported'
        } : null
      });
    } catch (err) {
      results.push({
        id: rt.id,
        name: rt.brand?.name || rt.id,
        kind: 'error',
        available: false,
        error: err.message
      });
    }
  }
  return results;
}

/**
 * Keep backward-compatible export for callers inspecting Deck Runtime Registry
 */
async function getDeckRuntimeRegistry() {
  const oar = await getOarModule();
  return oar?.defaultRuntimes || null;
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

  const persisted = loadPersistedSession(username, sessionName);
  const agentType = options.agentType || (persisted && persisted.agentType) || 'agy';
  const workspacePath = options.workspacePath || (persisted && persisted.workspacePath) || process.cwd();

  const sessionData = persisted || {
    sessionName,
    username: username || 'default',
    agentType,
    workspacePath,
    model: options.model || '',
    activeModel: null,
    oarSessionId: null,
    conversationId: null,
    claudeSessionId: null,
    usage: null,
    contextUsage: null,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    messages: [
      {
        id: 'msg-welcome',
        role: 'assistant',
        content: `👋 您好！已进入 **OAR 纯会话模式**（\`@botiverse/oar\` 流式引擎）。\n当前智能体：\`${agentType}\`\n工作区：\`${workspacePath}\`\n支持实时流式思考、工具调用追踪、原生多模态图片输入、运行中转向/排队，以及 \`/compact\` 上下文压缩。`,
        timestamp: Date.now()
      }
    ]
  };

  const oarSession = {
    ...sessionData,
    oarSessionId: (persisted && persisted.oarSessionId) || null,
    conversationId: (persisted && persisted.conversationId) || null,
    claudeSessionId: (persisted && persisted.claudeSessionId) || null,
    lastUpdated: (persisted && persisted.lastUpdated) || Date.now(),
    isGenerating: false,
    statusText: '就绪',
    liveSession: null,
    liveRuntimeId: null,
    unsubscribeEvents: null,
    activeAssistantMsg: null,
    oarCapabilities: null,
    currentController: null,
    subscribers: new Set()
  };

  activeOarSessions.set(sessionKey, oarSession);
  return oarSession;
}

/**
 * Filter valid local image paths for OAR native InputOptions.images
 */
function normalizeNativeImages(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const valid = [];
  for (const img of images) {
    const p = typeof img === 'string' ? img : img?.path;
    if (!p || typeof p !== 'string') continue;
    if (!SUPPORTED_IMAGE_EXT.test(p)) continue;
    if (fs.existsSync(p)) {
      valid.push({ path: p });
    }
  }
  return valid;
}

/**
 * Send user message to OAR session (Native OAR 0.128.1 streaming runtime with Gateway fallback)
 */
async function sendUserMessage(username, sessionName, userText, onChunk = null, options = {}) {
  const sess = await getOrCreateSession(username, sessionName);
  const trimmedText = (userText || '').trim();
  const nativeImages = normalizeNativeImages(options.images);

  if (!trimmedText && nativeImages.length === 0) {
    throw new Error('Message content cannot be empty');
  }

  const userMsgId = `msg-user-${Date.now()}`;
  const userMsg = {
    id: userMsgId,
    role: 'user',
    content: trimmedText || '[图片附件]',
    timestamp: Date.now()
  };
  sess.messages.push(userMsg);
  touchSession(sess);

  // Check if user explicitly selected a custom LLM Gateway provider/model (contains '/')
  const hasCustomGatewayModel = Boolean(sess.model && sess.model !== 'default' && sess.model.includes('/'));

  // 1. Primary path: Native @botiverse/oar 0.128.1 built-in long-lived streaming session
  if (!hasCustomGatewayModel) {
    const liveSession = await ensureLiveOarSession(sess);
    if (liveSession) {
      const inputOpts = {
        inputId: crypto.randomUUID()
      };
      if (nativeImages.length > 0 && liveSession.capabilities?.images) {
        inputOpts.images = nativeImages;
      }

      // If a turn is already running, use OAR 0.128.1 deliver() (steer if supported, else queue)
      if (sess.isGenerating) {
        try {
          const delivery = await liveSession.deliver(trimmedText, {
            when: 'now',
            ...inputOpts
          });
          sess.statusText = delivery.kind === 'steered' ? '已实时转向当前推理...' : '已加入执行队列...';
          touchSession(sess);
          persistSessionState(sess);
          return {
            id: userMsgId,
            role: 'system',
            delivery: delivery.kind,
            content: delivery.kind === 'steered' ? '已将新指令实时注入当前推理。' : '已将新指令加入队列，等待当前轮次完成。'
          };
        } catch (deliverErr) {
          console.warn('[OAR] deliver() failed while busy:', deliverErr.message);
        }
      }

      // Start a new turn with placeholder assistant message
      const assistantMsg = {
        id: `msg-asst-${Date.now()}`,
        role: 'assistant',
        content: '',
        thinking: '',
        tools: [],
        timestamp: Date.now()
      };
      sess.messages.push(assistantMsg);
      sess.activeAssistantMsg = assistantMsg;
      sess.isGenerating = true;
      sess.statusText = 'OAR 智能体思考中...';
      touchSession(sess);
      persistSessionState(sess);

      try {
        const oar = await getOarModule();
        if (oar && typeof oar.promptAndWait === 'function') {
          const run = await oar.promptAndWait(liveSession, trimmedText, inputOpts);
          if (run && run.kind === 'rejected') {
            assistantMsg.content = `[OAR 运行时拒绝]: ${run.reason || '当前会话无法接收指令'}`;
          } else if (run && run.kind === 'handled') {
            if (!assistantMsg.content) {
              assistantMsg.content = '（指令已由运行时原生处理完成）';
            }
          }
        } else {
          await liveSession.prompt(trimmedText, inputOpts);
        }

        // Refresh latest session folds
        const latestModel = liveSession.model?.()?.value;
        if (latestModel) sess.activeModel = latestModel;
        const latestUsage = liveSession.usage?.()?.value?.total;
        if (latestUsage) {
          sess.usage = latestUsage;
          assistantMsg.usage = latestUsage;
        }
        const latestCtx = liveSession.contextUsage?.()?.value;
        if (latestCtx) sess.contextUsage = latestCtx;

        if (!assistantMsg.content && (!assistantMsg.tools || assistantMsg.tools.length === 0)) {
          assistantMsg.content = '（已完成交互）';
        }
      } catch (err) {
        console.error('[OAR] Native session prompt error:', err);
        if (!assistantMsg.content) {
          assistantMsg.content = `❌ [OAR 运行时异常]: ${err.message}`;
        }
      } finally {
        sess.isGenerating = false;
        sess.statusText = '就绪';
        sess.activeAssistantMsg = null;
        touchSession(sess);
        persistSessionState(sess);
      }

      if (onChunk) {
        onChunk({ type: 'done', message: assistantMsg });
      }
      return assistantMsg;
    }
  }

  // 2. Fallback path: LLM Gateway / Custom Provider with ReAct multi-turn loop
  const assistantMsg = {
    id: `msg-asst-${Date.now()}`,
    role: 'assistant',
    content: '',
    thinking: '',
    tools: [],
    timestamp: Date.now()
  };
  sess.messages.push(assistantMsg);
  sess.activeAssistantMsg = assistantMsg;
  sess.isGenerating = true;
  sess.statusText = 'LLM 网关推理中...';
  touchSession(sess);
  persistSessionState(sess);

  const abortCtrl = new AbortController();
  sess.currentController = abortCtrl;

  try {
    let handled = false;
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
1. The workspace and tool environment are ALREADY verified, healthy, and operational. DO NOT blindly output exploratory phrases or run exploratory pwd/ls on simple greetings, discussions, or non-coding queries.
2. Only invoke tools when specifically required to inspect codebase files, edit code, run builds/tests, or fulfill the user's specific request.
3. Supported tools:
   - bash: execute shell commands in the workspace directory.
4. Always respond in the language used by the user (typically Chinese).`;

      const messagesPayload = [
        { role: 'system', content: systemPrompt },
        ...sess.messages.slice(-8, -1).map(m => ({
          role: m.role,
          content: m.content
        })),
        { role: 'user', content: trimmedText }
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

        const { cleanText, tools } = parseToolCallsFromOutput(rawContent, rawToolCalls);

        if (tools.length === 0) {
          finalCleanResponse = cleanText || rawContent || '（智能体未返回文本）';
          handled = true;
          break;
        }

        for (const t of tools) {
          t.status = 'running';
          accumulatedTools.push(t);
        }
        assistantMsg.tools = [...accumulatedTools];
        touchSession(sess);

        let toolOutputsCombined = '';
        for (const t of tools) {
          const execRes = await executeTool(t, sess.workspacePath);
          t.output = execRes.output;
          t.status = execRes.success ? 'ok' : 'failed';
          const cmdName = t.input?.command || t.input?.description || t.name;
          toolOutputsCombined += `[Tool ${t.name} (${cmdName}) Output]:\n${execRes.output}\n\n`;
          touchSession(sess);
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
          touchSession(sess);
        }
      }

      if (handled || finalCleanResponse) {
        assistantMsg.content = finalCleanResponse || '（已完成工具执行与响应）';
        assistantMsg.tools = accumulatedTools;
        handled = true;
      }
    }

    if (!handled) {
      assistantMsg.content = `[OAR 引擎提示]\n未检测到可用的原生运行时 (\`${sess.agentType}\`) 或已启用的 LLM 网关配置。\n请确认对应 CLI 已安装并完成登录，或在设置中启用 LLM Gateway。`;
    }

    if (onChunk) {
      onChunk({ type: 'done', message: assistantMsg });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      assistantMsg.content += '\n\n*(操作已由用户手动中止)*';
    } else {
      assistantMsg.content = `❌ [OAR 运行时异常]: ${err.message}`;
    }
  } finally {
    sess.isGenerating = false;
    sess.statusText = '就绪';
    sess.activeAssistantMsg = null;
    sess.currentController = null;
    touchSession(sess);
    persistSessionState(sess);
  }

  return assistantMsg;
}

/**
 * Abort active generation for an OAR session (supports both native OAR Session & fallback AbortController)
 */
async function abortSession(username, sessionName) {
  const sessionKey = `${username || 'default'}:${sessionName}`;
  const sess = activeOarSessions.get(sessionKey);
  if (!sess) return false;

  let aborted = false;
  if (sess.liveSession && typeof sess.liveSession.abort === 'function') {
    try {
      const outcome = await sess.liveSession.abort();
      aborted = Boolean(outcome && outcome.kind === 'accepted');
    } catch (e) {
      console.warn('[OAR] liveSession.abort() failed:', e.message);
    }
  }

  if (sess.currentController) {
    try {
      sess.currentController.abort();
      aborted = true;
    } catch (e) {}
  }

  if (aborted) {
    sess.isGenerating = false;
    sess.statusText = '已中止';
    touchSession(sess);
    persistSessionState(sess);
  }
  return aborted;
}

/**
 * Trigger OAR 0.128.1 native manual context compaction (session.compact())
 */
async function compactSession(username, sessionName) {
  const sess = await getOrCreateSession(username, sessionName);
  const liveSession = await ensureLiveOarSession(sess);

  if (!liveSession || typeof liveSession.compact !== 'function') {
    return {
      supported: false,
      outcome: 'unsupported',
      message: `当前运行时 (${sess.agentType}) 暂不支持原生 /compact 上下文压缩。`
    };
  }

  if (sess.isGenerating) {
    return {
      supported: true,
      outcome: 'busy',
      message: '智能体正在生成中，请等待当前轮次完成后再执行 /compact。'
    };
  }

  sess.statusText = '正在压缩上下文...';
  touchSession(sess);

  try {
    const result = await liveSession.compact({ timeoutMs: 60000 });
    const kind = result?.kind || 'completed';
    const ok = kind === 'completed';
    const note = ok
      ? '✅ 已完成上下文压缩（OAR 原生 Compact），释放了上下文窗口空间。'
      : `⚠️ 上下文压缩结果：${kind}${result?.reason ? ` (${result.reason})` : ''}`;

    sess.messages.push({
      id: `msg-compact-${Date.now()}`,
      role: 'assistant',
      content: note,
      timestamp: Date.now()
    });
    sess.statusText = '就绪';
    touchSession(sess);
    persistSessionState(sess);

    return {
      supported: true,
      outcome: kind,
      message: note,
      raw: result
    };
  } catch (err) {
    sess.statusText = '就绪';
    touchSession(sess);
    return {
      supported: true,
      outcome: 'failed',
      message: `❌ 上下文压缩失败: ${err.message}`
    };
  }
}

/**
 * Clear OAR session context (dispose live session, reset messages & native session id)
 */
async function clearSession(username, sessionName) {
  const sess = await getOrCreateSession(username, sessionName);
  if (sess.currentController) {
    try { sess.currentController.abort(); } catch (e) {}
    sess.currentController = null;
  }
  await disposeLiveSession(sess);

  sess.messages = [];
  sess.isGenerating = false;
  sess.statusText = '就绪';
  sess.activeAssistantMsg = null;
  sess.oarSessionId = null;
  sess.usage = null;
  sess.contextUsage = null;
  sess.conversationId = crypto.randomUUID();
  sess.claudeSessionId = crypto.randomUUID();
  touchSession(sess);
  persistSessionState(sess);
  return sess;
}

/**
 * Delete OAR session and release underlying runtime process
 */
function deleteOarSession(username, sessionName) {
  const sessionKey = `${username || 'default'}:${sessionName}`;
  const sess = activeOarSessions.get(sessionKey);
  if (sess) {
    disposeLiveSession(sess).catch(() => {});
    activeOarSessions.delete(sessionKey);
  }
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
  listAvailableRuntimes,
  getOrCreateSession,
  sendUserMessage,
  abortSession,
  compactSession,
  clearSession,
  deleteOarSession,
  loadPersistedSession
};
