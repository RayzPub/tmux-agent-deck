const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { CONFIG_DIR, hasCommand, safeResolve, tmuxArgs } = require('./config');
const { resolveOptionalEsmUrl } = require('./depsManager');
const { readTmuxSessionMeta } = require('./tmuxHandlers');
const sessionRegistry = require('./sessionRegistry');

// Single source of truth: directly bundled by esbuild from services/agentChatService.js & client/oar-runtime.js
const agentChatService = require('../../services/agentChatService');
const { createDeviceOarManager } = require('../oar-runtime');

// Active agent child processes: sessionId -> childProcess
const runningTasks = new Map();

let deviceOarManager = null;
function getDeviceOarManager() {
  if (deviceOarManager) return deviceOarManager;
  try {
    deviceOarManager = createDeviceOarManager({
      storageDir: path.join(CONFIG_DIR, 'oar_sessions'),
      resolveEsmUrl: resolveOptionalEsmUrl
    });
    return deviceOarManager;
  } catch (err) {
    console.warn('⚠️ [ccnow-agent] Failed to initialize oar-runtime:', err.message);
    return null;
  }
}

async function handleClearContext(send, reqId, sessionName) {
  const oarMgr = getDeviceOarManager();
  if (oarMgr && sessionName) {
    try { await oarMgr.clearSession(sessionName); } catch (_) {}
  }
  const isPureChat = Boolean(sessionRegistry.getPureChatSession(sessionName));
  if (!isPureChat && hasCommand('tmux') && sessionName) {
    try {
      try { execFileSync('tmux', tmuxArgs(['set-option', '-u', '-t', sessionName, '@agent_session_id']), { stdio: 'ignore' }); } catch (_) {}
      execFileSync('tmux', tmuxArgs(['send-keys', '-t', sessionName, '/clear', 'C-m']), { stdio: 'ignore' });
    } catch (e) {}
  }
  if (reqId) {
    send({ action: 'agent:clear_context_result', reqId, success: true });
  }
}

async function handleOarRuntimes(send, reqId) {
  const oarMgr = getDeviceOarManager();
  if (!oarMgr) {
    return send({ action: 'oar:runtimes_result', reqId, runtimes: [], error: 'OAR runtime unavailable' });
  }
  try {
    const runtimes = await oarMgr.listAvailableRuntimes();
    send({ action: 'oar:runtimes_result', reqId, runtimes });
  } catch (err) {
    send({ action: 'oar:runtimes_result', reqId, runtimes: [], error: err.message });
  }
}

async function handleOarMessage(send, reqId, msg) {
  const { sessionName, content, images } = msg;
  const oarMgr = getDeviceOarManager();
  if (!oarMgr) {
    return send({ action: 'oar:message_result', reqId, accepted: false, error: '当前设备未加载 OAR 纯会话引擎' });
  }
  try {
    const meta = readTmuxSessionMeta(sessionName);
    const result = await oarMgr.sendMessage(sessionName, content || '', {
      agentType: meta.agentType,
      workspacePath: meta.workspacePath,
      model: meta.model,
      images: Array.isArray(images) ? images : []
    });
    send({ action: 'oar:message_result', reqId, ...result });
  } catch (err) {
    send({ action: 'oar:message_result', reqId, accepted: false, error: err.message });
  }
}

async function handleOarCompact(send, reqId, sessionName) {
  const oarMgr = getDeviceOarManager();
  if (!oarMgr) {
    return send({ action: 'oar:compact_result', reqId, supported: false, message: '当前设备未加载 OAR 引擎' });
  }
  try {
    const meta = readTmuxSessionMeta(sessionName);
    const result = await oarMgr.compactSession(sessionName, {
      agentType: meta.agentType,
      workspacePath: meta.workspacePath,
      model: meta.model
    });
    send({ action: 'oar:compact_result', reqId, ...result });
  } catch (err) {
    send({ action: 'oar:compact_result', reqId, supported: false, error: err.message });
  }
}

async function handleOarAbort(send, reqId, sessionName) {
  const oarMgr = getDeviceOarManager();
  if (!oarMgr) {
    return send({ action: 'oar:abort_result', reqId, aborted: false });
  }
  try {
    const aborted = await oarMgr.abortSession(sessionName);
    send({ action: 'oar:abort_result', reqId, aborted });
  } catch (err) {
    send({ action: 'oar:abort_result', reqId, aborted: false, error: err.message });
  }
}

async function handleChatHistory(send, reqId, sessionName) {
  try {
    // 0. Fast-path: tmux-free Pure Chat OAR session from ~/.ccnow/sessions.json
    const pureChat = sessionRegistry.getPureChatSession(sessionName);
    if (pureChat) {
      const oarMgr = getDeviceOarManager();
      if (oarMgr) {
        const snapshot = oarMgr.getHistorySnapshot(sessionName, {
          agentType: pureChat.agentType || 'claude',
          workspacePath: pureChat.workspacePath || process.cwd()
        });
        return send({ action: 'agent:chat_history_result', reqId, ...snapshot });
      }
    }

    const hasTmux = hasCommand('tmux');
    let sessionCwd = process.cwd();
    let agentType = '';
    let agentSessionId = null;
    let panePid = null;
    let sessionMode = 'hybrid';

    if (hasTmux && sessionName) {
      try {
        const fmt = '#{session_path}|#{@workspace_name}|#{@agent_type}|#{@agent_session_id}|#{pane_pid}|#{@session_mode}';
        const out = execFileSync('tmux', tmuxArgs(['display-message', '-p', '-t', sessionName, fmt]), {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        const parts = out.split('|');
        if (parts[0] && fs.existsSync(parts[0])) sessionCwd = parts[0];
        agentType = (parts[2] || '').trim();
        agentSessionId = (parts[3] && parts[3].trim()) ? parts[3].trim() : null;
        panePid = (parts[4] && parts[4].trim()) ? parts[4].trim() : null;
        const rawMode = (parts[5] && parts[5].trim()) ? parts[5].trim() : '';
        sessionMode = rawMode || (agentType === 'default' ? 'terminal_only' : 'hybrid');
      } catch (e) {}
    }

    // 1. Pure Chat Mode (Device-Side OAR Engine)
    if (sessionMode === 'chat_only') {
      const oarMgr = getDeviceOarManager();
      if (oarMgr) {
        const snapshot = oarMgr.getHistorySnapshot(sessionName, {
          agentType: agentType || 'claude',
          workspacePath: sessionCwd
        });
        return send({ action: 'agent:chat_history_result', reqId, ...snapshot });
      }
    }

    // 2. Unified Agent Chat Parser (bundled from services/agentChatService.js)
    const homeDir = os.homedir();
    const match = agentChatService.findAgentSessionFile(
      agentType || 'claude',
      sessionCwd,
      agentSessionId,
      panePid,
      homeDir,
      homeDir
    );
    if (match && match.filePath && fs.existsSync(match.filePath)) {
      const parsed = await agentChatService.parseAgentChat(agentType || 'claude', match.filePath, 50);
      return send({
        action: 'agent:chat_history_result',
        reqId,
        sessionName,
        agentType: agentType || 'claude',
        agentSessionId: match.sessionId || agentSessionId,
        sessionMode,
        supported: true,
        pendingAction: parsed.pendingAction || null,
        lastUpdated: parsed.lastUpdated || Date.now(),
        messages: parsed.messages || []
      });
    }

    return send({
      action: 'agent:chat_history_result',
      reqId,
      sessionName,
      agentType,
      agentSessionId: (match && match.sessionId) || agentSessionId,
      sessionMode,
      supported: true,
      pendingAction: null,
      lastUpdated: Date.now(),
      messages: []
    });
  } catch (e) {
    console.warn('⚠️ [ccnow-agent] Failed to parse chat history:', e.message);
    send({
      action: 'agent:chat_history_result',
      reqId,
      sessionName,
      sessionMode: 'hybrid',
      supported: true,
      lastUpdated: Date.now(),
      messages: []
    });
  }
}

function resolveSessionWorkspace(sessionName) {
  const pureChat = sessionRegistry.getPureChatSession(sessionName);
  if (pureChat && pureChat.workspacePath && fs.existsSync(pureChat.workspacePath)) {
    return pureChat.workspacePath;
  }
  if (hasCommand('tmux') && sessionName) {
    try {
      const out = execFileSync('tmux', tmuxArgs(['display-message', '-p', '-t', sessionName, '#{session_path}']), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch (_) {}
  }
  return os.homedir();
}

function handleChatUpload(send, reqId, msg) {
  try {
    const { sessionName, files } = msg;
    const targetWorkspace = resolveSessionWorkspace(sessionName);
    const uploadDir = path.join(targetWorkspace, '.deck', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const uploadedFiles = [];
    for (const f of (files || [])) {
      const cleanName = path.basename(f.originalName || 'upload').replace(/[\x00-\x1f\x80-\x9f]/g, '').trim() || 'upload';
      const ext = path.extname(cleanName);
      const base = path.basename(cleanName, ext);
      const uniqueName = `${base}_${Date.now()}${ext}`;
      const destPath = path.join(uploadDir, uniqueName);
      const buf = Buffer.from(f.bufferBase64, 'base64');
      fs.writeFileSync(destPath, buf);
      const isImg = (f.mimeType && f.mimeType.startsWith('image/')) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(uniqueName);
      uploadedFiles.push({
        name: uniqueName,
        originalName: cleanName,
        relativePath: `.deck/uploads/${uniqueName}`,
        absolutePath: destPath,
        size: buf.length,
        mimeType: f.mimeType || 'application/octet-stream',
        isImage: isImg
      });
    }
    send({ action: 'agent:chat_upload_result', reqId, success: true, files: uploadedFiles });
  } catch (e) {
    send({ action: 'agent:chat_upload_result', reqId, error: e.message });
  }
}

function handleChatAttachment(send, reqId, msg) {
  try {
    const { sessionName, filename } = msg || {};
    const cleanName = path.basename(String(filename || ''));
    if (!cleanName) {
      return send({ action: 'agent:chat_attachment_result', reqId, error: 'Invalid filename' });
    }
    const targetWorkspace = resolveSessionWorkspace(sessionName);
    const filePath = safeResolve(targetWorkspace, path.join('.deck', 'uploads', cleanName));
    if (!fs.existsSync(filePath)) {
      return send({ action: 'agent:chat_attachment_result', reqId, error: 'Attachment not found' });
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 15 * 1024 * 1024) {
      return send({ action: 'agent:chat_attachment_result', reqId, error: 'Attachment too large (>15MB)' });
    }
    const ext = path.extname(cleanName).toLowerCase();
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
      '.json': 'application/json', '.md': 'text/markdown; charset=utf-8'
    };
    const buf = fs.readFileSync(filePath);
    send({
      action: 'agent:chat_attachment_result',
      reqId,
      filename: cleanName,
      mimeType: mimeMap[ext] || 'application/octet-stream',
      bufferBase64: buf.toString('base64')
    });
  } catch (e) {
    send({ action: 'agent:chat_attachment_result', reqId, error: e.message });
  }
}

function executeAgentTask(send, msg) {
  const { sessionId, prompt, agentType, workDir } = msg;
  const targetDir = workDir && fs.existsSync(workDir) ? workDir : process.cwd();

  console.log(`🤖 [Agent Task] Session: ${sessionId} | Type: ${agentType || 'claude-code'}`);

  let cmd = 'claude';
  let args = ['--print', prompt];

  const hasClaude = hasCommand('claude');
  if (!hasClaude) {
    cmd = 'bash';
    args = ['-c', `echo "🤖 [ccnow-agent on ${os.hostname()}] Claude Code is not installed in PATH. (Install with: npm i -g @anthropic-ai/claude-code)\n\nRunning prompt as test command:"; echo "Prompt received: ${prompt.replace(/"/g, '\\"')}"`];
  }

  send({
    action: 'agent:stream',
    sessionId,
    delta: `[ccnow-agent on ${os.hostname()}] Executing task with ${hasClaude ? 'Claude Code' : 'Local Shell'}...\n`
  });

  let child;
  try {
    child = spawn(cmd, args, {
      cwd: targetDir,
      env: { ...process.env, FORCE_COLOR: '1' }
    });
  } catch (err) {
    send({ action: 'agent:error', sessionId, error: `Failed to spawn agent process: ${err.message}` });
    return;
  }

  runningTasks.set(sessionId, child);

  child.stdout.on('data', (data) => send({ action: 'agent:stream', sessionId, delta: data.toString() }));
  child.stderr.on('data', (data) => send({ action: 'agent:stream', sessionId, delta: data.toString() }));

  child.on('close', (code) => {
    runningTasks.delete(sessionId);
    send({ action: 'agent:done', sessionId, exitCode: code, status: code === 0 ? 'success' : 'failed' });
  });

  child.on('error', (err) => {
    runningTasks.delete(sessionId);
    send({ action: 'agent:error', sessionId, error: err.message });
  });
}

function interruptAgentTask(sessionId) {
  if (sessionId && runningTasks.has(sessionId)) {
    console.log(`🛑 Interrupting task for session ${sessionId}...`);
    const proc = runningTasks.get(sessionId);
    try { proc.kill('SIGINT'); } catch (e) {}
  }
}

module.exports = {
  getDeviceOarManager,
  handleClearContext,
  handleOarRuntimes,
  handleOarMessage,
  handleOarCompact,
  handleOarAbort,
  handleChatHistory,
  handleChatUpload,
  handleChatAttachment,
  executeAgentTask,
  interruptAgentTask
};
