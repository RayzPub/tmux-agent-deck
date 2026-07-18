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

