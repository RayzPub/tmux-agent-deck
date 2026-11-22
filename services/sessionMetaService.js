const { getDb, withTransaction } = require('./sqliteService');
const llmGatewayService = require('./llmGatewayService');

// Prevent concurrent duplicate LLM summarization calls for the same session
const inFlightSummaries = new Set();

const AGENT_DISPLAY_LABELS = {
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  claude: 'Claude',
  'claude-code': 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  default: 'Shell',
  terminal: 'Shell'
};

/**
 * Allocate a strictly monotonically increasing unique session sequence ID (1, 2, 3, ...).
 * Backed by SQLite AUTOINCREMENT (`sqlite_sequence`), so deleted rows never cause ID reuse.
 */
function allocateNextSessionSeq() {
  return withTransaction((db) => {
    const info = db.prepare('INSERT INTO session_seq DEFAULT VALUES').run();
    const seqId = Number(info.lastInsertRowid);
    // Keep session_seq table tiny while sqlite_sequence preserves the monotonic high-water mark
    if (seqId > 20) {
      db.prepare('DELETE FROM session_seq WHERE id < ?').run(seqId - 5);
    }
    return seqId;
  });
}

/**
 * Build a collision-free, tmux-safe and OAR-safe technical session ID using the monotonic seqId.
 * Always matches ^[a-zA-Z0-9_-]+$.
 */
function buildAutoSessionId({ agentType = 'agy', sessionMode = 'hybrid', seqId = 1, customPrefix = '' } = {}) {
  const cleanCustom = String(customPrefix || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 16);

  const normAgent = String(agentType || 'default').trim().toLowerCase();
  const agentSlug = (normAgent === 'default' || normAgent === 'terminal' || !normAgent)
    ? 'shell'
    : normAgent.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'agent';

  const idNum = Math.max(1, Number(seqId) || 1);
  if (cleanCustom) {
    return `${cleanCustom}-${idNum}`;
  }
  if (sessionMode === 'chat_only') {
    return `oar-${agentSlug}-${idNum}`;
  }
  return `${agentSlug}-${idNum}`;
}

/**
 * Build a friendly default display title before first-message auto-summary arrives.
 */
function buildDefaultDisplayTitle({ agentType = '', sessionMode = 'hybrid', seqId = 0, sessionName = '' } = {}) {
  const norm = String(agentType || '').trim().toLowerCase();
  const label = AGENT_DISPLAY_LABELS[norm] || (sessionMode === 'chat_only' ? 'OAR 会话' : '新会话');
  if (seqId && Number(seqId) > 0) {
    return `${label} #${Number(seqId)}`;
  }
  return sessionName || label;
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    seqId: Number(row.seq_id) || 0,
    deviceId: row.device_id,
    sessionName: row.session_name,
    username: row.username || 'admin',
    title: row.title || '',
    autoTitle: Boolean(row.auto_title),
    titleSource: row.title_source || 'auto_pending',
    agentType: row.agent_type || '',
    sessionMode: row.session_mode || 'hybrid',
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function getDisplayTitleForSession(sessionName, meta, fallback = {}) {
  if (meta && meta.title && meta.title.trim()) {
    return meta.title.trim();
  }
  if (meta && meta.seqId > 0) {
    return buildDefaultDisplayTitle({
      agentType: meta.agentType || fallback.agentType,
      sessionMode: meta.sessionMode || fallback.sessionMode,
      seqId: meta.seqId,
      sessionName
    });
  }
  return sessionName;
}

function getSessionMeta(deviceId, sessionName) {
  if (!deviceId || !sessionName) return null;
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM session_meta WHERE device_id = ? AND session_name = ?')
      .get(String(deviceId), String(sessionName));
    return rowToMeta(row);
  } catch (err) {
    console.warn('[SessionMeta] getSessionMeta failed:', err.message);
    return null;
  }
}

function getDeviceSessionMetaMap(deviceId) {
  const map = new Map();
  if (!deviceId) return map;
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM session_meta WHERE device_id = ?')
      .all(String(deviceId));
    for (const row of rows) {
      const meta = rowToMeta(row);
      if (meta) map.set(meta.sessionName, meta);
    }
  } catch (err) {
    console.warn('[SessionMeta] getDeviceSessionMetaMap failed:', err.message);
  }
  return map;
}

function upsertSessionMeta(deviceId, sessionName, patch = {}) {
  if (!deviceId || !sessionName) return null;
  const now = Date.now();
  const existing = getSessionMeta(deviceId, sessionName);

  const next = {
    seqId: patch.seqId !== undefined ? Number(patch.seqId) || 0 : (existing?.seqId || 0),
    deviceId: String(deviceId),
    sessionName: String(sessionName),
    username: patch.username || existing?.username || 'admin',
    title: patch.title !== undefined ? String(patch.title).trim().slice(0, 60) : (existing?.title || ''),
    autoTitle: patch.autoTitle !== undefined ? Boolean(patch.autoTitle) : (existing ? existing.autoTitle : true),
    titleSource: patch.titleSource || existing?.titleSource || 'auto_pending',
    agentType: patch.agentType !== undefined ? String(patch.agentType) : (existing?.agentType || ''),
    sessionMode: patch.sessionMode !== undefined ? String(patch.sessionMode) : (existing?.sessionMode || 'hybrid'),
    createdAt: existing?.createdAt || patch.createdAt || now,
    updatedAt: now
  };

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO session_meta (
        seq_id, device_id, session_name, username, title, auto_title,
        title_source, agent_type, session_mode, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, session_name) DO UPDATE SET
        seq_id = CASE WHEN excluded.seq_id > 0 THEN excluded.seq_id ELSE session_meta.seq_id END,
        username = excluded.username,
        title = excluded.title,
        auto_title = excluded.auto_title,
        title_source = excluded.title_source,
        agent_type = CASE WHEN excluded.agent_type != '' THEN excluded.agent_type ELSE session_meta.agent_type END,
        session_mode = CASE WHEN excluded.session_mode != '' THEN excluded.session_mode ELSE session_meta.session_mode END,
        updated_at = excluded.updated_at
    `).run(
      next.seqId,
      next.deviceId,
      next.sessionName,
      next.username,
      next.title,
      next.autoTitle ? 1 : 0,
      next.titleSource,
      next.agentType,
      next.sessionMode,
      next.createdAt,
      next.updatedAt
    );
    return next;
  } catch (err) {
    console.warn('[SessionMeta] upsertSessionMeta failed:', err.message);
    return next;
  }
}

function updateSessionTitle(deviceId, sessionName, rawTitle, opts = {}) {
  const cleaned = String(rawTitle || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
  if (!cleaned) {
    return upsertSessionMeta(deviceId, sessionName, {
      title: '',
      autoTitle: opts.autoTitle !== undefined ? Boolean(opts.autoTitle) : true,
      titleSource: 'auto_pending',
      username: opts.username
    });
  }
  return upsertSessionMeta(deviceId, sessionName, {
    title: cleaned,
    autoTitle: Boolean(opts.autoTitle),
    titleSource: opts.source || 'manual',
    username: opts.username
  });
}

function deleteSessionMeta(deviceId, sessionName) {
  if (!deviceId || !sessionName) return false;
  try {
    const db = getDb();
    db.prepare('DELETE FROM session_meta WHERE device_id = ? AND session_name = ?')
      .run(String(deviceId), String(sessionName));
    return true;
  } catch (err) {
    console.warn('[SessionMeta] deleteSessionMeta failed:', err.message);
    return false;
  }
}

/**
 * Clean & heuristically summarize a user's first prompt into a concise session title.
 * Zero latency, works offline and without LLM keys.
 */
function summarizePromptHeuristically(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText;

  // Strip appended attachment block injected by chatMode.js
  text = text.replace(/\n*\[附带文件\]:[\s\S]*$/i, '');
  // Strip XML wrapper tags if any
  text = text.replace(/<\/?[A-Z_]+>/g, ' ');
  // Strip fenced code blocks (keep brief marker if text becomes empty)
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').trim();
  text = withoutCode || text.replace(/```/g, ' ');
  // Strip inline markdown formatting
  text = text.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/#+\s*/g, '');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) return '';
  // Skip pure slash commands or attachment-only placeholders
  if (/^\/[a-z0-9_-]+$/i.test(text)) return '';
  if (text === '[图片附件]' || text === '请查看附带的文件/图片并进行分析：') return '';

  // Remove common conversational filler prefixes
  text = text
    .replace(/^【任务】\s*/, '')
    .replace(/^(?:你好[，,！!\s]*|嗨[，,！!\s]*|hi[,\s!]+|hello[,\s!]+)/i, '')
    .replace(/^(?:请(?:你)?帮我|帮我|麻烦(?:你)?|请问(?:一下)?|可以帮我|能不能帮我|我想要?|我想让你)\s*/, '')
    .replace(/^(?:please\s+|can you\s+|could you\s+|help me\s+)/i, '')
    .trim();

  if (!text) return '';

  // Take the first meaningful clause if very long
  const firstClause = text.split(/[。！？!?\n]/)[0].trim();
  const candidate = firstClause.length >= 4 ? firstClause : text;

  // Measure visual width (CJK ~2, ASCII ~1) to cap nicely at ~32 display columns (~16 Chinese chars)
  let width = 0;
  let cutIdx = candidate.length;
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    const charWidth = code > 0x2e7f ? 2 : 1;
    if (width + charWidth > 32) {
      cutIdx = i;
      break;
    }
    width += charWidth;
  }

  let result = candidate.slice(0, cutIdx).trim();
  // Avoid cutting mid-ASCII-word if possible
  if (cutIdx < candidate.length && /[a-zA-Z0-9]$/.test(result) && /^[a-zA-Z0-9]/.test(candidate[cutIdx])) {
    const lastSpace = result.lastIndexOf(' ');
    if (lastSpace > 8) {
      result = result.slice(0, lastSpace).trim();
    }
  }
  result = result.replace(/[，,、；;：:\-–—]+$/, '').trim();
  if (cutIdx < candidate.length && result.length > 0) {
    result += '…';
  }
  return result;
}

/**
 * Clean LLM-generated title text.
 */
function sanitizeGeneratedTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let line = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean) || '';
  line = line
    .replace(/^(?:标题|会话标题|Title)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’「」『』《》\[\]]+|["'“”‘’「」『』《》\[\]]+$/g, '')
    .replace(/[。！？.!?]+$/, '')
    .trim();
  if (!line || line.length > 40) {
    line = line.slice(0, 32).trim();
  }
  return line;
}

/**
 * Optional non-blocking LLM title refinement via configured LLM Gateway providers.
 * Returns null gracefully if gateway is disabled, unconfigured, or times out.
 */
async function summarizePromptWithLlm(rawText) {
  try {
    const config = llmGatewayService.loadConfig();
    if (!config || !config.enabled) return null;

    const snippet = String(rawText || '')
      .replace(/\n*\[附带文件\]:[\s\S]*$/i, '')
      .trim()
      .slice(0, 400);
    if (!snippet) return null;

    const systemPrompt = '你是会话标题生成器。请将用户的首条消息提炼为一个简洁精准的会话标题（中文不超过14字，英文不超过6词）。只输出标题文本本身，不要引号、编号、标点或任何解释。';

    // Prefer OpenAI-compatible default provider, fall back to Anthropic
    const candidates = [
      { protocol: 'openai', providerId: config.defaults?.openai, model: config.defaults?.openaiModel },
      { protocol: 'anthropic', providerId: config.defaults?.anthropic, model: config.defaults?.anthropicModel }
    ];

    for (const c of candidates) {
      if (!c.providerId) continue;
      const prov = config.providers?.[c.providerId];
      if (!prov || !prov.enabled) continue;
      const key = llmGatewayService.getNextKey(c.providerId, config);
      if (!key) continue;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        if (c.protocol === 'openai') {
          const baseUrl = (prov.endpoints?.openai || prov.baseUrl || '').replace(/\/+$/, '');
          if (!baseUrl) continue;
          const model = c.model || prov.models?.openai?.find(m => m && !m.includes('*')) || 'glm-5.3-flash';
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model,
              max_tokens: 48,
              temperature: 0.2,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: snippet }
              ]
            }),
            signal: controller.signal
          });
          if (!res.ok) continue;
          const json = await res.json();
          const content = json?.choices?.[0]?.message?.content || '';
          const cleaned = sanitizeGeneratedTitle(content);
          if (cleaned) return cleaned;
        } else {
          const baseUrl = (prov.endpoints?.anthropic || prov.baseUrl || '').replace(/\/+$/, '');
          if (!baseUrl) continue;
          const model = c.model || prov.models?.anthropic?.find(m => m && !m.includes('*')) || 'glm-5.3-flash';
          const res = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model,
              max_tokens: 48,
              temperature: 0.2,
              system: systemPrompt,
              messages: [{ role: 'user', content: snippet }]
            }),
            signal: controller.signal
          });
          if (!res.ok) continue;
          const json = await res.json();
          const textPart = Array.isArray(json?.content)
            ? json.content.find(p => p && p.type === 'text' && p.text)
            : null;
          const cleaned = sanitizeGeneratedTitle(textPart?.text || '');
          if (cleaned) return cleaned;
        }
      } catch (_) {
        // Ignore network/timeout errors and try next candidate
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Trigger automatic title summarization from a session's first meaningful user prompt.
 * Applies instant heuristic summary immediately and asynchronously refines via LLM if available.
 */
function maybeAutoSummarizeTitle(deviceId, sessionName, rawPromptText) {
  if (!deviceId || !sessionName || !rawPromptText) return null;
  const meta = getSessionMeta(deviceId, sessionName);
  if (!meta || !meta.autoTitle || meta.titleSource !== 'auto_pending') {
    return null;
  }

  const heuristicTitle = summarizePromptHeuristically(rawPromptText);
  if (!heuristicTitle) return null;

  const updated = upsertSessionMeta(deviceId, sessionName, {
    title: heuristicTitle,
    autoTitle: true,
    titleSource: 'auto_heuristic'
  });

  const lockKey = `${deviceId}::${sessionName}`;
  if (!inFlightSummaries.has(lockKey)) {
    inFlightSummaries.add(lockKey);
    summarizePromptWithLlm(rawPromptText)
      .then((llmTitle) => {
        if (!llmTitle) return;
        const latest = getSessionMeta(deviceId, sessionName);
        // Only apply LLM refinement if the user did not manually rename in the meantime
        if (latest && latest.autoTitle && latest.titleSource === 'auto_heuristic') {
          upsertSessionMeta(deviceId, sessionName, {
            title: llmTitle,
            autoTitle: true,
            titleSource: 'auto_llm'
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlightSummaries.delete(lockKey);
      });
  }

  return updated;
}

module.exports = {
  allocateNextSessionSeq,
  buildAutoSessionId,
  buildDefaultDisplayTitle,
  getDisplayTitleForSession,
  getSessionMeta,
  getDeviceSessionMetaMap,
  upsertSessionMeta,
  updateSessionTitle,
  deleteSessionMeta,
  summarizePromptHeuristically,
  summarizePromptWithLlm,
  maybeAutoSummarizeTitle
};
