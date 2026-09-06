# Antigravity & Agent Rules (AGENTS.md)

This file defines the project standards, directory layout, commands, and coding guidelines for AI developers working on **tmux-agent-deck**.

## 1. System Environment & Commands
- **Runtime Environment**: Node.js `v26.4.0` (managed via NVM).
  - Absolute Path: `/home/ubuntu/.nvm/versions/node/v26.4.0/bin/node`
- **Port Bindings**: Default ports are HTTP `80` and HTTPS `443` (requires root privileges).
- **Run Commands**:
  - Run Production/Staging: `sudo npm start` or `sudo node server.js`
  - Non-Privileged Staging/Test Run: `PORT=3888 HTTPS_PORT=3889 SSL_CERT_PATH="" SSL_KEY_PATH="" node server.js`
  - **Restart Guidelines**: Do NOT restart the server for frontend resource changes (e.g., changes under `public/` or static files). Only restart the server when backend code (e.g., `server.js`, `config/`, `routes/`, `services/`, `sockets/`, `middlewares/`) is modified.

## 2. Directory Layout & Architecture
This project is fully refactored into a modular architecture. All logic must follow this layout:

- **Backend**:
  - `server.js` - Server entry point (keep minimal; only configures/boots services).
  - `config/` - Configuration loader and dotenv loading.
  - `middlewares/` - Authentication and general express middlewares.
  - `routes/` - REST API endpoints.
  - `services/` - Sub-services (Tmux execution, Git operations, File processing, Push Notifications).
  - `sockets/` - Socket.io event mappings and PTY process bindings.
- **Frontend**:
  - `public/index.html` - HTML Shell.
  - `public/js/app.js` - Main entrypoint (loaded as `type="module"`).
  - `public/js/modules/` - Shared state and UI sub-controllers (explorer, editor, terminal, tabs, diff, push, voice, theme).
  - `public/css/` - Styling system.

## 3. Strict Coding Guidelines

### 🛡️ Safety & Path Validation (Critical)
- **Directory Traversal Prevention**: Any backend API that reads, writes, or checks files on disk **MUST** use the `safeResolve` validator from `services/fileService.js`:
  ```javascript
  const { safeResolve } = require('../services/fileService');
  const targetPath = safeResolve(workspacePath, reqPath);
  ```
- **Constraint**: Do not use ad-hoc string validation like `path.startsWith(root)` on path strings as this is vulnerable to sibling-directory traversal (e.g. `/path/to/project-sibling` matching `/path/to/project`).

### 🐚 Tmux Privilege Dropping
- When launching shell commands or PTY processes, check if the server is running as root and drop privileges to the invoking `SUDO_USER` when executing git, shell commands, or attaching tmux sessions. Use `getRunUser()` and the wrapped execution helpers in `services/tmuxService.js`.

### 📦 Modular Development
- **No Monoliths**: Avoid adding logic directly into `server.js` or `public/js/app.js`. Create individual modular service files, routes, or front-end ES modules as appropriate.
- **ES Modules on Frontend**: Any new front-end file must be placed under `public/js/modules/` and exported, then imported in `public/js/app.js` or another module.

### ⚡ Production Caching & Build Guidelines (CDN Deployment)
To support CDN deployments and browser caching optimizations without causing stale file issues, the project follows these guidelines:

- **Custom Client Assets (`app.js`, `style.css`)**:
  - Must be compiled via `npm run build` (uses `esbuild` to bundle, minify, and hash filenames: `app-[hash].js`, `style-[hash].css`).
  - Served from `public/dist/` under the `/dist` route with a 1-year strong cache: `Cache-Control: public, max-age=31536000, immutable`.
  - The startup script `start.sh` automatically performs an incremental check before starting the server. If any source file modification time is newer than the build in `public/dist`, it rebuilds assets.
  - In development mode (where `public/dist/` is absent), the server automatically falls back to raw unbundled assets in `public/` (with `no-cache` to force revalidation).
- **Third-Party Vendor Libraries (lucide, xterm, qrcode, marked)**:
  - Must be kept separate (not bundled into the main app) to optimize caching (Vendor Splitting).
  - Must be placed under a `vendor/` subdirectory (e.g. `public/js/vendor/` or `public/css/vendor/`) to automatically match server cache configurations (which set a 1-year cache: `Cache-Control: public, max-age=31536000, immutable`).
- **HTML Pages (`/`, `/login`, `/register`, `/welcome`)**:
  - Must use clean URLs without the `.html` extension (both `/login` and `/login.html` are supported in Express).
  - Must NEVER be permanently cached. They are served with `Cache-Control: no-cache, must-revalidate` to force CDN/browser revalidation on every load.
- **API Endpoints (`/api/*`)**:
  - Must NEVER be cached or stored in any public/private cache. They are served with `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate` to ensure real-time accuracy and prevent security leaks.
- **Offline Cache Service Worker (`sw.js`)**:
  - Must remain in the root directory `public/sw.js` (cannot be placed in `/dist` due to scope limitations).
  - Must not use a hashed filename and is served with `Cache-Control: no-cache` to allow automatic browser byte-by-byte updates.

## 4. AI Agent CLI Integration & Environment Guard (Claude Code & Codex)
When integrating or modifying execution flows for **Claude Code** and **OpenAI Codex CLI**, follow these critical rules:
- **Detailed Reference Guide**: Refer to [docs/agent_cli_config_guide.md](docs/agent_cli_config_guide.md) for full architecture and protocol breakdown.
- **Claude Code Precedence Alert**: `~/.claude/settings.json` has an internal `env` mapping that **overrides** shell `process.env`. When 127 LLM Gateway is active, `services/fileService.js` must ensure `settings.env.ANTHROPIC_BASE_URL` is purged so that traffic is not hijacked to external endpoints with virtual keys.
- **Codex CLI Configuration Rule**: Codex CLI defaults to reading `base_url` from `~/.codex/config.toml` and **ignores** `OPENAI_BASE_URL` from the environment. Use `ensureCodexConfig()` from `services/fileService.js` to ensure `deck_gateway` is written to `config.toml` pointing to `http://127.0.0.1/v1`.
- **Sensitive Key Separation**: Never write plaintext `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` into `settings.json` or `config.toml`. All real keys belong in `data/llm_gateway.json` and are dynamically managed by the backend.

## 5. 前端主题色适配规范 (Theme & Color Adaptation Guidelines)
系统支持深浅双主题切换，任何前端界面新增或迭代必须严格遵守以下主题色规范：

- **双主题架构机制**：
  - 默认深色：Cyberpunk 赛博朋克深黑霓虹主题（根作用域）。
  - 浅色极简：通过 `document.body` 挂载 `.light-minimalist` 类实现（`body.light-minimalist`）。
- **全要素双态适配要求（强制）**：
  - 任何新增的 UI 组件（弹窗、选项卡片、输入框、徽章、下拉菜单、交互图表）**必须同步编写 `body.light-minimalist` 浅色适配样式**。
  - 严禁出现“仅适配深色”导致切换至浅色模式时产生白底白字、未反色的深黑孤岛或对比度过低等视觉残缺。
- **深浅色彩映射对照标准**：
  - **容器与卡片底色**：
    - 深色：`rgba(7, 9, 18, 0.7)` / `#0e121e` / `var(--bg-card)`
    - 浅色：纯白 `#ffffff` / 底白 `#f8fafc`，悬停态反显 `#f1f5f9`
  - **边框与分割线**：
    - 深色：`rgba(255, 255, 255, 0.08)` / 赛博青微光边框
    - 浅色：柔和浅灰 `#cbd5e1` / `#e2e8f0`，悬停或获得焦点时加深为 `#94a3b8`
  - **选中与高亮态 (Checked / Active)**：
    - 深色：霓虹青 `var(--neon-cyan)` 边框 + 赛博发光阴影 + 青色微底
    - 浅色：优雅靛蓝 `#4f46e5` 边框 + 柔和浅紫 `#eef2ff` 底色，消除发光滤镜（`box-shadow: 0 0 0 1px #4f46e5`）
  - **文字层级对比度**：
    - 主标题 / 核心文本：深色 `#ffffff` ➔ 浅色 `#0f172a`（高对比度深墨灰）
    - 提供商 Tag / 高亮标识：深色 `var(--neon-cyan)` ➔ 浅色 `#4f46e5`
    - 辅助说明 / 次级文本：深色 `var(--text-muted)` ➔ 浅色 `#64748b` / `#475569`
  - **状态徽章 (Badges & Pills)**：
    - 深色：`rgba(0, 240, 255, 0.1)` 底色 + 霓虹青字色与细边框
    - 浅色：`#eef2ff` 浅底 + `#4f46e5` 靛蓝字色 + `#c7d2fe` 浅紫细边框
- **静态资源构建提醒**：
  - 修改 `public/css/` 下的任何样式文件后，必须执行 `npm run build` 生成生产环境 Hash 资源文件，确保 CDN/强缓存机制下能立即加载最新样式。



