/**
 * Unified Agent Model & Reasoning Effort Selector Module
 * Supports live device-side OAR model discovery (/api/oar/models) with gateway fallback,
 * powering both the New Session Modal (OAR + Tmux) and the in-chat OAR Model Switcher.
 */

import { state } from './state.js';

const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h persistent localStorage + memory cache
const MODEL_STORAGE_PREFIX = 'ccnow_oar_models_v1::';
const modelCatalogCache = new Map(); // `${deviceId}::${agent}` -> { fetchedAt, data }
const inFlightRequests = new Map();
let modalRenderSeq = 0;

function readCachedModelsEntry(cacheKey) {
  const mem = modelCatalogCache.get(cacheKey);
  if (mem && (Date.now() - mem.fetchedAt) < MODEL_CACHE_TTL_MS) {
    return mem;
  }
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_PREFIX + cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && Array.isArray(parsed.data.models) && parsed.data.models.length > 0 && (Date.now() - (parsed.fetchedAt || 0)) < MODEL_CACHE_TTL_MS) {
        modelCatalogCache.set(cacheKey, parsed);
        return parsed;
      }
    }
  } catch (_) {}
  return null;
}

function writeCachedModelsEntry(cacheKey, data) {
  const entry = { fetchedAt: Date.now(), data };
  modelCatalogCache.set(cacheKey, entry);
  try {
    localStorage.setItem(MODEL_STORAGE_PREFIX + cacheKey, JSON.stringify(entry));
  } catch (_) {}
}

const EFFORT_LABELS = {
  low: '低 (Low)',
  medium: '中 (Medium)',
  high: '高 (High)',
  xhigh: '极高 (XHigh)',
  max: '最大 (Max)',
  on: '开启 (On)',
  off: '关闭 (Off)'
};

const EFFORT_SHORT_LABELS = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  on: 'On',
  off: 'Off'
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeModelAgent(agent) {
  const t = String(agent || '').trim().toLowerCase();
  if (t === 'antigravity' || t === 'agy') return 'agy';
  if (t === 'claude-code' || t === 'claudecode' || t === 'claude') return 'claude';
  if (t === 'codex-cli' || t === 'codex') return 'codex';
  if (t === 'kimi-code' || t === 'kimi-cli' || t === 'kimi') return 'kimi';
  return t || 'default';
}

export function formatEffortLabel(level) {
  if (!level) return '默认';
  const key = String(level).trim().toLowerCase();
  return EFFORT_LABELS[key] || String(level);
}

export function formatShortEffort(level) {
  if (!level) return '';
  const key = String(level).trim().toLowerCase();
  return EFFORT_SHORT_LABELS[key] || String(level);
}

export function clearAgentModelsCache() {
  modelCatalogCache.clear();
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(MODEL_STORAGE_PREFIX)) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}

/**
 * Synchronously read warm cached models (memory or localStorage) for instant 0ms UI rendering.
 */
export function getCachedAgentModels(agent, opts = {}) {
  const normAgent = normalizeModelAgent(agent);
  if (!normAgent || normAgent === 'default' || normAgent === 'shell' || normAgent === 'terminal') {
    return null;
  }
  const deviceId = opts.deviceId !== undefined ? opts.deviceId : (state.currentDeviceId || 'cloud');
  const cacheKey = `${deviceId || 'default'}::${normAgent}`;
  const entry = readCachedModelsEntry(cacheKey);
  return entry ? entry.data : null;
}

export function findModelEntry(models, modelId) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const target = String(modelId || '').trim().toLowerCase();
  if (!target || target === 'default') {
    return models.find(m => m.isDefault) || models.find(m => m.id === '') || models[0] || null;
  }
  return (
    models.find(m => String(m.id || '').toLowerCase() === target) ||
    models.find(m => String(m.rawId || '').toLowerCase() === target) ||
    models.find(m => String(m.resolvedId || '').toLowerCase() === target) ||
    null
  );
}

/**
 * Fetch live available models for an agent on the current compute device.
 */
export async function fetchAgentModels(agent, opts = {}) {
  const normAgent = normalizeModelAgent(agent);
  if (!normAgent || normAgent === 'default' || normAgent === 'shell' || normAgent === 'terminal') {
    return { success: true, agent: normAgent, runtimeKind: 'unsupported', models: [] };
  }

  const deviceId = opts.deviceId !== undefined ? opts.deviceId : (state.currentDeviceId || 'cloud');
  const workspacePath = opts.workspacePath !== undefined ? opts.workspacePath : (state.currentWorkspacePath || '');
  const refresh = Boolean(opts.refresh);
  const cacheKey = `${deviceId || 'default'}::${normAgent}`;

  if (!refresh) {
    const cached = readCachedModelsEntry(cacheKey);
    if (cached) {
      return cached.data;
    }
  }

  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const reqPromise = (async () => {
    try {
      const params = new URLSearchParams();
      params.set('agent', normAgent);
      if (deviceId && deviceId !== 'cloud') params.set('deviceId', deviceId);
      if (workspacePath) params.set('workspacePath', workspacePath);
      if (refresh) params.set('refresh', '1');

      const res = await fetch(`/api/oar/models?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const normalized = {
        success: true,
        agent: normAgent,
        runtimeKind: data.runtimeKind || 'ok',
        runtimeDetail: data.runtimeDetail || null,
        models: Array.isArray(data.models) ? data.models : []
      };
      if (normalized.models.length > 0) {
        writeCachedModelsEntry(cacheKey, normalized);
      }
      return normalized;
    } catch (err) {
      // Fallback to legacy /api/llm-models cache for Claude / Codex
      const legacy = state.availableModels && state.availableModels[normAgent];
      if (Array.isArray(legacy) && legacy.length > 0) {
        const mapped = legacy.map((item, idx) => ({
          id: item.provider === 'default' || item.provider === 'oauth' ? '' : (item.model || ''),
          rawId: item.model || item.id || 'default',
          displayName: item.modelName || item.displayName || item.model || '默认',
          resolvedId: item.model || '',
          provider: item.provider || 'default',
          providerName: item.providerName || '网关',
          desc: item.desc || '',
          isDefault: idx === 0,
          effortLevels: [],
          defaultEffort: '',
          disabled: null,
          source: 'gateway'
        }));
        return { success: true, agent: normAgent, runtimeKind: 'fallback', models: mapped };
      }
      return { success: false, agent: normAgent, runtimeKind: 'error', runtimeDetail: err.message, models: [] };
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, reqPromise);
  return reqPromise;
}

/**
 * Switch model & reasoning effort on an active OAR Native Stream (chat_only) session.
 */
export async function switchOarSessionModel(sessionName, { model = '', effort = '', modelLabel = '' } = {}) {
  if (!sessionName) {
    throw new Error('缺少会话名称');
  }
  const devParam = state.currentDeviceId && state.currentDeviceId !== 'cloud'
    ? `?deviceId=${encodeURIComponent(state.currentDeviceId)}`
    : '';
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/oar-model${devParam}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, effort, modelLabel })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(data.error || `切换模型失败 (HTTP ${res.status})`);
    err.busy = Boolean(data.busy);
    throw err;
  }
  return data;
}

function getModelIconName(item) {
  if (item.provider === 'kimi' || item.provider === 'antigravity') return 'sparkles';
  if (item.provider === 'tencent') return 'cloud';
  if (item.provider === 'oauth') return 'shield-check';
  if (item.source === 'oar') return 'sparkles';
  return 'cpu';
}

function renderSessionEffortPills(modelItem, container) {
  if (!container) return;
  const levels = Array.isArray(modelItem?.effortLevels) ? modelItem.effortLevels : [];
  if (levels.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const defaultEff = modelItem.defaultEffort || '';
  const options = [
    { value: '', label: defaultEff ? `默认 (${formatShortEffort(defaultEff)})` : '默认' },
    ...levels.map(lvl => ({ value: lvl, label: formatEffortLabel(lvl) }))
  ];

  container.classList.remove('hidden');
  container.innerHTML = `
    <span class="session-effort-label">推理强度</span>
    <div class="session-effort-pills">
      ${options.map((opt, idx) => `
        <label class="session-effort-pill">
          <input type="radio" name="sessionModelEffort" value="${escapeHtml(opt.value)}" ${idx === 0 ? 'checked' : ''}>
          <span>${escapeHtml(opt.label)}</span>
        </label>
      `).join('')}
    </div>
  `;
}

/**
 * Render live models and effort pills inside the Create Session Modal (#sessionModal).
 */
export async function renderSessionModelPicker({
  agent = 'agy',
  sessionMode = 'hybrid',
  scrollIntoView = false,
  refresh = false
} = {}) {
  const modelGroup = document.getElementById('sessionModelGroup');
  const container = document.getElementById('sessionModelCardsContainer');
  const effortRow = document.getElementById('sessionEffortRow');
  const modeHint = document.getElementById('sessionModelModeHint');
  const refreshBtn = document.getElementById('refreshSessionModelsBtn');

  if (!modelGroup || !container) return;

  const normAgent = normalizeModelAgent(agent);
  if (!normAgent || normAgent === 'default' || normAgent === 'shell' || normAgent === 'terminal') {
    modelGroup.classList.add('hidden');
    container.innerHTML = '';
    if (effortRow) {
      effortRow.classList.add('hidden');
      effortRow.innerHTML = '';
    }
    return;
  }

  const reqSeq = ++modalRenderSeq;
  modelGroup.classList.remove('hidden');
  if (modeHint) {
    modeHint.textContent = sessionMode === 'chat_only'
      ? '原生流 · 对话中可随时切换'
      : '启动时传入 --model';
  }

  const warmCached = !refresh ? getCachedAgentModels(normAgent, { deviceId: state.currentDeviceId || 'cloud' }) : null;

  if (!warmCached) {
    if (refreshBtn) refreshBtn.classList.add('is-spinning');
    container.innerHTML = `
      <div class="model-cards-loading">
        <i data-lucide="loader-2" class="spin"></i>
        <span>正在探测设备可用模型...</span>
      </div>
    `;
    if (effortRow) {
      effortRow.classList.add('hidden');
      effortRow.innerHTML = '';
    }
    if (window.lucide) window.lucide.createIcons();
  }

  const result = warmCached || await fetchAgentModels(normAgent, {
    deviceId: state.currentDeviceId || 'cloud',
    workspacePath: state.currentWorkspacePath || '',
    refresh
  });

  if (refreshBtn) refreshBtn.classList.remove('is-spinning');
  if (reqSeq !== modalRenderSeq) return; // Stale response after user switched agent again

  const items = Array.isArray(result.models) ? result.models : [];
  if (items.length === 0) {
    const reasonText = result.runtimeKind === 'unauthenticated'
      ? '当前智能体尚未登录，将使用 CLI 默认配置启动'
      : '未探测到可选模型，将使用智能体默认模型启动';
    container.innerHTML = `
      <div class="model-cards-empty">
        <i data-lucide="info"></i>
        <span>${escapeHtml(reasonText)}</span>
      </div>
    `;
    if (effortRow) {
      effortRow.classList.add('hidden');
      effortRow.innerHTML = '';
    }
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Pick initial checked index: first enabled default, else first enabled model
  let defaultIdx = items.findIndex(m => m.isDefault && !m.disabled);
  if (defaultIdx === -1) defaultIdx = items.findIndex(m => !m.disabled);
  if (defaultIdx === -1) defaultIdx = 0;

  container.innerHTML = items.map((item, idx) => {
    const isDisabled = Boolean(item.disabled);
    const displayLabel = item.providerName && item.source === 'gateway'
      ? `${item.providerName} · ${item.displayName}`
      : item.displayName;
    const iconName = getModelIconName(item);
    return `
      <label class="model-card-option${isDisabled ? ' is-disabled' : ''}" title="${escapeHtml(item.disabled?.reason || item.desc || item.displayName)}">
        <input
          type="radio"
          name="sessionFlatModel"
          value="${escapeHtml(item.provider || 'default')}"
          data-model="${escapeHtml(item.id || '')}"
          data-raw-id="${escapeHtml(item.rawId || item.id || '')}"
          data-provider-name="${escapeHtml(item.providerName || '')}"
          data-model-name="${escapeHtml(item.displayName || '')}"
          data-display-name="${escapeHtml(displayLabel)}"
          data-model-index="${idx}"
          ${idx === defaultIdx ? 'checked' : ''}
          ${isDisabled ? 'disabled' : ''}
        >
        <div class="model-card-inner">
          <div class="model-provider-row">
            <span class="model-provider-tag">${escapeHtml(item.providerName || normAgent)}</span>
            ${item.isDefault ? '<span class="model-default-badge">默认</span>' : ''}
          </div>
          <div class="model-card-title">
            <i data-lucide="${iconName}" style="width: 13px; height: 13px;"></i>
            <span>${escapeHtml(item.displayName)}</span>
          </div>
          <div class="model-card-desc" title="${escapeHtml(item.desc || '')}">${escapeHtml(item.desc || item.resolvedId || item.id || '')}</div>
        </div>
      </label>
    `;
  }).join('');

  // Render effort pills for initially selected model and update on radio change
  renderSessionEffortPills(items[defaultIdx], effortRow);
  container.querySelectorAll('input[name="sessionFlatModel"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const idx = parseInt(radio.dataset.modelIndex, 10);
      if (!Number.isNaN(idx) && items[idx]) {
        renderSessionEffortPills(items[idx], effortRow);
      }
    });
  });

  if (window.lucide) {
    window.lucide.createIcons();
  }

  if (scrollIntoView) {
    requestAnimationFrame(() => {
      modelGroup.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

/**
 * Read currently selected model + effort from the New Session Modal form.
 */
export function getSelectedSessionModelPayload() {
  const selectedModelRadio = document.querySelector('input[name="sessionFlatModel"]:checked');
  const selectedEffortRadio = document.querySelector('input[name="sessionModelEffort"]:checked');

  return {
    modelProvider: selectedModelRadio ? (selectedModelRadio.value || 'default') : 'default',
    modelName: selectedModelRadio ? (selectedModelRadio.dataset.model || '') : '',
    modelLabel: selectedModelRadio ? (selectedModelRadio.dataset.displayName || '') : '',
    modelEffort: selectedEffortRadio ? (selectedEffortRadio.value || '') : ''
  };
}
