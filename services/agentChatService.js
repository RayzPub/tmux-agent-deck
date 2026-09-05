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
      if (match && match[1]) return match[1].trim();
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

module.exports = {
  getProjectSlug,
  getClaudeProjectsDirs,
  getSessionIdFromPanePid,
  findClaudeSessionFile,
  parseClaudeJsonl
};
