const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_ROOT = path.join(__dirname, '..');
const ICONS_BASE_DIR = path.join(PROJECT_ROOT, 'public', 'icons');

// Unified Charcoal & Lavender-Violet palette aligned with CCNOW's visual refresh
// Dark theme: --c-bg #17191e, --c-side #13151b, --c-soft #22252e, --c-accent #ac9bff, --c-green #64cda2
// Light theme: --c-bg #f3f4f6, --c-accent #6952d9
const BRAND = {
  accentLight: '#d8ceff',  // Soft luminous lavender highlight
  accent: '#ac9bff',       // Primary lavender-violet (Dark --c-accent)
  accentMid: '#8a74f0',    // Balanced electric violet
  secondary: '#6952d9',    // Deep royal violet (Light --c-accent)
  tertiary: '#4835a8',     // Sculpted shadow violet
  deepShadow: '#2a1f63',   // Deepest indigo shadow

  bgTop: '#222532',        // Elevated charcoal-slate top-left (--c-soft harmonized)
  bgMid: '#17191e',        // Core console surface (--c-bg)
  bgBottom: '#101218',     // Deep sidebar anchor (--c-side)
  ambientGlow: '#7e66f5',  // Soft calm center ambient tint (--c-selected harmonized)

  mint: '#64cda2',         // Console --c-green subtle live dot
  white: '#f6f4ff'         // Soft violet-tinted white core
};

const ICON_VERSION = '2';

function renderBaseBackground(id, b) {
  return `
    <linearGradient id="bg-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1024" y2="1024">
      <stop offset="0%" stop-color="${b.bgTop}"/>
      <stop offset="52%" stop-color="${b.bgMid}"/>
      <stop offset="100%" stop-color="${b.bgBottom}"/>
    </linearGradient>
    <radialGradient id="ambient-${id}" gradientUnits="userSpaceOnUse" cx="512" cy="472" r="540">
      <stop offset="0%" stop-color="${b.ambientGlow}" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="${b.secondary}" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="${b.bgBottom}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="grad-${id}" gradientUnits="userSpaceOnUse" x1="200" y1="200" x2="824" y2="824">
      <stop offset="0%" stop-color="${b.accentLight}"/>
      <stop offset="48%" stop-color="${b.accent}"/>
      <stop offset="100%" stop-color="${b.secondary}"/>
    </linearGradient>
    <filter id="soft-glow-${id}" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14" result="blur"/>
      <feFlood flood-color="${b.accent}" flood-opacity="0.26" result="color"/>
      <feComposite in="color" in2="blur" operator="in" result="glow"/>
      <feMerge>
        <feMergeNode in="glow"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  `;
}

function renderCanvasRects(id) {
  return `
    <!-- Full-bleed borderless background (iOS/Android/PWA safe-zone friendly) -->
    <rect x="0" y="0" width="1024" height="1024" fill="url(#bg-${id})"/>
    <rect x="0" y="0" width="1024" height="1024" fill="url(#ambient-${id})"/>
  `;
}

const ICON_SHAPES = [
  {
    id: 'shape-diamond',
    name: '星曜菱形',
    subtitle: 'CCNOW Diamond',
    description: '经典 CCNOW 菱形战徽，深炭星紫配色呼应控制台品牌标识',
    renderSvg: (b) => `
      <defs>
        ${renderBaseBackground('diamond', b)}
        <linearGradient id="core-diamond-top" gradientUnits="userSpaceOnUse" x1="356" y1="356" x2="668" y2="512">
          <stop offset="0%" stop-color="${b.accentLight}"/>
          <stop offset="100%" stop-color="${b.accent}"/>
        </linearGradient>
        <linearGradient id="core-diamond-bottom" gradientUnits="userSpaceOnUse" x1="356" y1="512" x2="668" y2="668">
          <stop offset="0%" stop-color="${b.accentMid}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
      </defs>

      ${renderCanvasRects('diamond')}

      <!-- Subtle Architectural Crosshairs -->
      <g stroke="${b.accent}" stroke-width="2" stroke-opacity="0.08">
        <line x1="160" y1="512" x2="864" y2="512"/>
        <line x1="512" y1="160" x2="512" y2="864"/>
      </g>

      <!-- Outer Precision Diamond -->
      <g filter="url(#soft-glow-diamond)">
        <polygon points="512,188 836,512 512,836 188,512" fill="none" stroke="url(#grad-diamond)" stroke-width="36" stroke-linejoin="round"/>
        <polygon points="512,282 742,512 512,742 282,512" fill="none" stroke="${b.accent}" stroke-width="8" stroke-opacity="0.34" stroke-linejoin="round"/>

        <!-- Faceted Solid Core Diamond -->
        <polygon points="512,356 668,512 512,512 356,512" fill="url(#core-diamond-top)"/>
        <polygon points="356,512 512,512 668,512 512,668" fill="url(#core-diamond-bottom)"/>
        <circle cx="512" cy="512" r="30" fill="${b.white}"/>
      </g>
    `
  },
  {
    id: 'shape-terminal',
    name: '极客终端',
    subtitle: 'Terminal Prompt',
    description: '命令行提示符 >_，代表控制台与 Tmux 终端智能体',
    renderSvg: (b) => `
      <defs>
        ${renderBaseBackground('terminal', b)}
        <linearGradient id="plate-terminal" gradientUnits="userSpaceOnUse" x1="184" y1="212" x2="840" y2="812">
          <stop offset="0%" stop-color="#282c3b" stop-opacity="0.78"/>
          <stop offset="100%" stop-color="#191c25" stop-opacity="0.86"/>
        </linearGradient>
        <linearGradient id="cursor-terminal" gradientUnits="userSpaceOnUse" x1="498" y1="670" x2="706" y2="670">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.accentLight}"/>
        </linearGradient>
      </defs>

      ${renderCanvasRects('terminal')}

      <!-- Subtle Elevated Terminal Plate (Inside Safe Zone, No Outer Border) -->
      <rect x="184" y="212" width="656" height="600" rx="68" fill="url(#plate-terminal)" stroke="${b.accent}" stroke-width="4" stroke-opacity="0.18"/>
      <line x1="184" y1="322" x2="840" y2="322" stroke="${b.accent}" stroke-width="3" stroke-opacity="0.12"/>

      <!-- Minimal Window Dots (Calm Mint Live Indicator + Lavender Tints) -->
      <circle cx="250" cy="268" r="13" fill="${b.mint}" fill-opacity="0.9"/>
      <circle cx="296" cy="268" r="13" fill="${b.accent}" fill-opacity="0.45"/>
      <circle cx="342" cy="268" r="13" fill="${b.accent}" fill-opacity="0.24"/>

      <!-- Bold Prompt Symbol >_ -->
      <g filter="url(#soft-glow-terminal)">
        <polyline points="310,446 448,560 310,674" fill="none" stroke="url(#grad-terminal)" stroke-width="60" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="502" y="644" width="204" height="60" rx="30" fill="url(#cursor-terminal)"/>
      </g>
    `
  },
  {
    id: 'shape-hexagon',
    name: '战术六边',
    subtitle: 'Tactical Hexagon',
    description: '蜂巢结构与战术护盾，象征稳固架构与沙箱安全隔离',
    renderSvg: (b) => `
      <defs>
        ${renderBaseBackground('hexagon', b)}
        <radialGradient id="core-hex" cx="38%" cy="35%" r="65%">
          <stop offset="0%" stop-color="${b.accentLight}"/>
          <stop offset="55%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </radialGradient>
      </defs>

      ${renderCanvasRects('hexagon')}

      <!-- Outer & Inner Architectural Hexagon -->
      <g filter="url(#soft-glow-hexagon)">
        <polygon points="512,188 792,350 792,674 512,836 232,674 232,350" fill="none" stroke="url(#grad-hexagon)" stroke-width="36" stroke-linejoin="round"/>
        <polygon points="512,286 708,399 708,625 512,738 316,625 316,399" fill="none" stroke="${b.accent}" stroke-width="10" stroke-dasharray="42 22" stroke-opacity="0.45" stroke-linejoin="round"/>

        <!-- Core Node -->
        <circle cx="512" cy="512" r="92" fill="url(#core-hex)"/>
        <circle cx="512" cy="512" r="34" fill="${b.white}"/>
      </g>
    `
  },
  {
    id: 'shape-cube',
    name: '等距立方',
    subtitle: 'Isometric Cube',
    description: '3D 悬浮空间立方，象征多工作区 Workspace 隔离与容器',
    renderSvg: (b) => `
      <defs>
        ${renderBaseBackground('cube', b)}
        <linearGradient id="top-face" gradientUnits="userSpaceOnUse" x1="256" y1="216" x2="768" y2="512">
          <stop offset="0%" stop-color="${b.accentLight}"/>
          <stop offset="100%" stop-color="${b.accent}"/>
        </linearGradient>
        <linearGradient id="left-face" gradientUnits="userSpaceOnUse" x1="256" y1="364" x2="512" y2="808">
          <stop offset="0%" stop-color="${b.accentMid}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <linearGradient id="right-face" gradientUnits="userSpaceOnUse" x1="512" y1="364" x2="768" y2="808">
          <stop offset="0%" stop-color="${b.tertiary}"/>
          <stop offset="100%" stop-color="${b.deepShadow}"/>
        </linearGradient>
      </defs>

      ${renderCanvasRects('cube')}

      <!-- Sculpted Isometric Cube -->
      <g filter="url(#soft-glow-cube)">
        <!-- Top Face -->
        <polygon points="512,216 768,364 512,512 256,364" fill="url(#top-face)" stroke="${b.accentLight}" stroke-width="3" stroke-linejoin="round"/>
        <!-- Left Face -->
        <polygon points="256,364 512,512 512,808 256,660" fill="url(#left-face)" stroke="${b.accent}" stroke-width="3" stroke-opacity="0.45" stroke-linejoin="round"/>
        <!-- Right Face -->
        <polygon points="768,364 512,512 512,808 768,660" fill="url(#right-face)" stroke="${b.accent}" stroke-width="3" stroke-opacity="0.35" stroke-linejoin="round"/>

        <!-- Crisp Inner Ridge Highlights -->
        <polyline points="256,364 512,512 768,364" fill="none" stroke="${b.white}" stroke-width="6" stroke-opacity="0.65" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="512" y1="512" x2="512" y2="808" stroke="${b.accentLight}" stroke-width="5" stroke-opacity="0.45" stroke-linecap="round"/>

        <!-- Center Specular Vertex -->
        <circle cx="512" cy="512" r="18" fill="${b.white}"/>
      </g>
    `
  },
  {
    id: 'shape-neural',
    name: '神经节点',
    subtitle: 'Neural Network',
    description: '多维智能互联中枢，象征多 Agent 协同与知识流动',
    renderSvg: (b) => `
      <defs>
        ${renderBaseBackground('neural', b)}
        <radialGradient id="node-grad" cx="35%" cy="35%" r="68%">
          <stop offset="0%" stop-color="${b.accentLight}"/>
          <stop offset="55%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </radialGradient>
      </defs>

      ${renderCanvasRects('neural')}

      <!-- Multi-Agent Constellation -->
      <g filter="url(#soft-glow-neural)">
        <!-- Outer Triangle Edges -->
        <line x1="512" y1="252" x2="268" y2="696" stroke="url(#grad-neural)" stroke-width="24" stroke-linecap="round"/>
        <line x1="512" y1="252" x2="756" y2="696" stroke="url(#grad-neural)" stroke-width="24" stroke-linecap="round"/>
        <line x1="268" y1="696" x2="756" y2="696" stroke="url(#grad-neural)" stroke-width="24" stroke-linecap="round"/>

        <!-- Inner Hub Links -->
        <line x1="512" y1="252" x2="512" y2="548" stroke="${b.accentLight}" stroke-width="12" stroke-opacity="0.55" stroke-dasharray="18 14" stroke-linecap="round"/>
        <line x1="268" y1="696" x2="512" y2="548" stroke="${b.accentLight}" stroke-width="12" stroke-opacity="0.55" stroke-dasharray="18 14" stroke-linecap="round"/>
        <line x1="756" y1="696" x2="512" y2="548" stroke="${b.accentLight}" stroke-width="12" stroke-opacity="0.55" stroke-dasharray="18 14" stroke-linecap="round"/>

        <!-- 3 Outer Agent Nodes -->
        <circle cx="512" cy="252" r="58" fill="url(#node-grad)"/>
        <circle cx="512" cy="252" r="22" fill="${b.white}"/>

        <circle cx="268" cy="696" r="58" fill="url(#node-grad)"/>
        <circle cx="268" cy="696" r="22" fill="${b.white}"/>

        <circle cx="756" cy="696" r="58" fill="url(#node-grad)"/>
        <circle cx="756" cy="696" r="22" fill="${b.white}"/>

        <!-- Central AI Orchestrator Core -->
        <circle cx="512" cy="548" r="76" fill="url(#node-grad)"/>
        <circle cx="512" cy="548" r="32" fill="${b.white}"/>
      </g>
    `
  },
  {
    id: 'shape-orb',
    name: '极简圆环',
    subtitle: 'Reactor Orb',
    description: '现代简约聚能同心环，呼应控制台静谧光球质感',
    renderSvg: (b) => `
      <defs>
        ${renderBaseBackground('orb', b)}
        <radialGradient id="core-orb" cx="38%" cy="35%" r="65%">
          <stop offset="0%" stop-color="${b.accentLight}"/>
          <stop offset="52%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </radialGradient>
      </defs>

      ${renderCanvasRects('orb')}

      <g filter="url(#soft-glow-orb)">
        <!-- Outer Precision Ring -->
        <circle cx="512" cy="512" r="306" fill="none" stroke="url(#grad-orb)" stroke-width="30"/>

        <!-- Inner Orbital Segmented Ring -->
        <circle cx="512" cy="512" r="218" fill="none" stroke="${b.accent}" stroke-width="14" stroke-dasharray="76 34" stroke-opacity="0.55" stroke-linecap="round"/>

        <!-- Inner Cardinal Axis Ticks (Cleanly Inside Outer Ring) -->
        <line x1="230" y1="512" x2="266" y2="512" stroke="${b.accentLight}" stroke-width="11" stroke-linecap="round" stroke-opacity="0.65"/>
        <line x1="758" y1="512" x2="794" y2="512" stroke="${b.accentLight}" stroke-width="11" stroke-linecap="round" stroke-opacity="0.65"/>
        <line x1="512" y1="230" x2="512" y2="266" stroke="${b.accentLight}" stroke-width="11" stroke-linecap="round" stroke-opacity="0.65"/>
        <line x1="512" y1="758" x2="512" y2="794" stroke="${b.accentLight}" stroke-width="11" stroke-linecap="round" stroke-opacity="0.65"/>

        <!-- Core Energy Sphere -->
        <circle cx="512" cy="512" r="102" fill="url(#core-orb)"/>
        <circle cx="512" cy="512" r="42" fill="${b.white}"/>
      </g>
    `
  }
];

function buildFullSvg(shape, { rounded = false } = {}) {
  const inner = shape.renderSvg(BRAND);
  if (!rounded) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  ${inner}
</svg>`;
  }

  // Browser tab favicon: crisp rounded-square clip with zero outer border
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <clipPath id="favicon-clip">
      <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224"/>
    </clipPath>
  </defs>
  <g clip-path="url(#favicon-clip)">
    ${inner}
  </g>
</svg>`;
}

async function generateAllIcons() {
  console.log('🚀 Starting batch generation of borderless charcoal-violet CCNOW icons...');
  const startTime = Date.now();

  if (fs.existsSync(ICONS_BASE_DIR)) {
    fs.rmSync(ICONS_BASE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(ICONS_BASE_DIR, { recursive: true });

  const generatedShapes = [];

  for (const shape of ICON_SHAPES) {
    const shapeDir = path.join(ICONS_BASE_DIR, shape.id);
    fs.mkdirSync(shapeDir, { recursive: true });

    const svgContent = buildFullSvg(shape, { rounded: false });
    const faviconSvgContent = buildFullSvg(shape, { rounded: true });
    const svgPath = path.join(shapeDir, 'icon.svg');
    fs.writeFileSync(svgPath, svgContent, 'utf8');

    const fullSvgBuffer = Buffer.from(svgContent);
    const faviconSvgBuffer = Buffer.from(faviconSvgContent);

    // Standard PWA & Web icon resolutions
    const targets = [
      { name: 'favicon.png', size: 32, buffer: faviconSvgBuffer },
      { name: 'apple-touch-icon.png', size: 180, buffer: fullSvgBuffer },
      { name: 'icon-192.png', size: 192, buffer: fullSvgBuffer },
      { name: 'icon-512.png', size: 512, buffer: fullSvgBuffer }
    ];

    for (const target of targets) {
      const outputPath = path.join(shapeDir, target.name);
      await sharp(target.buffer)
        .resize(target.size, target.size)
        .png({ quality: 100, compressionLevel: 9 })
        .toFile(outputPath);
    }

    const meta = {
      id: shape.id,
      name: shape.name,
      subtitle: shape.subtitle,
      description: shape.description,
      preview: `/icons/${shape.id}/icon-192.png?v=${ICON_VERSION}`,
      favicon: `/icons/${shape.id}/favicon.png?v=${ICON_VERSION}`,
      appleTouchIcon: `/icons/${shape.id}/apple-touch-icon.png?v=${ICON_VERSION}`,
      icon192: `/icons/${shape.id}/icon-192.png?v=${ICON_VERSION}`,
      icon512: `/icons/${shape.id}/icon-512.png?v=${ICON_VERSION}`
    };

    fs.writeFileSync(
      path.join(shapeDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8'
    );

    generatedShapes.push(meta);
    console.log(`✅ Generated shape: ${shape.name} (${shape.id})`);
  }

  fs.writeFileSync(
    path.join(ICONS_BASE_DIR, 'themes.json'),
    JSON.stringify(generatedShapes, null, 2),
    'utf8'
  );

  // Sync active theme files into public/images/
  try {
    const iconService = require('../services/iconService');
    iconService.initActiveIcon();
    const active = iconService.getActiveTheme();
    console.log(`🔄 Synced active icon "${active.id}" -> public/images/`);
  } catch (err) {
    console.warn('⚠️ Could not auto-sync public/images/ via iconService:', err.message);
  }

  console.log(`✨ All ${ICON_SHAPES.length} shape icons generated successfully in ${((Date.now() - startTime) / 1000).toFixed(2)}s!`);
}

if (require.main === module) {
  generateAllIcons().catch((err) => {
    console.error('❌ Error generating icons:', err);
    process.exit(1);
  });
}

module.exports = {
  BRAND,
  ICON_VERSION,
  ICON_SHAPES,
  generateAllIcons
};
