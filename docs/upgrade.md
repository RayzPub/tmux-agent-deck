# CCNOW 架构升级指南 (`Upgrade Guide`)

本文档面向正在运行旧版本 **tmux-agent-deck (CCNOW)** 的线上或测试实例，指导如何安全、平滑地升级至最新架构版本（**Control Plane + 统一算力设备模型 + `node:sqlite` + OAR `0.128.1` + `ccnow-agent v1.7.6`**）。

> **适用跨度**：从 2026-11-15 及之前版本（JSON 文件持久化、旧版单机直连模式、`@botiverse/oar 0.79.x`、`ccnow-agent <= 1.2.x`）或任意近期版本升级至 `main` 最新提交（`31b6061` 及之后）。

---

## 1. 近期重大架构升级摘要（升级前必读）

最近两周系统完成了核心架构重构，升级时请重点留意以下变化：

| 模块 | 旧架构 | 新架构 | 升级影响与必做动作 |
| :--- | :--- | :--- | :--- |
| **持久化存储** | 多个分散 JSON 文件（`data/users.json`、`workspaces.json` 等） | **Node.js 原生 `node:sqlite` (`data/ccnow.db`, WAL 模式)**，Schema v2 含单调自增会话 ID 与 `session_meta` | **必须使用支持 `node:sqlite` 的 Node.js（≥ v22.5，推荐 v22.13+ / v26.4.0）**；需执行数据迁移脚本 |
| **控制面与算力解耦** | `server.js` 直接承载本机 Tmux/会话 | 四层架构：`Control Plane -> User -> Device (host-admin / docker-sandbox / external) -> Workspace -> Session` | 宿主机需运行 `setup-host-admin-agent.js` 注册独立服务 `ccnow-host-agent.service` |
| **云端托管沙箱** | 无容器级隔离 | 新增硬化 Docker 沙箱（`docker/Dockerfile.sandbox`）与作用域虚拟 Key LLM Gateway（`sk-ccnow-<id>.<secret>`） | 若启用多用户云电脑，需构建 `ccnow-sandbox:latest` 镜像 |
| **OAR 与模型选择** | `@botiverse/oar ^0.79.0`，静态模型配置 | 升级至 `@botiverse/oar ^0.128.1`；精简为 **Tmux 双模 / OAR 原生流式** 两大引擎；支持**实时设备端模型与推理深度（Effort）探测及对话内切换** | 需 `npm install` 更新依赖，并将宿主机与外部节点 `ccnow-agent` 升级至 `v1.7.6` |
| **边缘守护进程** | 单体脚本 | 模块化源码（`client/src/`）经 esbuild 打包为单文件 `client/ccnow-agent.js`（`v1.7.6`），支持依赖自安装、免 Tmux 跑 OAR、`systemd`/`launchd` 守护 | 控制面需运行 `npm run build`；外部节点需触发远程升级或 CLI `update` |
| **服务进程管理** | `nohup node server.js` | `start.sh` / `stop.sh` / `restart.sh` 自动将 `server.js` 隔离在 `systemd` 单元 `ccnow-server.service` 中 | 重启控制面不断开宿主机 Agent；新增 `restart.sh --with-agent` |
| **IM Bot 通道** | 配置 Token 后自动启用 | **默认关闭**（受 `IM_BOT_ENABLED` 开关控制） | 如原实例在使用 Telegram / 微信机器人，需在 `.env` 显式增加 `IM_BOT_ENABLED=true` |
| **前端与无设备引导** | 静态欢迎页 | 新增无在线设备时的 **Onboarding 引导页**、Session-as-Task 看板、Mermaid 渲染、文件路径跳转、刷新 PWA 图标 | 必须执行 `npm run build` 重新生成带 Hash 的 `public/dist/` 静态产物 |

---

## 2. 升级前检查与完整备份

### 2.1 检查 Node.js 版本（关键前置条件）

新版本控制面直接使用 Node.js 内置模块 `node:sqlite`，不再依赖第三方原生 SQLite 包：

```bash
node -v
node -e "const { DatabaseSync } = require('node:sqlite'); console.log('node:sqlite OK');"
```

- 如果输出 `node:sqlite OK`，可直接继续。
- 如果提示 `Cannot find module 'node:sqlite'` 或 Node 版本低于 `v22.5.0`，请先升级 Node.js（推荐通过 NVM 安装最新 LTS 或与开发环境一致的 `v26.4.0`）：
  ```bash
  nvm install 26.4.0
  nvm use 26.4.0
  nvm alias default 26.4.0
  ```
- **注意**：升级 Node.js 主版本后，后续步骤中务必重新安装/重编译 `node_modules`（尤其是原生模块 `node-pty`）。

### 2.2 备份现有数据与配置

在项目根目录（如 `~/tmux-agent-deck`）执行完整快照备份：

```bash
cd /path/to/tmux-agent-deck

BACKUP_DIR="backups/pre-upgrade-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 备份环境变量、历史 JSON 数据目录与根目录运行数据
for target in .env data workspaces.json push_subscriptions.json im_bindings.json vapid.json; do
  [ -e "$target" ] && cp -a "$target" "$BACKUP_DIR/"
done

# 若已存在宿主机 Agent 配置，一并备份
[ -d "$HOME/.ccnow-host-agent" ] && cp -a "$HOME/.ccnow-host-agent" "$BACKUP_DIR/ccnow-host-agent"

ls -la "$BACKUP_DIR"
```

### 2.3 检查 Git 工作区状态

```bash
git status -sb
```

如有未提交的本地定制修改，请先 `git stash` 或手动保存，避免拉取代码冲突。

---

## 3. 控制面标准升级步骤

### Step 1：停止当前运行的服务

```bash
sudo ./stop.sh
```

> 若旧实例是通过手动 `nohup`、`pm2` 或其他自定义 `systemd` 服务启动的，请确认原有 `server.js` 进程已彻底退出且监听端口（默认 `80` / `443`）已释放：
> ```bash
> ps aux | grep "[s]erver.js"
> ```

### Step 2：拉取最新代码并安装依赖

```bash
git pull --ff-only origin main
npm install
```

> **如果刚才升级了 Node.js 主版本**，建议清理重建原生模块，避免 `node-pty` ABI 不匹配：
> ```bash
> rm -rf node_modules && npm install
> ```

### Step 3：核对 `.env` 配置项

对比 [.env.example](../.env.example)，检查你的 `.env` 文件：

1. **必填安全校验**（`config/index.js` 启动时会强制检查）：
   - `PASSWORD` 长度 ≥ 16 字符
   - `JWT_SECRET` 长度 ≥ 32 字符
2. **多用户与沙箱开关**：
   ```env
   # 多用户隔离模式（单人私有实例设为 false，多人协作设为 true）
   MULTI_USER_ENABLED=true

   # 云端托管 Docker 沙箱（如不需要云电脑，可设为 false）
   DOCKER_SANDBOX_ENABLED=true
   DOCKER_SANDBOX_IMAGE=ccnow-sandbox:latest
   DOCKER_SANDBOX_MEMORY=1g
   DOCKER_SANDBOX_CPUS=1
   DOCKER_SANDBOX_PIDS_LIMIT=256
   DOCKER_SANDBOX_IDLE_MINUTES=30
   ```
3. **IM 机器人开关（如原实例依赖 Telegram / 微信 Bot）**：
   ```env
   # 默认为 false；需要继续使用旧版 IM Bot 时显式开启
   IM_BOT_ENABLED=true
   ```

> **提示**：当 `MULTI_USER_ENABLED=true` 时，`start.sh` 会检查 Linux 宿主机是否已安装 `firejail`（`sudo apt install -y firejail`）；若为纯个人单机实例，建议将 `MULTI_USER_ENABLED=false`。

### Step 4：执行 JSON ➔ SQLite 数据迁移

虽然 `server.js` 启动时会自动调用幂等迁移，但**强烈建议在启动前手动预演并执行一次**，以便核对迁移数量：

```bash
# 1. Dry-run 预演（只读，不修改任何文件或数据库）
node scripts/migrate-json-to-sqlite.js --dry-run

# 2. 正式执行迁移（自动创建 data/legacy_json_backup_<timestamp>/ 备份）
npm run migrate:sqlite
```

如需迁移完成后自动把旧 JSON 移入归档目录（保持目录整洁），可使用：
```bash
node scripts/migrate-json-to-sqlite.js --archive
```

确认输出中的 `users`、`invite_codes`、`settings`、`devices`、`workspaces`、`task_board_*`、`push_subscriptions` 计数与原实例一致，且 `data/ccnow.db` 已生成。

### Step 5：构建前端静态资源与 `ccnow-agent` 单文件包

```bash
npm run build
```

此步骤会同步完成两件事：
- 编译压缩并带内容 Hash 打包前端资源至 `public/dist/`；
- 将 `client/src/` 打包为最新 `v1.7.6` 单文件 `client/ccnow-agent.js`（供本机、Docker 沙箱与外部节点下载）。

### Step 6：启动控制面服务

```bash
sudo ./start.sh
```

`start.sh` 在 Linux systemd 环境下会自动以隔离单元 `ccnow-server.service` 启动 `server.js`。检查启动日志确认无报错：

```bash
systemctl status ccnow-server.service --no-pager
tail -n 40 server.log
```

---

## 4. 升级与注册算力节点（重要）

> [!IMPORTANT]
> 新架构下，控制面（`server.js`）本身**不再直接充当默认算力设备**。升级控制面后，请务必完成 **Step 7（宿主机 `host-admin`）**，否则登录控制台后会看到“无在线设备引导页”，无法直接操作云主机上的原有工作区和会话。

### Step 7：注册 / 升级宿主机常驻 Agent（`host-admin`）

在当前非 root 运维用户下使用 `sudo` 执行（脚本会自动识别 `SUDO_USER` 为运行用户，若直接以 root 登录请显式指定 `SUDO_USER=<你的用户名>`）：

```bash
sudo node scripts/setup-host-admin-agent.js
# 若当前就是 root shell 且业务用户是 ubuntu（或其他用户名）：
# SUDO_USER=ubuntu node scripts/setup-host-admin-agent.js
```

该脚本是**完全幂等**的（首次安装与后续版本升级均执行同一条命令），它会自动完成：
1. 在 SQLite 中为 `admin` 创建或复用 `deviceKind: 'host-admin'` 设备记录（默认名：`主服务器`）；
2. 将凭证写入 `~/.ccnow-host-agent/device.json`，并配置 `CCNOW_TMUX_SOCKET` 指向 `user_data/admin/tmux.sock`；
3. 自动同步宿主机 `~/.codex/config.toml` 与清理冲突的 `~/.claude/settings.json` 环境变量（若开启了 Claude OAuth 模式则自动注入 `CCNOW_CLAUDE_OAUTH_MODE=1`）；
4. 写入/更新 `/etc/systemd/system/ccnow-host-agent.service` 并重启服务，使宿主机 Agent 升级到 `v1.7.6`。

验证宿主机 Agent 运行与隧道连接状态：

```bash
systemctl status ccnow-host-agent.service --no-pager
tail -n 30 ~/.ccnow-host-agent/agent.log
```

看到成功连接 `ws://127.0.0.1.../device-tunnel` 且上报 `v1.7.6` 即表示正常。

> **工作区核对**：宿主机 Agent 的工作区列表保存在 `~/.ccnow-host-agent/workspaces.json`。如原云主机上有多个工作区目录，登录后可在侧边栏直接添加，或编辑该文件后重启 `ccnow-host-agent.service`。
>
> 后续日常仅重启控制面用 `sudo ./restart.sh`（宿主机 Agent 与会话不断连）；如需连同宿主机 Agent 一起重启，使用 `sudo ./restart.sh --with-agent`。

### Step 8（可选）：构建 / 升级云端 Docker 沙箱镜像（`docker-sandbox`）

仅当需要为多用户或自己提供「云电脑」隔离容器时执行（需要宿主机已安装并启动 Docker）：

```bash
# 标准构建（基于 node:26.4-trixie-slim，内置 tmux/node-pty/@botiverse/oar/claude/codex/agy/kimi）
npm run build:sandbox
```

常用加速与定制参数：

```bash
# 国内服务器加速 + 自动重建已在运行的旧版沙箱容器（挂载卷数据不丢失）
bash scripts/build-sandbox-image.sh \
  --apt-mirror mirrors.tencent.com \
  --npm-registry https://registry.npmmirror.com \
  --recreate-running

# 如不需要 agy 或 kimi，可按需裁剪减小镜像体积
bash scripts/build-sandbox-image.sh --no-agy --no-kimi
```

构建脚本自带第 3 步硬化自检（在 `--cap-drop=ALL`、`--security-opt=no-new-privileges:true`、1G 内存限制下验证 `node` / `tmux` / `claude` / `codex` / `node-pty` / `@botiverse/oar` 全部可用）。

### Step 9（可选）：升级已接入的外部设备（Mac / Linux / Windows）

为支持最新的动态模型列表探测（`oar:list_models`）、对话内模型切换（`oar:set_model`）及守护进程管理，建议将所有外部边缘节点升级到 `ccnow-agent v1.7.6`：

- **方式 A：Web 控制台一键远程升级（推荐，适用于当前在线设备）**
  1. 登录 Web 控制台 → **「系统设置」➔「设备管理」**；
  2. 找到版本低于 `v1.7.6` 的在线设备，点击 **升级 Agent** 按钮；
  3. 节点会自动从控制面 `/agent.js` 拉取最新版并延迟 1 秒自重启重连。

- **方式 B：在外部设备本机通过 CLI 手动升级**
  ```bash
  node ~/.ccnow/ccnow-agent.js update
  node ~/.ccnow/ccnow-agent.js service restart
  node ~/.ccnow/ccnow-agent.js version
  ```
  如果该节点尚未安装可选运行时依赖（如 `@botiverse/oar` 或 `node-pty`），可执行一次自检安装：
  ```bash
  node ~/.ccnow/ccnow-agent.js setup
  ```

- **方式 C：早期版本（< v1.2.0）或未配置守护进程**
  直接到 Web 控制台「设备管理」复制最新配对命令，带上 `--daemon` 重新配对并注册开机自启服务。

---

## 5. 升级后验证清单

### 5.1 命令行与测试套件验证

```bash
# 1. 运行核心自动化测试（网关、SQLite 存储、会话元数据）
npm test
npm run test:storage
node test/sessionMeta.test.js

# 2. 检查控制面健康探测（仅限本机回环访问）
curl -s http://127.0.0.1:${PORT:-80}/api/hello
# 预期输出: {"status":"ok"}

# 3. 检查双服务状态
systemctl is-active ccnow-server.service ccnow-host-agent.service
```

### 5.2 Web 端功能验收

1. **刷新前端缓存**：打开控制台（若使用 CDN 或 PWA，先硬刷新一次确认加载最新 `public/dist/` 资源）。
2. **账号与数据核对**：确认原有账号、邀请码、LLM Gateway 配置（`data/llm_gateway.json`）正常可用。
3. **设备在线状态**：左上角设备切换器中 `主服务器 (host-admin)` 显示在线且版本为 `v1.7.6`。
4. **模型与推理深度选择器**：点击「新建会话」，切换不同 Agent（Claude / Codex / Antigravity / Kimi），确认可动态加载设备端与网关模型列表及 Reasoning Effort 选项。
5. **会话与对话切换验证**：
   - 创建一条 **OAR 原生流式会话** 或 **Tmux 双模会话**；
   - 确认留空名称时自动生成递增 ID 且首条消息后自动摘要标题；
   - 在 OAR 对话中测试顶部/输入栏模型切换器正常工作。
6. **（如启用 Docker 沙箱）**：在「设备管理」点击启动云电脑，确认容器拉起且自动连入控制面。

---

## 6. 常见问题排查

### Q1：启动报错 `Cannot find module 'node:sqlite'`
- **原因**：当前运行 `server.js` 的 Node.js 版本低于 `v22.5.0`。
- **解决**：使用 NVM 安装 Node.js ≥ v22.13（推荐 `v26.4.0`），确认 `start.sh` 探测到的 `NODE_BIN` 是新版本，并执行 `rm -rf node_modules && npm install`。

### Q2：升级后登录控制台直接进入“离线设备引导页”，看不到原工作区
- **原因**：尚未注册宿主机 `host-admin` Agent，或 `ccnow-host-agent.service` 启动失败。
- **解决**：
  1. 执行 `sudo node scripts/setup-host-admin-agent.js`；
  2. 查看日志 `tail -n 50 ~/.ccnow-host-agent/agent.log ~/.ccnow-host-agent/agent-err.log`；
  3. 确认 `.env` 中的 `PORT` 与 `ccnow-host-agent.service` 中的 `CCNOW_SERVER_URL` 端口一致（脚本会自动读取 `.env` 中的 `PORT`）。

### Q3：`node-pty` 报错 `posix_spawnp failed` 或 `NODE_MODULE_VERSION` 不匹配
- **原因**：升级 Node.js 后未重新编译 `node-pty` 原生扩展。
- **解决**：执行 `npm rebuild node-pty` 或 `rm -rf node_modules && npm install`，然后 `sudo ./restart.sh --with-agent`。

### Q4：原有 Telegram / 微信（ClawBot）机器人不再回复
- **原因**：新版本将旧版 IM Bot 置于实验性开关 `IM_BOT_ENABLED` 下且默认关闭。
- **解决**：在 `.env` 中添加 `IM_BOT_ENABLED=true`，再执行 `sudo ./restart.sh`。

### Q5：前端样式异常或看不到新功能
- **原因**：修改或拉取代码后未更新 `public/dist/`，或 CDN / 浏览器 Service Worker 残留旧缓存。
- **解决**：执行 `npm run build`（或 `rm -rf public/dist && npm run build` 强制全量构建），确认 `server.js` 无需因纯前端改动重启，并强制刷新浏览器。

---

## 7. 紧急回滚方案

如果升级过程中遇到环境不兼容需要立即回退：

```bash
# 1. 停止新服务与宿主机 Agent
sudo ./stop.sh
sudo systemctl stop ccnow-host-agent.service 2>/dev/null || true

# 2. 切回升级前的 Git Commit（替换为升级前记录的 commit hash）
git checkout <OLD_COMMIT_HASH>

# 3. 恢复备份的数据与 .env（将路径替换为第 2.2 节生成的实际备份目录）
BACKUP_DIR="backups/pre-upgrade-YYYYMMDD-HHMMSS"
cp -a "$BACKUP_DIR/.env" .
cp -a "$BACKUP_DIR/data/"* data/
for f in workspaces.json push_subscriptions.json im_bindings.json vapid.json; do
  [ -e "$BACKUP_DIR/$f" ] && cp -a "$BACKUP_DIR/$f" .
done

# 4. 恢复依赖、构建并重启
npm install
npm run build
sudo ./start.sh
```

> 说明：JSON ➔ SQLite 迁移默认只会向新建的 `data/ccnow.db` 写入并保留原文件备份，因此回滚恢复非常安全。

---

## 8. 运维速查清单（TL;DR）

对于已确认 Node.js ≥ v22.13 的生产实例，标准升级流程如下：

```bash
cd /path/to/tmux-agent-deck

# 1. 备份与停服
BACKUP_DIR="backups/pre-upgrade-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR" && cp -a .env data "$BACKUP_DIR/" 2>/dev/null || true
sudo ./stop.sh

# 2. 拉代码、装依赖、迁移 SQLite、构建产物
git pull --ff-only origin main
npm install
node scripts/migrate-json-to-sqlite.js --dry-run
npm run migrate:sqlite
npm run build

# 3. 启动控制面 + 注册/升级宿主机 Agent
sudo ./start.sh
sudo node scripts/setup-host-admin-agent.js

# 4. （可选，如需云电脑）构建 Docker 沙箱镜像
# npm run build:sandbox

# 5. 验证
systemctl is-active ccnow-server.service ccnow-host-agent.service
curl -s http://127.0.0.1:${PORT:-80}/api/hello
```
