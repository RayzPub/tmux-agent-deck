const fs = require('fs');
const path = require('path');

const BINDINGS_FILE = path.join(__dirname, 'im_bindings.json');
let bindings = {
  telegram: [],
  feishu: [],
  activeSessions: {}
};

// In-memory binding tokens: token -> metadata
const pendingBindings = new Map();

function loadBindings() {
  if (fs.existsSync(BINDINGS_FILE)) {
    try {
      bindings = JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8'));
      if (!bindings.telegram) bindings.telegram = [];
      if (!bindings.feishu) bindings.feishu = [];
      if (!bindings.activeSessions) bindings.activeSessions = {};
    } catch (e) {
      console.error('[IM Bot] Error loading bindings:', e);
    }
  }
}

function saveBindings() {
  try {
    fs.writeFileSync(BINDINGS_FILE, JSON.stringify(bindings, null, 2), 'utf8');
  } catch (e) {
    console.error('[IM Bot] Error saving bindings:', e);
  }
}

// Escape HTML utility for Telegram HTML parse_mode
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Send helper to Telegram
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[IM Bot] Telegram sendMessage error:`, data);
    }
  } catch (err) {
    console.error(`[IM Bot] Telegram network error:`, err);
  }
}

// Set Webhook helper
async function setupTelegramWebhook(domainName) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  
  const webhookUrl = `https://${domainName}/api/im/telegram/webhook`;
  const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok) {
      console.log(`🤖 [IM Bot] Telegram Webhook successfully set to ${webhookUrl}`);
    } else {
      console.error(`❌ [IM Bot] Failed to set Telegram Webhook:`, data);
    }
  } catch (err) {
    console.error(`❌ [IM Bot] Error setting Telegram Webhook:`, err);
  }
}

// Set Commands Menu helper
async function setupTelegramCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const body = {
    commands: [
      { command: "list", description: "🖥️ 列出所有 Tmux 会话" },
      { command: "status", description: "📸 查看当前活动会话屏幕" },
      { command: "help", description: "❓ 查看指令帮助" }
    ]
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`🤖 [IM Bot] Telegram Bot commands menu successfully registered.`);
    } else {
      console.error(`❌ [IM Bot] Failed to register Telegram Bot commands:`, data);
    }
  } catch (err) {
    console.error(`❌ [IM Bot] Error setting Telegram Bot commands:`, err);
  }
}

let botUsername = process.env.TELEGRAM_BOT_USERNAME || 'OutshineCloudBot';

const activeMonitors = new Map();

function startSessionMonitor(sessionName, chatId, execTmux) {
  // If there's already a monitor for this session, clear it first
  if (activeMonitors.has(sessionName)) {
    clearInterval(activeMonitors.get(sessionName).intervalId);
  }

  const monitorState = {
    lastContent: '',
    changeCount: 0,
    silentTicks: 0,
    totalTicks: 0,
    intervalId: null
  };

  // We perform an initial capture right away
  execTmux(['capture-pane', '-t', sessionName, '-p'], (err, stdout) => {
    if (!err) {
      monitorState.lastContent = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    }
  });

  monitorState.intervalId = setInterval(() => {
    monitorState.totalTicks++;
    
    // Safety timeout: stop monitoring after 5 minutes (200 ticks of 1.5s)
    if (monitorState.totalTicks > 200) {
      clearInterval(monitorState.intervalId);
      activeMonitors.delete(sessionName);
      sendTelegramMessage(chatId, `ℹ️ <i>会话 ${escapeHTML(sessionName)} 上的任务已超过最大监视时间（5分钟）。已停止监听。</i>`);
      return;
    }

    execTmux(['capture-pane', '-t', sessionName, '-p'], async (err, stdout) => {
      if (err) {
        clearInterval(monitorState.intervalId);
        activeMonitors.delete(sessionName);
        return;
      }

      const cleanContent = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
      
      if (cleanContent !== monitorState.lastContent) {
        monitorState.lastContent = cleanContent;
        monitorState.changeCount++;
        monitorState.silentTicks = 0;
      } else {
        monitorState.silentTicks++;
        
        // If we've seen changes, and now it has been silent for 2 ticks (3 seconds),
        // or if it has been silent for 8 ticks (12 seconds) without any changes (command might be silent or finished instantly)
        const shouldReport = (monitorState.changeCount > 0 && monitorState.silentTicks >= 2) || 
                             (monitorState.changeCount === 0 && monitorState.silentTicks >= 8);

        if (shouldReport) {
          clearInterval(monitorState.intervalId);
          activeMonitors.delete(sessionName);

          const lines = cleanContent.split('\n');
          const lastLines = lines.slice(-20).join('\n'); // Send last 20 lines of result
          
          await sendTelegramMessage(chatId, 
            `✅ <b>会话 ${escapeHTML(sessionName)} 上的任务执行完毕：</b>\n` +
            `<pre>${escapeHTML(lastLines)}</pre>`
          );
        }
      }
    });
  }, 1500);

  activeMonitors.set(sessionName, monitorState);
}

module.exports = {
  init(app, execTmux, getRunUser, requireAuth) {
    loadBindings();

    const domainName = process.env.DOMAIN_NAME || 'outshine.cloud';
    if (process.env.TELEGRAM_BOT_TOKEN) {
      setupTelegramWebhook(domainName);
      setupTelegramCommands();
      
      // Auto-fetch username if not explicitly set in .env
      if (!process.env.TELEGRAM_BOT_USERNAME) {
        fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)
          .then(res => res.json())
          .then(data => {
            if (data.ok && data.result && data.result.username) {
              botUsername = data.result.username;
              console.log(`🤖 [IM Bot] Automatically retrieved Telegram Bot username: @${botUsername}`);
            }
          })
          .catch(err => {
            console.error('❌ [IM Bot] Failed to fetch Telegram Bot username:', err);
          });
      }
    } else {
      console.log('🤖 [IM Bot] Telegram Bot is disabled (TELEGRAM_BOT_TOKEN not configured).');
    }

    // 1. Generate binding token (Auth required)
    app.get('/api/im/binding-token', requireAuth, (req, res) => {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        return res.status(400).json({ error: 'IM Bot is not configured on this server.' });
      }

      // Generate a unique 6-digit pin
      let token = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Clean up expired ones first
      const now = Date.now();
      for (const [t, data] of pendingBindings.entries()) {
        if (data.expiresAt < now) {
          pendingBindings.delete(t);
        }
      }

      pendingBindings.set(token, {
        token,
        bound: false,
        chatId: null,
        username: null,
        expiresAt: now + 5 * 60 * 1000 // 5 minutes validity
      });

      res.json({
        token,
        botUsername,
        bindingUrl: `https://t.me/${botUsername}?start=${token}`
      });
    });

    // 2. Poll binding status (Auth required)
    app.get('/api/im/bind-status', requireAuth, (req, res) => {
      const { token } = req.query;
      if (!token) {
        return res.status(400).json({ error: 'Token is required' });
      }

      const pBinding = pendingBindings.get(token);
      if (!pBinding) {
        return res.json({ status: 'expired' });
      }

      if (pBinding.expiresAt < Date.now()) {
        pendingBindings.delete(token);
        return res.json({ status: 'expired' });
      }

      if (pBinding.bound) {
        pendingBindings.delete(token);
        return res.json({ status: 'bound', username: pBinding.username });
      }

      res.json({ status: 'pending' });
    });

    // 3. Get list of bound users (Auth required)
    app.get('/api/im/status', requireAuth, (req, res) => {
      res.json({
        enabled: !!process.env.TELEGRAM_BOT_TOKEN,
        bindings: bindings.telegram
      });
    });

    // 4. Unbind specific device (Auth required)
    app.post('/api/im/unbind', requireAuth, (req, res) => {
      const { chatId } = req.body;
      if (!chatId) {
        return res.status(400).json({ error: 'chatId is required' });
      }

      bindings.telegram = bindings.telegram.filter(user => user.chatId !== chatId);
      delete bindings.activeSessions[chatId];
      saveBindings();

      res.json({ success: true });
    });

    // 5. Telegram Webhook Receiver
    app.post('/api/im/telegram/webhook', async (req, res) => {
      res.sendStatus(200); // Telegram expects 200 OK immediately
      
      const { message, callback_query } = req.body;

      // Handle Callback Query (Buttons clicking)
      if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const queryId = callback_query.id;
        const data = callback_query.data;
        const msgId = callback_query.message.message_id;

        // Check if user is bound
        const isUserBound = bindings.telegram.some(user => user.chatId === chatId);
        if (!isUserBound) {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: queryId, text: 'Unauthorized user!', show_alert: true })
          });
          return;
        }

        const parts = data.split(':');
        const action = parts[0];
        const sessionName = parts[1];

        if (action === 'approve' || action === 'deny') {
          const keysToSend = action === 'approve' ? 'y' : 'n';
          const actionText = action === 'approve' ? '✅ 已允许 (Approve)' : '❌ 已拒绝 (Deny)';

          // Run tmux send-keys
          execTmux(['send-keys', '-t', sessionName, keysToSend, 'Enter'], async (err) => {
            // Answer callback query
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: queryId, text: action === 'approve' ? '已授权通过' : '已拒绝请求' })
            });

            // Edit message to remove buttons and show decision
            const newText = `${callback_query.message.text}\n\n<b>审批决策：${actionText}</b>`;
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                message_id: msgId,
                text: newText,
                parse_mode: 'HTML'
              })
            });

            // Start monitoring session output after approval/denial to capture the next step
            startSessionMonitor(sessionName, chatId, execTmux);
          });
        }
        return;
      }

      // Handle Message
      if (!message || !message.text) return;
      const chatId = message.chat.id;
      const text = message.text.trim();
      const username = message.from.username || message.from.first_name || 'Unknown';

      // Start command (with optional token)
      if (text.startsWith('/start')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
          const token = parts[1];
          const pBinding = pendingBindings.get(token);
          if (pBinding && pBinding.expiresAt > Date.now()) {
            // Add user
            if (!bindings.telegram.some(user => user.chatId === chatId)) {
              bindings.telegram.push({ chatId, username });
            }
            pBinding.bound = true;
            pBinding.username = username;
            
            saveBindings();
            
            await sendTelegramMessage(chatId, `🎉 <b>赛博朋克 TMUX Agent Deck 绑定成功！</b>\n\n你现在可以实时接收通知，并在此直接管理你的 TMUX 会话了。\n\n发送 /list 列出所有会话。`);
            return;
          } else {
            await sendTelegramMessage(chatId, `❌ <b>无效或已过期的绑定 PIN 码。</b>\n\n请在网页端仪表盘重新生成并扫描绑定二维码。`);
            return;
          }
        } else {
          await sendTelegramMessage(chatId, `🤖 <b>赛博朋克 TMUX Agent Deck 机器人</b>\n\n请前往你的网页控制面板，点击 <b>IM BOT</b> 按钮并扫描二维码进行绑定。`);
          return;
        }
      }

      // Verify authorization for all other commands
      const isUserBound = bindings.telegram.some(user => user.chatId === chatId);
      if (!isUserBound) {
        await sendTelegramMessage(chatId, `🔒 <b>未授权访问。</b>\n\n请先在网页端仪表盘扫描绑定二维码。`);
        return;
      }

      // Command: /help
      if (text === '/help') {
        await sendTelegramMessage(chatId, 
          `🤖 <b>可用命令列表：</b>\n` +
          `• /list - 列出所有 TMUX 会话\n` +
          `• /switch &lt;session&gt; - 切换当前活动会话\n` +
          `• /status - 查看当前活动会话屏幕\n` +
          `• /help - 查看本帮助消息\n\n` +
          `<i>你也可以直接回复任何文本，机器人会将其作为键盘输入发送给活动终端！</i>`
        );
        return;
      }

      // Command: /list
      if (text === '/list') {
        execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_path}'], async (err, stdout) => {
          if (err) {
            await sendTelegramMessage(chatId, `🖥️ <b>服务器上当前没有活跃的 Tmux 会话。</b>`);
            return;
          }
          const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
          let reply = `🖥️ <b>TMUX 会话列表：</b>\n`;
          lines.forEach(line => {
            const [name, attached, pathStr] = line.split('|');
            const attachedStatus = attached === '1' ? '🟢 已挂载 (Attached)' : '🔴 未挂载 (Detached)';
            reply += `• <b>${escapeHTML(name)}</b> - ${attachedStatus}\n  <code>${escapeHTML(pathStr)}</code>\n`;
          });
          
          const currentActive = bindings.activeSessions[chatId] || '无';
          reply += `\n🎯 <b>当前的活动会话：</b> <code>${escapeHTML(currentActive)}</code>`;
          reply += `\n使用 <code>/switch [会话名]</code> 进行切换。`;

          await sendTelegramMessage(chatId, reply);
        });
        return;
      }

      // Command: /switch <session>
      if (text.startsWith('/switch')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
          await sendTelegramMessage(chatId, `⚠️ 使用方法：<code>/switch &lt;会话名称&gt;</code>`);
          return;
        }
        const sessionName = parts[1];
        execTmux(['list-sessions', '-F', '#{session_name}'], async (err, stdout) => {
          if (err) {
            await sendTelegramMessage(chatId, `❌ 获取会话列表时发生错误。`);
            return;
          }
          const sessions = stdout.split('\n').map(s => s.trim()).filter(Boolean);
          if (!sessions.includes(sessionName)) {
            await sendTelegramMessage(chatId, `❌ 会话 <b>${escapeHTML(sessionName)}</b> 不存在。`);
            return;
          }
          
          bindings.activeSessions[chatId] = sessionName;
          saveBindings();
          await sendTelegramMessage(chatId, `🎯 活动会话已切换为：<b>${escapeHTML(sessionName)}</b>`);
        });
        return;
      }

      // Command: /status
      if (text === '/status') {
        const sessionName = bindings.activeSessions[chatId];
        if (!sessionName) {
          await sendTelegramMessage(chatId, `⚠️ 尚未选择活动会话。使用 /list 查看会话，然后通过 <code>/switch &lt;name&gt;</code> 选择一个。`);
          return;
        }

        execTmux(['capture-pane', '-t', sessionName, '-p'], async (err, stdout) => {
          if (err) {
            await sendTelegramMessage(chatId, `❌ 截取屏幕失败：${escapeHTML(err.message)}`);
            return;
          }
          const cleanOutput = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          const lines = cleanOutput.split('\n');
          const lastLines = lines.slice(-20).join('\n');
          
          await sendTelegramMessage(chatId, `🖥️ <b>会话实时屏幕：${escapeHTML(sessionName)}</b>\n<pre>${escapeHTML(lastLines)}</pre>`);
        });
        return;
      }

      // Regular message input (Send keys to active session)
      const sessionName = bindings.activeSessions[chatId];
      if (!sessionName) {
        await sendTelegramMessage(chatId, `⚠️ 尚未选择活动会话。请先使用 <code>/switch &lt;session_name&gt;</code> 选择一个会话再发送输入。`);
        return;
      }

      // Send inputs to session
      execTmux(['send-keys', '-t', sessionName, text, 'Enter'], (err) => {
        if (err) {
          sendTelegramMessage(chatId, `❌ 发送键盘输入失败：${escapeHTML(err.message)}`);
        } else {
          // Confirm keys were sent and start watching the screen for completion
          sendTelegramMessage(chatId, `📥 <i>输入已投递至 ${escapeHTML(sessionName)}:</i> <code>${escapeHTML(text)}</code>\n⏳ <i>任务执行中，正在监视终端状态...</i>`);
          
          startSessionMonitor(sessionName, chatId, execTmux);
        }
      });
    });
  },

  // Notify method
  async notify(payload) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || bindings.telegram.length === 0) return;

    const title = payload.title || 'Notification';
    const body = payload.body || '';
    const session = payload.session;

    let text = `🔔 <b>${escapeHTML(title)}</b>\n${escapeHTML(body)}`;
    if (session) {
      text += `\n\n会话：<code>${escapeHTML(session)}</code>`;
    }

    // Set buttons if it looks like a request for permission
    let replyMarkup = null;
    const isPermissionRequest = title.includes('请求') || title.includes('Request') || title.includes('权限') || body.includes('确认') || body.includes('authorize') || body.includes('approve');
    
    if (isPermissionRequest && session) {
      replyMarkup = {
        inline_keyboard: [
          [
            { text: "✅ 允许 (Approve)", callback_data: `approve:${session}` },
            { text: "❌ 拒绝 (Deny)", callback_data: `deny:${session}` }
          ]
        ]
      };
    }

    for (const user of bindings.telegram) {
      // Set active session for the user if they don't have one set yet
      if (session && !bindings.activeSessions[user.chatId]) {
        bindings.activeSessions[user.chatId] = session;
        saveBindings();
      }
      await sendTelegramMessage(user.chatId, text, replyMarkup);
    }
  }
};
