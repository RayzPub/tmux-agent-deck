/**
 * No-Device / Offline Device Onboarding Module
 * Replaces the generic welcome guide when the user has no online compute device,
 * guiding them directly to start their Managed Docker Sandbox or pair a local machine.
 */

import { state } from './state.js';
import { toast } from './toast.js';
import { openHelpDocTab } from './helpDoc.js';

let obPairMode = 'daemon';
let obPairCommands = { daemon: '', foreground: '' };
let obPairExpireAt = 0;
let obSandboxStatus = null;
let obLoadingSandbox = false;
let obStartingSandbox = false;
let obLoadingPair = false;
let obCopyTimer = null;
let obInitialized = false;

/**
 * Determine whether the currently selected device is online.
 */
export function isCurrentDeviceOnline() {
  const id = state.currentDeviceId;
  if (!id || id === 'cloud') return false;
  const dev = (state.remoteDevices || []).find(d => d.deviceId === id);
  return Boolean(dev && dev.isOnline);
}

/**
 * Determine whether the user has any online device at all.
 */
export function hasAnyOnlineDevice() {
  return (state.remoteDevices || []).some(d => Boolean(d && d.isOnline));
}

/**
 * Switch the welcome panel between Ready State and No-Device Onboarding State.
 */
export function syncOnboardingView(options = {}) {
  const readyEl = document.getElementById('welcomeReadyState');
  const onboardingEl = document.getElementById('welcomeOnboardingState');
  const welcomePanel = document.getElementById('welcomePanel');
  if (!readyEl || !onboardingEl) return;

  const currentOnline = isCurrentDeviceOnline();
  const anyOnline = hasAnyOnlineDevice();
  const showOnboarding = !currentOnline;

  readyEl.classList.toggle('hidden', showOnboarding);
  onboardingEl.classList.toggle('hidden', !showOnboarding);
  if (welcomePanel) {
    welcomePanel.classList.toggle('is-onboarding', showOnboarding);
  }

  if (!showOnboarding) {
    return;
  }

  // Tailor headline/subtitle based on whether user has 0 devices or offline devices
  const devices = state.remoteDevices || [];
  const titleEl = document.getElementById('obTitle');
  const subtitleEl = document.getElementById('obSubtitle');
  const offlineSummary = document.getElementById('obOfflineSummary');
  const offlineSummaryText = document.getElementById('obOfflineSummaryText');

  if (devices.length === 0) {
    if (titleEl) titleEl.textContent = '接入你的第一台算力设备';
    if (subtitleEl) {
      subtitleEl.textContent = '启动专属云端隔离沙箱，或一行命令接入自己的 Mac / Linux / Windows，设备上线后将自动进入工作台。';
    }
    if (offlineSummary) offlineSummary.classList.add('hidden');
  } else if (anyOnline) {
    // Current selected device is offline, though user has another online device
    const currDev = devices.find(d => d.deviceId === state.currentDeviceId);
    const currName = currDev?.name || currDev?.hostname || '当前设备';
    if (titleEl) titleEl.textContent = `${currName} 当前离线`;
    if (subtitleEl) {
      subtitleEl.textContent = '你可以唤醒云电脑、重新接入该设备，或点击左上角切换至其他在线设备。';
    }
    if (offlineSummary && offlineSummaryText) {
      offlineSummaryText.textContent = `已有 ${devices.filter(d => d.isOnline).length} 台其他设备在线，可在左上角直接切换`;
      offlineSummary.classList.remove('hidden');
    }
  } else {
    if (titleEl) titleEl.textContent = '当前暂无在线设备';
    if (subtitleEl) {
      subtitleEl.textContent = '一键唤醒休眠中的云电脑，或在本地终端启动 Agent，上线后将自动恢复工作区与会话。';
    }
    if (offlineSummary && offlineSummaryText) {
      const names = devices.slice(0, 2).map(d => d.name || d.hostname).filter(Boolean).join('、');
      const more = devices.length > 2 ? ` 等 ${devices.length} 台设备` : '';
      offlineSummaryText.textContent = `已绑定但离线：${names}${more}`;
      offlineSummary.classList.remove('hidden');
    }
  }

  // Refresh sandbox status & pair command lazily when entering onboarding
  if (options.forceRefresh || !obSandboxStatus) {
    loadOnboardingSandboxCard();
  } else {
    renderSandboxCard(obSandboxStatus);
  }

  const now = Date.now();
  const needNewPair = options.forceRefresh || !obPairCommands.daemon || (obPairExpireAt > 0 && obPairExpireAt - now < 60 * 1000);
  if (needNewPair) {
    refreshOnboardingPairToken();
  } else {
    applyOnboardingPairModeUI(obPairMode);
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

/**
 * Fetch Docker Sandbox status and update the left onboarding card.
 */
export async function loadOnboardingSandboxCard() {
  if (obLoadingSandbox) return;
  obLoadingSandbox = true;

  try {
    const res = await fetch('/api/sandbox/status');
    if (!res.ok) throw new Error('无法获取云电脑状态');
    const data = await res.json();
    obSandboxStatus = data;
    renderSandboxCard(data);
  } catch (err) {
    console.warn('[DeviceOnboarding] Failed to load sandbox status:', err);
    renderSandboxCard({ dockerAvailable: false, error: err.message });
  } finally {
    obLoadingSandbox = false;
  }
}

function renderSandboxCard(data) {
  const card = document.getElementById('obSandboxCard');
  const badge = document.getElementById('obSandboxBadge');
  const tagline = document.getElementById('obSandboxTagline');
  const quotaText = document.getElementById('obSandboxQuotaText');
  const btn = document.getElementById('obStartSandboxBtn');
  const btnText = document.getElementById('obStartSandboxBtnText');
  if (!card || !btn) return;

  if (obStartingSandbox) return;

  const dockerOk = Boolean(data && data.dockerAvailable);
  const imageOk = dockerOk && data.imageReady !== false;

  if (!dockerOk || !imageOk) {
    card.classList.add('is-unavailable');
    if (badge) {
      badge.textContent = '未启用';
      badge.className = 'ob-badge muted';
    }
    if (tagline) {
      tagline.textContent = !dockerOk
        ? '当前服务器未开启托管云电脑服务，请使用右侧接入你自己的电脑'
        : '云电脑镜像尚未就绪，请联系管理员构建沙箱镜像或先接入本机';
    }
    if (quotaText) {
      quotaText.textContent = !dockerOk ? '服务端未启用 Docker 沙箱' : '等待服务端构建 ccnow-sandbox 镜像';
    }
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="slash"></i><span id="obStartSandboxBtnText">暂不可用</span>`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  card.classList.remove('is-unavailable');
  const isRunning = Boolean(data.running);
  const isOnline = Boolean(data.isOnline);
  const limits = data.limits || {};
  const cpus = limits.cpus || '1';
  const mem = String(limits.memory || '1g').toUpperCase();
  const idleMin = data.idleTimeoutMinutes || 30;

  if (quotaText) {
    quotaText.textContent = `配置：${cpus} 核 · ${mem} 内存 · 闲置 ${idleMin} 分钟自动休眠`;
  }
  if (tagline) {
    tagline.textContent = '专属隔离 Docker 沙箱 · 内置云端模型代理 · 开箱即用';
  }

  if (isRunning && isOnline && data.deviceId) {
    if (badge) {
      badge.textContent = '运行中';
      badge.className = 'ob-badge online';
    }
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="arrow-right-circle"></i><span id="obStartSandboxBtnText">立即进入云电脑</span>`;
  } else if (isRunning) {
    if (badge) {
      badge.textContent = '连接中';
      badge.className = 'ob-badge sandbox';
    }
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="refresh-cw"></i><span id="obStartSandboxBtnText">刷新连接状态</span>`;
  } else if (data.exists) {
    if (badge) {
      badge.textContent = '已休眠';
      badge.className = 'ob-badge muted';
    }
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="play"></i><span id="obStartSandboxBtnText">一键唤醒云电脑</span>`;
  } else {
    if (badge) {
      badge.textContent = '按需启动';
      badge.className = 'ob-badge sandbox';
    }
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="rocket"></i><span id="obStartSandboxBtnText">一键启动云电脑</span>`;
  }

  if (window.lucide) window.lucide.createIcons();
}

/**
 * Handle clicking the primary Start / Wake / Enter Sandbox button.
 */
async function handleStartSandboxClick() {
  const btn = document.getElementById('obStartSandboxBtn');
  if (!btn || obStartingSandbox) return;

  // If sandbox is already running & online, enter immediately
  if (obSandboxStatus?.running && obSandboxStatus?.isOnline && obSandboxStatus?.deviceId) {
    if (typeof window.deckDeviceActions?.switchToDevice === 'function') {
      window.deckDeviceActions.switchToDevice(obSandboxStatus.deviceId);
    }
    return;
  }

  obStartingSandbox = true;
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="spin"></i><span id="obStartSandboxBtnText">${obSandboxStatus?.exists ? '正在唤醒云电脑...' : '正在启动云电脑...'}</span>`;
  if (window.lucide) window.lucide.createIcons();

  try {
    const res = await fetch('/api/sandbox/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '启动失败');
    }

    const devices = typeof window.deckDeviceActions?.fetchDevices === 'function'
      ? await window.deckDeviceActions.fetchDevices()
      : [];

    if (typeof window.deckDeviceActions?.updateSwitcherDropdownItems === 'function') {
      window.deckDeviceActions.updateSwitcherDropdownItems();
    }

    const targetId = data.deviceId || devices.find(d => d.deviceKind === 'docker-sandbox')?.deviceId;
    obSandboxStatus = {
      ...(obSandboxStatus || {}),
      dockerAvailable: true,
      imageReady: true,
      exists: true,
      running: true,
      isOnline: Boolean(data.isOnline || devices.find(d => d.deviceId === targetId)?.isOnline),
      deviceId: targetId || null
    };

    obStartingSandbox = false;
    if (targetId && typeof window.deckDeviceActions?.switchToDevice === 'function') {
      toast.success('云电脑已就绪', { description: '已自动切入云端隔离工作台，可以开始新建会话了' });
      window.deckDeviceActions.switchToDevice(targetId);
    } else {
      toast.success('云电脑已启动，正在等待隧道上线...');
      await loadOnboardingSandboxCard();
    }
  } catch (err) {
    obStartingSandbox = false;
    toast.error(`启动云电脑失败: ${err.message}`);
    await loadOnboardingSandboxCard();
  }
}

/**
 * Apply daemon vs foreground segmented toggle in the local-device onboarding card.
 */
function applyOnboardingPairModeUI(mode) {
  obPairMode = mode === 'foreground' ? 'foreground' : 'daemon';
  const isDaemon = obPairMode === 'daemon';

  document.querySelectorAll('.ob-seg-btn[data-ob-pair-mode]').forEach(btn => {
    const active = btn.getAttribute('data-ob-pair-mode') === obPairMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const hintEl = document.getElementById('obPlatformHint');
  if (hintEl) {
    hintEl.textContent = isDaemon ? 'Mac / Linux 开机自启' : '全平台临时运行';
  }

  const cmdEl = document.getElementById('obPairCmdText');
  const nextCmd = isDaemon ? obPairCommands.daemon : obPairCommands.foreground;
  if (cmdEl && nextCmd) {
    cmdEl.textContent = nextCmd;
  }
}

/**
 * Generate a fresh one-time pair command for the onboarding card.
 */
export async function refreshOnboardingPairToken() {
  const cmdEl = document.getElementById('obPairCmdText');
  const expireEl = document.getElementById('obPairExpireText');
  if (!cmdEl || obLoadingPair) return;

  obLoadingPair = true;
  cmdEl.textContent = '正在生成配对命令...';

  try {
    const res = await fetch('/api/devices/pair-token', { method: 'POST' });
    if (!res.ok) throw new Error('Token generation failed');
    const data = await res.json();

    const fgCmd = data.foregroundCommand || String(data.command || '').replace(/\s+--daemon\b/, '');
    const dmCmd = data.daemonCommand || (fgCmd ? `${fgCmd} --daemon` : data.command);
    obPairCommands = { daemon: dmCmd, foreground: fgCmd };
    obPairExpireAt = data.expireAt ? new Date(data.expireAt).getTime() : (Date.now() + (data.ttlSeconds || 600) * 1000);

    applyOnboardingPairModeUI(obPairMode);
    if (expireEl) {
      expireEl.textContent = `${Math.max(1, Math.floor((data.ttlSeconds || 600) / 60))} 分钟内有效`;
    }
  } catch (err) {
    console.error('[DeviceOnboarding] Error generating pair token:', err);
    cmdEl.textContent = '生成失败，请点击下方「刷新命令」重试';
  } finally {
    obLoadingPair = false;
  }
}

/**
 * Copy active pair command with 2500ms confirmation decay.
 */
function copyOnboardingPairCommand() {
  const cmd = obPairMode === 'foreground' ? obPairCommands.foreground : obPairCommands.daemon;
  if (!cmd) return;

  const btn = document.getElementById('obCopyCmdBtn');
  const onCopied = () => {
    toast.success('配对命令已复制', { description: '在你的电脑终端粘贴运行即可自动接入' });
    if (btn) {
      if (obCopyTimer) clearTimeout(obCopyTimer);
      btn.classList.add('copied');
      btn.innerHTML = `<i data-lucide="check"></i><span>已复制</span>`;
      if (window.lucide) window.lucide.createIcons();
      obCopyTimer = setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<i data-lucide="copy"></i><span>复制</span>`;
        if (window.lucide) window.lucide.createIcons();
      }, 2500);
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmd).then(onCopied).catch(() => fallbackCopy(cmd, onCopied));
  } else {
    fallbackCopy(cmd, onCopied);
  }
}

function fallbackCopy(text, onSuccess) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    onSuccess();
  } catch (_) {
    toast.warning('复制失败，请手动选中命令复制');
  }
}

/**
 * Bind DOM events for the No-Device Onboarding panel.
 */
export function initDeviceOnboarding() {
  if (obInitialized) return;
  obInitialized = true;

  const startSandboxBtn = document.getElementById('obStartSandboxBtn');
  if (startSandboxBtn) {
    startSandboxBtn.addEventListener('click', handleStartSandboxClick);
  }

  document.querySelectorAll('.ob-seg-btn[data-ob-pair-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      applyOnboardingPairModeUI(btn.getAttribute('data-ob-pair-mode'));
    });
  });

  const copyBtn = document.getElementById('obCopyCmdBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', copyOnboardingPairCommand);
  }

  const refreshBtn = document.getElementById('obRefreshCmdBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshOnboardingPairToken();
    });
  }

  const openModalBtn = document.getElementById('obOpenDeviceModalBtn');
  if (openModalBtn) {
    openModalBtn.addEventListener('click', () => {
      if (typeof window.deckDeviceActions?.openDeviceModal === 'function') {
        window.deckDeviceActions.openDeviceModal();
      }
    });
  }

  const openHelpBtn = document.getElementById('obOpenHelpDocBtn');
  if (openHelpBtn) {
    openHelpBtn.addEventListener('click', () => {
      openHelpDocTab();
    });
  }

  const welcomeManageDeviceBtn = document.getElementById('welcomeManageDeviceBtn');
  if (welcomeManageDeviceBtn) {
    welcomeManageDeviceBtn.addEventListener('click', () => {
      if (typeof window.deckDeviceActions?.openDeviceModal === 'function') {
        window.deckDeviceActions.openDeviceModal();
      }
    });
  }

  // Expose helper for cross-module sync without circular import overhead
  window.syncDeviceOnboarding = syncOnboardingView;
}
