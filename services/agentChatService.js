const fs = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * Convert an absolute workspace path into a Claude Code project slug.
 * Example: /home/ubuntu/tmux-agent-deck -> -home-ubuntu-tmux-agent-deck
 */
function getProjectSlug(workspacePath) {
  if (!workspacePath) return '';
  const normalized = path.resolve(workspacePath).replace(/\/+$/, '');
  return normalized.replace(/\//g, '-');
}

/**
 * Locate candidate Claude projects directories
 */
function getClaudeProjectsDirs(userHomeDir, sysHomeDir) {
  const dirs = [];
  if (userHomeDir) {
    dirs.push(path.join(userHomeDir, '.claude', 'projects'));
  }
  if (sysHomeDir && sysHomeDir !== userHomeDir) {
    dirs.push(path.join(sysHomeDir, '.claude', 'projects'));
  }
  // Default system fallback
  const defaultHome = process.env.HOME || '/home/ubuntu';
  const defPath = path.join(defaultHome, '.claude', 'projects');
  if (!dirs.includes(defPath)) {
    dirs.push(defPath);
  }
  return dirs;
}

/**
 * Extract --session-id from process cmdline under a tmux pane PID
 */
function getSessionIdFromPanePid(panePid) {
  if (!panePid) return null;
  try {
    const pids = fs.readdirSync('/proc').filter(f => /^\d+$/.test(f));
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const parts = stat.split(' ');
        const ppid = parts[3];
        if (ppid === String(panePid)) {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          const match = cmdline.match(/--session-id[ \x00]+([a-f0-9-]+)/i);
          if (match && match[1]) {
            return match[1];
          }
        }
      } catch (e) {}
    }
  } catch (err) {}
  return null;
}

/**
 * Find the matching JSONL file strictly for a specific session ID
 * Note: Never fallback to random/latest files to avoid cross-terminal contamination.
 */
function findClaudeSessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir) {
  const slug = getProjectSlug(workspacePath);
  if (!slug) return null;

  // Determine target session ID: either passed explicitly or detected from pane process
  const targetSessionId = explicitSessionId || getSessionIdFromPanePid(panePid);
  if (!targetSessionId) {
    // If no session ID is associated with this terminal, do NOT guess or borrow another session's file
    return null;
  }

  const projectDirs = getClaudeProjectsDirs(userHomeDir, sysHomeDir);

  for (const baseDir of projectDirs) {
    const projectPath = path.join(baseDir, slug);
    if (!fs.existsSync(projectPath)) continue;

    const targetFile = path.join(projectPath, `${targetSessionId}.jsonl`);
    if (fs.existsSync(targetFile)) {
      return {
        filePath: targetFile,
        sessionId: targetSessionId,
        projectPath
      };
    }
  }

  return {
    filePath: null,
    sessionId: targetSessionId,
    projectPath: null
  };
}

/**
 * Extract clean user text from string, array of text/tool_result, or object
 */
function extractUserText(rawContent, event) {
  if (!rawContent) return '';
  if (typeof rawContent === 'string') {
    if (rawContent.includes('<local-command-caveat>')) return '';
    if (rawContent.includes('<command-name>')) {
      const match = rawContent.match(/<command-message>(.*?)<\/command-message>/s) ||
                    rawContent.match(/<command-name>(.*?)<\/command-name>/s);
      if (match && match[1]) {
        const cmd = match[1].trim();
        if (cmd === 'clear' || cmd === '/clear') return '';
        return cmd;
      }
    }
    return rawContent.trim();
  }

  if (Array.isArray(rawContent)) {
    const textPieces = [];
    for (const item of rawContent) {
      if (typeof item === 'string') {
        const cleaned = extractUserText(item, event);
        if (cleaned) textPieces.push(cleaned);
      } else if (item && typeof item === 'object') {
        if (item.type === 'text' && item.text) {
          const cleaned = extractUserText(item.text, event);
          if (cleaned) textPieces.push(cleaned);
        } else if (item.type === 'tool_result') {
          // Format user answers to AskUserQuestion
          if (event && event.toolUseResult && event.toolUseResult.answers) {
            const ansList = Object.entries(event.toolUseResult.answers)
              .map(([q, a]) => `**${q}**\n↳ ${a}`)
              .join('\n\n');
            textPieces.push(`📋 **已回答智能体提问：**\n\n${ansList}`);
          } else if (typeof item.content === 'string' && item.content.startsWith('Your questions have been answered:')) {
            const cleanContent = item.content.replace(/^Your questions have been answered:\s*/, '').replace(/\.\s*You can now continue with these answers in mind\./, '');
            textPieces.push(`📋 **已回答智能体提问：**\n\n${cleanContent}`);
          } else if ((event && event.toolDenialKind === 'user-rejected') || (typeof item.content === 'string' && item.content.includes("user doesn't want to proceed"))) {
            textPieces.push(`🛑 **已拒绝此工具执行操作**`);
          }
        }
      }
    }
    return textPieces.join('\n\n').trim();
  }

  if (typeof rawContent === 'object') {
    if (rawContent.type === 'text' && rawContent.text) {
      return extractUserText(rawContent.text, event);
    }
    if (rawContent.text && typeof rawContent.text === 'string') {
      return extractUserText(rawContent.text, event);
    }
  }

  return '';
}

/**
 * Parse a Claude Code .jsonl file into structured chat messages
 */
async function parseClaudeJsonl(filePath, maxMessages = 50) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { messages: [], lastUpdated: null };
  }

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const parsedEvents = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      parsedEvents.push(item);
    } catch (err) {}
  }

  const messages = [];
  const toolUses = new Map(); // tool_use_id -> toolInfo
  const toolResults = new Set(); // tool_use_id

  for (const event of parsedEvents) {
    // Check if event is a /clear command, which resets conversation history
    if (event.commandRun && (event.commandRun.command === 'clear' || event.commandRun.command === '/clear')) {
      messages.length = 0;
      toolUses.clear();
      toolResults.clear();
      continue;
    }
    if (event.type === 'user' && event.message && typeof event.message.content === 'string' && event.message.content.includes('<command-name>/clear')) {
      messages.length = 0;
      toolUses.clear();
      toolResults.clear();
      continue;
    }

    // User message
    if (event.type === 'user' && event.message && event.message.content) {
      if (event.isMeta) continue;

      if (Array.isArray(event.message.content)) {
        for (const item of event.message.content) {
          if (item && item.type === 'tool_result' && item.tool_use_id) {
            toolResults.add(item.tool_use_id);
          }
        }
      }
      
      const cleanText = extractUserText(event.message.content, event);
      if (!cleanText) continue; // Ignore empty or internal-only messages

      messages.push({
        id: event.uuid || `user-${messages.length}`,
        role: 'user',
        timestamp: event.timestamp || new Date().toISOString(),
        content: cleanText
      });
    }

    // Assistant message
    if (event.type === 'assistant' && event.message && event.message.content) {
      const contentList = Array.isArray(event.message.content) 
        ? event.message.content 
        : [{ type: 'text', text: String(event.message.content) }];

      let textParts = [];
      let thinkingParts = [];
      let tools = [];

      for (const part of contentList) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text);
        } else if (part.type === 'thinking' && part.thinking) {
          thinkingParts.push(part.thinking);
        } else if (part.type === 'tool_use') {
          const isAskQ = part.name === 'AskUserQuestion';
          const tInfo = {
            id: part.id,
            name: part.name || 'tool',
            input: part.input || {},
            isAskQuestion: isAskQ,
            questions: (isAskQ && part.input && part.input.questions) ? part.input.questions : []
          };
          tools.push(tInfo);
          if (part.id) {
            toolUses.set(part.id, tInfo);
          }
        }
      }

      // If AskUserQuestion without accompanying text, provide friendly title and options
      const askTool = tools.find(t => t.isAskQuestion);
      if (askTool && textParts.length === 0 && askTool.questions && askTool.questions.length > 0) {
        const qSummary = askTool.questions.map((q, idx) => {
          const opts = (q.options || []).map((o, oIdx) => `   - **${oIdx + 1}. ${o.label}**${o.description ? `：${o.description}` : ''}`).join('\n');
          return `${idx + 1}. **${q.question}**\n${opts}`;
        }).join('\n\n');
        textParts.push(`❓ **智能体发起提问：**\n\n${qSummary}`);
      }

      const combinedText = textParts.join('\n\n').trim();
      const combinedThinking = thinkingParts.join('\n\n').trim();

      if (combinedText || combinedThinking || tools.length > 0) {
        messages.push({
          id: event.uuid || `assistant-${messages.length}`,
          role: 'assistant',
          timestamp: event.timestamp || new Date().toISOString(),
          content: combinedText,
          thinking: combinedThinking,
          tools: tools
        });
      }
    }
  }

  // Detect pending interactive decision on the latest assistant message
  let pendingAction = null;

  // 1. Check if the latest assistant message has unresolved tool calls (AskUserQuestion or Tool Permission)
  if (parsedEvents.length > 0) {
    let lastAssistantEvent = null;
    let lastAssistantIdx = -1;
    for (let i = parsedEvents.length - 1; i >= 0; i--) {
      if (parsedEvents[i].type === 'assistant') {
        lastAssistantEvent = parsedEvents[i];
        lastAssistantIdx = i;
        break;
      }
    }

    const hasSubsequentUserMessage = parsedEvents.slice(lastAssistantIdx + 1).some(e => e.type === 'user' && !e.isMeta);

    if (lastAssistantEvent && lastAssistantEvent.message && !hasSubsequentUserMessage) {
      const contentList = Array.isArray(lastAssistantEvent.message.content)
        ? lastAssistantEvent.message.content
        : [];

      for (const part of contentList) {
        if (part.type === 'tool_use' && part.id && !toolResults.has(part.id)) {
          if (part.name === 'AskUserQuestion') {
            pendingAction = {
              type: 'ask_question',
              toolUseId: part.id,
              questions: part.input?.questions || [],
              hint: '智能体提出问题，请在下方选择回答'
            };
            break;
          } else {
            pendingAction = {
              type: 'permission',
              toolUseId: part.id,
              toolName: part.name || 'tool',
              toolInput: part.input || {},
              hint: `智能体请求权限执行: ${part.name || '工具'}`
            };
            break;
          }
        }
      }
    }
  }

  // 2. Fallback check on latest message text content for (y/n) prompts
  if (!pendingAction && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'assistant' && lastMsg.content) {
      const contentLower = lastMsg.content.toLowerCase();
      if (
        contentLower.includes('(y/n)') || 
        contentLower.includes('[y/n]') || 
        contentLower.includes('proceed?') ||
        contentLower.includes('continue?') ||
        contentLower.includes('are you sure')
      ) {
        pendingAction = {
          type: 'yn',
          hint: '等待确认操作'
        };
      }
    }
  }

  const trimmedMessages = messages.slice(-maxMessages);

  let mtime = null;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch (e) {}

  return {
    messages: trimmedMessages,
    pendingAction,
    lastUpdated: mtime
  };
}

/**
 * Locate candidate Antigravity CLI directories
 */
function getAntigravityDirs(userHomeDir, sysHomeDir) {
  const dirs = [];
  if (userHomeDir) {
    dirs.push(path.join(userHomeDir, '.gemini', 'antigravity-cli'));
  }
  if (sysHomeDir && sysHomeDir !== userHomeDir) {
    dirs.push(path.join(sysHomeDir, '.gemini', 'antigravity-cli'));
  }
  const defaultHome = process.env.HOME || '/home/ubuntu';
  const defPath = path.join(defaultHome, '.gemini', 'antigravity-cli');
  if (!dirs.includes(defPath)) {
    dirs.push(defPath);
  }
  const adminUserData = '/home/ubuntu/tmux-agent-deck/user_data/admin/home/.gemini/antigravity-cli';
  if (!dirs.includes(adminUserData) && fs.existsSync(adminUserData)) {
    dirs.push(adminUserData);
  }
  return dirs;
}

/**
 * Extract conversation ID from process cmdline or open file descriptors under a tmux pane PID
 */
function getAgySessionIdFromPanePid(panePid) {
  if (!panePid) return null;
  try {
    const pids = fs.readdirSync('/proc').filter(f => /^\d+$/.test(f));
    const parentMap = new Map();
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const lastParen = stat.lastIndexOf(')');
        if (lastParen === -1) continue;
        const rest = stat.substring(lastParen + 2).split(' ');
        const ppid = rest[1];
        parentMap.set(pid, ppid);
      } catch (e) {}
    }

    // Recursively collect all descendant processes of panePid
    const targetPids = new Set();
    const queue = [String(panePid)];
    while (queue.length > 0) {
      const currentParent = queue.shift();
      for (const [pid, ppid] of parentMap.entries()) {
        if (ppid === currentParent && !targetPids.has(pid)) {
          targetPids.add(pid);
          queue.push(pid);
        }
      }
    }

    // Check if any process has --conversation in cmdline
    for (const pid of targetPids) {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        const match = cmdline.match(/--conversation[ \x00=]+([a-f0-9-]{36})/i);
        if (match && match[1]) {
          return match[1];
        }
      } catch (e) {}
    }

    // Check open file descriptors in /proc/<pid>/fd:
    // Priority 1: Check presence/<id>.lock (The authoritative active conversation lock in Antigravity)
    for (const pid of targetPids) {
      try {
        const fdDir = `/proc/${pid}/fd`;
        if (!fs.existsSync(fdDir)) continue;
        const fds = fs.readdirSync(fdDir);
        for (const fd of fds) {
          try {
            const link = fs.readlinkSync(path.join(fdDir, fd));
            const match = link.match(/presence\/([a-f0-9-]{36})\.lock$/i);
            if (match && match[1]) {
              return match[1];
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // Priority 2: Fallback to conversations/brain descriptors (sorted by highest fd number to prefer newer descriptors)
    for (const pid of targetPids) {
      try {
        const fdDir = `/proc/${pid}/fd`;
        if (!fs.existsSync(fdDir)) continue;
        const fds = fs.readdirSync(fdDir).sort((a, b) => {
          const numA = parseInt(a, 10) || 0;
          const numB = parseInt(b, 10) || 0;
          return numB - numA;
        });
        for (const fd of fds) {
          try {
            const link = fs.readlinkSync(path.join(fdDir, fd));
            const match = link.match(/(?:conversations|brain)\/([a-f0-9-]{36})/i);
            if (match && match[1]) {
              return match[1];
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (err) {}
  return null;
}

/**
 * Fallback: Extract the most recent conversation ID from Antigravity history.jsonl for a workspace
 */
function getAgySessionIdFromHistory(workspacePath, userHomeDir, sysHomeDir) {
  if (!workspacePath) return null;
  const normalizedWs = path.resolve(workspacePath).replace(/\/+$/, '');
  const agyDirs = getAntigravityDirs(userHomeDir, sysHomeDir);

  for (const baseDir of agyDirs) {
    const historyFile = path.join(baseDir, 'history.jsonl');
    if (!fs.existsSync(historyFile)) continue;

    try {
      const stats = fs.statSync(historyFile);
      const readSize = Math.min(stats.size, 65536);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(historyFile, 'r');
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
      fs.closeSync(fd);

      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const item = JSON.parse(lines[i]);
          if (item && item.conversationId && item.workspace) {
            const itemWs = path.resolve(item.workspace).replace(/\/+$/, '');
            if (itemWs === normalizedWs) {
              return item.conversationId;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Find the matching Antigravity transcript file
 * Note: Never fallback to historical/latest workspace files to avoid cross-session contamination,
 * especially when another agy session is actively running in the same workspace.
 */
function findAgySessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir) {
  const targetSessionId = explicitSessionId ||
                          getAgySessionIdFromPanePid(panePid);

  if (!targetSessionId) {
    return null;
  }

  const agyDirs = getAntigravityDirs(userHomeDir, sysHomeDir);

  for (const baseDir of agyDirs) {
    const transcriptPath = path.join(baseDir, 'brain', targetSessionId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(transcriptPath)) {
      return {
        filePath: transcriptPath,
        sessionId: targetSessionId,
        projectPath: path.join(baseDir, 'brain', targetSessionId),
        agentType: 'agy'
      };
    }
    const transcriptFullPath = path.join(baseDir, 'brain', targetSessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (fs.existsSync(transcriptFullPath)) {
      return {
        filePath: transcriptFullPath,
        sessionId: targetSessionId,
        projectPath: path.join(baseDir, 'brain', targetSessionId),
        agentType: 'agy'
      };
    }
  }

  return {
    filePath: null,
    sessionId: targetSessionId,
    projectPath: null,
    agentType: 'agy'
  };
}

/**
 * Unified Agent Session File locator (Claude Code & Antigravity)
 */
function findAgentSessionFile(agentType, workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir) {
  const lowerAgent = (agentType || '').toLowerCase();
  if (lowerAgent === 'agy' || lowerAgent === 'antigravity') {
    const res = findAgySessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
    if (res) return res;
    return {
      filePath: null,
      sessionId: explicitSessionId || null,
      projectPath: null,
      agentType: 'agy'
    };
  }

  if (lowerAgent === 'claude') {
    const res = findClaudeSessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
    if (res) {
      res.agentType = 'claude';
      return res;
    }
    return {
      filePath: null,
      sessionId: explicitSessionId || null,
      projectPath: null,
      agentType: 'claude'
    };
  }

  // Auto-detect based on pane PID / active processes
  const agyPidSess = getAgySessionIdFromPanePid(panePid);
  if (agyPidSess) {
    const agyRes = findAgySessionFile(workspacePath, agyPidSess, panePid, userHomeDir, sysHomeDir);
    if (agyRes) return agyRes;
  }

  const claudePidSess = getSessionIdFromPanePid(panePid);
  if (claudePidSess) {
    const claudeRes = findClaudeSessionFile(workspacePath, claudePidSess, panePid, userHomeDir, sysHomeDir);
    if (claudeRes) {
      claudeRes.agentType = 'claude';
      return claudeRes;
    }
  }

  // Fallback checks
  const claudeCheck = findClaudeSessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
  if (claudeCheck && claudeCheck.filePath) {
    claudeCheck.agentType = 'claude';
    return claudeCheck;
  }

  const agyCheck = findAgySessionFile(workspacePath, explicitSessionId, panePid, userHomeDir, sysHomeDir);
  if (agyCheck && agyCheck.filePath) {
    agyCheck.agentType = 'agy';
    return agyCheck;
  }

  return null;
}

/**
 * Extract clean user text from Antigravity user input step
 */
function extractAgyUserText(content) {
  if (!content) return '';
  let text = String(content);
  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch && reqMatch[1]) {
    return reqMatch[1].trim();
  }
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  return text.trim();
}

/**
 * Parse an Antigravity transcript.jsonl file into structured chat messages
 */
async function parseAgyJsonl(filePath, maxMessages = 50) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { messages: [], lastUpdated: null, pendingAction: null };
  }

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const parsedEvents = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsedEvents.push(JSON.parse(trimmed));
    } catch (err) {}
  }

  const messages = [];
  let currentAssistantMsg = null;
  const answeredQuestionSteps = new Set();

  // Pre-scan for question answers and tool completions
  for (const ev of parsedEvents) {
    if (ev.type === 'ASK_QUESTION' && ev.step_index !== undefined) {
      // Step_index in event is the answer step
      answeredQuestionSteps.add(ev.step_index - 1);
    }
  }

  for (const event of parsedEvents) {
    // 1. User message
    if (event.source === 'USER_EXPLICIT' && event.type === 'USER_INPUT') {
      const cleanText = extractAgyUserText(event.content);
      if (!cleanText) continue;

      // Handle slash clear command in AGY transcript: reset all prior messages
      if (cleanText.toLowerCase() === '/clear') {
        messages.length = 0;
        currentAssistantMsg = null;
        continue;
      }

      currentAssistantMsg = null; // Close previous turn
      messages.push({
        id: `user-${event.step_index}`,
        role: 'user',
        timestamp: event.created_at || new Date().toISOString(),
        content: cleanText
      });
      continue;
    }

    // 2. Assistant planner response
    if (event.source === 'MODEL' && event.type === 'PLANNER_RESPONSE') {
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          id: `assistant-${event.step_index}`,
          role: 'assistant',
          timestamp: event.created_at || new Date().toISOString(),
          content: '',
          thinking: '',
          tools: []
        };
        messages.push(currentAssistantMsg);
      }

      if (event.thinking) {
        currentAssistantMsg.thinking = String(event.thinking).trim();
      }

      if (event.content) {
        const text = String(event.content).trim();
        if (text) {
          currentAssistantMsg.content = currentAssistantMsg.content
            ? currentAssistantMsg.content + '\n\n' + text
            : text;
        }
      }

      if (Array.isArray(event.tool_calls)) {
        for (const tc of event.tool_calls) {
          const isAskQ = tc.name === 'ask_question' || tc.name === 'AskUserQuestion';
          let rawArgs = tc.args || {};
          let normalizedArgs = {};

          if (typeof rawArgs === 'string') {
            try { rawArgs = JSON.parse(rawArgs); } catch (e) {}
          }
          if (rawArgs && typeof rawArgs === 'object') {
            for (const [k, v] of Object.entries(rawArgs)) {
              if (typeof v === 'string') {
                try {
                  normalizedArgs[k] = JSON.parse(v);
                } catch (e) {
                  normalizedArgs[k] = v;
                }
              } else {
                normalizedArgs[k] = v;
              }
            }
          }

          let questions = [];
          if (isAskQ) {
            let qList = normalizedArgs.questions;
            if (typeof qList === 'string') {
              try { qList = JSON.parse(qList); } catch (e) {}
            }
            if (Array.isArray(qList)) {
              questions = qList.map(q => {
                const opts = Array.isArray(q.options) ? q.options.map((o, idx) => {
                  if (typeof o === 'string') return { label: o, description: '' };
                  return { label: o.label || o.text || `选项 ${idx + 1}`, description: o.description || '' };
                }) : [];
                return {
                  question: q.question || '',
                  options: opts,
                  multiSelect: Boolean(q.is_multi_select || q.multiSelect)
                };
              });
            }
          }

          const toolItem = {
            id: `tool-${event.step_index}-${tc.name}`,
            name: tc.name || 'tool',
            input: normalizedArgs,
            isAskQuestion: isAskQ,
            questions: questions
          };

          currentAssistantMsg.tools.push(toolItem);
        }
      }
    }
  }

  // Detect pending interactive decision on the latest state
  let pendingAction = null;

  if (parsedEvents.length > 0) {
    const lastEvent = parsedEvents[parsedEvents.length - 1];
    
    // Check if the last model action was ask_question without a subsequent response
    if (lastEvent && lastEvent.source === 'MODEL' && lastEvent.type === 'PLANNER_RESPONSE') {
      const askCall = (lastEvent.tool_calls || []).find(t => t.name === 'ask_question' || t.name === 'AskUserQuestion');
      if (askCall) {
        let rawArgs = askCall.args || {};
        if (typeof rawArgs === 'string') {
          try { rawArgs = JSON.parse(rawArgs); } catch (e) {}
        }
        let qList = rawArgs.questions;
        if (typeof qList === 'string') {
          try { qList = JSON.parse(qList); } catch (e) {}
        }
        const questions = Array.isArray(qList) ? qList.map(q => {
          const opts = Array.isArray(q.options) ? q.options.map((o, idx) => {
            if (typeof o === 'string') return { label: o, description: '' };
            return { label: o.label || o.text || `选项 ${idx + 1}`, description: o.description || '' };
          }) : [];
          return {
            question: q.question || '',
            options: opts,
            multiSelect: Boolean(q.is_multi_select || q.multiSelect)
          };
        }) : [];

        pendingAction = {
          type: 'ask_question',
          toolUseId: `tool-${lastEvent.step_index}-ask_question`,
          questions: questions,
          hint: '智能体提出问题，请在下方选择回答'
        };
      }
    }
  }

  // Fallback check on latest message text content for (y/n) prompts
  if (!pendingAction && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'assistant' && lastMsg.content) {
      const contentLower = lastMsg.content.toLowerCase();
      if (
        contentLower.includes('(y/n)') ||
        contentLower.includes('[y/n]') ||
        contentLower.includes('proceed?') ||
        contentLower.includes('continue?') ||
        contentLower.includes('are you sure')
      ) {
        pendingAction = {
          type: 'yn',
          hint: '等待确认操作'
        };
      }
    }
  }

  const trimmedMessages = messages.slice(-maxMessages);

  let mtime = null;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch (e) {}

  return {
    messages: trimmedMessages,
    pendingAction,
    lastUpdated: mtime
  };
}

/**
 * Unified Chat History Parser dispatching to agent-specific parser
 */
async function parseAgentChat(agentType, filePath, maxMessages = 50) {
  const lower = (agentType || '').toLowerCase();
  if (lower === 'agy' || lower === 'antigravity') {
    return parseAgyJsonl(filePath, maxMessages);
  }
  return parseClaudeJsonl(filePath, maxMessages);
}

module.exports = {
  getProjectSlug,
  getClaudeProjectsDirs,
  getSessionIdFromPanePid,
  findClaudeSessionFile,
  parseClaudeJsonl,
  getAntigravityDirs,
  getAgySessionIdFromPanePid,
  getAgySessionIdFromHistory,
  findAgySessionFile,
  findAgentSessionFile,
  parseAgyJsonl,
  parseAgentChat
};

