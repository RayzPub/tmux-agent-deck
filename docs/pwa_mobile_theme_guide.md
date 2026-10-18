# 移动端 PWA 沉浸式主题切换实践与避坑指南

本文档总结了在 Web / PWA 应用中实现移动端（特别是 **iPhone / iOS Safari / PWA Standalone 独立应用**）主题切换时，使系统状态栏、刘海区与页面顶部边框浑然一体、无割裂感的核心技术方案与关键避坑点。

---

## 1. 核心痛点与现象

在普通的 Web 响应式页面切换主题时，常出现以下手机端（尤其是 iPhone）特有的兼容性体验问题：
- **电脑端正常，但 iPhone PWA 顶部完全不随主题改变**。
- **系统状态栏色差孤岛**：网页内容已变为深色（暗黑），但 iPhone 顶部状态栏依旧死锁在白色背景（或反之）。
- **页面与刘海区分界割裂**：页面顶部的 `header` 边框与系统状态栏交接处出现突兀的色彩断层。

---

## 2. iPhone PWA 的底层原理与两大核心方案

### 方案 A（推荐）：`black-translucent` 沉浸式穿透模式（最丝滑无 bug）
这是现代高端移动 Web App（包括全屏 PWA）最佳的实现方式。
- **原理**：将状态栏设为 `black-translucent`（纯透明悬浮层），页面直接向上顶满到屏幕物理边缘（穿透刘海/灵动岛）。
- **效果**：此时状态栏没有自己的实体底色，**完全透出你网页顶栏（Header / Body）的 CSS 颜色**。因此当你在 JS 里切换主题改变 CSS 背景时，顶部状态栏会 100% 同步切换，绝无任何色差和延迟！
- **必须注意**：顶栏必须增加安全距离 `padding-top: env(safe-area-inset-top)`，避免文字被刘海或灵动岛遮挡。

```html
<!-- 方案 A 的标准 Head 配置 -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<!-- 关键：必须是 black-translucent，绝对不能写 default 或 black -->
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" id="pwaThemeColor" content="#141a29">
```

```css
/* CSS 顶栏需要避让刘海安全区 */
.app-header {
  padding-top: env(safe-area-inset-top);
  height: calc(56px + env(safe-area-inset-top));
  background: var(--surface-0); /* 深色时为 #141a29 */
  border-bottom: 0.5px solid var(--border-hairline);
}

body.light-minimalist .app-header {
  background: #ffffff; /* 浅色时为纯白，状态栏透过后直接显示纯白 */
  border-bottom: 1px solid #e2e8f0;
}
```

---

### 方案 B：纯标准 Web App 模式（无 Apple 私有状态栏锁死标签）
如果不需要网页穿透到状态栏后方，而是希望系统状态栏在网页上方独立显示：
- **切勿声明** `<meta name="apple-mobile-web-app-status-bar-style">`！
- 只保留 `<meta name="theme-color">`，让系统根据标准 `theme-color` 实时着色。

```html
<!-- 方案 B 的标准 Head 配置 -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" id="pwaThemeColor" content="#141a29">
<!-- 严禁添加 apple-mobile-web-app-status-bar-style -->
```

---

## 3. 为什么你在其他项目改了之后 iPhone 失效？（五大排查清单）

### 🚨 排查 1：误写了 `<meta name="apple-mobile-web-app-status-bar-style" content="default">`（最致命）
- **原因**：当配置了 `content="default"` 时，iOS 会把状态栏强行写死为“白底黑字”；配置了 `content="black"` 时，强行写死为“黑底白字”。
- **后果**：**iOS 一旦读取到这两个值，就会直接彻底忽略 `<meta name="theme-color">` 的动态修改！** 这就是为什么电脑上正常、Android 上正常，但在 iPhone 上死活不动的根本原因。
- **解决办法**：
  - 如果想要沉浸式，改成 `content="black-translucent"`；
  - 或者直接把 `<meta name="apple-mobile-web-app-status-bar-style">` 这一行整行删除！

### 🚨 排查 2：`html` 和 `body` 的底色没有绑定主题（SPA / React / Vue 常见坑）
- **原因**：在 Vue / React 项目中，很多开发者把主题色挂在 `<div id="app">`、`<div id="root">` 或自定义容器上，而根节点 `html` 与 `body` 没有设置动态的 `background-color`。
- **后果**：iOS WebKit 在计算状态栏采样和弹性回弹区域时，**读取的是 `html` 和 `body` 的 CSS 背景色**，而不是里面的子容器。
- **解决办法**：
  ```css
  html, body {
    background-color: var(--bg-core);
    margin: 0;
    padding: 0;
  }
  body.light-minimalist {
    --bg-core: #ffffff;
  }
  ```

### 🚨 排查 3：iPhone 主屏幕强缓存了旧的 PWA 配置（极高概率）
- **原因**：iOS 的“添加到主屏幕”机制非常古怪——**它会在你点击“添加到主屏幕”的那一瞬间，将 HTML 里的 Meta 标签和 Manifest 固化在 iOS 本地沙盒中**。
- **后果**：后续即使你在服务器修改了 HTML、更新了 Meta 标签，**已经安装在 iPhone 桌面上的 PWA 图标依然会使用第一次安装时的旧配置**！
- **解决办法**：
  1. 在 iPhone 主屏幕长按并**彻底删除**该 Web App 图标。
  2. 打开 Safari，清除该域名的网站缓存（或在无痕模式测试）。
  3. 重新在 Safari 中点击“添加到主屏幕”。

### 🚨 排查 4：iOS WebKit 动态修改 `meta` 标签的响应 Bug
- **原因**：在某些 iOS WebKit 版本中，直接执行 `meta.setAttribute('content', color)` 不会触发状态栏实时重绘。
- **解决办法**：采用“销毁并重建节点”的方式强制触发 WebKit 重绘：
  ```javascript
  export function updateMetaThemeColor(isLight) {
    const color = isLight ? '#ffffff' : '#141a29';
    let meta = document.getElementById('pwaThemeColor');
    
    // 强制重建节点，强迫 iOS WebKit 重新解析并重绘状态栏
    if (meta) {
      meta.remove();
    }
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.id = 'pwaThemeColor';
    meta.content = color;
    document.head.appendChild(meta);
  }
  ```

### 🚨 排查 5：存在带 `media` 属性的 theme-color 标签冲突
- 如果 HTML 中预先写了：
  ```html
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
  ```
- 当你用 JS 去修改无 `media` 的标签时，iOS 会优先采用系统级跟随的 `media` 规则，导致你的自定义切换被系统覆盖。请确保只保留一个不带 `media` 的单一 `meta[name="theme-color"]` 由 JS 全权接管。
