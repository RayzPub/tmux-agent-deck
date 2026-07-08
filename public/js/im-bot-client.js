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
    imBotBtn.title = 'Connect IM Bot (Telegram/Feishu)';
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
          <div id="imBotConfigStatus" style="margin-bottom: 20px; font-size: 13px; border-left: 3px solid var(--neon-cyan); padding-left: 10px;">
            Checking server configuration...
          </div>
          
          <div id="imBotMainSection" class="hidden">
            <div style="border: 1px solid rgba(0, 240, 255, 0.25); padding: 15px; background: rgba(0,0,0,0.3); margin-bottom: 20px; border-radius: 4px;">
              <div style="font-size: 12px; color: var(--neon-cyan); margin-bottom: 10px; letter-spacing: 1px;">// BOUND INSTANCES</div>
              <div id="imBotDevicesList" style="display: flex; flex-direction: column; gap: 8px;">
                <div style="font-size: 12px; color: #888;">No bound accounts yet.</div>
              </div>
            </div>
            
            <div id="imBotQRSection" class="hidden" style="text-align: center; border: 1px dashed var(--border-neon); padding: 20px; margin-bottom: 20px; background: rgba(0,240,255,0.02); border-radius: 4px;">
              <div style="font-size: 12px; margin-bottom: 15px; line-height: 1.5;">Scan this QR code or click the button to open Telegram, then tap <b>Start</b>:</div>
              <div id="imBotQRCodeContainer" style="margin: 15px auto; width: 180px; height: 180px; background: #fff; border: 2px solid var(--neon-cyan); border-radius: 4px; box-shadow: 0 0 15px rgba(0, 240, 255, 0.3); overflow: hidden; display: flex; align-items: center; justify-content: center;">
                <img id="imBotQRImage" src="" alt="QR Code" style="width: 170px; height: 170px;" />
              </div>
              <div style="margin: 15px 0;">
                <a id="imBotTelegramLink" href="#" target="_blank" class="cyber-btn" style="display: inline-block; padding: 6px 15px; font-size: 11px; text-decoration: none;">OPEN IN TELEGRAM</a>
              </div>
              <div style="margin-top: 15px; font-size: 13px;">
                PIN Code: <span id="imBotBindingCode" style="font-size: 20px; font-weight: bold; color: var(--neon-magenta); letter-spacing: 3px; text-shadow: 0 0 8px var(--neon-magenta);">------</span>
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
        const configStatus = document.getElementById('imBotConfigStatus');
        const mainSection = document.getElementById('imBotMainSection');

        // Update the IM Bot button text inside the dropdown
        const imBotBtnSpan = imBotBtn.querySelector('span');
        if (imBotBtnSpan) {
          if (!data.enabled) {
            imBotBtnSpan.textContent = 'IM BOT: OFF';
            imBotBtn.classList.remove('active');
          } else if (data.bindings && data.bindings.length > 0) {
            imBotBtnSpan.textContent = `IM BOT: ${data.bindings.length} ACTIVE`;
            imBotBtn.classList.add('active');
          } else {
            imBotBtnSpan.textContent = 'IM BOT: UNBOUND';
            imBotBtn.classList.remove('active');
          }
        }

        if (!data.enabled) {
          configStatus.innerHTML = `⚠️ <span style="color: var(--neon-magenta);">IM Bot is not enabled on this server.</span><br>Please set <code>TELEGRAM_BOT_TOKEN</code> in your server's <code>.env</code> file and restart.`;
          configStatus.style.borderLeftColor = 'var(--neon-magenta)';
          mainSection.classList.add('hidden');
          return;
        }

        configStatus.innerHTML = `🟢 <b>IM Bot Service Active</b> (Supports Telegram Webhooks)`;
        configStatus.style.borderLeftColor = 'var(--neon-green)';
        mainSection.classList.remove('hidden');

        // Render devices list
        const devicesList = document.getElementById('imBotDevicesList');
        if (data.bindings && data.bindings.length > 0) {
          devicesList.innerHTML = data.bindings.map(device => `
            <div class="im-bot-device-item">
              <div class="im-bot-device-info">
                <span class="im-bot-device-platform">Telegram</span>
                <span style="font-weight: bold; color: #fff;">@${device.username || 'user'}</span>
                <span style="font-size: 10px; color: #666;">ID: ${device.chatId}</span>
              </div>
              <button class="im-bot-device-unbind" data-chat-id="${device.chatId}">UNBIND</button>
            </div>
          `).join('');

          // Hook unbind buttons
          devicesList.querySelectorAll('.im-bot-device-unbind').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const chatId = parseInt(e.target.getAttribute('data-chat-id'), 10);
              if (confirm(`Are you sure you want to disconnect Telegram ID ${chatId}?`)) {
                await unbindDevice(chatId);
              }
            });
          });
        } else {
          devicesList.innerHTML = `<div style="font-size: 12px; color: #888; text-align: center; padding: 10px 0;">No accounts bound yet. Scan the QR code to connect.</div>`;
        }

      } catch (err) {
        console.error('Error loading IM bot status:', err);
        document.getElementById('imBotConfigStatus').innerHTML = `❌ Error: ${err.message}`;
      }
    };

    const unbindDevice = async (chatId) => {
      try {
        const res = await fetch('/api/im/unbind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId })
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
        const res = await fetch('/api/im/binding-token');
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

        // Set Link
        document.getElementById('imBotTelegramLink').href = data.bindingUrl;

        // Render QR Code using standard QR API
        const qrImg = document.getElementById('imBotQRImage');
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.bindingUrl)}`;

        const pollStatusText = document.getElementById('imBotPollingStatus');
        pollStatusText.innerHTML = `<span class="pulse-dot"></span> Waiting for you to click Start in Telegram...`;

        // Start polling
        stopPolling();
        pollInterval = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/im/bind-status?token=${data.token}`);
            if (statusRes.ok) {
              const statusData = await statusRes.json();
              if (statusData.status === 'bound') {
                stopPolling();
                qrSection.classList.add('hidden');
                alert(`🎉 Account @${statusData.username} bound successfully!`);
                await refreshStatus();
              } else if (statusData.status === 'expired') {
                stopPolling();
                pollStatusText.textContent = `❌ Binding PIN expired. Please generate a new one.`;
              }
            }
          } catch (e) {
            console.error('Polling error:', e);
          }
        }, 3000);

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

    // Initial status check to update the button UI on page load
    refreshStatus();
  });
})();
