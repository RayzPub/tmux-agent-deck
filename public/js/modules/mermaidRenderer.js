/**
 * Mermaid Diagram Renderer Module for Chat Mode
 * - Lazy-loads /js/vendor/mermaid-11.4.1.min.js on demand (1-year immutable vendor cache)
 * - Dual-theme support (Cyberpunk Dark & Light Minimalist) with theme switch re-rendering
 * - In-memory SVG cache to prevent flickering across chat history polls
 * - Toggle between Diagram and Source view, Copy Source, and Interactive Zoom Lightbox
 */

const MERMAID_VENDOR_SRC = '/js/vendor/mermaid-11.4.1.min.js';
const MAX_SVG_CACHE_SIZE = 120;

let mermaidLoadPromise = null;
let lastInitializedTheme = null;
let renderSeq = 0;

// Theme-aware SVG cache: `${themeKey}::${rawCode}` -> svg string
const svgCache = new Map();
// Persist user's "show source" toggle state across chat polls by diagram hash
const sourceViewHashes = new Set();

/**
 * Decode common HTML entities produced by marked.js inside <code>...</code>
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Lightweight deterministic hash for identifying diagram blocks across polls
 */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * Resolve current UI theme key ('light' | 'dark')
 */
function getCurrentThemeKey() {
  return document.body && document.body.classList.contains('light-minimalist') ? 'light' : 'dark';
}

/**
 * Build Mermaid theme configuration matching CDS Dual-Theme Architecture
 */
function getMermaidConfig(themeKey) {
  const isLight = themeKey === 'light';
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: isLight ? 'default' : 'dark',
    fontFamily: 'var(--font-body, "Outfit", "Noto Sans SC", -apple-system, sans-serif)',
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      curve: 'basis'
    },
    sequence: {
      useMaxWidth: true
    },
    themeVariables: isLight
      ? {
          primaryColor: '#eef2ff',
          primaryTextColor: '#0f172a',
          primaryBorderColor: '#4f46e5',
          lineColor: '#64748b',
          secondaryColor: '#f8fafc',
          tertiaryColor: '#f1f5f9',
          background: '#ffffff',
          mainBkg: '#ffffff',
          nodeBorder: '#6366f1',
          clusterBkg: '#f8fafc',
          clusterBorder: '#cbd5e1',
          titleColor: '#0f172a',
          edgeLabelBackground: '#ffffff',
          actorBkg: '#eef2ff',
          actorBorder: '#4f46e5',
          actorTextColor: '#0f172a',
          signalColor: '#334155',
          signalTextColor: '#0f172a'
        }
      : {
          primaryColor: '#1e2c4a',
          primaryTextColor: '#f1f5f9',
          primaryBorderColor: '#00f0ff',
          lineColor: '#64748b',
          secondaryColor: '#253554',
          tertiaryColor: '#172036',
          background: '#141a29',
          mainBkg: '#1c253b',
          nodeBorder: '#38bdf8',
          clusterBkg: '#162035',
          clusterBorder: 'rgba(0, 240, 255, 0.32)',
          titleColor: '#f8fafc',
          edgeLabelBackground: '#1c253b',
          actorBkg: '#1e2c4a',
          actorBorder: '#00f0ff',
          actorTextColor: '#f1f5f9',
          signalColor: '#94a3b8',
          signalTextColor: '#e2e8f0'
        }
  };
}

/**
 * Lazy-load mermaid vendor script once on demand
 */
export function ensureMermaidLoaded() {
  if (window.mermaid) {
    return Promise.resolve(window.mermaid);
  }
  if (mermaidLoadPromise) {
    return mermaidLoadPromise;
  }

  mermaidLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${MERMAID_VENDOR_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.mermaid), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load mermaid vendor script')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = MERMAID_VENDOR_SRC;
    script.async = true;
    script.onload = () => {
      if (window.mermaid) {
        resolve(window.mermaid);
      } else {
        mermaidLoadPromise = null;
        reject(new Error('Mermaid global object not found after script load'));
      }
    };
    script.onerror = () => {
      mermaidLoadPromise = null;
      reject(new Error('Failed to load mermaid vendor script'));
    };
    document.head.appendChild(script);
  });

  return mermaidLoadPromise;
}

/**
 * Ensure Mermaid is initialized with the current UI theme
 */
function configureMermaidIfNeeded(mermaid, themeKey) {
  if (lastInitializedTheme !== themeKey) {
    mermaid.initialize(getMermaidConfig(themeKey));
    lastInitializedTheme = themeKey;
  }
}

/**
 * Save rendered SVG into bounded LRU cache
 */
function putCachedSvg(cacheKey, svg) {
  if (svgCache.has(cacheKey)) {
    svgCache.delete(cacheKey);
  } else if (svgCache.size >= MAX_SVG_CACHE_SIZE) {
    const oldestKey = svgCache.keys().next().value;
    svgCache.delete(oldestKey);
  }
  svgCache.set(cacheKey, svg);
}

/**
 * Build the HTML card for a ```mermaid code block inside enhanceMarkdownCodeBlocks().
 * If the SVG for the current theme is already cached, it is inlined synchronously to avoid flicker.
 */
export function buildMermaidCardHtml(escapedCodeContent) {
  const rawCode = decodeHtmlEntities(escapedCodeContent).trim();
  const diagramHash = hashString(rawCode);
  const themeKey = getCurrentThemeKey();
  const cacheKey = `${themeKey}::${rawCode}`;
  const cachedSvg = svgCache.get(cacheKey);
  const isSourceView = sourceViewHashes.has(diagramHash);

  const stageHtml = cachedSvg
    ? `<div class="chat-mermaid-svg">${cachedSvg}</div>`
    : `<div class="chat-mermaid-loading">
         <span class="chat-mermaid-spinner"></span>
         <span>正在渲染流程图...</span>
       </div>`;

  return `
    <div class="chat-mermaid-wrapper${isSourceView ? ' is-source-view' : ''}" data-mermaid-hash="${diagramHash}" data-mermaid-rendered="${cachedSvg ? 'true' : 'false'}" data-mermaid-theme="${themeKey}">
      <div class="chat-mermaid-header">
        <div class="chat-mermaid-title">
          <i data-lucide="git-branch"></i>
          <span>mermaid</span>
        </div>
        <div class="chat-mermaid-actions">
          <button type="button" class="chat-mermaid-action-btn chat-mermaid-toggle-btn" title="${isSourceView ? '切换为流程图视图' : '查看 Mermaid 源码'}">
            <i data-lucide="${isSourceView ? 'eye' : 'code-2'}"></i>
            <span>${isSourceView ? '图表' : '源码'}</span>
          </button>
          <button type="button" class="chat-mermaid-action-btn chat-mermaid-zoom-btn" title="放大预览流程图">
            <i data-lucide="maximize-2"></i>
            <span>放大</span>
          </button>
          <button type="button" class="chat-mermaid-action-btn chat-mermaid-copy-btn" title="复制 Mermaid 源码">
            <i data-lucide="copy"></i>
            <span>复制</span>
          </button>
        </div>
      </div>
      <div class="chat-mermaid-stage">${stageHtml}</div>
      <div class="chat-mermaid-source">
        <pre><code class="language-mermaid">${escapedCodeContent}</code></pre>
      </div>
    </div>
  `;
}

/**
 * Clean up any orphan error containers Mermaid might have attached to document.body
 */
function cleanupMermaidTempNodes(renderId) {
  const orphan = document.getElementById(`d${renderId}`);
  if (orphan && orphan.parentNode) {
    orphan.parentNode.removeChild(orphan);
  }
}

/**
 * Render all unrendered (or theme-stale) Mermaid blocks inside a container.
 * @param {HTMLElement} container
 * @param {{ forceThemeRerender?: boolean, onRendered?: () => void }} [options]
 */
export async function renderMermaidBlocks(container, options = {}) {
  if (!container) return;
  const { forceThemeRerender = false, onRendered } = options;

  const themeKey = getCurrentThemeKey();
  const wrappers = Array.from(container.querySelectorAll('.chat-mermaid-wrapper')).filter((el) => {
    if (forceThemeRerender) return true;
    return el.dataset.mermaidRendered !== 'true' || el.dataset.mermaidTheme !== themeKey;
  });

  if (wrappers.length === 0) return;

  let mermaid;
  try {
    mermaid = await ensureMermaidLoaded();
  } catch (err) {
    console.warn('[MermaidRenderer] Failed to load mermaid:', err);
    wrappers.forEach((wrapper) => {
      const stage = wrapper.querySelector('.chat-mermaid-stage');
      if (stage) {
        stage.innerHTML = `<div class="chat-mermaid-error">流程图渲染引擎加载失败，请切换查看源码。</div>`;
      }
      wrapper.classList.add('is-source-view');
    });
    return;
  }

  configureMermaidIfNeeded(mermaid, themeKey);

  let renderedAny = false;

  for (const wrapper of wrappers) {
    if (!wrapper.isConnected) continue;

    const codeEl = wrapper.querySelector('.chat-mermaid-source code');
    const stageEl = wrapper.querySelector('.chat-mermaid-stage');
    if (!codeEl || !stageEl) continue;

    const rawCode = (codeEl.textContent || '').trim();
    if (!rawCode) continue;

    const cacheKey = `${themeKey}::${rawCode}`;
    const cachedSvg = svgCache.get(cacheKey);
    if (cachedSvg) {
      stageEl.innerHTML = `<div class="chat-mermaid-svg">${cachedSvg}</div>`;
      wrapper.dataset.mermaidRendered = 'true';
      wrapper.dataset.mermaidTheme = themeKey;
      renderedAny = true;
      continue;
    }

    const renderId = `chat-mermaid-${Date.now()}-${++renderSeq}`;
    try {
      const result = await mermaid.render(renderId, rawCode);
      cleanupMermaidTempNodes(renderId);

      if (!wrapper.isConnected) continue;

      const svg = result && result.svg ? result.svg : '';
      if (svg) {
        putCachedSvg(cacheKey, svg);
        stageEl.innerHTML = `<div class="chat-mermaid-svg">${svg}</div>`;
        wrapper.dataset.mermaidRendered = 'true';
        wrapper.dataset.mermaidTheme = themeKey;
        renderedAny = true;
      }
    } catch (err) {
      cleanupMermaidTempNodes(renderId);
      if (!wrapper.isConnected) continue;

      // Graceful fallback (also covers incomplete Mermaid code during streaming)
      stageEl.innerHTML = `
        <div class="chat-mermaid-error">
          <div class="chat-mermaid-error-title">流程图暂无法渲染（可能正在输出中或存在语法问题），已自动展示源码</div>
        </div>
      `;
      wrapper.classList.add('is-source-view');
      wrapper.dataset.mermaidRendered = 'error';
      wrapper.dataset.mermaidTheme = themeKey;
    }
  }

  if (renderedAny && typeof onRendered === 'function') {
    onRendered();
  }
}

/**
 * Re-render all visible Mermaid diagrams when user switches Dark / Light theme
 */
export function refreshMermaidForTheme() {
  const container = document.getElementById('agentChatMessages');
  if (container && container.querySelector('.chat-mermaid-wrapper')) {
    renderMermaidBlocks(container, { forceThemeRerender: true });
  }
}

/**
 * Open interactive zoomable lightbox modal for a Mermaid SVG
 */
function openMermaidLightbox(svgMarkup, rawCode) {
  let overlay = document.getElementById('chatMermaidLightbox');
  if (overlay) {
    overlay.remove();
  }

  let scale = 1;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 3.5;

  overlay = document.createElement('div');
  overlay.id = 'chatMermaidLightbox';
  overlay.className = 'chat-mermaid-lightbox';
  overlay.innerHTML = `
    <div class="chat-mermaid-lightbox-dialog" role="dialog" aria-modal="true" aria-label="流程图预览">
      <div class="chat-mermaid-lightbox-header">
        <div class="chat-mermaid-lightbox-title">
          <i data-lucide="git-branch"></i>
          <span>Mermaid 流程图预览</span>
        </div>
        <div class="chat-mermaid-lightbox-tools">
          <button type="button" class="chat-mermaid-lb-btn" data-lb-action="zoom-out" title="缩小">
            <i data-lucide="zoom-out"></i>
          </button>
          <span class="chat-mermaid-lb-scale">100%</span>
          <button type="button" class="chat-mermaid-lb-btn" data-lb-action="zoom-in" title="放大">
            <i data-lucide="zoom-in"></i>
          </button>
          <button type="button" class="chat-mermaid-lb-btn" data-lb-action="reset" title="重置缩放">
            <i data-lucide="rotate-ccw"></i>
          </button>
          <button type="button" class="chat-mermaid-lb-btn" data-lb-action="download" title="下载 SVG">
            <i data-lucide="download"></i>
            <span>SVG</span>
          </button>
          <button type="button" class="chat-mermaid-lb-btn close" data-lb-action="close" title="关闭 (Esc)">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
      <div class="chat-mermaid-lightbox-canvas">
        <div class="chat-mermaid-lightbox-stage">${svgMarkup}</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  if (window.lucide) {
    window.lucide.createIcons();
  }

  const stageEl = overlay.querySelector('.chat-mermaid-lightbox-stage');
  const canvasEl = overlay.querySelector('.chat-mermaid-lightbox-canvas');
  const scaleLabel = overlay.querySelector('.chat-mermaid-lb-scale');

  const applyScale = (nextScale) => {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    if (stageEl) {
      stageEl.style.transform = `scale(${scale})`;
    }
    if (scaleLabel) {
      scaleLabel.textContent = `${Math.round(scale * 100)}%`;
    }
  };

  const close = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === '+' || e.key === '=') {
      applyScale(scale + 0.2);
    } else if (e.key === '-') {
      applyScale(scale - 0.2);
    } else if (e.key === '0') {
      applyScale(1);
    }
  };

  document.addEventListener('keydown', onKeyDown);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
      return;
    }
    const btn = e.target.closest('[data-lb-action]');
    if (!btn) return;
    const action = btn.dataset.lbAction;
    if (action === 'close') {
      close();
    } else if (action === 'zoom-in') {
      applyScale(scale + 0.25);
    } else if (action === 'zoom-out') {
      applyScale(scale - 0.25);
    } else if (action === 'reset') {
      applyScale(1);
    } else if (action === 'download') {
      try {
        const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mermaid-${hashString(rawCode || 'diagram')}.svg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.warn('[MermaidRenderer] Failed to download SVG:', err);
      }
    }
  });

  if (canvasEl) {
    canvasEl.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.15 : -0.15;
          applyScale(scale + delta);
        }
      },
      { passive: false }
    );
  }
}

/**
 * Delegated click handler for Mermaid cards inside #agentChatMessages.
 * Returns true if the event was handled.
 */
export function handleMermaidContainerClick(e) {
  const wrapper = e.target.closest('.chat-mermaid-wrapper');
  if (!wrapper) return false;

  // 1. Toggle Diagram / Source view
  const toggleBtn = e.target.closest('.chat-mermaid-toggle-btn');
  if (toggleBtn) {
    const isSourceNow = wrapper.classList.toggle('is-source-view');
    const diagramHash = wrapper.dataset.mermaidHash;
    if (diagramHash) {
      if (isSourceNow) sourceViewHashes.add(diagramHash);
      else sourceViewHashes.delete(diagramHash);
    }
    const labelSpan = toggleBtn.querySelector('span');
    const iconEl = toggleBtn.querySelector('i, svg');
    if (labelSpan) labelSpan.textContent = isSourceNow ? '图表' : '源码';
    toggleBtn.title = isSourceNow ? '切换为流程图视图' : '查看 Mermaid 源码';
    if (iconEl) {
      iconEl.setAttribute('data-lucide', isSourceNow ? 'eye' : 'code-2');
      if (window.lucide) window.lucide.createIcons();
    }
    return true;
  }

  // 2. Copy raw Mermaid source
  const copyBtn = e.target.closest('.chat-mermaid-copy-btn');
  if (copyBtn) {
    const codeEl = wrapper.querySelector('.chat-mermaid-source code');
    if (codeEl) {
      const rawCode = codeEl.textContent || '';
      navigator.clipboard?.writeText(rawCode).then(() => {
        copyBtn.classList.add('copied');
        const labelSpan = copyBtn.querySelector('span');
        if (labelSpan) labelSpan.textContent = '✓ 已复制';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          if (labelSpan) labelSpan.textContent = '复制';
        }, 2500);
      }).catch(() => {});
    }
    return true;
  }

  // 3. Zoom / Lightbox preview
  const zoomBtn = e.target.closest('.chat-mermaid-zoom-btn');
  if (zoomBtn) {
    const svgWrap = wrapper.querySelector('.chat-mermaid-svg');
    const codeEl = wrapper.querySelector('.chat-mermaid-source code');
    if (svgWrap && svgWrap.innerHTML.trim()) {
      openMermaidLightbox(svgWrap.innerHTML, codeEl ? codeEl.textContent || '' : '');
    }
    return true;
  }

  return false;
}
