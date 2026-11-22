const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

function readRegistry() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data;
      }
    }
  } catch (_) {}
  return {};
}

function writeRegistry(map) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const tmp = `${SESSIONS_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, SESSIONS_FILE);
    return true;
  } catch (err) {
    console.warn('⚠️ [sessionRegistry] Failed to persist sessions.json:', err.message);
    return false;
  }
}

function listPureChatSessions() {
  const reg = readRegistry();
  return Object.values(reg)
    .filter(s => s && s.name)
    .map(s => ({
      name: s.name,
      seqId: s.seqId || null,
      windows: 1,
      created: s.created || Date.now(),
      attached: false,
      path: s.workspacePath || '',
      workspaceName: s.workspaceName || '',
      agentType: s.agentType || 'claude',
      agentModel: s.agentModel || s.modelName || '',
      sessionMode: 'chat_only',
      agentSessionId: '',
      isRemote: true
    }));
}

function getPureChatSession(sessionName) {
  if (!sessionName) return null;
  const reg = readRegistry();
  return reg[sessionName] || null;
}

function upsertPureChatSession(sessionName, meta = {}) {
  if (!sessionName) return null;
  const reg = readRegistry();
  const prev = reg[sessionName] || {};
  const record = {
    name: sessionName,
    seqId: meta.seqId !== undefined ? meta.seqId : (prev.seqId || null),
    workspacePath: meta.workspacePath || prev.workspacePath || process.cwd(),
    workspaceName: meta.workspaceName !== undefined ? meta.workspaceName : (prev.workspaceName || ''),
    agentType: meta.agentType || prev.agentType || 'claude',
    agentModel: meta.agentModel !== undefined ? meta.agentModel : (prev.agentModel || ''),
    modelName: meta.modelName !== undefined ? meta.modelName : (prev.modelName || ''),
    sessionMode: 'chat_only',
    created: prev.created || meta.created || Date.now()
  };
  reg[sessionName] = record;
  writeRegistry(reg);
  return record;
}

function deletePureChatSession(sessionName) {
  if (!sessionName) return false;
  const reg = readRegistry();
  if (!Object.prototype.hasOwnProperty.call(reg, sessionName)) return false;
  delete reg[sessionName];
  writeRegistry(reg);
  return true;
}

module.exports = {
  SESSIONS_FILE,
  readRegistry,
  listPureChatSessions,
  getPureChatSession,
  upsertPureChatSession,
  deletePureChatSession
};
