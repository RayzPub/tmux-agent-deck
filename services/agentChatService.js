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
function extractUserText(rawContent) {
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
        const cleaned = extractUserText(item);
        if (cleaned) textPieces.push(cleaned);
      } else if (item && typeof item === 'object') {
        if (item.type === 'text' && item.text) {
          const cleaned = extractUserText(item.text);
          if (cleaned) textPieces.push(cleaned);
        }
      }
    }
    return textPieces.join('\n\n').trim();
  }

  if (typeof rawContent === 'object') {
    if (rawContent.type === 'text' && rawContent.text) {
      return extractUserText(rawContent.text);
    }
    if (rawContent.text && typeof rawContent.text === 'string') {
      return extractUserText(rawContent.text);
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

  for (const event of parsedEvents) {
    // User message
    if (event.type === 'user' && event.message && event.message.content) {
      if (event.isMeta) continue;
      
      const cleanText = extractUserText(event.message.content);
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
          tools.push({
            name: part.name || 'tool',
            input: part.input || {}
          });
        }
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
  if (messages.length > 0) {
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
