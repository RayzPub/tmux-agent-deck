/**
 * Agent-Aware Slash Command Registry & Resolver
 * Adapts quick `/` commands and clear-context commands to each supported CLI agent:
 * Antigravity (agy), Claude Code (claude), Codex CLI (codex), Kimi Code (kimi), OAR, and Bash (default).
 */

import { state } from './state.js';

const AGENT_LABELS = {
  agy: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  kimi: 'Kimi Code',
  oar: 'OAR 会话',
  default: '终端 Bash'
};

const AGENT_CLEAR_COMMANDS = {
  agy: '/clear',
  claude: '/clear',
  codex: '/new',
  kimi: '/clear',
  oar: '/clear',
  default: 'clear'
};

const AGENT_SLASH_COMMANDS = {
  agy: [
    { cmd: '/clear', desc: '清空当前对话上下文并重置' },
    { cmd: '/compact', desc: '压缩上下文历史并释放空间' },
    { cmd: '/usage', desc: '查看模型额度与使用量 (/quota)' },
    { cmd: '/context', desc: '查看当前上下文窗口占用详情' },
    { cmd: '/model', desc: '切换默认推理模型' },
    { cmd: '/effort', desc: '设置或查看模型推理强度' },
    { cmd: '/plan', desc: '探索代码并起草分步实施计划' },
    { cmd: '/goal', desc: '启动长程自主深度执行直到完成' },
    { cmd: '/boost', desc: '高阶编码多智能体深度验证' },
    { cmd: '/grill-me', desc: '交互式问答对齐方案与决策' },
    { cmd: '/swarm', desc: '启动多智能体协作蜂群任务' },
    { cmd: '/teamwork', desc: '启动多智能体协作团队模式' },
    { cmd: '/browser', desc: '浏览器交互与网页调试测试' },
    { cmd: '/schedule', desc: '创建定时器或周期性计划任务' },
    { cmd: '/learn', desc: '将偏好与纠偏沉淀为持久化规则' },
    { cmd: '/diff', desc: '打开交互式代码变更 Diff 视图' },
    { cmd: '/resume', desc: '恢复或切换历史对话会话' },
    { cmd: '/rewind', desc: '回滚对话历史至之前的消息' },
    { cmd: '/fork', desc: '从当前对话分叉出平行新会话' },
    { cmd: '/credits', desc: '查看剩余 AI Credits 额度' },
    { cmd: '/permissions', desc: '查看与管理当前工具权限' },
    { cmd: '/mcp', desc: '查看与管理 MCP 服务器连接' },
    { cmd: '/agents', desc: '打开智能体与后台子代理面板' },
    { cmd: '/skills', desc: '浏览或重载已加载的 Skills' },
    { cmd: '/tasks', desc: '查看后台 Shell 任务与日志' },
    { cmd: '/config', desc: '打开交互式 CLI 配置编辑器' },
    { cmd: '/help', desc: '显示内置命令与快捷键帮助' }
  ],
  claude: [
    { cmd: '/clear', desc: '清空当前对话历史并重置上下文' },
    { cmd: '/compact', desc: '压缩对话历史以节省 Token' },
    { cmd: '/model', desc: '切换当前会话使用的模型' },
    { cmd: '/plan', desc: '进入只读方案规划模式' },
    { cmd: '/context', desc: '查看当前上下文窗口占用详情' },
    { cmd: '/cost', desc: '查看当前会话 Token 消耗与费用' },
    { cmd: '/status', desc: '查看会话、账户与配置状态' },
    { cmd: '/review', desc: '审查当前代码变更或 PR' },
    { cmd: '/memory', desc: '编辑 CLAUDE.md 项目记忆' },
    { cmd: '/init', desc: '为项目初始化生成 CLAUDE.md' },
    { cmd: '/resume', desc: '恢复历史会话记录' },
    { cmd: '/mcp', desc: '查看与管理 MCP 服务器连接' },
    { cmd: '/permissions', desc: '查看与管理当前工具权限' },
    { cmd: '/help', desc: '显示 Claude Code 帮助信息' }
  ],
  codex: [
    { cmd: '/new', desc: '开启全新对话并清空上下文' },
    { cmd: '/compact', desc: '总结压缩对话以释放上下文' },
    { cmd: '/model', desc: '选择模型与推理强度' },
    { cmd: '/review', desc: '对当前工作区变更执行代码审查' },
    { cmd: '/diff', desc: '查看当前 Git 变更差异' },
    { cmd: '/status', desc: '查看当前配置与 Token 用量' },
    { cmd: '/approvals', desc: '切换命令执行审批策略' },
    { cmd: '/init', desc: '生成项目 AGENTS.md 指导文件' },
    { cmd: '/mention', desc: '引用指定文件到上下文', fillOnly: true },
    { cmd: '/mcp', desc: '列出已配置的 MCP 工具' },
    { cmd: '/resume', desc: '恢复先前的交互会话' },
    { cmd: '/help', desc: '显示 Codex 帮助指令' }
  ],
  kimi: [
    { cmd: '/clear', desc: '清空当前对话上下文' },
    { cmd: '/compact', desc: '压缩历史上下文以节省 Token' },
    { cmd: '/reset', desc: '重置当前会话状态' },
    { cmd: '/model', desc: '切换模型配置' },
    { cmd: '/yolo', desc: '切换自动审批 (YOLO) 模式' },
    { cmd: '/init', desc: '分析项目并生成 AGENTS.md' },
    { cmd: '/setup', desc: '配置 API Key 与服务接入' },
    { cmd: '/status', desc: '查看当前会话与连接状态' },
    { cmd: '/help', desc: '显示 Kimi CLI 帮助信息' }
  ],
  oar: [
    { cmd: '/clear', desc: '清空当前 OAR 会话上下文并重置' },
    { cmd: '/compact', desc: '使用 OAR 原生压缩上下文，释放窗口空间' }
  ],
  default: [
    { cmd: 'clear', desc: '清空当前终端屏幕' },
    { cmd: 'git status', desc: '查看 Git 仓库变更状态' },
    { cmd: 'git diff', desc: '查看当前代码差异' },
    { cmd: 'git log -n 10 --oneline', desc: '查看最近 10 条提交记录' },
    { cmd: 'ls -la', desc: '列出当前目录详细文件' },
    { cmd: 'pwd', desc: '显示当前工作目录路径' },
    { cmd: 'exit', desc: '退出当前终端会话' }
  ]
};

/**
 * Normalize raw agentType string into one of:
 * 'agy' | 'claude' | 'codex' | 'kimi' | 'oar' | 'default'
 */
export function normalizeAgentType(rawType, sessionName = '') {
  const t = String(rawType || '').trim().toLowerCase();
  if (t === 'agy' || t === 'antigravity') return 'agy';
  if (t === 'claude' || t === 'claude-code' || t === 'claudecode') return 'claude';
  if (t === 'codex' || t === 'codex-cli') return 'codex';
  if (t === 'kimi' || t === 'kimi-code' || t === 'kimi-cli') return 'kimi';
  if (t === 'oar') return 'oar';
  if (t === 'default' || t === 'bash' || t === 'shell' || t === 'terminal') return 'default';

  // Fallback heuristic from session name when agentType metadata is absent
  const nameLower = String(sessionName || '').trim().toLowerCase();
  if (nameLower) {
    if (nameLower.includes('agy') || nameLower.includes('antigravity')) return 'agy';
    if (nameLower.includes('claude')) return 'claude';
    if (nameLower.includes('codex')) return 'codex';
    if (nameLower.includes('kimi')) return 'kimi';
  }
  return 'default';
}

/**
 * Resolve normalized agent type for a given session name
 * @param {string} sessionName
 * @param {string} [hintAgentType] Optional agentType hint from chat history / API response
 */
export function resolveSessionAgentType(sessionName, hintAgentType = '') {
  const sessName = sessionName || state.currentSession || '';
  const hintLower = String(hintAgentType || '').trim().toLowerCase();
  if (hintLower && hintLower !== 'terminal' && hintLower !== 'default') {
    return normalizeAgentType(hintLower, sessName);
  }

  if (sessName && Array.isArray(state.sessionListCache)) {
    const sessObj = state.sessionListCache.find(s => s.name === sessName);
    if (sessObj && sessObj.agentType) {
      return normalizeAgentType(sessObj.agentType, sessName);
    }
  }

  return normalizeAgentType(hintLower, sessName);
}

export function getAgentDisplayName(agentType) {
  const key = normalizeAgentType(agentType);
  return AGENT_LABELS[key] || AGENT_LABELS.default;
}

export function getAgentClearCommand(agentType) {
  const key = normalizeAgentType(agentType);
  return AGENT_CLEAR_COMMANDS[key] || '/clear';
}

export function isClearCommandForAgent(text, agentType) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  const key = normalizeAgentType(agentType);
  if (key === 'codex') {
    return normalized === '/new';
  }
  return normalized === '/clear' || normalized === 'clear';
}

export function getSlashCommandsForAgent(agentType) {
  const key = normalizeAgentType(agentType);
  return AGENT_SLASH_COMMANDS[key] || AGENT_SLASH_COMMANDS.default;
}

/**
 * Filter commands for the given agent based on query text (e.g. '/', '/co', 'git')
 */
export function filterSlashCommands(agentType, queryText = '/') {
  const list = getSlashCommandsForAgent(agentType);
  const raw = String(queryText || '').trim().toLowerCase();
  if (!raw || raw === '/') {
    return [...list];
  }

  const withoutSlash = raw.replace(/^\/+/, '');
  return list.filter(item => {
    const cmdLower = item.cmd.toLowerCase();
    if (cmdLower.startsWith(raw)) return true;
    // Also match shell commands (no leading slash) when user types `/clear` or `/git`
    if (!cmdLower.startsWith('/') && withoutSlash && cmdLower.startsWith(withoutSlash)) {
      return true;
    }
    return false;
  });
}
