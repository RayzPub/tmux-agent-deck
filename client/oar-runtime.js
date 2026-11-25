/**
 * Standalone Device-Side OAR Runtime Engine (ccnow-agent / host-admin / docker-sandbox / external)
 * Zero dependency on Control Plane modules (config, tmuxService, fileService, llmGatewayService).
 * Dynamically loads @botiverse/oar (>=0.128.1) via low-memory per-runtime subpath imports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

const OAR_RETAINED_BYTES = 8 * 1024 * 1024;
const MODEL_LIST_TTL_MS = 12 * 60 * 60 * 1000; // 12h persistent disk+memory cache; click refresh to force re-probe
const SUPPORTED_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function resolveLaunchModel(rawModel) {
  if (typeof rawModel !== 'string') return null;
  const trimmed = rawModel.trim();
  if (!trimmed || trimmed === 'default') return null;
  // Allow real provider/model IDs (e.g. "kimi-code/k3", "gemini-4-neon", "glm-5.3-flash"),
  // while ignoring UI display labels that contain spaces or non-ASCII text.
  if (!/^[a-zA-Z0-9._:@/-]+$/.test(trimmed)) return null;
  return trimmed;
}

function resolveLaunchEffort(rawEffort) {
  if (typeof rawEffort !== 'string') return null;
  const trimmed = rawEffort.trim();
  if (!trimmed || trimmed === 'default') return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

function settleRunningToolsInMessage(msg, targetStatus = 'interrupted') {
  if (!msg || !Array.isArray(msg.tools)) return false;
  let changed = false;
  for (const t of msg.tools) {
    if (!t || typeof t !== 'object') continue;
    if ('_rawInputBuffer' in t) {
      delete t._rawInputBuffer;
      changed = true;
    }
    if (t.status === 'running') {
      t.status = targetStatus;
      changed = true;
    }
  }
  return changed;
}

function settleRunningToolsInMessages(messages, targetStatus = 'interrupted') {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const m of messages) {
    if (settleRunningToolsInMessage(m, targetStatus)) {
      changed = true;
    }
  }
  return changed;
}

function createDeviceOarManager(options = {}) {
  const storageDir = options.storageDir || path.join(os.homedir(), '.ccnow', 'oar_sessions');
  const resolveEsmUrl = typeof options.resolveEsmUrl === 'function' ? options.resolveEsmUrl : null;
  const activeSessions = new Map();
  const runtimeCache = new Map();
  const modelListCache = new Map();
  const inFlightModelLists = new Map();
  let rootOarPromise = null;
  let capsModulePromise = null;

  async function importOarSpecifier(specifier) {
    try {
      return await import(specifier);
    } catch (primaryErr) {
      if (resolveEsmUrl) {
        const fallbackUrl = resolveEsmUrl(specifier);
        if (fallbackUrl) {
          return await import(fallbackUrl);
        }
      }
      throw primaryErr;
    }
  }

  function ensureStorageDir() {
    if (!fs.existsSync(storageDir)) {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
      } catch (_) {}
    }
    return storageDir;
  }

  function getSessionFile(sessionName) {
    const safeName = String(sessionName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(ensureStorageDir(), `${safeName}.json`);
  }

  function getRootOar() {
    if (!rootOarPromise) {
      rootOarPromise = importOarSpecifier('@botiverse/oar').catch(err => {
        console.warn('[DeviceOAR] @botiverse/oar not available on this device:', err.message);
        rootOarPromise = null; // Allow retry after background auto-install completes
        return null;
      });
    }
    return rootOarPromise;
  }

  function getCapabilitiesModule() {
    if (!capsModulePromise) {
      capsModulePromise = importOarSpecifier('@botiverse/oar/capabilities').catch(() => {
        capsModulePromise = null;
        return null;
      });
    }
    return capsModulePromise;
  }

  async function loadBuiltinRuntime(runtimeId) {
    if (!runtimeId || !RUNTIME_EXPORT_NAME[runtimeId]) return null;
    if (runtimeCache.has(runtimeId)) return runtimeCache.get(runtimeId);
    const promise = (async () => {
      try {
        const mod = await importOarSpecifier(`@botiverse/oar/runtimes/${runtimeId}`);
        return mod[RUNTIME_EXPORT_NAME[runtimeId]] || null;
      } catch (err) {
        console.warn(`[DeviceOAR] Failed to load @botiverse/oar/runtimes/${runtimeId}:`, err.message);
        runtimeCache.delete(runtimeId); // Allow retry after background auto-install completes
        return null;
      }
    })();
    runtimeCache.set(runtimeId, promise);
    return promise;
  }

  function resolveRuntimeId(agentType) {
    if (!agentType) return 'claude';
    const norm = String(agentType).trim().toLowerCase();
    return AGENT_TO_OAR_RUNTIME[norm] || null;
  }

  /**
   * Build device-native environment while preserving container/host proxy credentials
   * (e.g. ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY scoped virtual key in Docker sandbox).
   */
  function buildDeviceEnv() {
    const home = process.env.HOME || os.homedir();
    const nodeBinDir = path.dirname(process.execPath);
    const pathParts = [
      nodeBinDir,
      path.join(home, '.local', 'bin'),
      path.join(home, '.kimi-code', 'bin'),
      '/usr/local/bin',
      process.env.PATH || '/usr/bin:/bin'
    ];
    const mergedPath = Array.from(new Set(pathParts.filter(Boolean))).join(':');
    if (process.env.PATH !== mergedPath) {
      process.env.PATH = mergedPath;
    }
    return {
      ...process.env,
      HOME: home,
      PATH: mergedPath
    };
  }

  function touchSession(sess) {
    const now = Date.now();
    sess.lastUpdated = (sess.lastUpdated && now <= sess.lastUpdated) ? sess.lastUpdated + 1 : now;
  }

  function loadPersisted(sessionName) {
    const file = getSessionFile(sessionName);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function persistSession(sess) {
    if (!sess) return;
    try {
      const file = getSessionFile(sess.sessionName);
      fs.writeFileSync(file, JSON.stringify({
        sessionName: sess.sessionName,
        agentType: sess.agentType,
        workspacePath: sess.workspacePath,
        model: sess.model || '',
        effort: sess.effort || '',
        activeModel: sess.activeModel || null,
        activeEffort: sess.activeEffort || null,
        oarSessionId: sess.oarSessionId || null,
        usage: sess.usage || null,
        contextUsage: sess.contextUsage || null,
        createdAt: sess.createdAt,
        lastUpdated: sess.lastUpdated,
        messages: sess.messages
      }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[DeviceOAR] Failed to persist session:', e.message);
    }
  }

  function parseToolInput(rawInput) {
    if (rawInput == null) return {};
    if (typeof rawInput === 'object') return rawInput;
    const str = String(rawInput).trim();
    if (!str) return {};
    if (str.startsWith('{') || str.startsWith('[')) {
      try { return JSON.parse(str); } catch (_) { return { raw: str }; }
    }
    return { command: str };
  }

  function summarizeToolOutput(contentParts) {
    if (!Array.isArray(contentParts) || contentParts.length === 0) return '';
    const chunks = [];
    for (const part of contentParts) {
      if (!part) continue;
      if (part.kind === 'text' && typeof part.text === 'string') chunks.push(part.text);
      else if (part.kind === 'image') chunks.push(`[image: ${part.mediaType || 'image'}]`);
      else if (typeof part === 'string') chunks.push(part);
    }
    const combined = chunks.join('\n').trim();
    return combined.length > 4000 ? combined.slice(0, 4000) + '\n...(truncated)' : combined;
  }

  function validateWorkspaceImages(workspacePath, rawImages) {
    if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
    const root = path.resolve(workspacePath || process.cwd());
    const valid = [];
    for (const img of rawImages) {
      const candidate = typeof img === 'string' ? img : (img && (img.relativePath || img.path));
      if (!candidate || typeof candidate !== 'string') continue;
      const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!SUPPORTED_IMAGE_EXT.test(resolved)) continue;
      if (fs.existsSync(resolved)) {
        valid.push({ path: resolved });
      }
    }
    return valid;
  }

  function attachEvents(sess, liveSession) {
    if (typeof sess.unsubscribeEvents === 'function') {
      try { sess.unsubscribeEvents(); } catch (_) {}
      sess.unsubscribeEvents = null;
    }

    let persistTimer = null;
    const schedulePersist = () => {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistSession(sess);
      }, 600);
    };

    const ensureAssistantMsg = () => {
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

    sess.unsubscribeEvents = liveSession.events((event) => {
      if (!event || !event.kind) return;
      const isRoot = !Array.isArray(event.agentPath) || event.agentPath.length === 0;

      switch (event.kind) {
        case 'turn_started':
        case 'turn_active':
          if (isRoot) {
            sess.isGenerating = true;
            sess.statusText = 'OAR 智能体思考中...';
            touchSession(sess);
          }
          break;

        case 'reasoning':
          if (isRoot && event.content && event.content.kind === 'text' && event.content.text) {
            const msg = ensureAssistantMsg();
            msg.thinking = (msg.thinking || '') + event.content.text;
            sess.statusText = '正在深入思考...';
            touchSession(sess);
            schedulePersist();
          }
          break;

        case 'text_delta':
          if (isRoot && event.text) {
            const msg = ensureAssistantMsg();
            msg.content = (msg.content || '') + event.text;
            sess.statusText = '正在生成回复...';
            touchSession(sess);
            schedulePersist();
          }
          break;

        case 'tool_call_started':
          if (isRoot) {
            const msg = ensureAssistantMsg();
            if (!Array.isArray(msg.tools)) msg.tools = [];
            const toolName = event.toolName || event.tool || 'tool';
            let entry = msg.tools.find(t => t.id === event.callId);
            if (!entry) {
              entry = {
                id: event.callId,
                name: toolName,
                server: event.server || undefined,
                input: parseToolInput(event.input),
                _rawInputBuffer: typeof event.input === 'string' ? event.input : '',
                status: 'running'
              };
              msg.tools.push(entry);
            } else {
              entry.name = toolName;
              if (event.input) entry.input = parseToolInput(event.input);
              entry.status = 'running';
            }
            sess.statusText = `正在执行工具: ${toolName}...`;
            touchSession(sess);
            schedulePersist();
          }
          break;

        case 'tool_call_input_delta':
          if (isRoot && event.callId && event.delta) {
            const msg = ensureAssistantMsg();
            const entry = Array.isArray(msg.tools) ? msg.tools.find(t => t.id === event.callId) : null;
            if (entry) {
              entry._rawInputBuffer = (entry._rawInputBuffer || '') + event.delta;
              entry.input = parseToolInput(entry._rawInputBuffer);
              touchSession(sess);
            }
          }
          break;

        case 'tool_call_input':
          if (isRoot && event.callId) {
            const msg = ensureAssistantMsg();
            const entry = Array.isArray(msg.tools) ? msg.tools.find(t => t.id === event.callId) : null;
            if (entry) {
              entry._rawInputBuffer = typeof event.input === 'string' ? event.input : '';
              entry.input = parseToolInput(event.input);
              touchSession(sess);
              schedulePersist();
            }
          }
          break;

        case 'tool_call_ended':
          if (isRoot && event.callId) {
            const msg = ensureAssistantMsg();
            const entry = Array.isArray(msg.tools) ? msg.tools.find(t => t.id === event.callId) : null;
            if (entry) {
              delete entry._rawInputBuffer;
              entry.status = event.result || 'ok';
              if (event.exitCode !== undefined && event.exitCode !== null) {
                entry.exitCode = event.exitCode;
              }
              const out = summarizeToolOutput(event.content);
              if (out) entry.output = out;
              if (Array.isArray(event.fileChanges) && event.fileChanges.length > 0) {
                entry.fileChanges = event.fileChanges;
              }
              touchSession(sess);
              schedulePersist();
            }
          }
          break;

        case 'usage':
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

        case 'model':
          if (isRoot && event.model) {
            sess.activeModel = event.model;
            touchSession(sess);
          }
          break;

        case 'effort':
          if (isRoot && event.effort) {
            sess.activeEffort = event.effort;
            touchSession(sess);
          }
          break;

        case 'compaction_started':
          if (isRoot) {
            sess.statusText = '正在压缩上下文...';
            touchSession(sess);
          }
          break;

        case 'compaction_ended':
          if (isRoot) {
            sess.statusText = event.outcome === 'completed' ? '上下文压缩完成' : '就绪';
            touchSession(sess);
          }
          break;

        case 'retry':
          if (isRoot) {
            sess.statusText = `正在重试 (第 ${event.attempt} 次)...`;
            touchSession(sess);
          }
          break;

        case 'turn_ended':
          if (isRoot) {
            const msg = sess.activeAssistantMsg;
            if (msg) {
              if (Array.isArray(msg.tools)) {
                for (const t of msg.tools) {
                  delete t._rawInputBuffer;
                  if (t.status === 'running') t.status = 'ok';
                }
              }
              if (event.forkAnchor) msg.forkAnchor = event.forkAnchor;
              const outcome = event.outcome;
              if (outcome && outcome.kind === 'aborted') {
                if (!msg.content) msg.content = '*(已中止当前生成)*';
                else if (!msg.content.includes('已中止')) msg.content += '\n\n*(操作已由用户手动中止)*';
              } else if (outcome && outcome.kind === 'failed') {
                const reason = outcome.message || outcome.failure || '执行失败';
                if (!msg.content) msg.content = `❌ [OAR 运行时异常]: ${reason}`;
                else msg.content += `\n\n❌ [异常]: ${reason}`;
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
            persistSession(sess);
          }
          break;

        case 'exited':
          if (isRoot) {
            if (sess.liveSession === liveSession) {
              sess.liveSession = null;
              sess.liveRuntimeId = null;
              sess.unsubscribeEvents = null;
            }
            if (sess.isGenerating) {
              sess.isGenerating = false;
              sess.statusText = '就绪';
              if (sess.activeAssistantMsg) {
                settleRunningToolsInMessage(sess.activeAssistantMsg, 'interrupted');
                if (!sess.activeAssistantMsg.content) {
                  sess.activeAssistantMsg.content = '*(底层运行时进程已退出，下次发送消息将自动恢复会话)*';
                }
              }
              sess.activeAssistantMsg = null;
              touchSession(sess);
              persistSession(sess);
            }
          }
          break;

        default:
          break;
      }
    }, { coalesceText: { maxHoldMs: 120 } });
  }

  async function disposeLive(sess) {
    if (!sess) return;
    if (typeof sess.unsubscribeEvents === 'function') {
      try { sess.unsubscribeEvents(); } catch (_) {}
      sess.unsubscribeEvents = null;
    }
    const live = sess.liveSession;
    sess.liveSession = null;
    sess.liveRuntimeId = null;
    sess.liveModel = '';
    sess.liveEffort = '';
    if (live && typeof live.dispose === 'function') {
      try { await live.dispose(); } catch (_) {}
    }
  }

  async function ensureLiveSession(sess) {
    const runtimeId = resolveRuntimeId(sess.agentType);
    if (!runtimeId) return { session: null, error: `不支持的 OAR 运行时类型: ${sess.agentType}` };

    const resolvedModel = resolveLaunchModel(sess.model);
    const resolvedEffort = resolveLaunchEffort(sess.effort);

    if (
      sess.liveSession &&
      sess.liveRuntimeId === runtimeId &&
      (sess.liveModel || '') === (resolvedModel || '') &&
      (sess.liveEffort || '') === (resolvedEffort || '')
    ) {
      return { session: sess.liveSession, error: null };
    }
    if (sess.liveSession) {
      await disposeLive(sess);
    }

    const runtime = await loadBuiltinRuntime(runtimeId);
    if (!runtime || typeof runtime.session !== 'function') {
      return {
        session: null,
        error: `当前设备未安装 @botiverse/oar 或不支持运行时 "${runtimeId}"（需 Node.js >= 24 且安装 @botiverse/oar）。`
      };
    }

    const env = buildDeviceEnv();
    let installation = null;
    try {
      installation = await runtime.installation?.();
    } catch (err) {
      return { session: null, error: `探测运行时 "${runtimeId}" 失败: ${err.message}` };
    }
    if (!installation || installation.kind !== 'available') {
      return {
        session: null,
        error: `当前设备未检测到可用的 "${runtimeId}" CLI（状态: ${installation?.kind || 'not_found'}）。`
      };
    }

    const capsMod = await getCapabilitiesModule();
    const preCaps = capsMod?.installedSessionCapabilities
      ? capsMod.installedSessionCapabilities(runtime, installation)
      : {};
    const refused = preCaps?.refusedSessionOptions || runtime.refusedSessionOptions || {};
    const cwd = (sess.workspacePath && fs.existsSync(sess.workspacePath)) ? sess.workspacePath : process.cwd();

    const buildOpts = ({ includeResume = true, includeModel = true, includeEffort = true } = {}) => {
      const opts = { cwd, retainedBytes: OAR_RETAINED_BYTES };
      const sessionEnv = { ...env };
      if (includeModel && resolvedModel) {
        opts.model = resolvedModel;
        if (runtimeId === 'claude') {
          sessionEnv.ANTHROPIC_MODEL = resolvedModel;
        } else if (runtimeId === 'codex') {
          sessionEnv.OPENAI_MODEL = resolvedModel;
          sessionEnv.CODEX_MODEL = resolvedModel;
        }
      }
      if (includeEffort && resolvedEffort) {
        opts.effort = resolvedEffort;
      }
      if (!refused.env) opts.env = sessionEnv;
      if (includeResume && sess.oarSessionId) opts.resume = sess.oarSessionId;
      return opts;
    };

    let liveSession = null;
    try {
      liveSession = await runtime.session(installation, buildOpts({ includeResume: true, includeModel: true, includeEffort: true }));
    } catch (err) {
      const errName = err?.name || '';
      const errMsg = String(err?.message || '');
      const isResumeErr = errName === 'SessionNotFoundError' || errName === 'SessionUnavailableError' || errName === 'ResumeCwdError' || (errName === 'UnsupportedOptionError' && err?.option === 'cwd');
      const isModelErr = errName === 'ModelConfirmationError' || (errName === 'UnsupportedOptionError' && err?.option === 'model');
      const isEffortErr = (errName === 'UnsupportedOptionError' && err?.option === 'effort') || /\beffort\b/i.test(errMsg);
      if (isResumeErr || isModelErr || isEffortErr) {
        if (isResumeErr) sess.oarSessionId = null;
        try {
          liveSession = await runtime.session(installation, buildOpts({
            includeResume: !isResumeErr,
            includeModel: !isModelErr,
            includeEffort: !isEffortErr && !isModelErr
          }));
        } catch (retryErr) {
          return { session: null, error: `启动 "${runtimeId}" 会话失败: ${retryErr.message}` };
        }
      } else {
        return { session: null, error: `启动 "${runtimeId}" 会话失败: ${err.message}` };
      }
    }

    sess.liveSession = liveSession;
    sess.liveRuntimeId = runtimeId;
    sess.liveModel = resolvedModel || '';
    sess.liveEffort = resolvedEffort || '';
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
    if (reportedModel) sess.activeModel = reportedModel;
    const reportedEffort = liveSession.effort?.()?.value;
    if (reportedEffort) sess.activeEffort = reportedEffort;

    attachEvents(sess, liveSession);
    touchSession(sess);
    persistSession(sess);
    return { session: liveSession, error: null };
  }

  function getOrCreateSession(sessionName, opts = {}) {
    if (activeSessions.has(sessionName)) {
      const existing = activeSessions.get(sessionName);
      if (opts.workspacePath) existing.workspacePath = opts.workspacePath;
      if (opts.agentType) existing.agentType = opts.agentType;
      if (opts.forceModelUpdate) {
        if (opts.model !== undefined) existing.model = resolveLaunchModel(opts.model) || '';
        if (opts.effort !== undefined) existing.effort = resolveLaunchEffort(opts.effort) || '';
      } else {
        if (!existing.model && opts.model) {
          const cleanM = resolveLaunchModel(opts.model);
          if (cleanM) existing.model = cleanM;
        }
        if (!existing.effort && opts.effort) {
          const cleanE = resolveLaunchEffort(opts.effort);
          if (cleanE) existing.effort = cleanE;
        }
      }
      return existing;
    }

    const persisted = loadPersisted(sessionName);
    const agentType = opts.agentType || (persisted && persisted.agentType) || 'claude';
    const workspacePath = opts.workspacePath || (persisted && persisted.workspacePath) || process.cwd();
    const initialModel = resolveLaunchModel(opts.model) || resolveLaunchModel(persisted && persisted.model) || '';
    const initialEffort = resolveLaunchEffort(opts.effort) || resolveLaunchEffort(persisted && persisted.effort) || '';

    const loadedMessages = (persisted && Array.isArray(persisted.messages))
      ? persisted.messages.filter(m => m && m.id !== 'msg-welcome')
      : [];
    // Any tool still marked 'running' on disk came from a prior dead process; self-heal on load
    const healedStaleTools = settleRunningToolsInMessages(loadedMessages, 'interrupted');

    const sess = {
      sessionName,
      agentType,
      workspacePath,
      model: initialModel,
      effort: initialEffort,
      activeModel: (persisted && persisted.activeModel) || initialModel || null,
      activeEffort: (persisted && persisted.activeEffort) || initialEffort || null,
      oarSessionId: (persisted && persisted.oarSessionId) || null,
      usage: (persisted && persisted.usage) || null,
      contextUsage: (persisted && persisted.contextUsage) || null,
      createdAt: (persisted && persisted.createdAt) || Date.now(),
      lastUpdated: (persisted && persisted.lastUpdated) || Date.now(),
      messages: loadedMessages,
      isGenerating: false,
      statusText: '就绪',
      liveSession: null,
      liveRuntimeId: null,
      liveModel: '',
      liveEffort: '',
      unsubscribeEvents: null,
      activeAssistantMsg: null,
      oarCapabilities: null
    };

    activeSessions.set(sessionName, sess);
    if (healedStaleTools) {
      touchSession(sess);
      persistSession(sess);
    }
    return sess;
  }

  function getHistorySnapshot(sessionName, opts = {}) {
    const sess = getOrCreateSession(sessionName, opts);
    return {
      supported: true,
      hasHistory: sess.messages.length > 0,
      sessionName: sess.sessionName,
      agentType: sess.agentType || 'oar',
      sessionMode: 'chat_only',
      workspacePath: sess.workspacePath,
      messages: sess.messages || [],
      pendingAction: null,
      isGenerating: Boolean(sess.isGenerating),
      statusText: sess.statusText || (sess.isGenerating ? 'OAR 智能体思考中...' : '就绪'),
      model: sess.model || '',
      effort: sess.effort || '',
      activeModel: sess.activeModel || sess.model || null,
      activeEffort: sess.activeEffort || sess.effort || null,
      usage: sess.usage || null,
      contextUsage: sess.contextUsage || null,
      oarCapabilities: sess.oarCapabilities || null,
      lastUpdated: sess.lastUpdated || Date.now()
    };
  }

  /**
   * Dispatch a user message on the device.
   * Starts the OAR turn asynchronously so RPC / HTTP never hits proxy timeouts;
   * frontend 500ms polling streams thinking/tools/text_delta in real time.
   */
  async function sendMessage(sessionName, content, opts = {}) {
    const sess = getOrCreateSession(sessionName, opts);
    const trimmedText = String(content || '').trim();
    const nativeImages = validateWorkspaceImages(sess.workspacePath, opts.images);

    if (!trimmedText && nativeImages.length === 0) {
      throw new Error('Message content or images required');
    }

    if (!sess.isGenerating) {
      settleRunningToolsInMessages(sess.messages, 'interrupted');
    }

    const userMsg = {
      id: `msg-user-${Date.now()}`,
      role: 'user',
      content: trimmedText || '[图片附件]',
      timestamp: Date.now()
    };
    sess.messages.push(userMsg);
    touchSession(sess);

    const { session: liveSession, error } = await ensureLiveSession(sess);
    if (!liveSession) {
      const errMsg = {
        id: `msg-asst-${Date.now()}`,
        role: 'assistant',
        content: `❌ [设备端 OAR 不可用]: ${error}`,
        timestamp: Date.now()
      };
      sess.messages.push(errMsg);
      sess.isGenerating = false;
      sess.statusText = '就绪';
      touchSession(sess);
      persistSession(sess);
      return { accepted: false, error, message: errMsg };
    }

    const inputOpts = { inputId: crypto.randomUUID() };
    if (nativeImages.length > 0 && liveSession.capabilities?.images) {
      inputOpts.images = nativeImages;
    }

    // Running turn: steer or queue via OAR 0.128.1 deliver()
    if (sess.isGenerating) {
      try {
        const delivery = await liveSession.deliver(trimmedText, { when: 'now', ...inputOpts });
        sess.statusText = delivery.kind === 'steered' ? '已实时转向当前推理...' : '已加入执行队列...';
        touchSession(sess);
        persistSession(sess);
        return { accepted: true, streaming: true, delivery: delivery.kind };
      } catch (deliverErr) {
        console.warn('[DeviceOAR] deliver() failed:', deliverErr.message);
      }
    }

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
    persistSession(sess);

    // Run turn in background on the device; events stream into sess.messages & sess.lastUpdated
    (async () => {
      try {
        const oar = await getRootOar();
        if (oar && typeof oar.promptAndWait === 'function') {
          const run = await oar.promptAndWait(liveSession, trimmedText, inputOpts);
          if (run && run.kind === 'rejected') {
            assistantMsg.content = `[OAR 运行时拒绝]: ${run.reason || '当前会话无法接收指令'}`;
          } else if (run && run.kind === 'handled' && !assistantMsg.content) {
            assistantMsg.content = '（指令已由运行时原生处理完成）';
          }
        } else {
          await liveSession.prompt(trimmedText, inputOpts);
        }

        const latestModel = liveSession.model?.()?.value;
        if (latestModel) sess.activeModel = latestModel;
        const latestEffort = liveSession.effort?.()?.value;
        if (latestEffort) sess.activeEffort = latestEffort;
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
        if (!assistantMsg.content) {
          assistantMsg.content = `❌ [OAR 运行时异常]: ${err.message}`;
        }
      } finally {
        settleRunningToolsInMessage(assistantMsg, 'ok');
        sess.isGenerating = false;
        sess.statusText = '就绪';
        sess.activeAssistantMsg = null;
        touchSession(sess);
        persistSession(sess);
      }
    })();

    return { accepted: true, streaming: true, isGenerating: true };
  }

  async function abortSession(sessionName) {
    const sess = activeSessions.get(sessionName);
    if (!sess) return false;
    let aborted = false;
    if (sess.liveSession && typeof sess.liveSession.abort === 'function') {
      try {
        const outcome = await sess.liveSession.abort();
        aborted = Boolean(outcome && outcome.kind === 'accepted');
      } catch (_) {}
    }
    if (aborted) {
      settleRunningToolsInMessage(sess.activeAssistantMsg, 'aborted');
      sess.isGenerating = false;
      sess.statusText = '已中止';
      touchSession(sess);
      persistSession(sess);
    }
    return aborted;
  }

  function shutdownAll() {
    for (const sess of activeSessions.values()) {
      const settledTools = settleRunningToolsInMessages(sess.messages, 'interrupted');
      const hadActive = Boolean(sess.isGenerating) || settledTools;
      if (hadActive) {
        if (sess.activeAssistantMsg && !sess.activeAssistantMsg.content) {
          sess.activeAssistantMsg.content = '*(服务重启导致本轮执行中断，可继续对话恢复上下文)*';
        }
        sess.isGenerating = false;
        sess.statusText = '就绪';
        sess.activeAssistantMsg = null;
        touchSession(sess);
        persistSession(sess);
      }
      if (typeof sess.unsubscribeEvents === 'function') {
        try { sess.unsubscribeEvents(); } catch (_) {}
        sess.unsubscribeEvents = null;
      }
      sess.liveSession = null;
      sess.liveRuntimeId = null;
    }
  }

  async function compactSession(sessionName, opts = {}) {
    const sess = getOrCreateSession(sessionName, opts);
    const { session: liveSession, error } = await ensureLiveSession(sess);
    if (!liveSession) {
      return { supported: false, outcome: 'unavailable', message: error };
    }
    if (typeof liveSession.compact !== 'function') {
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
      const note = kind === 'completed'
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
      persistSession(sess);
      return { supported: true, outcome: kind, message: note };
    } catch (err) {
      sess.statusText = '就绪';
      touchSession(sess);
      return { supported: true, outcome: 'failed', message: `❌ 上下文压缩失败: ${err.message}` };
    }
  }

  async function clearSession(sessionName) {
    const sess = activeSessions.get(sessionName) || getOrCreateSession(sessionName);
    await disposeLive(sess);
    sess.messages = [];
    sess.isGenerating = false;
    sess.statusText = '就绪';
    sess.activeAssistantMsg = null;
    sess.oarSessionId = null;
    sess.usage = null;
    sess.contextUsage = null;
    touchSession(sess);
    persistSession(sess);
    return true;
  }

  function deleteSession(sessionName) {
    const sess = activeSessions.get(sessionName);
    if (sess) {
      disposeLive(sess).catch(() => {});
      activeSessions.delete(sessionName);
    }
    const file = getSessionFile(sessionName);
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }

  async function listAvailableRuntimes() {
    buildDeviceEnv();
    const oar = await getRootOar();
    if (!oar || !oar.defaultRuntimes) {
      return [];
    }
    const capsMod = await getCapabilitiesModule();
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

  async function setSessionModel(sessionName, opts = {}) {
    const sess = getOrCreateSession(sessionName, {
      agentType: opts.agentType,
      workspacePath: opts.workspacePath
    });
    if (sess.isGenerating) {
      return {
        ok: false,
        busy: true,
        error: '智能体正在生成中，请等待当前轮次完成或中止后再切换模型。'
      };
    }

    const nextModel = resolveLaunchModel(opts.model) || '';
    const nextEffort = resolveLaunchEffort(opts.effort) || '';
    const changed = (sess.model || '') !== nextModel || (sess.effort || '') !== nextEffort;

    sess.model = nextModel;
    sess.effort = nextEffort;
    sess.activeModel = nextModel || null;
    sess.activeEffort = nextEffort || null;

    if (changed && sess.liveSession) {
      // OAR contract: model & effort are applied at open/resume; dispose live process while keeping oarSessionId & history
      await disposeLive(sess);
    }

    touchSession(sess);
    persistSession(sess);

    return {
      ok: true,
      sessionName: sess.sessionName,
      model: sess.model,
      effort: sess.effort,
      activeModel: sess.activeModel,
      activeEffort: sess.activeEffort,
      willResume: Boolean(sess.oarSessionId),
      lastUpdated: sess.lastUpdated
    };
  }

  function getModelCacheFile() {
    return path.join(ensureStorageDir(), '_models_cache.json');
  }

  function loadDiskModelCache() {
    try {
      const file = getModelCacheFile();
      if (!fs.existsSync(file)) return {};
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveDiskModelCacheEntry(cacheKey, entry) {
    try {
      const all = loadDiskModelCache();
      all[cacheKey] = entry;
      fs.writeFileSync(getModelCacheFile(), JSON.stringify(all, null, 2), 'utf8');
    } catch (_) {}
  }

  async function listRuntimeModels(agentType, opts = {}) {
    const runtimeId = resolveRuntimeId(agentType);
    if (!runtimeId) {
      return { runtimeId: null, kind: 'unsupported', models: [], reason: `不支持的运行时类型: ${agentType}` };
    }

    const cwd = (opts.workspacePath && fs.existsSync(opts.workspacePath)) ? opts.workspacePath : process.cwd();
    const cacheKey = `${runtimeId}::${cwd}`;
    const forceRefresh = Boolean(opts.refresh);

    if (!forceRefresh) {
      const memCached = modelListCache.get(cacheKey);
      if (memCached && (Date.now() - memCached.fetchedAt) < MODEL_LIST_TTL_MS) {
        return memCached.data;
      }
      // Check disk cache (persists across ccnow-agent restarts)
      const diskAll = loadDiskModelCache();
      const diskEntry = diskAll[cacheKey] || Object.values(diskAll).find(
        e => e && e.data && e.data.runtimeId === runtimeId && (Date.now() - (e.fetchedAt || 0)) < MODEL_LIST_TTL_MS
      );
      if (diskEntry && diskEntry.data && (Date.now() - (diskEntry.fetchedAt || 0)) < MODEL_LIST_TTL_MS) {
        modelListCache.set(cacheKey, diskEntry);
        return diskEntry.data;
      }
    }

    if (inFlightModelLists.has(cacheKey)) {
      return inFlightModelLists.get(cacheKey);
    }

    const task = (async () => {
      try {
        const runtime = await loadBuiltinRuntime(runtimeId);
        if (!runtime) {
          return { runtimeId, kind: 'unavailable', models: [], reason: `当前设备未加载 "${runtimeId}" 运行时` };
        }
        const env = buildDeviceEnv();
        const installation = await runtime.installation?.();
        if (!installation || installation.kind !== 'available') {
          return { runtimeId, kind: 'unavailable', models: [], reason: `未检测到可用的 "${runtimeId}" CLI` };
        }
        if (typeof runtime.listModels !== 'function') {
          return { runtimeId, kind: 'unsupported', models: [], reason: `运行时 "${runtimeId}" 未提供模型枚举接口` };
        }
        // Claude CLI's list_models control request returns a hardcoded static catalog even when logged out.
        // Verify authStatus first so unauthenticated Claude instances report 'unauthenticated' instead of fake models.
        if (runtimeId === 'claude' && typeof runtime.authStatus === 'function') {
          try {
            const auth = await runtime.authStatus(installation, { env, timeoutMs: 8000 });
            if (auth && auth.kind === 'logged_out') {
              return {
                runtimeId,
                kind: 'unauthenticated',
                models: [],
                detail: 'Claude Code 尚未登录（且未配置 ANTHROPIC_API_KEY）'
              };
            }
          } catch (_) {}
        }
        const res = await runtime.listModels(installation, {
          cwd,
          env,
          timeoutMs: 12000
        });
        if (!res || res.kind !== 'ok') {
          const out = {
            runtimeId,
            kind: res?.kind || 'error',
            models: [],
            detail: res?.detail || res?.reason || undefined
          };
          return out;
        }
        const models = (Array.isArray(res.models) ? res.models : []).map(m => ({
          id: m.id,
          resolvedId: m.resolvedId || undefined,
          displayName: m.displayName || m.id,
          default: Boolean(m.default),
          effortLevels: Array.isArray(m.effortLevels) ? [...m.effortLevels] : [],
          defaultEffort: m.defaultEffort || undefined,
          disabled: m.disabled || undefined,
          provider: m.provider || undefined
        }));
        const out = { runtimeId, kind: 'ok', models };
        const cacheEntry = { fetchedAt: Date.now(), data: out };
        modelListCache.set(cacheKey, cacheEntry);
        saveDiskModelCacheEntry(cacheKey, cacheEntry);
        return out;
      } catch (err) {
        return { runtimeId, kind: 'error', models: [], error: err.message };
      } finally {
        inFlightModelLists.delete(cacheKey);
      }
    })();

    inFlightModelLists.set(cacheKey, task);
    return task;
  }

  return {
    getOrCreateSession,
    getHistorySnapshot,
    sendMessage,
    setSessionModel,
    listRuntimeModels,
    abortSession,
    compactSession,
    clearSession,
    deleteSession,
    shutdownAll,
    listAvailableRuntimes
  };
}

module.exports = {
  createDeviceOarManager
};
