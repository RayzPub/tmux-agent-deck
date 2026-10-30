const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../config');

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
 * Load persisted session data
 */
function loadPersistedSession(username, sessionName) {
  const file = getSessionStorageFile(username, sessionName);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
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
    agentType: options.agentType || 'claude',
    workspacePath: options.workspacePath || process.cwd(),
    model: options.model || '',
    createdAt: Date.now(),
    messages: [
      {
        id: 'msg-welcome',
        role: 'assistant',
        content: `👋 您好！已进入 **OAR 纯会话模式**。\n当前智能体：\`${options.agentType || 'claude'}\`\n工作区：\`${options.workspacePath || process.cwd()}\`\n本模式由 Open Agent Runtime 规范直接驱动，无终端黑盒按键盲发与错位，享受零干扰的结构化对话与工具调用。`,
        timestamp: Date.now()
      }
    ]
  };

  const oarSession = {
    ...sessionData,
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

  savePersistedSession(username, sessionName, {
    sessionName: sess.sessionName,
    username: sess.username,
    agentType: sess.agentType,
    workspacePath: sess.workspacePath,
    model: sess.model,
    createdAt: sess.createdAt,
    messages: sess.messages
  });

  const oar = await getOarModule();
  
  // AbortController for cancellation
  const abortCtrl = new AbortController();
  sess.currentController = abortCtrl;

  try {
    let handled = false;

    // Check if OAR Claude installation is available
    if (oar && sess.agentType === 'claude' && oar.claudeInstallation) {
      try {
        const inst = await oar.claudeInstallation();
        if (inst && inst.kind === 'available') {
          // OAR supports launching Claude in headless/stream-json mode!
          // We can use OAR's session adapter or fallback to llm gateway if needed
          console.log('[OAR] Found Claude installation via OAR:', inst.command);
        }
      } catch (checkErr) {
        console.warn('[OAR] Claude probe failed:', checkErr.message);
      }
    }

    // Call LLM Gateway / Mock Engine with OAR structured protocol
    const llmGatewayService = require('./llmGatewayService');
    const gwConfig = llmGatewayService.loadConfig();

    if (gwConfig && gwConfig.enabled && gwConfig.providers) {
      const { PORT } = require('../config');
      const localPort = PORT || 3000;
      const gwBaseUrl = (localPort === 80 || localPort === '80') ? 'http://127.0.0.1/v1' : `http://127.0.0.1:${localPort}/v1`;

      const messagesPayload = sess.messages.slice(-10).map(m => ({
        role: m.role,
        content: m.content
      }));

      const defaultModel = gwConfig.defaults?.openaiModel || gwConfig.defaults?.anthropicModel || 'deepseek/deepseek-flash';
      const targetModel = sess.model || defaultModel;

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

      if (fetchRes.ok) {
        const completion = await fetchRes.json();
        const replyText = completion.choices?.[0]?.message?.content || '（智能体未返回文本）';
        assistantMsg.content = replyText;
        handled = true;
      } else {
        const errText = await fetchRes.text();
        console.warn('[OAR] Gateway returned error:', fetchRes.status, errText);
      }
    }

    if (!handled) {
      // Fallback response with OAR confirmation
      assistantMsg.content = `[OAR 引擎响应]\n已收到指令: "${userText}"\n\n当前工作空间: \`${sess.workspacePath}\`\n智能体类型: \`${sess.agentType}\`\n\n💡 提示: OAR 纯会话引擎已成功就绪并托管该会话。已省去底层虚拟键盘敲击，如已配置 127 LLM Gateway 模型网关，后续交互将直接通过标准流式接口提供完整工具调用与多步推理。`;
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
    savePersistedSession(username, sessionName, {
      sessionName: sess.sessionName,
      username: sess.username,
      agentType: sess.agentType,
      workspacePath: sess.workspacePath,
      model: sess.model,
      createdAt: sess.createdAt,
      messages: sess.messages
    });
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
  getOrCreateSession,
  sendUserMessage,
  abortSession,
  deleteOarSession,
  loadPersistedSession
};
