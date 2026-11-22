/**
 * Calm Dot-Matrix State Orb (Canvas 2D)
 * Inspired by Rare UI MatrixOrb (https://rareui.com), adapted as a zero-dependency
 * vanilla JS module tuned for low-distraction developer workspaces:
 *  - Smooth spring-blended state transitions: 'idle' | 'listening' | 'thinking'
 *  - Automatic dual-theme accent color synchronization (:root dark & body.light-minimalist)
 *  - Automatic pause via IntersectionObserver & document.visibilityState (zero hidden CPU)
 *  - Full prefers-reduced-motion static fallback
 */

const TAU = Math.PI * 2;
const STATES = ['idle', 'listening', 'thinking'];

const STATE_SCALE = {
  idle: 0.88,
  listening: 0.98,
  thinking: 0.92,
};

const STIFFNESS = 140;
const DAMPING = 24;
const ATTACK = 0.18;
const RELEASE = 0.06;
const BLEND = 0.12;

// Calmer, slower orbiters than flashy defaults so the orb feels meditative and unobtrusive
const ORBITERS = [
  { radius: 0.58, speed: 1.35, phase: 0, spread: 0.46 },
  { radius: 0.38, speed: -1.05, phase: 2.1, spread: 0.42 },
  { radius: 0.74, speed: 0.78, phase: 4.1, spread: 0.40 },
];

function isReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function resolveThemeAccentColor() {
  if (typeof document === 'undefined') return '#ac9bff';
  const isLight = document.body && document.body.classList.contains('light-minimalist');
  if (isLight) {
    return '#4f46e5';
  }
  try {
    const computed = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim();
    if (computed) return computed;
  } catch (e) {}
  return '#ac9bff';
}

// Smooth organic breathing envelope without harsh Math.abs troughs
function organicEnvelope(t) {
  const slow = 0.5 + 0.5 * Math.sin(t * 0.55 + 0.4);
  const fast = 0.5 + 0.5 * Math.sin(t * 1.45 + 1.1);
  return 0.24 + 0.68 * (0.45 + 0.55 * slow) * fast;
}

function dotIntensity(state, d, nx, ny, t, amplitude) {
  if (state === 'listening') {
    const ripple = 0.5 + 0.5 * Math.sin(d * 3.8 - t * 2.4);
    return 0.30 + amplitude * (0.34 + 0.36 * ripple);
  }

  if (state === 'thinking') {
    let heat = 0;
    for (let i = 0; i < ORBITERS.length; i++) {
      const o = ORBITERS[i];
      const a = t * o.speed + o.phase;
      const dx = nx - Math.cos(a) * o.radius;
      const dy = ny - Math.sin(a) * o.radius;
      heat += Math.exp(-(dx * dx + dy * dy) / (o.spread * o.spread));
    }
    return 0.26 + 0.74 * Math.min(1, heat);
  }

  // Serene idle breathing (low amplitude, slow wave)
  return 0.56 + 0.09 * Math.sin(t * 0.85 - d * 2.2);
}

/**
 * Mount a calm Canvas 2D dot-matrix orb inside `containerEl`.
 * Returns controller: { setState, pulseLevel, refreshColor, destroy }
 */
export function createMatrixOrb(containerEl, options = {}) {
  if (!containerEl) return null;

  const size = Math.max(24, Number(options.size) || 84);
  const grid = Math.max(5, Math.round(Number(options.dots) || 11));
  const opacity = options.opacity !== undefined ? Number(options.opacity) : 0.76;
  const fixedColor = options.color || null;

  let currentState = STATES.includes(options.state) ? options.state : 'idle';
  let fillColor = fixedColor || resolveThemeAccentColor();
  let manualPulse = 0;
  let manualPulseDecayAt = 0;
  let destroyed = false;
  let isVisible = true;
  let rafId = 0;

  const canvas = document.createElement('canvas');
  canvas.className = 'ccnow-matrix-orb-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.opacity = String(opacity);
  containerEl.innerHTML = '';
  containerEl.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { setState() {}, pulseLevel() {}, refreshColor() {}, destroy() {} };
  }

  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  const half = (grid - 1) / 2;
  const spacing = (size * 0.74) / (grid - 1);
  const maxRadius = spacing * 0.54;
  const center = size / 2;

  const weights = { idle: 0, listening: 0, thinking: 0 };
  weights[currentState] = 1;

  function configureCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const buffer = Math.round(size * dpr);
    canvas.width = buffer;
    canvas.height = buffer;
    ctx.setTransform(buffer / size, 0, 0, buffer / size, 0, 0);
    ctx.fillStyle = fillColor;
  }

  configureCanvas();

  function drawFrame(t, amplitude, scale) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = fillColor;

    for (let iy = 0; iy < grid; iy++) {
      for (let ix = 0; ix < grid; ix++) {
        const nx = (ix - half) / half;
        const ny = (iy - half) / half;
        const d = Math.hypot(nx, ny);
        if (d > 1.12) continue;

        let blended = 0;
        for (let k = 0; k < STATES.length; k++) {
          const s = STATES[k];
          if (weights[s] < 0.001) continue;
          blended += weights[s] * dotIntensity(s, d, nx, ny, t, amplitude);
        }

        const intensity = Math.min(1, Math.max(0, blended));
        const radius = maxRadius * Math.exp(-d * d * 1.8) * intensity * scale;
        if (radius * dpr < 0.45) continue;

        ctx.beginPath();
        ctx.arc(
          center + (ix - half) * spacing * scale,
          center + (iy - half) * spacing * scale,
          radius,
          0,
          TAU
        );
        ctx.fill();
      }
    }
  }

  function drawStatic() {
    for (let k = 0; k < STATES.length; k++) {
      const s = STATES[k];
      weights[s] = s === currentState ? 1 : 0;
    }
    drawFrame(0, 0.55, STATE_SCALE[currentState]);
  }

  let t = 0;
  let amplitude = 0.35;
  let scale = STATE_SCALE[currentState];
  let velocity = 0;
  let lastNow = performance.now();

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick(now) {
    if (destroyed) return;
    if (!canvas.isConnected) {
      destroy();
      return;
    }
    if (!isVisible || document.hidden) {
      rafId = 0;
      return;
    }

    const dt = Math.min((now - lastNow) / 1000, 0.05);
    lastNow = now;
    t += dt;

    const baseTarget = organicEnvelope(t);
    const pulseActive = now < manualPulseDecayAt ? manualPulse : 0;
    const target = Math.min(1, Math.max(baseTarget, pulseActive));
    const rate = target > amplitude ? ATTACK : RELEASE;
    amplitude += (target - amplitude) * (1 - Math.pow(1 - rate, dt * 60));

    const step = 1 - Math.pow(1 - BLEND, dt * 60);
    for (let k = 0; k < STATES.length; k++) {
      const s = STATES[k];
      weights[s] += ((s === currentState ? 1 : 0) - weights[s]) * step;
    }

    velocity += (-STIFFNESS * (scale - STATE_SCALE[currentState]) - DAMPING * velocity) * dt;
    scale += velocity * dt;

    drawFrame(t, amplitude, scale);
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (destroyed || rafId) return;
    if (isReducedMotion()) {
      drawStatic();
      return;
    }
    if (!isVisible || document.hidden) return;
    lastNow = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  // Pause automatically when off-screen or inside a .hidden panel
  let observer = null;
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        isVisible = Boolean(entry && entry.isIntersecting);
        if (isVisible) {
          startLoop();
        } else {
          stopLoop();
        }
      },
      { threshold: 0.01 }
    );
    observer.observe(canvas);
  }

  const onVisibilityChange = () => {
    if (document.hidden) {
      stopLoop();
    } else {
      startLoop();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const onResize = () => {
    if (destroyed) return;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 3);
    if (nextDpr !== dpr) {
      configureCanvas();
      if (isReducedMotion()) drawStatic();
    }
  };
  window.addEventListener('resize', onResize, { passive: true });

  // Sync automatically with dark/light theme toggles
  let themeObserver = null;
  if (!fixedColor && typeof MutationObserver !== 'undefined' && document.body) {
    themeObserver = new MutationObserver(() => {
      if (destroyed) return;
      const nextColor = resolveThemeAccentColor();
      if (nextColor !== fillColor) {
        fillColor = nextColor;
        if (isReducedMotion()) drawStatic();
      }
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  startLoop();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('resize', onResize);
    if (canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
  }

  return {
    setState(nextState) {
      if (destroyed || !STATES.includes(nextState)) return;
      currentState = nextState;
      if (isReducedMotion()) {
        drawStatic();
      } else {
        startLoop();
      }
    },
    pulseLevel(level = 0.85, holdMs = 360) {
      if (destroyed) return;
      manualPulse = Math.min(1, Math.max(0, Number(level) || 0));
      manualPulseDecayAt = performance.now() + holdMs;
    },
    refreshColor(nextColor) {
      if (destroyed) return;
      fillColor = nextColor || fixedColor || resolveThemeAccentColor();
      if (isReducedMotion()) drawStatic();
    },
    destroy,
  };
}
