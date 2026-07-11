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
