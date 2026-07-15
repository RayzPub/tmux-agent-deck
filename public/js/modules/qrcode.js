/**
 * Module for mobile connection via QR Code with 60s temporary login token
 */

let activeToken = '';
let timerInterval = null;
let countdownSeconds = 0;
let cachedIps = [];

export function generateQrCode(url) {
  const container = document.getElementById('qrcodeContainer');
  if (!container) return;

  if (typeof QRCode === 'undefined') {
    container.innerHTML = `<span style="color: var(--neon-pink); font-family: var(--font-mono); font-size: 11px; text-align: center;">二维码生成库未加载。<br>请检查网络连接。</span>`;
    return;
  }

  // Clear container
  container.innerHTML = '';

  try {
    new QRCode(container, {
      text: url,
      width: 180,
      height: 180,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (error) {
    console.error('Failed to generate QR Code:', error);
    container.innerHTML = `<span style="color: var(--neon-pink); font-family: var(--font-mono); font-size: 11px;">生成二维码失败。</span>`;
  }
}

// Function to fetch a new temporary login token and refresh QR code/input
async function refreshLoginToken() {
  const qrCodeUrlSelect = document.getElementById('qrCodeUrlSelect');
  const qrCodeUrlInput = document.getElementById('qrCodeUrlInput');
  const qrcodeTimer = document.getElementById('qrcodeTimer');
  
  if (!qrCodeUrlSelect || !qrCodeUrlInput) return;

  try {
    // 1. Fetch short-lived token from backend
    const tokenRes = await fetch('/api/system/temp-login-token', { method: 'POST' });
    const tokenData = await tokenRes.json();
    
    if (!tokenData.success || !tokenData.token) {
      throw new Error(tokenData.error || '获取临时登录令牌失败');
    }

    activeToken = tokenData.token;
    countdownSeconds = tokenData.expiresIn || 60;

    // Update target URL and redraw QR code
    const baseUrl = qrCodeUrlSelect.value;
    const finalUrl = `${baseUrl}?token=${activeToken}`;
    qrCodeUrlInput.value = finalUrl;
    generateQrCode(finalUrl);

    // Reset countdown display
    if (qrcodeTimer) {
      const timerSpan = qrcodeTimer.querySelector('span');
      if (timerSpan) timerSpan.textContent = `有效期剩余: ${countdownSeconds}秒`;
    }

    // Start timer interval if not already running
    startCountdown();

  } catch (err) {
    console.error('Error refreshing login token:', err);
    const container = document.getElementById('qrcodeContainer');
    if (container) {
      container.innerHTML = `<span style="color: var(--neon-pink); font-family: var(--font-mono); font-size: 11px;">获取登录令牌失败。<br>${err.message}</span>`;
    }
  }
}

// Handles countdown timer decrementing
function startCountdown() {
  clearInterval(timerInterval);
  
  const qrcodeTimer = document.getElementById('qrcodeTimer');
  if (!qrcodeTimer) return;
  const timerSpan = qrcodeTimer.querySelector('span');

  timerInterval = setInterval(() => {
    countdownSeconds--;
    if (timerSpan) {
      timerSpan.textContent = `有效期剩余: ${countdownSeconds}秒`;
    }

    if (countdownSeconds <= 0) {
      clearInterval(timerInterval);
      // Auto renew
      refreshLoginToken();
    }
  }, 1000);
}

export function initQrCode() {
  const qrCodeBtn = document.getElementById('qrCodeBtn');
  const qrCodeModal = document.getElementById('qrCodeModal');
  const closeQrCodeModalBtn = document.getElementById('closeQrCodeModalBtn');
  const closeQrCodeModalOkBtn = document.getElementById('closeQrCodeModalOkBtn');
  const qrCodeUrlSelect = document.getElementById('qrCodeUrlSelect');
  const qrCodeUrlInput = document.getElementById('qrCodeUrlInput');
  const copyQrCodeUrlBtn = document.getElementById('copyQrCodeUrlBtn');

  if (!qrCodeBtn || !qrCodeModal) return;

  // Hide the QR code button on mobile devices or small screens where scanning is not applicable
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) 
                    || window.innerWidth <= 768;
  if (isMobile) {
    qrCodeBtn.style.display = 'none';
    return;
  }

  // Toggle modal open
  qrCodeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    
    // Reset/loading state
    qrCodeUrlInput.value = '正在初始化安全通道...';
    const container = document.getElementById('qrcodeContainer');
    if (container) {
      container.innerHTML = '<div class="cyber-spinner" style="border-color: var(--neon-cyan); border-right-color: transparent;"></div>';
    }

    qrCodeModal.classList.remove('hidden');

    try {
      // Fetch network IPs from backend if not cached
      if (cachedIps.length === 0) {
        const response = await fetch('/api/system/network-ips');
        const data = await response.json();
        if (data.success && Array.isArray(data.ips)) {
          cachedIps = data.ips;
        }
      }

      // Rebuild native select options (values will be the login-by-token endpoint base URLs)
      qrCodeUrlSelect.innerHTML = '';

      // 1. Current host option
      const currentBaseUrl = `${window.location.protocol}//${window.location.host}/api/login-by-token`;
      const currentOpt = document.createElement('option');
      currentOpt.value = currentBaseUrl;
      currentOpt.textContent = `当前网址 (${window.location.hostname})`;
      qrCodeUrlSelect.appendChild(currentOpt);

      // 2. Local network IP options
      cachedIps.forEach(ip => {
        const baseUrl = `${window.location.protocol}//${ip.address}${window.location.port ? ':' + window.location.port : ''}/api/login-by-token`;
        const opt = document.createElement('option');
        opt.value = baseUrl;
        opt.textContent = `${ip.name} (${ip.address})`;
        qrCodeUrlSelect.appendChild(opt);
      });

      // Find preferred IP for default if on localhost/127.0.0.1
      let defaultBaseUrl = currentBaseUrl;
      if ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && cachedIps.length > 0) {
        const preferredIp = cachedIps.find(ip => ip.address.startsWith('192.168') || ip.address.startsWith('10.') || ip.address.startsWith('172.'));
        const targetIp = preferredIp ? preferredIp.address : cachedIps[0].address;
        defaultBaseUrl = `${window.location.protocol}//${targetIp}${window.location.port ? ':' + window.location.port : ''}/api/login-by-token`;
      }

      // Set select option
      qrCodeUrlSelect.value = defaultBaseUrl;
      
      // Fetch first token and draw QR code
      await refreshLoginToken();

    } catch (err) {
      console.error('Failed to initialize QR code URLs:', err);
      // Fallback
      qrCodeUrlSelect.innerHTML = '';
      const currentBaseUrl = `${window.location.protocol}//${window.location.host}/api/login-by-token`;
      const currentOpt = document.createElement('option');
      currentOpt.value = currentBaseUrl;
      currentOpt.textContent = `当前网址 (${window.location.hostname})`;
      qrCodeUrlSelect.appendChild(currentOpt);

      qrCodeUrlSelect.value = currentBaseUrl;
      await refreshLoginToken();
    }
  });

  // Select change handler
  qrCodeUrlSelect.addEventListener('change', () => {
    if (!activeToken) return;
    const baseUrl = qrCodeUrlSelect.value;
    const finalUrl = `${baseUrl}?token=${activeToken}`;
    qrCodeUrlInput.value = finalUrl;
    generateQrCode(finalUrl);
  });

  // Copy URL action
  if (copyQrCodeUrlBtn && qrCodeUrlInput) {
    copyQrCodeUrlBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(qrCodeUrlInput.value);
        
        // Visual feedback
        const icon = copyQrCodeUrlBtn.querySelector('i, svg');
        if (icon) {
          icon.setAttribute('data-lucide', 'check');
          if (window.lucide) window.lucide.createIcons();
          setTimeout(() => {
            icon.setAttribute('data-lucide', 'copy');
            if (window.lucide) window.lucide.createIcons();
          }, 1500);
        }
      } catch (err) {
        console.error('Failed to copy text:', err);
      }
    });
  }

  // Close handler
  const closeBtnHandler = () => {
    qrCodeModal.classList.add('hidden');
    clearInterval(timerInterval);
    timerInterval = null;
    activeToken = '';
  };

  if (closeQrCodeModalBtn) closeQrCodeModalBtn.addEventListener('click', closeBtnHandler);
  if (closeQrCodeModalOkBtn) closeQrCodeModalOkBtn.addEventListener('click', closeBtnHandler);

  // Close when clicking outside card
  qrCodeModal.addEventListener('click', (e) => {
    if (e.target === qrCodeModal) {
      closeBtnHandler();
    }
  });
}
