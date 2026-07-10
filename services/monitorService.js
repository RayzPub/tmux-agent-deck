const crypto = require('crypto');
const { execPromise } = require('./tmuxService');
const { sendPushToAll } = require('./pushService');

const notifiedPrompts = new Map();

const checkSessionsForPrompts = async (io) => {
  try {
    const listOutput = await execPromise(['list-sessions', '-F', '#{session_name}']);
    const sessions = listOutput.split('\n').map(s => s.trim()).filter(Boolean);
    
    for (const session of sessions) {
      try {
        const paneContent = await execPromise(['capture-pane', '-t', session, '-p']);
        const lines = paneContent.split('\n').map(l => l.trim()).filter(Boolean);
        
        // We look at the last 5 lines of the pane (where prompts/confirmations usually appear)
        const lastLines = lines.slice(-5);
        let foundMatch = null;
        
        // Common patterns for agent prompt/confirmations or permissions
        const patterns = [
          /\[y\/N\]/i,
          /\[Y\/n\]/i,
          /\[y\/n\]/i,
          /\(y\/n\)/i,
          /allow\s+.*?\?/i,
          /confirm\s+.*?\?/i,
          /please\s+authorize/i,
          /authorize\s+.*?\?/i,
          /waiting\s+for\s+(approval|input|feedback)/i,
          /escalate_admin/i,
          /permission\s+denied/i,
          /enter\s+to\s+continue/i,
          /password\s+for\s+.*?:/i
        ];
        
        for (const line of lastLines) {
          for (const pattern of patterns) {
            if (pattern.test(line)) {
              foundMatch = line;
              break;
            }
          }
          if (foundMatch) break;
        }
        
        if (foundMatch) {
          // Clean ANSI escape codes from matched line for a clean notification display
          const cleanLine = foundMatch.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          const hash = crypto.createHash('md5').update(cleanLine).digest('hex');
          const lastHash = notifiedPrompts.get(session);
          
          if (lastHash !== hash) {
            console.log(`[Push Notification Triggered] Session: ${session}, Match: "${cleanLine}"`);
            notifiedPrompts.set(session, hash);
            
            sendPushToAll(io, {
              title: `Agent Action Required: ${session}`,
              body: cleanLine.length > 80 ? cleanLine.slice(0, 77) + '...' : cleanLine,
              url: `/?session=${session}`,
              session: session
            });
          }
        } else {
          // No prompt found in the last lines, clear the notification state
          if (notifiedPrompts.has(session)) {
            notifiedPrompts.delete(session);
          }
        }
      } catch (err) {
        // Ignored: session might have just been closed or is not capturing
      }
    }
  } catch (err) {
    // Ignored: tmux is running but has no sessions
  }
};

const startMonitoring = (io) => {
  console.log('👀 Starting Tmux session monitoring daemon (interval: 5s)...');
  return setInterval(() => checkSessionsForPrompts(io), 5000);
};

module.exports = {
  startMonitoring
};
