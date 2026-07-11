// Cyberpunk TMUX Agent Deck - IM Bot Integration Client
// This file is completely modular and self-contained to prevent regressions.

(function () {
  document.addEventListener('DOMContentLoaded', () => {
    // 1. Inject the IM Bot button in the header
    const pushToggleBtn = document.getElementById('pushToggleBtn');
    if (!pushToggleBtn) return; // Exit if header is not present (e.g. on login page)

    const imBotBtn = document.createElement('button');
    imBotBtn.id = 'imBotBtn';
    imBotBtn.className = 'header-btn';
    imBotBtn.title = 'Connect IM Bot (Telegram/WeChat)';
    imBotBtn.innerHTML = `
      <i data-lucide="message-square"></i>
      <span>IM BOT</span>
    `;
    pushToggleBtn.parentNode.insertBefore(imBotBtn, pushToggleBtn.nextSibling);

    // Re-render Lucide icons so the message-square icon loads
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // 2. Inject Modal styling
    const style = document.createElement('style');
    style.innerHTML = `
      #imBotModal .hidden {
        display: none !important;
      }
      .im-bot-tabs {
        display: flex;
        gap: 10px;
        margin-bottom: 15px;
        border-bottom: 1px solid rgba(0, 240, 255, 0.15);
        padding-bottom: 10px;
      }
      .im-bot-tab-btn {
        background: transparent;
        border: 1px solid rgba(0, 240, 255, 0.2);
        color: #888;
        cursor: pointer;
        font-family: var(--font-mono);
        font-size: 11px;
        padding: 4px 12px;
        border-radius: 3px;
        transition: all 0.2s ease;
      }
      .im-bot-tab-btn.active {
        border-color: var(--neon-cyan);
        color: var(--neon-cyan);
        box-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
        background: rgba(0, 240, 255, 0.05);
      }
      .im-bot-device-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: rgba(0, 240, 255, 0.05);
        border: 1px solid rgba(0, 240, 255, 0.2);
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 13px;
      }
      .im-bot-device-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .im-bot-device-platform {
        font-size: 10px;
        color: var(--neon-cyan);
        text-transform: uppercase;
      }
      .im-bot-device-unbind {
        background: transparent;
        border: none;
        color: var(--neon-magenta);
        cursor: pointer;
        font-family: var(--font-mono);
        font-size: 11px;
        padding: 2px 6px;
        border: 1px solid rgba(255, 0, 128, 0.3);
        border-radius: 3px;
        transition: all 0.2s ease;
      }
      .im-bot-device-unbind:hover {
        background: rgba(255, 0, 128, 0.1);
        border-color: var(--neon-magenta);
        box-shadow: 0 0 8px rgba(255, 0, 128, 0.4);
      }

      /* Modular IM Bot Card & Inner styling */
      .im-bot-card {
        border: 1px solid rgba(0, 240, 255, 0.25);
        padding: 15px;
        background: rgba(0, 0, 0, 0.3);
        margin-bottom: 20px;
        border-radius: 4px;
      }
      #imBotBoundTitle {
        font-size: 12px;
        color: var(--neon-cyan);
        margin-bottom: 10px;
        letter-spacing: 1px;
      }
      .im-bot-device-username {
        font-weight: bold;
        color: #fff;
      }
      .im-bot-device-chatid {
        font-size: 10px;
        color: #888;
      }
      .im-bot-qr-section {
        text-align: center;
        border: 1px dashed var(--border-neon);
        padding: 20px;
        margin-bottom: 20px;
        background: rgba(0, 240, 255, 0.02);
        border-radius: 4px;
      }
      .im-bot-qr-container {
        margin: 15px auto;
        width: 180px;
        height: 180px;
        background: #fff;
        border: 2px solid var(--neon-cyan);
        border-radius: 4px;
        box-shadow: 0 0 15px rgba(0, 240, 255, 0.3);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .im-bot-pin-code {
        font-size: 20px;
        font-weight: bold;
        color: var(--neon-pink);
        letter-spacing: 3px;
        text-shadow: 0 0 8px rgba(255, 0, 127, 0.4);
      }

      /* Light Theme minimal overrides */
      body.light-minimalist .im-bot-tabs {
        border-bottom-color: #cbd5e1;
      }
      body.light-minimalist .im-bot-tab-btn {
        border-color: #cbd5e1;
        color: #64748b;
      }
      body.light-minimalist .im-bot-tab-btn:hover {
        background: #f1f5f9;
        border-color: #94a3b8;
        color: #0f172a;
      }
      body.light-minimalist .im-bot-tab-btn.active {
        border-color: #4f46e5;
        color: #4f46e5;
        background: #eef2ff;
        box-shadow: none;
      }
      body.light-minimalist .im-bot-card {
        background: #f8fafc;
        border: 1px solid #cbd5e1;
      }
      body.light-minimalist #imBotBoundTitle {
        color: #0f172a;
      }
      body.light-minimalist .im-bot-device-item {
        background: #ffffff;
        border-color: #e2e8f0;
      }
      body.light-minimalist .im-bot-device-platform {
        color: #4f46e5;
      }
      body.light-minimalist .im-bot-device-username {
        color: #0f172a;
      }
      body.light-minimalist .im-bot-device-chatid {
        color: #64748b;
      }
      body.light-minimalist .im-bot-device-unbind {
        border-color: rgba(239, 68, 68, 0.3);
        color: #ef4444;
      }
      body.light-minimalist .im-bot-device-unbind:hover {
        background: #fef2f2;
        border-color: #ef4444;
        box-shadow: none;
      }
      body.light-minimalist .im-bot-qr-section {
        background: #f8fafc;
        border-color: #cbd5e1;
      }
      body.light-minimalist .im-bot-qr-container {
        border-color: #4f46e5;
        box-shadow: none;
      }
      body.light-minimalist .im-bot-pin-code {
        color: #4f46e5;
        text-shadow: none;
      }
    `;
    document.head.appendChild(style);

    // 3. Inject Modal HTML structure
    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'imBotModal';
    modalOverlay.className = 'modal-overlay hidden';
    modalOverlay.innerHTML = `
      <div class="modal-card" style="max-width: 500px;">
        <div class="modal-header">
          <h3><i data-lucide="message-square"></i> IM BOT INTEGRATION</h3>
          <button class="modal-close" id="closeImBotModalBtn"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body" style="font-family: var(--font-mono); color: var(--color-text);">
          <div class="im-bot-tabs">
            <button class="im-bot-tab-btn active" id="imBotTabTelegram">TELEGRAM</button>
            <button class="im-bot-tab-btn" id="imBotTabWechat">WECHAT</button>
          </div>

          <div id="imBotConfigStatus" style="margin-bottom: 20px; font-size: 13px; border-left: 3px solid var(--neon-cyan); padding-left: 10px;">
            Checking server configuration...
          </div>
          
          <div id="imBotMainSection" class="hidden">
            <div class="im-bot-card">
              <div id="imBotBoundTitle">// BOUND INSTANCES</div>
              <div id="imBotDevicesList" style="display: flex; flex-direction: column; gap: 8px;">
                <div style="font-size: 12px; color: #888;">No bound accounts yet.</div>
              </div>
            </div>
            
            <div id="imBotQRSection" class="hidden im-bot-qr-section">
              <div id="imBotQRInstructions" style="font-size: 12px; margin-bottom: 15px; line-height: 1.5;">Scan this QR code or click the button to open Telegram, then tap <b>Start</b>:</div>
              <div id="imBotQRCodeContainer" class="im-bot-qr-container"></div>
              <div id="imBotTelegramLinkContainer" style="margin: 15px 0;">
                <a id="imBotTelegramLink" href="#" target="_blank" class="cyber-btn" style="display: inline-block; padding: 6px 15px; font-size: 11px; text-decoration: none;">OPEN IN TELEGRAM</a>
              </div>
              <div id="imBotPinContainer" style="margin-top: 15px; font-size: 13px;">
                PIN Code: <span id="imBotBindingCode" class="im-bot-pin-code">------</span>
              </div>
              <div style="font-size: 11px; color: var(--neon-cyan); margin-top: 12px;" id="imBotPollingStatus">Waiting for connection...</div>
            </div>
            
            <div class="modal-actions" style="margin-top: 20px;">
              <button type="button" class="cyber-btn" id="imBotGenTokenBtn">LINK NEW ACCOUNT</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalOverlay);

    // Re-render Lucide icons for the newly injected modal
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // 4. State variables
    let pollInterval = null;
    let currentPlatform = 'telegram';
    let globalIMData = null;

    // 5. Functions
    const openModal = async () => {
      modalOverlay.classList.remove('hidden');
      await refreshStatus();
    };

    const closeModal = () => {
      modalOverlay.classList.add('hidden');
      stopPolling();
      document.getElementById('imBotQRSection').classList.add('hidden');
    };

    const stopPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    const refreshStatus = async () => {
      try {
        const res = await fetch('/api/im/status');
        if (!res.ok) throw new Error('Failed to load status');
        
        const data = await res.json();
        globalIMData = data;

        // Update the IM Bot button text inside the dropdown
        const imBotBtnSpan = imBotBtn.querySelector('span');
        if (imBotBtnSpan) {
          const totalActive = (data.bindings ? data.bindings.length : 0) + (data.wechatBindings ? data.wechatBindings.length : 0);
          const anyEnabled = data.enabled || data.wechatEnabled;
          
          if (!anyEnabled) {
            imBotBtnSpan.textContent = 'IM BOT: OFF';
            imBotBtn.classList.remove('active');
          } else if (totalActive > 0) {
            imBotBtnSpan.textContent = `IM BOT: ${totalActive} ACTIVE`;
            imBotBtn.classList.add('active');
          } else {
            imBotBtnSpan.textContent = 'IM BOT: UNBOUND';
            imBotBtn.classList.remove('active');
          }
        }

        renderPlatformUI();

      } catch (err) {
        console.error('Error loading IM bot status:', err);
        document.getElementById('imBotConfigStatus').innerHTML = `❌ Error: ${err.message}`;
      }
    };

    const renderPlatformUI = () => {
      if (!globalIMData) return;
      const data = globalIMData;
      const configStatus = document.getElementById('imBotConfigStatus');
      const mainSection = document.getElementById('imBotMainSection');
      const devicesList = document.getElementById('imBotDevicesList');
      const genTokenBtn = document.getElementById('imBotGenTokenBtn');

      // Update tabs active state
      document.getElementById('imBotTabTelegram').classList.toggle('active', currentPlatform === 'telegram');
      document.getElementById('imBotTabWechat').classList.toggle('active', currentPlatform === 'wechat');

      if (currentPlatform === 'telegram') {
        genTokenBtn.textContent = 'LINK TELEGRAM ACCOUNT';
        if (!data.enabled) {
          configStatus.innerHTML = `⚠️ <span style="color: var(--neon-magenta);">Telegram Bot is not enabled.</span><br>Please set <code>TELEGRAM_BOT_TOKEN</code> in your server's <code>.env</code> file and restart.`;
          configStatus.style.borderLeftColor = 'var(--neon-magenta)';
          mainSection.classList.add('hidden');
          return;
        }

        configStatus.innerHTML = `🟢 <b>Telegram Bot Active</b> (Supports Telegram Webhooks)`;
        configStatus.style.borderLeftColor = 'var(--neon-green)';
        mainSection.classList.remove('hidden');

        // Render devices list
        if (data.bindings && data.bindings.length > 0) {
          devicesList.innerHTML = data.bindings.map(device => `
            <div class="im-bot-device-item">
              <div class="im-bot-device-info">
                <span class="im-bot-device-platform">Telegram</span>
                <span class="im-bot-device-username">@${device.username || 'user'}</span>
                <span class="im-bot-device-chatid">ID: ${device.chatId}</span>
              </div>
              <button class="im-bot-device-unbind" data-chat-id="${device.chatId}">UNBIND</button>
            </div>
          `).join('');

          // Hook unbind buttons
          devicesList.querySelectorAll('.im-bot-device-unbind').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const chatId = parseInt(e.target.getAttribute('data-chat-id'), 10);
              if (confirm(`Are you sure you want to disconnect Telegram ID ${chatId}?`)) {
                await unbindDevice(chatId, null, 'telegram');
              }
            });
          });
        } else {
          devicesList.innerHTML = `<div style="font-size: 12px; color: #888; text-align: center; padding: 10px 0;">No Telegram accounts bound yet. Click Link to connect.</div>`;
        }
      } else {
        // WeChat
        genTokenBtn.textContent = 'LINK WECHAT ACCOUNT';
        if (!data.wechatEnabled) {
          configStatus.innerHTML = `⚠️ <span style="color: var(--neon-magenta);">WeChat Bot is not enabled.</span>`;
          configStatus.style.borderLeftColor = 'var(--neon-magenta)';
          mainSection.classList.add('hidden');
          return;
        }

        configStatus.innerHTML = `🟢 <b>WeChat Bot Active</b> (iLink AI ClawBot)`;
        configStatus.style.borderLeftColor = 'var(--neon-green)';
        mainSection.classList.remove('hidden');

        // Render devices list
        if (data.wechatBindings && data.wechatBindings.length > 0) {
          devicesList.innerHTML = data.wechatBindings.map(device => `
            <div class="im-bot-device-item">
              <div class="im-bot-device-info">
                <span class="im-bot-device-platform">WeChat</span>
                <span class="im-bot-device-username">${device.username || 'WeChat User'}</span>
                <span class="im-bot-device-chatid">OpenID: ${device.openid.substring(0, 10)}...</span>
              </div>
              <button class="im-bot-device-unbind" data-openid="${device.openid}">UNBIND</button>
            </div>
          `).join('');

          // Hook unbind buttons
          devicesList.querySelectorAll('.im-bot-device-unbind').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const openid = e.target.getAttribute('data-openid');
              if (confirm(`Are you sure you want to disconnect WeChat User?`)) {
                await unbindDevice(null, openid, 'wechat');
              }
            });
          });
        } else {
          devicesList.innerHTML = `<div style="font-size: 12px; color: #888; text-align: center; padding: 10px 0;">No WeChat accounts bound yet. Click Link to connect.</div>`;
        }
      }
    };

    const unbindDevice = async (chatId, openid, platform) => {
      try {
        const res = await fetch('/api/im/unbind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, openid, platform })
        });
        if (res.ok) {
          await refreshStatus();
        } else {
          alert('Failed to unbind device.');
        }
      } catch (err) {
        alert(`Error unbinding device: ${err.message}`);
      }
    };

    const startBinding = async () => {
      try {
        const res = await fetch(`/api/im/binding-token?platform=${currentPlatform}`);
        if (!res.ok) {
          const errData = await res.json();
          alert(errData.error || 'Failed to generate token');
          return;
        }

        const data = await res.json();
        
        // Show QR section
        const qrSection = document.getElementById('imBotQRSection');
        qrSection.classList.remove('hidden');

        // Set Code
        document.getElementById('imBotBindingCode').textContent = data.token;

        const linkContainer = document.getElementById('imBotTelegramLinkContainer');
        const instructionsText = document.getElementById('imBotQRInstructions');
        const qrContainer = document.getElementById('imBotQRCodeContainer');
        qrContainer.innerHTML = '';
        const pollStatusText = document.getElementById('imBotPollingStatus');

        const pinContainer = document.getElementById('imBotPinContainer');

        if (currentPlatform === 'telegram') {
          if (pinContainer) pinContainer.classList.remove('hidden');
          linkContainer.classList.remove('hidden');
          document.getElementById('imBotTelegramLink').href = data.bindingUrl;
          instructionsText.innerHTML = `Scan this QR code or click the button to open Telegram, then tap <b>Start</b>:`;
          new QRCode(qrContainer, {
            text: data.bindingUrl,
            width: 170,
            height: 170,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
          pollStatusText.innerHTML = `<span class="pulse-dot"></span> Waiting for you to click Start in Telegram...`;
        } else {
          if (pinContainer) pinContainer.classList.add('hidden');
          linkContainer.classList.add('hidden');
          instructionsText.innerHTML = `请使用微信扫描下方二维码，并在手机上确认登录以授权：`;
          new QRCode(qrContainer, {
            text: data.qrCodeUrl,
            width: 170,
            height: 170,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
          pollStatusText.innerHTML = `<span class="pulse-dot"></span> 请用微信扫码，并在手机上确认登录`;
        }

        // Start polling
        stopPolling();
        let verifyCodePromptActive = false;

        const checkStatus = async () => {
          if (verifyCodePromptActive) return;
          try {
            const statusRes = await fetch(`/api/im/bind-status?token=${data.token}`);
            if (statusRes.ok) {
              const statusData = await statusRes.json();
              if (statusData.status === 'bound') {
                stopPolling();
                qrSection.classList.add('hidden');
                alert(`🎉 Bound successfully!`);
                await refreshStatus();
              } else if (statusData.status === 'expired') {
                stopPolling();
                pollStatusText.textContent = `❌ Binding PIN expired. Please generate a new one.`;
              } else if (statusData.status === 'need_verifycode') {
                verifyCodePromptActive = true;
                const code = prompt(statusData.message || '请输入手机微信上显示的两位数验证码：');
                if (code) {
                  try {
                    await fetch('/api/im/wechat/verify-code', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ token: data.token, code })
                    });
                  } catch (err) {
                    console.error('Failed to send verification code:', err);
                  }
                } else {
                  // User cancelled
                  stopPolling();
                  qrSection.classList.add('hidden');
                  pollStatusText.textContent = '❌ 连接已取消。';
                }
                verifyCodePromptActive = false;
              }
            }
          } catch (e) {
            console.error('Polling error:', e);
          }
        };

        pollInterval = setInterval(checkStatus, 3000);

      } catch (err) {
        alert(`Error starting bind: ${err.message}`);
      }
    };

    // 6. Hook Event Listeners
    imBotBtn.addEventListener('click', openModal);
    document.getElementById('closeImBotModalBtn').addEventListener('click', closeModal);
    
    // Clicking outside card closes modal
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        closeModal();
      }
    });

    document.getElementById('imBotGenTokenBtn').addEventListener('click', startBinding);

    // Tab buttons event listeners
    document.getElementById('imBotTabTelegram').addEventListener('click', () => {
      if (currentPlatform !== 'telegram') {
        currentPlatform = 'telegram';
        stopPolling();
        document.getElementById('imBotQRSection').classList.add('hidden');
        renderPlatformUI();
      }
    });

    document.getElementById('imBotTabWechat').addEventListener('click', () => {
      if (currentPlatform !== 'wechat') {
        currentPlatform = 'wechat';
        stopPolling();
        document.getElementById('imBotQRSection').classList.add('hidden');
        renderPlatformUI();
      }
    });

    // Initial status check to update the button UI on page load
    refreshStatus();
  });
})();
