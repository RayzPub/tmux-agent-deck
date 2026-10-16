# 移动端 PWA 沉浸式主题切换实践规范

本文档总结了在 Web / PWA 应用中实现移动端（特别是手机端 iOS Safari / Android Chrome）主题切换时，使系统状态栏、刘海区与页面顶部边框浑然一体、无割裂感的核心技术方案。

---

## 1. 核心痛点与现象

在普通的 Web 响应式页面切换主题时，常出现以下手机端兼容性体验问题：
- **系统状态栏色差孤岛**：网页内容已变为浅色（白底），但手机顶部状态栏/刘海区域依旧停留在深黑色；反之亦然。
- **顶栏分界割裂**：页面顶部的 `header` 边框与系统状态栏交接处出现突兀的色彩断层。

---

## 2. 核心架构：双轨驱动机制

要实现移动端顶部的一体化联动，必须采用 **“原生层 + 样式层” 双轨同步机制**：
1. **原生层（驱动系统状态栏）**：动态操纵 `<meta name="theme-color">`。
2. **样式层（驱动页面 DOM 顶栏及边框）**：切换 `body` 上的主题类名，联动 CSS 变量与边框颜色。

```
              ┌─── [JavaScript: toggleTheme()] ───┐
              │                                    │
              ▼                                    ▼
   【原生层 / 系统状态栏】                  【样式层 / 网页 DOM】
更新 meta[name="theme-color"]            切换 body 类名 (e.g. .light-minimalist)
       │                                            │
       ▼                                            ▼
手机顶部刘海/状态栏底色变色                   .header 背景与 border-bottom 变色
```

---

## 3. 标准落地三步法

### 步骤一：HTML 头部配置（声明 ID 与视口）
在 `index.html` 的 `<head>` 中配置视口扩展（撑满刘海屏），并为 `theme-color` 赋予一个固定 `id`，以便 JS 高效查找：

```html
<head>
  <meta charset="UTF-8">
  <!-- viewport-fit=cover 允许页面内容延伸至刘海区安全边距 -->
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  
  <!-- 预设初始主题色，并设定固定 id -->
  <meta name="theme-color" id="pwaThemeColor" content="#141a29">
  
  <!-- iOS Safari 沉浸式状态栏配置（可选） -->
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
</head>
```

### 步骤二：JavaScript 同步更新函数
在切换主题的逻辑中，同步操作 DOM 类与 Meta 属性：

```javascript
// theme.js
export function updateMetaThemeColor(isLight) {
  const meta = document.getElementById('pwaThemeColor');
  if (meta) {
    // 浅色模式：设为白色(#ffffff)或浅灰，与浅色顶栏底色一致
    // 深色模式：设为暗夜背景色(#141a29)，与深色顶栏底色一致
    meta.setAttribute('content', isLight ? '#ffffff' : '#141a29');
  }
}

export function toggleTheme() {
  const isLight = document.body.classList.toggle('light-minimalist');
  
  // 1. 本地持久化
  localStorage.setItem('theme-style', isLight ? 'light-minimalist' : 'dark-cyberpunk');
  
  // 2. 关键：通知手机端浏览器/PWA 状态栏改变底色
  updateMetaThemeColor(isLight);
}
```

### 步骤三：CSS 边框与背景色响应
顶栏的 `background` 必须与 `meta theme-color` 严格保持一致，边框采用与当前主题层级相配的微光边或柔和边：

```css
/* ===================================================
   深色模式（默认）
   =================================================== */
:root {
  --surface-0: #141a29;
  --border-hairline: rgba(255, 255, 255, 0.08);
}

.app-header {
  height: 56px;
  background: var(--surface-0); /* 与深色 meta theme-color 完全一致 */
  border-bottom: 0.5px solid var(--border-hairline); /* 极细微光下边框 */
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
}

/* ===================================================
   浅色模式（挂载类名）
   =================================================== */
body.light-minimalist .app-header {
  background: #ffffff; /* 与浅色 meta theme-color 完全一致 */
  border-bottom: 1px solid #e2e8f0; /* 自动切换为高对比度浅灰分割线 */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
```

---

## 4. 关键设计与避坑原则

1. **色值强一致原则（绝对不能有偏差）**：
   `meta theme-color` 的色值必须精确匹配 `.app-header` 的有效背景色。若有一丝色差（如 header 是 `#ffffff`，meta 写成了 `#f8fafc`），手机在滚动或静止时顶部就会出现一条极显眼的断层线。
2. **避免在 header 上使用带透明度且无不透明底色的背景**：
   如果 `.app-header` 使用半透明背景（如 `rgba(255, 255, 255, 0.8)` 带毛玻璃），`theme-color` 不支持 Alpha 透明通道，建议 `theme-color` 使用混合后的主底色。
3. **iOS 状态栏字体反色机制**：
   当 `apple-mobile-web-app-status-bar-style` 设为 `default` 时，iOS 系统会根据 `theme-color` 或网页顶部的明暗度自动切换状态栏文字颜色（深色背景自动配白色文字/图标，浅色背景自动配黑色文字/图标）。
