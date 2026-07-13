const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const BINDINGS_FILE = path.join(__dirname, 'im_bindings.json');
let bindings = {
  telegram: [],
  feishu: [],
  wechat: [],
  activeSessions: {}
};

// In-memory binding tokens: token -> metadata
const pendingBindings = new Map();

const getWebUsername = (id) => {
  if (bindings.telegram && Array.isArray(bindings.telegram)) {
    const user = bindings.telegram.find(u => u.chatId === id);
    if (user) return user.webUsername || 'admin';
  }
  if (bindings.wechat && Array.isArray(bindings.wechat)) {
    const user = bindings.wechat.find(u => u.openid === id);
    if (user) return user.webUsername || 'admin';
  }
  return null; // Changed from 'admin' - unbound users should not default to admin
};

function loadBindings() {
  if (fs.existsSync(BINDINGS_FILE)) {
    try {
      bindings = JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8'));
      if (!bindings.telegram) bindings.telegram = [];
      if (!bindings.feishu) bindings.feishu = [];
      if (!bindings.wechat) bindings.wechat = [];
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

function getCleanTerminalOutput(stdout, lineCount) {
  // Remove ANSI escape codes
  const cleanOutput = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  
  const lines = cleanOutput.split('\n');
  const filteredLines = lines.map(line => {
    const trimmed = line.trim();
    // Filter out lines that are mostly horizontal borders or prompt separators (e.g. ─, ━, -, _, =)
    if (trimmed.length >= 5) {
      const nonDivider = trimmed.replace(/[─━┄┅┆┇┈┉┊┏═━─\-_=]/g, '');
      if (nonDivider.length / trimmed.length < 0.25) {
        return null; // Filter out this line
      }
    }
    return line;
  }).filter(line => line !== null);

  // Return the last N lines
  return filteredLines.slice(-lineCount).join('\n');
}

function randomWechatUin() {
  const uint32 = Math.floor(Math.random() * 4294967296);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

async function ilinkPostFetch(baseUrl, endpoint, body, token) {
  const url = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}${endpoint}`;
  
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff))
  };
  
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`iLink POST error ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function ilinkGetFetch(baseUrl, endpoint) {
  const url = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}${endpoint}`;
  
  const headers = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (6 & 0xff))
  };

  const res = await fetch(url, {
    method: "GET",
    headers
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`iLink GET error ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function fetchQRCode() {
  const body = { local_token_list: [] };
  const res = await ilinkPostFetch("https://ilinkai.weixin.qq.com", "ilink/bot/get_bot_qrcode?bot_type=3", body);
  return res;
}

async function pollQRStatus(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) {
    endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  }
  return await ilinkGetFetch(baseUrl, endpoint);
}

// Send helper to Telegram
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    link_preview_options: {
      is_disabled: true
    }
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
  let url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  
  const secretToken = process.env.TELEGRAM_SECRET_TOKEN;
  if (secretToken) {
    url += `&secret_token=${encodeURIComponent(secretToken)}`;
  }

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok) {
      console.log(`🤖 [IM Bot] Telegram Webhook successfully set to ${webhookUrl}${secretToken ? ' (with secret token)' : ''}`);
    } else {
      console.error(`❌ [IM Bot] Failed to set Telegram Webhook:`, data);
    }
  } catch (err) {
    console.error(`❌ [IM Bot] Error setting Telegram Webhook:`, err);
  }
}

const usedTokens = new Set();

// Clean up used tokens periodically to prevent memory leaks
setInterval(() => {
  usedTokens.clear();
}, 10 * 60 * 1000); // clear every 10 minutes (safe since tokens expire in 60s)

// Set Commands Menu helper
async function setupTelegramCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const body = {
    commands: [
      { command: "list", description: "🖥️ 列出所有 Tmux 会话" },
      { command: "status", description: "📸 查看当前活动会话屏幕" },
      { command: "link", description: "🔗 获取 60 秒免密登录链接" },
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

  const { MULTI_USER_ENABLED } = require('./config');
  const webUsername = getWebUsername(chatId);
  if (!webUsername) {
    console.warn(`[startSessionMonitor] No webUsername found for chatId ${chatId}, skipping monitor`);
    return;
  }
  const physicalSession = MULTI_USER_ENABLED ? `u_${webUsername}_${sessionName}` : sessionName;

  const monitorState = {
    lastContent: '',
    changeCount: 0,
    silentTicks: 0,
    totalTicks: 0,
    intervalId: null
  };

  // We perform an initial capture right away
  execTmux(['capture-pane', '-t', physicalSession, '-p'], (err, stdout) => {
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

    execTmux(['capture-pane', '-t', physicalSession, '-p'], async (err, stdout) => {
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

const activeWechatLoops = new Set(); // Stores openid of running loops

function startWechatUserUpdateLoops(execTmux) {
  // 1. Backward compatibility: Migrate legacy single bindings.wechatConfig to the matching user in bindings.wechat
  if (bindings.wechatConfig && bindings.wechatConfig.botToken && bindings.wechatConfig.userId) {
    const userId = bindings.wechatConfig.userId;
    if (!bindings.wechat) bindings.wechat = [];
    const existing = bindings.wechat.find(u => u.openid === userId);
    if (existing) {
      if (!existing.config) {
        existing.config = { ...bindings.wechatConfig };
      }
    } else {
      bindings.wechat.push({
        openid: userId,
        username: '微信主账号',
        webUsername: 'admin',
        config: { ...bindings.wechatConfig }
      });
    }
    delete bindings.wechatConfig;
    saveBindings();
  }

  // 2. Start dynamic polling loop for every bound wechat user with a valid token
  if (bindings.wechat && Array.isArray(bindings.wechat)) {
    bindings.wechat.forEach(user => {
      if (user.openid && user.config && user.config.botToken) {
        if (!activeWechatLoops.has(user.openid)) {
          activeWechatLoops.add(user.openid);
          runWechatUserUpdateLoop(user.openid, execTmux).catch(err => {
            console.error(`[IM Bot] WeChat update loop for ${user.openid} crashed:`, err);
            activeWechatLoops.delete(user.openid);
          });
        }
      }
    });
  }
}

async function runWechatUserUpdateLoop(openid, execTmux) {
  console.log(`🤖 [IM Bot] Starting WeChat ClawBot Update Loop for user: ${openid}...`);
  while (true) {
    // Dynamically retrieve the user object to detect unbinding/config removal
    const user = (bindings.wechat || []).find(u => u.openid === openid);
    if (!user || !user.config || !user.config.botToken) {
      console.log(`[IM Bot] WeChat config for ${openid} removed. Stopping update loop.`);
      break;
    }

    try {
      const config = user.config;
      const body = {
        get_updates_buf: config.getUpdatesBuf || "",
        base_info: {
          channel_version: "2.4.6",
          bot_agent: "OpenClaw"
        }
      };

      const res = await ilinkPostFetch(
        config.baseUrl || "https://ilinkai.weixin.qq.com",
        "ilink/bot/getupdates",
        body,
        config.botToken
      );

      if (res.ret && res.ret !== 0) {
        console.error(`[IM Bot] WeChat polling API error for ${openid}: ret=${res.ret}, errcode=${res.errcode}, message=${res.errmsg}`);
        if (res.ret === -14 || res.errcode === -14 || (res.errmsg && res.errmsg.toLowerCase().includes('token'))) {
          console.warn(`[IM Bot] WeChat session token expired or bound to another instance for ${openid}. Stopping update loop.`);
          delete user.config;
          saveBindings();
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (res.get_updates_buf) {
        config.getUpdatesBuf = res.get_updates_buf;
        saveBindings();
      }

      if (res.msgs && res.msgs.length > 0) {
        for (const msg of res.msgs) {
          await handleWechatInboundMessage(msg, openid, execTmux);
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[IM Bot] WeChat polling connection error for ${openid}:`, err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  activeWechatLoops.delete(openid);
}

async function handleWechatInboundMessage(msg, ownerOpenid, execTmux) {
  const fromUser = msg.from_user_id;
  const contextToken = msg.context_token;
  
  let text = "";
  if (msg.item_list && msg.item_list.length > 0) {
    const textItem = msg.item_list.find(item => item.type === 1 && item.text_item);
    if (textItem) {
      text = (textItem.text_item.text || "").trim();
    }
  }

  if (!text) return;

  if (!bindings.wechat) bindings.wechat = [];
  const userBinding = bindings.wechat.find(u => u.openid === fromUser);
  const ownerBinding = bindings.wechat.find(u => u.openid === ownerOpenid);

  async function reply(replyText) {
    try {
      const config = ownerBinding ? ownerBinding.config : null;
      if (!config || !config.botToken) return;
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: fromUser,
          client_id: `openclaw-weixin-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          message_type: 2,
          message_state: 2,
          item_list: [
            {
              type: 1,
              text_item: { text: replyText }
            }
          ],
          context_token: contextToken
        }
      };
      await ilinkPostFetch(config.baseUrl || "https://ilinkai.weixin.qq.com", "ilink/bot/sendmessage", body, config.botToken);
    } catch (err) {
      console.error('[IM Bot] Failed to send WeChat reply:', err);
    }
  }

  if (!userBinding) {
    return reply('🔒 未授权访问。请在网页控制端扫码绑定后自动授权。');
  }

  const webUsername = userBinding.webUsername || 'admin';
  const { MULTI_USER_ENABLED } = require('./config');
  const prefix = `u_${webUsername}_`;
  const lowerText = text.toLowerCase();

  // 1. Help Command
  if (lowerText === '帮助' || lowerText === 'help' || lowerText === '?' || lowerText === '/help' || lowerText === '/start') {
    return reply(
      '🤖 微信终端助手可用命令：\n\n' +
      '• 帮助 / help\n' +
      '  - 查看本帮助消息\n\n' +
      '• 会话 / list\n' +
      '  - 列出所有 TMUX 会话\n\n' +
      '• 切换 <名> / switch <名>\n' +
      '  - 切换当前活动会话\n\n' +
      '• 状态 / status\n' +
      '  - 查看当前活动会话屏幕\n\n' +
      '直接回复任何非指令文本，我将直接投递至活动会话终端输入中！'
    );
  }

  // 2. List Sessions Command
  if (lowerText === '会话' || lowerText === 'list' || lowerText === '/list' || lowerText === 'list会话' || lowerText === '列出会话') {
    execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_path}'], (err, stdout) => {
      if (err) {
        return reply('🖥️ 服务器上当前没有活跃的 Tmux 会话。');
      }
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      let replyText = '🖥️ TMUX 会话列表：\n';
      const activeSession = bindings.activeSessions[fromUser] || '无';

      lines.forEach(line => {
        const [name, attached, pathStr] = line.split('|');
        if (MULTI_USER_ENABLED) {
          if (!name.startsWith(prefix)) {
            return;
          }
          const shortName = name.substring(prefix.length);
          const numAttached = parseInt(attached, 10) || 0;
          const attachedStatus = numAttached > 0 ? '🟢 活跃' : '⚪ 挂起';
          replyText += `• ${shortName} [${attachedStatus}]\n  路径: ${pathStr}\n`;
        } else {
          const numAttached = parseInt(attached, 10) || 0;
          const attachedStatus = numAttached > 0 ? '🟢 活跃' : '⚪ 挂起';
          replyText += `• ${name} [${attachedStatus}]\n  路径: ${pathStr}\n`;
        }
      });
      replyText += `\n🎯 当前活动会话：${activeSession}\n回复 "切换 <名>" 或 "switch <名>" 可切换。`;
      reply(replyText);
    });
    return;
  }

  // 3. Switch Session Command
  if (lowerText.startsWith('切换') || lowerText.startsWith('switch ') || lowerText.startsWith('/switch ') || lowerText.startsWith('switch会话') || lowerText.startsWith('切换会话')) {
    let sessionName = "";
    if (lowerText.startsWith('切换')) {
      sessionName = text.substring(2).trim();
    } else if (lowerText.startsWith('switch ')) {
      sessionName = text.substring(7).trim();
    } else if (lowerText.startsWith('/switch ')) {
      sessionName = text.substring(8).trim();
    } else if (lowerText.startsWith('switch会话')) {
      sessionName = text.substring(8).trim();
    } else if (lowerText.startsWith('切换会话')) {
      sessionName = text.substring(4).trim();
    }

    if (!sessionName) {
      return reply('⚠️ 使用方法：切换 <会话名称> 或 switch <会话名称>');
    }

    const physicalSession = MULTI_USER_ENABLED ? `${prefix}${sessionName}` : sessionName;

    execTmux(['list-sessions', '-F', '#{session_name}'], (err, stdout) => {
      if (err) {
        return reply('❌ 获取会话列表时发生错误。');
      }
      const sessions = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (!sessions.includes(physicalSession)) {
        return reply(`❌ 会话 ${sessionName} 不存在。`);
      }
      
      bindings.activeSessions[fromUser] = sessionName;
      saveBindings();
      reply(`🎯 活动会话已切换为：${sessionName}`);
    });
    return;
  }

  // 4. Status Command
  if (lowerText === '状态' || lowerText === 'status' || lowerText === '/status' || lowerText === '查看状态') {
    const sessionName = bindings.activeSessions[fromUser];
    if (!sessionName) {
      return reply('⚠️ 您当前尚未选择活动 TMUX 会话。请回复 "切换 <名称>" 绑定一个会话，或回复 "帮助" 查看说明。');
    }

    const physicalSession = MULTI_USER_ENABLED ? `${prefix}${sessionName}` : sessionName;

    execTmux(['capture-pane', '-t', physicalSession, '-p'], (err, stdout) => {
      if (err) {
        return reply(`❌ 截取屏幕失败：${err.message}`);
      }
      const lastLines = getCleanTerminalOutput(stdout, 20);
      reply(`🖥️ 会话实时屏幕：${sessionName}\n\n${lastLines}`);
    });
    return;
  }

  // 5. Send Keys Command
  const sessionName = bindings.activeSessions[fromUser];
  if (!sessionName) {
    return reply(
      '⚠️ 您当前尚未选择活动 TMUX 会话。请先绑定会话后再发送键盘输入。\n\n' +
      '🤖 快速命令说明：\n' +
      '• 会话 / list - 查看可用会话\n' +
      '• 切换 <名称> / switch <名称> - 选择要控制的会话\n' +
      '• 帮助 / help - 查看完整指令列表'
    );
  }

  const physicalSession = MULTI_USER_ENABLED ? `${prefix}${sessionName}` : sessionName;

  execTmux(['send-keys', '-t', physicalSession, text, 'Enter'], (err) => {
    if (err) {
      reply(`❌ 发送键盘输入失败：${err.message}`);
    } else {
      setTimeout(() => {
        execTmux(['capture-pane', '-t', physicalSession, '-p'], (err, stdout) => {
          if (err) {
            reply(`📥 输入已投递，但获取最新屏幕失败。`);
          } else {
            const lastLines = getCleanTerminalOutput(stdout, 15);
            reply(`📥 输入已投递：${text}\n\n${lastLines}`);
          }
        });
      }, 2000);
    }
  });
}

async function pollWechatLogin(PIN, execTmux) {
  let count = 0;
  const maxAttempts = 150;
  
  while (pendingBindings.has(PIN) && count < maxAttempts) {
    const pBinding = pendingBindings.get(PIN);
    if (!pBinding || pBinding.bound) break;

    try {
      const res = await pollQRStatus(pBinding.currentApiBaseUrl, pBinding.qrcode, pBinding.pendingVerifyCode);
      pBinding.status = res.status;

      if (res.status === 'confirmed' && res.bot_token && res.ilink_bot_id) {
        const userConfig = {
          botToken: res.bot_token,
          accountId: res.ilink_bot_id,
          baseUrl: res.baseurl || 'https://ilinkai.weixin.qq.com',
          userId: res.ilink_user_id,
          getUpdatesBuf: ""
        };
        if (!bindings.wechat) bindings.wechat = [];
        const existing = bindings.wechat.find(u => u.openid === res.ilink_user_id);
        if (existing) {
          existing.webUsername = pBinding.webUsername || 'admin';
          existing.config = userConfig;
        } else {
          bindings.wechat.push({ 
            openid: res.ilink_user_id, 
            username: '微信主账号',
            webUsername: pBinding.webUsername || 'admin',
            config: userConfig
          });
        }
        saveBindings();
        
        startWechatUserUpdateLoops(execTmux);

        pBinding.bound = true;
        pBinding.username = '微信主账号';
        break;
      } else if (res.status === 'need_verifycode') {
        pBinding.verifyCodeRequired = true;
      } else if (res.status === 'scaned_but_redirect' && res.redirect_host) {
        pBinding.currentApiBaseUrl = `https://${res.redirect_host}`;
      } else if (res.status === 'scaned') {
        pBinding.pendingVerifyCode = undefined;
      } else if (res.status === 'expired') {
        pendingBindings.delete(PIN);
        break;
      }
    } catch (err) {
      console.error('[IM Bot] Error polling WeChat login:', err);
    }

    count++;
    await new Promise(r => setTimeout(r, 2000));
  }
}

module.exports = {
  init(app, execTmux, getRunUser, requireAuth) {
    loadBindings();
    startWechatUserUpdateLoops(execTmux);

    function getSessionsListMessage(chatId) {
      const { MULTI_USER_ENABLED } = require('./config');
      const webUsername = getWebUsername(chatId);
      const prefix = webUsername ? `u_${webUsername}_` : 'u_unknown_';

      return new Promise((resolve) => {
        execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_path}'], (err, stdout) => {
          if (err) {
            resolve({
              text: `🖥️ <b>服务器上当前没有活跃的 Tmux 会话。</b>`,
              replyMarkup: {
                inline_keyboard: [[{ text: '🔄 刷新列表', callback_data: 'refresh_list' }]]
              }
            });
            return;
          }
          const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
          let reply = `🖥️ <b>TMUX 会话列表：</b>\n`;
          const inlineKeyboard = [];
          const currentActive = bindings.activeSessions[chatId] || '无';

          lines.forEach(line => {
            const [name, attached, pathStr] = line.split('|');
            
            if (MULTI_USER_ENABLED) {
              if (!name.startsWith(prefix)) {
                return;
              }
              const shortName = name.substring(prefix.length);
              const numAttached = parseInt(attached, 10) || 0;
              const attachedStatus = numAttached > 0 
                ? `🟢 前台查看 (Active${numAttached > 1 ? ` x${numAttached}` : ''})` 
                : '⚪ 后台挂起 (Background)';
              reply += `• <b>${escapeHTML(shortName)}</b> - ${attachedStatus}\n  <code>${escapeHTML(pathStr)}</code>\n`;
              
              const isActive = shortName === currentActive;
              inlineKeyboard.push([{
                text: `${isActive ? '🎯' : '🔘'} ${shortName}`,
                callback_data: `switch:${shortName}`
              }]);
            } else {
              const numAttached = parseInt(attached, 10) || 0;
              const attachedStatus = numAttached > 0 
                ? `🟢 前台查看 (Active${numAttached > 1 ? ` x${numAttached}` : ''})` 
                : '⚪ 后台挂起 (Background)';
              reply += `• <b>${escapeHTML(name)}</b> - ${attachedStatus}\n  <code>${escapeHTML(pathStr)}</code>\n`;
              
              const isActive = name === currentActive;
              inlineKeyboard.push([{
                text: `${isActive ? '🎯' : '🔘'} ${name}`,
                callback_data: `switch:${name}`
              }]);
            }
          });
          
          reply += `\n🎯 <b>当前的活动会话：</b> <code>${escapeHTML(currentActive)}</code>`;
          reply += `\n使用 <code>/switch [会话名]</code> 或点击下方按钮直接切换：`;
          
          inlineKeyboard.push([{
            text: '🔄 刷新列表',
            callback_data: 'refresh_list'
          }]);
          
          resolve({
            text: reply,
            replyMarkup: { inline_keyboard: inlineKeyboard }
          });
        });
      });
    }

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
      const platform = req.query.platform || 'telegram';

      // Clean up expired ones first
      const now = Date.now();
      for (const [t, data] of pendingBindings.entries()) {
        if (data.expiresAt < now) {
          pendingBindings.delete(t);
        }
      }

      let token = Math.floor(100000 + Math.random() * 900000).toString();

      if (platform === 'wechat') {
        // WeChat ClawBot integration using public iLink AI API
        fetchQRCode().then(qrResponse => {
          pendingBindings.set(token, {
            token,
            platform: 'wechat',
            bound: false,
            webUsername: req.user.username,
            qrcode: qrResponse.qrcode,
            qrcodeUrl: qrResponse.qrcode_img_content,
            currentApiBaseUrl: 'https://ilinkai.weixin.qq.com',
            verifyCodeRequired: false,
            pendingVerifyCode: undefined,
            expiresAt: now + 5 * 60 * 1000
          });

          // Start polling in background
          pollWechatLogin(token, execTmux);

          res.json({
            token,
            platform: 'wechat',
            qrCodeUrl: qrResponse.qrcode_img_content,
            instructions: '请用手机微信扫描下方二维码，并在确认登录后，在微信中向 Bot 发送此 PIN 码进行绑定。'
          });
        }).catch(err => {
          console.error('[IM Bot] Failed to fetch WeChat QR Code:', err);
          res.status(500).json({ error: '获取微信登录二维码失败：' + err.message });
        });
        return;
      }

      // Default to Telegram
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        return res.status(400).json({ error: 'IM Bot is not configured on this server.' });
      }

      pendingBindings.set(token, {
        token,
        platform: 'telegram',
        bound: false,
        webUsername: req.user.username,
        chatId: null,
        username: null,
        expiresAt: now + 5 * 60 * 1000 // 5 minutes validity
      });

      res.json({
        token,
        platform: 'telegram',
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

      if (pBinding.verifyCodeRequired) {
        return res.json({ status: 'need_verifycode', message: '请输入手机微信上显示的两位数验证码：' });
      }

      res.json({ status: 'pending' });
    });

    // Verify code submission (Auth required)
    app.post('/api/im/wechat/verify-code', requireAuth, (req, res) => {
      const { token, code } = req.body;
      if (!token || !code) {
        return res.status(400).json({ error: 'Token and Code are required' });
      }

      const pBinding = pendingBindings.get(token);
      if (!pBinding) {
        return res.status(404).json({ error: 'Session not found or expired' });
      }

      pBinding.pendingVerifyCode = code;
      pBinding.verifyCodeRequired = false;
      res.json({ success: true });
    });

    // 3. Get list of bound users (Auth required)
    app.get('/api/im/status', requireAuth, (req, res) => {
      const username = req.user.username;
      const filteredTelegram = (bindings.telegram || []).filter(b => b.webUsername === username);
      const filteredWechat = (bindings.wechat || []).filter(b => b.webUsername === username);
      res.json({
        enabled: !!process.env.TELEGRAM_BOT_TOKEN,
        bindings: filteredTelegram,
        wechatEnabled: true,
        wechatBindings: filteredWechat
      });
    });

    // 4. Unbind specific device (Auth required)
    app.post('/api/im/unbind', requireAuth, (req, res) => {
      const { chatId, openid, platform } = req.body;
      const username = req.user.username;
      
      if (platform === 'wechat' || openid) {
        const idToUnbind = openid || chatId;
        
        // Find the binding first to verify ownership
        const binding = (bindings.wechat || []).find(user => user.openid === idToUnbind);
        if (binding && binding.webUsername !== username) {
          return res.status(403).json({ error: 'Permission denied: Cannot unbind this device' });
        }
        
        bindings.wechat = (bindings.wechat || []).filter(user => user.openid !== idToUnbind);
        delete bindings.activeSessions[idToUnbind];
        saveBindings();
        return res.json({ success: true });
      }

      if (!chatId) {
        return res.status(400).json({ error: 'chatId is required' });
      }

      // Find the binding first to verify ownership
      const binding = (bindings.telegram || []).find(user => user.chatId === chatId);
      if (binding && binding.webUsername !== username) {
        return res.status(403).json({ error: 'Permission denied: Cannot unbind this device' });
      }

      bindings.telegram = bindings.telegram.filter(user => user.chatId !== chatId);
      delete bindings.activeSessions[chatId];
      saveBindings();

      res.json({ success: true });
    });

    // WeChat Webhook verification and message receiver
    const crypto = require('crypto');

    app.get('/api/im/wechat/webhook', (req, res) => {
      const token = process.env.WECHAT_TOKEN;
      if (!token) {
        return res.status(400).send('WeChat integration not enabled.');
      }

      const { signature, timestamp, nonce, echostr } = req.query;
      const array = [token, timestamp, nonce].sort();
      const tempStr = array.join('');
      const hashCode = crypto.createHash('sha1').update(tempStr).digest('hex');

      if (hashCode === signature) {
        res.send(echostr);
      } else {
        res.status(403).send('Invalid signature');
      }
    });

    app.post('/api/im/wechat/webhook', require('express').text({ type: '*/xml' }), (req, res) => {
      const token = process.env.WECHAT_TOKEN;
      if (!token) {
        return res.status(400).send('Forbidden');
      }

      // Validate signature
      const { signature, timestamp, nonce } = req.query;
      const array = [token, timestamp, nonce].sort();
      const tempStr = array.join('');
      const hashCode = crypto.createHash('sha1').update(tempStr).digest('hex');

      if (hashCode !== signature) {
        console.warn('[IM Bot] WeChat invalid signature in POST webhook');
        return res.status(403).send('Invalid signature');
      }

      const xml = req.body;
      if (!xml) {
        return res.status(400).send('Empty body');
      }

      function extractXmlTag(xmlString, tag) {
        const match = xmlString.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`));
        return match ? match[1].trim() : null;
      }

      const fromUser = extractXmlTag(xml, 'FromUserName');
      const toUser = extractXmlTag(xml, 'ToUserName');
      const msgType = extractXmlTag(xml, 'MsgType');
      const text = (extractXmlTag(xml, 'Content') || '').trim();

      if (msgType !== 'text') {
        return sendWechatTextReply(res, fromUser, toUser, '🤖 抱歉，当前仅支持文本指令。');
      }

      function sendWechatTextReply(response, to, from, replyText) {
        response.type('application/xml');
        const replyXml = `<xml>
          <ToUserName><![CDATA[${to}]]></ToUserName>
          <FromUserName><![CDATA[${from}]]></FromUserName>
          <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[${replyText}]]></Content>
        </xml>`;
        response.send(replyXml);
      }

      // Check if user is bound
      if (!bindings.wechat) bindings.wechat = [];
      const isBound = bindings.wechat.some(user => user.openid === fromUser);

      if (!isBound) {
        const pBinding = pendingBindings.get(text);
        if (pBinding && pBinding.platform === 'wechat' && pBinding.expiresAt > Date.now()) {
          bindings.wechat.push({ openid: fromUser, username: `微信用户-${text}` });
          pBinding.bound = true;
          pBinding.username = `微信用户-${text}`;
          saveBindings();

          return sendWechatTextReply(res, fromUser, toUser, '🎉 微信绑定成功！\n\n您已成功将微信账号绑定至 Cyberpunk CCNOW。\n\n输入 "list会话" 查看活跃会话，或回复 "帮助" 查看可用指令列表。');
        } else {
          return sendWechatTextReply(res, fromUser, toUser, '🔒 未授权访问。\n\n请前往网页控制面板中的 IM BOT 面板生成 6 位 PIN 码，并将该 PIN 码直接发送给我以完成微信绑定。');
        }
      }

      // Help command
      if (text === '帮助' || text.toLowerCase() === 'help' || text === '/help') {
        return sendWechatTextReply(res, fromUser, toUser, 
          '🤖 微信终端助手可用命令：\n' +
          '• list会话 - 列出所有 TMUX 会话\n' +
          '• switch会话 <会话名> - 切换当前活动会话\n' +
          '• 查看状态 - 查看当前活动会话屏幕\n' +
          '• 帮助 - 查看本帮助消息\n\n' +
          '直接回复任何非指令文本，我将直接投递至活动会话终端输入中！'
        );
      }

      // List sessions command
      if (text === 'list会话' || text.toLowerCase() === '/list' || text.toLowerCase() === 'list') {
        execTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_path}'], (err, stdout) => {
          if (err) {
            return sendWechatTextReply(res, fromUser, toUser, '🖥️ 服务器上当前没有活跃的 Tmux 会话。');
          }
          const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
          let reply = '🖥️ TMUX 会话列表：\n';
          const activeSession = bindings.activeSessions[fromUser] || '无';

          lines.forEach(line => {
            const [name, attached, pathStr] = line.split('|');
            const attachedStatus = parseInt(attached, 10) > 0 ? '🟢 活跃' : '⚪ 挂起';
            reply += `• ${name} [${attachedStatus}]\n  路径: ${pathStr}\n`;
          });
          reply += `\n🎯 当前活动会话：${activeSession}\n回复 "switch会话 <名>" 可切换。`;
          sendWechatTextReply(res, fromUser, toUser, reply);
        });
        return;
      }

      // Switch session command
      if (text.startsWith('switch会话') || text.startsWith('/switch') || text.startsWith('switch')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
          return sendWechatTextReply(res, fromUser, toUser, '⚠️ 使用方法：switch会话 <会话名称>');
        }
        const sessionName = parts[1];
        execTmux(['list-sessions', '-F', '#{session_name}'], (err, stdout) => {
          if (err) {
            return sendWechatTextReply(res, fromUser, toUser, '❌ 获取会话列表时发生错误。');
          }
          const sessions = stdout.split('\n').map(s => s.trim()).filter(Boolean);
          if (!sessions.includes(sessionName)) {
            return sendWechatTextReply(res, fromUser, toUser, `❌ 会话 ${sessionName} 不存在。`);
          }
          
          bindings.activeSessions[fromUser] = sessionName;
          saveBindings();
          sendWechatTextReply(res, fromUser, toUser, `🎯 活动会话已切换为：${sessionName}`);
        });
        return;
      }

      // Status command
      if (text === '查看状态' || text.toLowerCase() === 'status' || text.toLowerCase() === '/status') {
        const sessionName = bindings.activeSessions[fromUser];
        if (!sessionName) {
          return sendWechatTextReply(res, fromUser, toUser, '⚠️ 尚未选择活动会话。使用 "list会话" 查看，然后通过 "switch会话 <名>" 绑定一个。');
        }

        execTmux(['capture-pane', '-t', sessionName, '-p'], (err, stdout) => {
          if (err) {
            return sendWechatTextReply(res, fromUser, toUser, `❌ 截取屏幕失败：${err.message}`);
          }
          const cleanOutput = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          const lastLines = cleanOutput.split('\n').slice(-20).join('\n');
          
          sendWechatTextReply(res, fromUser, toUser, `🖥️ 会话实时屏幕：${sessionName}\n\n${lastLines}`);
        });
        return;
      }

      // Regular message input (Send keys to active session)
      const sessionName = bindings.activeSessions[fromUser];
      if (!sessionName) {
        return sendWechatTextReply(res, fromUser, toUser, '⚠️ 尚未选择活动会话。请先回复 "switch会话 <名>" 选择一个会话，再发送键盘输入。');
      }

      // Send inputs to session
      execTmux(['send-keys', '-t', sessionName, text, 'Enter'], (err) => {
        if (err) {
          sendWechatTextReply(res, fromUser, toUser, `❌ 发送键盘输入失败：${err.message}`);
        } else {
          // Confirm keys were sent and wait 2 seconds to capture the command output
          setTimeout(() => {
            execTmux(['capture-pane', '-t', sessionName, '-p'], (err, stdout) => {
              if (err) {
                sendWechatTextReply(res, fromUser, toUser, `📥 输入已投递，但获取最新屏幕失败。`);
              } else {
                const cleanOutput = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
                const lastLines = cleanOutput.split('\n').slice(-15).join('\n');
                sendWechatTextReply(res, fromUser, toUser, `📥 输入已投递：${text}\n\n${lastLines}`);
              }
            });
          }, 2000);
        }
      });
    });

    // 5. Magic Link login handler (No auth required because token acts as auth)
    app.get('/api/im/login', (req, res) => {
      const { token } = req.query;
      if (!token) {
        return res.status(400).send('<h1>登录失败</h1><p>缺少 Token 参数。</p>');
      }

      // Check User-Agent: Prevent Telegram Bot link preview scrapers from consuming the token
      const ua = req.headers['user-agent'] || '';
      const isCrawler = /TelegramBot|Twitterbot|Slackbot|Discordbot|facebookexternalhit|WhatsApp/i.test(ua);
      if (isCrawler) {
        console.log(`[IM Bot] Blocked link preview crawler from consuming token. User-Agent: ${ua}`);
        return res.send('<html><head><title>Control Deck</title></head><body>Loading...</body></html>');
      }

      if (usedTokens.has(token)) {
        return res.status(401).send('<h1>登录失败</h1><p>该免密登录链接仅限单次有效，已被使用。请重新在机器人中发送 /link 获取新链接。</p>');
      }

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Verify that the Chat ID inside the token is still bound
        const boundUser = bindings.telegram.find(user => user.chatId === decoded.chatId);
        if (!boundUser) {
          return res.status(401).send('<h1>登录失败</h1><p>发起此请求的 Telegram 账号未绑定或已被解除绑定。</p>');
        }

        // Mark token as used
        usedTokens.add(token);

        // Issue standard session cookie (valid for 7 days)
        const useHttps = !!(process.env.SSL_CERT_PATH && process.env.SSL_KEY_PATH);
        const { MULTI_USER_ENABLED } = require('./config');
        
        let jwtPayload;
        if (MULTI_USER_ENABLED) {
          const db = require('./services/dbService');
          const users = db.getUsers();
          const username = boundUser.webUsername || 'admin';
          const storedUser = users[username.toLowerCase()];
          const role = storedUser ? storedUser.role : 'user';
          jwtPayload = { username, role, isMultiUser: true };
        } else {
          jwtPayload = { username: 'admin', role: 'admin', isMultiUser: false };
        }

        const sessionToken = jwt.sign(jwtPayload, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', sessionToken, {
          httpOnly: true,
          secure: useHttps,
          maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        // Redirect to index
        return res.redirect('/index.html');

      } catch (err) {
        return res.status(401).send('<h1>登录链接无效或已过期</h1><p>免密登录链接有效时间为 60 秒，请重新在机器人中发送 /link 获取。</p>');
      }
    });

    // 6. Telegram Webhook Receiver
    app.post('/api/im/telegram/webhook', async (req, res) => {
      // Validate webhook secret token if configured
      const configuredSecret = process.env.TELEGRAM_SECRET_TOKEN;
      if (configuredSecret) {
        const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (incomingSecret !== configuredSecret) {
          console.warn(`[IM Bot] Blocked unauthorized Webhook access attempt from IP ${req.ip}`);
          return res.status(403).send('Forbidden: Invalid secret token');
        }
      }

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
        } else if (action === 'switch') {
          bindings.activeSessions[chatId] = sessionName;
          saveBindings();

          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: queryId, text: `🎯 活动会话已切换为: ${sessionName}` })
          });

          const { text: updatedText, replyMarkup: updatedMarkup } = await getSessionsListMessage(chatId);
          fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: msgId,
              text: updatedText,
              reply_markup: updatedMarkup,
              parse_mode: 'HTML'
            })
          }).then(res => res.json()).then(data => {
            if (!data.ok && !data.description.includes('message is not modified')) {
              console.error('[IM Bot] editMessageText error:', data);
            }
          }).catch(err => console.error('[IM Bot] Edit message network error:', err));
        } else if (action === 'refresh_list') {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: queryId, text: `🔄 列表已刷新` })
          });

          const { text: updatedText, replyMarkup: updatedMarkup } = await getSessionsListMessage(chatId);
          fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: msgId,
              text: updatedText,
              reply_markup: updatedMarkup,
              parse_mode: 'HTML'
            })
          }).then(res => res.json()).then(data => {
            if (!data.ok && !data.description.includes('message is not modified')) {
              console.error('[IM Bot] editMessageText error:', data);
            }
          }).catch(err => console.error('[IM Bot] Edit message network error:', err));
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
            const existing = bindings.telegram.find(user => user.chatId === chatId);
            if (existing) {
              existing.username = username;
              existing.webUsername = pBinding.webUsername || 'admin';
            } else {
              bindings.telegram.push({
                chatId,
                username,
                webUsername: pBinding.webUsername || 'admin'
              });
            }
            pBinding.bound = true;
            pBinding.username = username;
            
            saveBindings();
            
            await sendTelegramMessage(chatId, `🎉 <b>赛博朋克 CCNOW 绑定成功！</b>\n\n你现在可以实时接收通知，并在此直接管理你的 TMUX 会话了。\n\n发送 /list 列出所有会话。`);
            return;
          } else {
            await sendTelegramMessage(chatId, `❌ <b>无效或已过期的绑定 PIN 码。</b>\n\n请在网页端仪表盘重新生成并扫描绑定二维码。`);
            return;
          }
        } else {
          await sendTelegramMessage(chatId, `🤖 <b>赛博朋克 CCNOW 机器人</b>\n\n请前往你的网页控制面板，点击 <b>IM BOT</b> 按钮并扫描二维码进行绑定。`);
          return;
        }
      }

      // Verify authorization for all other commands
      const boundUser = bindings.telegram.find(user => user.chatId === chatId);
      if (!boundUser) {
        await sendTelegramMessage(chatId, `🔒 <b>未授权访问。</b>\n\n请先在网页端仪表盘扫描绑定二维码。`);
        return;
      }

      // Get user context for multi-user mode
      const { MULTI_USER_ENABLED } = require('./config');
      const webUsername = boundUser.webUsername || 'admin';
      const prefix = `u_${webUsername}_`;

      // Command: /help
      if (text === '/help') {
        await sendTelegramMessage(chatId, 
          `🤖 <b>可用命令列表：</b>\n` +
          `• /list - 列出所有 TMUX 会话\n` +
          `• /switch &lt;session&gt; - 切换当前活动会话\n` +
          `• /status - 查看当前活动会话屏幕\n` +
          `• /link - 获取 60 秒免密登录链接\n` +
          `• /help - 查看本帮助消息\n\n` +
          `<i>你也可以直接回复任何文本，机器人会将其作为键盘输入发送给活动终端！</i>`
        );
        return;
      }

      // Command: /link or /login
      if (text === '/link' || text === '/login') {
        const token = jwt.sign(
          { authenticated: true, chatId: chatId },
          process.env.JWT_SECRET,
          { expiresIn: '60s' }
        );
        
        const domainName = process.env.DOMAIN_NAME || 'outshine.cloud';
        const loginUrl = `https://${domainName}/api/im/login?token=${token}`;
        
        await sendTelegramMessage(chatId, 
          `🔗 <b>免密登录链接已生成</b>\n` +
          `该链接有效时间为 <b>60 秒</b>，且仅限使用<b>单次</b>。请在手机浏览器中打开：\n\n` +
          `👉 <a href="${loginUrl}">点击此处一键免密登录 Control Deck</a>`
        );
        return;
      }

      // Command: /list
      if (text === '/list') {
        const { text: listText, replyMarkup } = await getSessionsListMessage(chatId);
        await sendTelegramMessage(chatId, listText, replyMarkup);
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
        const physicalSession = MULTI_USER_ENABLED ? `${prefix}${sessionName}` : sessionName;

        execTmux(['list-sessions', '-F', '#{session_name}'], async (err, stdout) => {
          if (err) {
            await sendTelegramMessage(chatId, `❌ 获取会话列表时发生错误。`);
            return;
          }
          const sessions = stdout.split('\n').map(s => s.trim()).filter(Boolean);
          if (!sessions.includes(physicalSession)) {
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
        const physicalSession = MULTI_USER_ENABLED ? `${prefix}${sessionName}` : sessionName;

        execTmux(['capture-pane', '-t', physicalSession, '-p'], async (err, stdout) => {
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

      const physicalSession = MULTI_USER_ENABLED ? `${prefix}${sessionName}` : sessionName;

      // Send inputs to session
      execTmux(['send-keys', '-t', physicalSession, text, 'Enter'], (err) => {
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
    const title = payload.title || 'Notification';
    const body = payload.body || '';
    const session = payload.session;

    const { MULTI_USER_ENABLED } = require('./config');
    
    // Extract target user and clean session name
    let targetUser = null;
    let displaySession = session;
    if (MULTI_USER_ENABLED && session && session.startsWith('u_')) {
      const parts = session.split('_');
      if (parts.length >= 3) {
        targetUser = parts[1];
        displaySession = parts.slice(2).join('_');
      }
    }

    // 1. Send Telegram Notification if enabled
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    if (tgToken && bindings.telegram && bindings.telegram.length > 0) {
      let text = `🔔 <b>${escapeHTML(title)}</b>\n${escapeHTML(body)}`;
      if (session) {
        text += `\n\n会话：<code>${escapeHTML(displaySession)}</code>`;
      }

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
        if (targetUser && user.webUsername !== targetUser) {
          continue;
        }
        if (session && !bindings.activeSessions[user.chatId]) {
          bindings.activeSessions[user.chatId] = displaySession;
          saveBindings();
        }
        await sendTelegramMessage(user.chatId, text, replyMarkup);
      }
    }

    // 2. Send WeChat Work (WeCom) Notification if enabled
    const corpId = process.env.WECHAT_CORPID;
    const corpSecret = process.env.WECHAT_CORPSECRET;
    const agentId = process.env.WECHAT_AGENTID;

    if (corpId && corpSecret && agentId && bindings.wechat && bindings.wechat.length > 0) {
      try {
        const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;
        const tokenRes = await fetch(tokenUrl);
        const tokenData = await tokenRes.json();
        if (tokenData.errcode === 0 && tokenData.access_token) {
          const accessToken = tokenData.access_token;
          let text = `🔔 ${title}\n${body}`;
          if (session) {
            text += `\n\n会话：${displaySession}`;
          }

          const users = bindings.wechat
            .filter(u => !targetUser || u.webUsername === targetUser)
            .map(u => u.openid)
            .join('|');
          if (!users) return;
          const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;
          
          await fetch(sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              touser: users,
              msgtype: 'text',
              agentid: parseInt(agentId, 10),
              text: { content: text },
              safe: 0
            })
          });
        }
      } catch (err) {
        console.error('[IM Bot] WeCom notify network error:', err);
      }
    }

    // 3. Send WeChat ClawBot Notification if enabled
    if (bindings.wechat && Array.isArray(bindings.wechat)) {
      for (const user of bindings.wechat) {
        if (targetUser && user.webUsername !== targetUser) {
          continue;
        }
        if (!user.config || !user.config.botToken) {
          continue;
        }
        
        let text = `🔔 ${title}\n${body}`;
        if (session) {
          text += `\n\n会话/Session: ${displaySession}`;
        }
        
        try {
          const bodyPayload = {
            msg: {
              from_user_id: "",
              to_user_id: user.openid,
              client_id: `openclaw-weixin-notify-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              message_type: 2,
              message_state: 2,
              item_list: [
                {
                  type: 1,
                  text_item: { text }
                }
              ]
            }
          };
          await ilinkPostFetch(user.config.baseUrl || "https://ilinkai.weixin.qq.com", "ilink/bot/sendmessage", bodyPayload, user.config.botToken);
        } catch (err) {
          console.error(`[IM Bot] WeChat ClawBot notify error for ${user.openid}:`, err);
        }
      }
    }
  }
};
