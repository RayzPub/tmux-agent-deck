const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_ROOT = path.join(__dirname, '..');
const ICONS_BASE_DIR = path.join(PROJECT_ROOT, 'public', 'icons');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'public', 'images');

// Unified Lake Blue palette that harmonizes with both dark (cyan/cyberpunk) and light (minimalist) themes
const BRAND = {
  accent: '#00f0ff',       // Primary lake blue / cyan
  secondary: '#0090ff',    // Azure / deep lake blue
  tertiary: '#0055c8',     // Deep ocean blue
  bgStart: '#0b162c',      // Sleek lake-slate
  bgEnd: '#040915',        // Deep abyss
  borderGlow: 'rgba(0, 240, 255, 0.45)',
  white: '#ffffff'
};

const ICON_SHAPES = [
  {
    id: 'shape-diamond',
    name: '赛博菱形',
    subtitle: 'Cyber Diamond',
    description: '经典 CCNOW 菱形战徽，呼应系统顶栏动态指示器',
    renderSvg: (b) => `
      <defs>
        <linearGradient id="bg-diamond" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.bgStart}"/>
          <stop offset="100%" stop-color="${b.bgEnd}"/>
        </linearGradient>
        <linearGradient id="grad-diamond" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <filter id="glow-diamond" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <!-- Base container -->
      <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg-diamond)" stroke="${b.accent}" stroke-width="12" stroke-opacity="0.8"/>
      
      <!-- Subtle Grid -->
      <g stroke="${b.accent}" stroke-width="2" stroke-opacity="0.12">
        <line x1="160" y1="256" x2="864" y2="256"/>
        <line x1="160" y1="512" x2="864" y2="512"/>
        <line x1="160" y1="768" x2="864" y2="768"/>
        <line x1="256" y1="160" x2="256" y2="864"/>
        <line x1="512" y1="160" x2="512" y2="864"/>
        <line x1="768" y1="160" x2="768" y2="864"/>
      </g>

      <!-- Outer Diamond Shield -->
      <g filter="url(#glow-diamond)">
        <polygon points="512,180 820,512 512,844 204,512" fill="none" stroke="url(#grad-diamond)" stroke-width="26" stroke-linejoin="round"/>
        <polygon points="512,270 730,512 512,754 294,512" fill="none" stroke="${b.accent}" stroke-width="10" stroke-dasharray="28 16" stroke-opacity="0.7"/>
        
        <!-- Solid Core Diamond -->
        <polygon points="512,390 620,512 512,634 404,512" fill="url(#grad-diamond)"/>
        <circle cx="512" cy="512" r="28" fill="${b.white}"/>
      </g>
      
      <circle cx="512" cy="180" r="16" fill="${b.accent}"/>
      <circle cx="820" cy="512" r="16" fill="${b.accent}"/>
      <circle cx="512" cy="844" r="16" fill="${b.accent}"/>
      <circle cx="204" cy="512" r="16" fill="${b.accent}"/>
    `
  },
  {
    id: 'shape-terminal',
    name: '极客终端',
    subtitle: 'Terminal Prompt',
    description: '命令行提示符 >_，代表控制台与 Tmux 终端智能体',
    renderSvg: (b) => `
      <defs>
        <linearGradient id="bg-terminal" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.bgStart}"/>
          <stop offset="100%" stop-color="${b.bgEnd}"/>
        </linearGradient>
        <linearGradient id="grad-terminal" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <filter id="glow-terminal" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg-terminal)" stroke="${b.accent}" stroke-width="12" stroke-opacity="0.8"/>
      
      <!-- Terminal Frame -->
      <rect x="180" y="200" width="664" height="624" rx="40" fill="none" stroke="${b.accent}" stroke-width="8" stroke-opacity="0.25"/>
      <line x1="180" y1="280" x2="844" y2="280" stroke="${b.accent}" stroke-width="4" stroke-opacity="0.2"/>
      <circle cx="230" cy="240" r="10" fill="${b.accent}" opacity="0.6"/>
      <circle cx="264" cy="240" r="10" fill="${b.accent}" opacity="0.6"/>
      <circle cx="298" cy="240" r="10" fill="${b.accent}" opacity="0.6"/>

      <!-- Terminal Prompt Symbol >_ -->
      <g filter="url(#glow-terminal)">
        <polyline points="320,400 450,530 320,660" fill="none" stroke="url(#grad-terminal)" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="500" y1="660" x2="680" y2="660" stroke="${b.accent}" stroke-width="48" stroke-linecap="round"/>
      </g>
    `
  },
  {
    id: 'shape-hexagon',
    name: '战术六边',
    subtitle: 'Tactical Hexagon',
    description: '蜂巢结构与战术护盾，象征稳固架构与安全隔离',
    renderSvg: (b) => `
      <defs>
        <linearGradient id="bg-hexagon" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.bgStart}"/>
          <stop offset="100%" stop-color="${b.bgEnd}"/>
        </linearGradient>
        <linearGradient id="grad-hexagon" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <filter id="glow-hexagon" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg-hexagon)" stroke="${b.accent}" stroke-width="12" stroke-opacity="0.8"/>
      
      <!-- Outer Hexagon -->
      <g filter="url(#glow-hexagon)">
        <polygon points="512,180 800,346 800,678 512,844 224,678 224,346" fill="none" stroke="url(#grad-hexagon)" stroke-width="26" stroke-linejoin="round"/>
        <!-- Inner segmented Hexagon -->
        <polygon points="512,280 710,394 710,630 512,744 314,630 314,394" fill="none" stroke="${b.accent}" stroke-width="10" stroke-dasharray="36 18" stroke-opacity="0.7"/>
        <!-- Core Node -->
        <circle cx="512" cy="512" r="76" fill="url(#grad-hexagon)"/>
        <circle cx="512" cy="512" r="32" fill="${b.white}"/>
      </g>

      <!-- Corner nodes -->
      <circle cx="512" cy="180" r="14" fill="${b.accent}"/>
      <circle cx="800" cy="346" r="14" fill="${b.accent}"/>
      <circle cx="800" cy="678" r="14" fill="${b.accent}"/>
      <circle cx="512" cy="844" r="14" fill="${b.accent}"/>
      <circle cx="224" cy="678" r="14" fill="${b.accent}"/>
      <circle cx="224" cy="346" r="14" fill="${b.accent}"/>
    `
  },
  {
    id: 'shape-cube',
    name: '等距立方',
    subtitle: 'Isometric Cube',
    description: '3D 悬浮空间立方，象征多工作区 Workspace 隔离与容器',
    renderSvg: (b) => `
      <defs>
        <linearGradient id="bg-cube" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.bgStart}"/>
          <stop offset="100%" stop-color="${b.bgEnd}"/>
        </linearGradient>
        <linearGradient id="top-face" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <linearGradient id="left-face" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.secondary}"/>
          <stop offset="100%" stop-color="${b.tertiary}"/>
        </linearGradient>
        <linearGradient id="right-face" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.tertiary}"/>
          <stop offset="100%" stop-color="#021c44"/>
        </linearGradient>
        <filter id="glow-cube" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg-cube)" stroke="${b.accent}" stroke-width="12" stroke-opacity="0.8"/>
      
      <!-- Outer Cube Frame -->
      <g filter="url(#glow-cube)">
        <!-- Top Face -->
        <polygon points="512,230 750,367 512,504 274,367" fill="url(#top-face)" stroke="${b.white}" stroke-width="6" opacity="0.95"/>
        <!-- Left Face -->
        <polygon points="274,367 512,504 512,778 274,641" fill="url(#left-face)" stroke="${b.accent}" stroke-width="6" opacity="0.85"/>
        <!-- Right Face -->
        <polygon points="750,367 512,504 512,778 750,641" fill="url(#right-face)" stroke="${b.accent}" stroke-width="6" opacity="0.85"/>
        
        <!-- Center glowing vertex -->
        <circle cx="512" cy="504" r="16" fill="${b.white}"/>
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
        <linearGradient id="bg-neural" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.bgStart}"/>
          <stop offset="100%" stop-color="${b.bgEnd}"/>
        </linearGradient>
        <linearGradient id="grad-neural" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <filter id="glow-neural" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg-neural)" stroke="${b.accent}" stroke-width="12" stroke-opacity="0.8"/>
      
      <!-- Network Links -->
      <g filter="url(#glow-neural)">
        <line x1="512" y1="270" x2="280" y2="690" stroke="url(#grad-neural)" stroke-width="20" stroke-linecap="round"/>
        <line x1="512" y1="270" x2="744" y2="690" stroke="url(#grad-neural)" stroke-width="20" stroke-linecap="round"/>
        <line x1="280" y1="690" x2="744" y2="690" stroke="url(#grad-neural)" stroke-width="20" stroke-linecap="round"/>

        <!-- Cross Links to Center -->
        <line x1="512" y1="270" x2="512" y2="550" stroke="${b.accent}" stroke-width="12" stroke-dasharray="16 12"/>
        <line x1="280" y1="690" x2="512" y2="550" stroke="${b.accent}" stroke-width="12" stroke-dasharray="16 12"/>
        <line x1="744" y1="690" x2="512" y2="550" stroke="${b.accent}" stroke-width="12" stroke-dasharray="16 12"/>

        <!-- 3 Outer Nodes -->
        <circle cx="512" cy="270" r="54" fill="url(#grad-neural)"/>
        <circle cx="512" cy="270" r="22" fill="${b.white}"/>

        <circle cx="280" cy="690" r="54" fill="url(#grad-neural)"/>
        <circle cx="280" cy="690" r="22" fill="${b.white}"/>

        <circle cx="744" cy="690" r="54" fill="url(#grad-neural)"/>
        <circle cx="744" cy="690" r="22" fill="${b.white}"/>

        <!-- Center AI Core Node -->
        <circle cx="512" cy="550" r="68" fill="url(#grad-neural)"/>
        <circle cx="512" cy="550" r="30" fill="${b.white}"/>
      </g>
    `
  },
  {
    id: 'shape-orb',
    name: '极简圆环',
    subtitle: 'Reactor Orb',
    description: '现代简约聚能同心环，圆润流畅且具纯粹科技感',
    renderSvg: (b) => `
      <defs>
        <linearGradient id="bg-orb" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.bgStart}"/>
          <stop offset="100%" stop-color="${b.bgEnd}"/>
        </linearGradient>
        <linearGradient id="grad-orb" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${b.accent}"/>
          <stop offset="100%" stop-color="${b.secondary}"/>
        </linearGradient>
        <filter id="glow-orb" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg-orb)" stroke="${b.accent}" stroke-width="12" stroke-opacity="0.8"/>
      
      <g filter="url(#glow-orb)">
        <!-- Outer Track Ring -->
        <circle cx="512" cy="512" r="310" fill="none" stroke="url(#grad-orb)" stroke-width="24"/>
        
        <!-- Segmented Track Ring -->
        <circle cx="512" cy="512" r="230" fill="none" stroke="${b.accent}" stroke-width="14" stroke-dasharray="64 24" stroke-opacity="0.75"/>
        
        <!-- Axis Crosshairs -->
        <line x1="202" y1="512" x2="272" y2="512" stroke="${b.accent}" stroke-width="10"/>
        <line x1="752" y1="512" x2="822" y2="512" stroke="${b.accent}" stroke-width="10"/>
        <line x1="512" y1="202" x2="512" y2="272" stroke="${b.accent}" stroke-width="10"/>
        <line x1="512" y1="752" x2="512" y2="822" stroke="${b.accent}" stroke-width="10"/>

        <!-- Core Energy Sphere -->
        <circle cx="512" cy="512" r="90" fill="url(#grad-orb)"/>
        <circle cx="512" cy="512" r="40" fill="${b.white}"/>
      </g>
    `
  }
];

function buildFullSvg(shape) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  ${shape.renderSvg(BRAND)}
</svg>`;
}

async function generateAllIcons() {
  console.log('🚀 Starting batch generation of unified lake-blue shape icons...');
  const startTime = Date.now();

  // Clear existing icons directory to remove old color themes
  if (fs.existsSync(ICONS_BASE_DIR)) {
    fs.rmSync(ICONS_BASE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(ICONS_BASE_DIR, { recursive: true });

  const generatedShapes = [];

  for (const shape of ICON_SHAPES) {
    const shapeDir = path.join(ICONS_BASE_DIR, shape.id);
    fs.mkdirSync(shapeDir, { recursive: true });

    const svgContent = buildFullSvg(shape);
    const svgPath = path.join(shapeDir, 'icon.svg');
    fs.writeFileSync(svgPath, svgContent, 'utf8');

    const svgBuffer = Buffer.from(svgContent);

    // Standard PWA & Web icon resolutions
    const targets = [
      { name: 'favicon.png', size: 32 },
      { name: 'apple-touch-icon.png', size: 180 },
      { name: 'icon-192.png', size: 192 },
      { name: 'icon-512.png', size: 512 }
    ];

    for (const target of targets) {
      const outputPath = path.join(shapeDir, target.name);
      await sharp(svgBuffer)
        .resize(target.size, target.size)
        .png({ quality: 100, compressionLevel: 9 })
        .toFile(outputPath);
    }

    // Write meta.json without any themeColor pollution
    const meta = {
      id: shape.id,
      name: shape.name,
      subtitle: shape.subtitle,
      description: shape.description,
      preview: `/icons/${shape.id}/icon-192.png`,
      favicon: `/icons/${shape.id}/favicon.png`,
      appleTouchIcon: `/icons/${shape.id}/apple-touch-icon.png`,
      icon192: `/icons/${shape.id}/icon-192.png`,
      icon512: `/icons/${shape.id}/icon-512.png`
    };

    fs.writeFileSync(
      path.join(shapeDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8'
    );

    generatedShapes.push(meta);
    console.log(`✅ Generated shape: ${shape.name} (${shape.id})`);
  }

  // Save index of all shapes
  fs.writeFileSync(
    path.join(ICONS_BASE_DIR, 'themes.json'),
    JSON.stringify(generatedShapes, null, 2),
    'utf8'
  );

  console.log(`✨ All ${ICON_SHAPES.length} shape icons generated successfully in ${((Date.now() - startTime)/1000).toFixed(2)}s!`);
}

if (require.main === module) {
  generateAllIcons().catch((err) => {
    console.error('❌ Error generating icons:', err);
    process.exit(1);
  });
}

module.exports = {
  BRAND,
  ICON_SHAPES,
  generateAllIcons
};
