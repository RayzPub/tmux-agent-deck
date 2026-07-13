# Cyberpunk CCNOW

一个极具科技感的网页端 Tmux 托管控制面板项目。通过此项目，你可以登录网页并利用 Web 终端完全控制服务器上的 Tmux 命令行会话，随时进行连接与断开。本项目专注于利用 Tmux 进行会话持久化管理，并无缝集成 **Claude Code**、**Antigravity (agy)**、**Codex Agent** 等 AI 编程智能体（Programming Agents）。

本项目的定位不仅仅是终端仿真器，而是一个以会话为中心的 AI 代理控制中心（Control Deck）。未来将更加兼容手机端等便携式设备，支持多设备无缝接入与可视化 Agent 管理。

## 📸 界面预览 / Screenshots

<table>
  <tr>
    <td align="center" width="50%"><b>1. 新建工作区 / Initialize Workspace</b></td>
    <td align="center" width="50%"><b>2. 新建 Agent / Initialize Agent Session</b></td>
  </tr>
  <tr>
    <td><img src="docs/images/workspace_preview.png" alt="新建工作区 / Initialize Workspace" width="100%"/></td>
    <td><img src="docs/images/agent_preview.png" alt="新建 Agent / Initialize Agent Session" width="100%"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>3. 多 Agent 会话 / Multi-Agent Dashboard</b></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/images/dashboard_preview.png" alt="多 Agent 会话 / Multi-Agent Dashboard" width="100%"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>4. Diff 与文件预览 / Diff & File Editor</b></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/images/editor_diff_preview.png" alt="Diff 与文件预览 / Diff & File Editor" width="100%"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>5. 📱 手机端展示预览 / Mobile View</b></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/images/mobile_preview.jpg" alt="📱 手机端展示预览 / Mobile View" width="360"/></td>
  </tr>
</table>

---

## 🌟 核心特性

- 👥 **多用户隔离系统 (Multi-User System)**：支持开启多用户隔离模式。非 Admin 用户拥有独立的沙盒工作区、独立代理运行配置（`$HOME` 隔离）与专属会话，有效防止敏感凭证越权访问与环境变量污染。支持管理员邀请注册制。
- 🔒 **安全访问控制**：采用基于 JWT 的访问认证（单用户模式基于全局主密码；多用户模式基于用户独立密码，支持 HTTP-Only Cookie 保持会话）。
- 🎨 **赛博霓虹设计**：基于暗黑极客风格精心打造，拥有发光特效、科幻扫描线、动态霓虹边框与平滑的微交互动画。
- 🤖 **AI 编程智能体集成**：
  - 在创建 Tmux 会话时，可一键选择直接运行 **Claude Code**、**Antigravity (agy)** 或 **Codex Agent** 等编程 Agent。
  - Tmux 会话持久化：即使关闭浏览器，AI Agent 的运行状态和上下文也会在服务器端继续保持，随时可以重连查看。
- 🖥️ **Tmux 会话交互**：
  - 在侧边栏实时扫描和列出所有活跃的 Tmux 会话（附带时间戳和“已挂载/未挂载”状态点）。
  - 支持直接在网页中创建新会话（自动附带合法性正则匹配）。
  - 支持销毁（Kill）任意指定会话。
- ⚡ **毫秒级终端连接**：使用 `xterm.js` 配合 WebSockets (`socket.io`) 和服务器 pseudo-terminal (`node-pty`) 实时对接，键盘响应极快。
- 📐 **自适应缩放 (Auto-Fit)**：当浏览器窗口大小发生改变时，自动重新计算终端行列数并对齐远程 Tmux 实例。
- 📡 **PWA 主动推送通知 (Web Push)**：
  - 整合 Web Push (VAPID 协议) 与 Service Worker，支持在后台甚至浏览器关闭时接收终端会话重要事件。
  - **AI 动作推送 Hook**：当 AI 智能体 (Agy / Claude / Codex) 触发特定长耗时操作或需要权限审批时，调用内置 `deck-notify` 命令行工具（自动通过 session 环境 PATH 动态定位）实时推送通知至订阅设备。
  - **智能免打扰机制**：在用户正聚焦查看当前会话时，系统将智能绕过推送，避免产生重复无谓的通知打扰。
- 💬 **即时通讯集成 (Telegram & 微信)**：支持双向控制、终端截屏、AI 任务实时审批与远程输入。

---

## 🛠️ 快速启动

### 🚀 一键安装（推荐）

您可以通过在终端执行以下命令，实现一键检测并安装系统依赖（Git、Tmux、Curl、GCC/C++ 编译工具）、Node.js 运行环境，并自动克隆仓库、安装项目依赖：

```bash
curl -fsSL https://raw.githubusercontent.com/RayzPub/tmux-agent-deck/main/install.sh | bash
```

安装完成后，进入项目目录：
```bash
cd tmux-agent-deck
```

接下来配置环境并启动。

### 1. 配置环境

在项目根目录下查看或编辑 `.env` 文件。该文件包含了主要的配置项：

```env
PORT=80
PASSWORD=your_secure_password
JWT_SECRET=your_jwt_secret_key
DEFAULT_SHELL=/bin/bash

# 多用户隔离模式配置
MULTI_USER_ENABLED=true
```

> [!IMPORTANT]
> **安全警示**：将该项目部署于公网前，请务必修改 `.env` 中的 `PASSWORD` 和 `JWT_SECRET`，防止未经授权的终端访问！

> [!NOTE]
> 在多用户模式下，系统首次启动时会自动根据配置的 `PASSWORD` 创建默认管理员账号 `admin`。

### 2. 启动服务

在项目目录下执行以下指令运行程序：

```bash
# 启动项目（脚本会自动在后台运行服务，并支持生成强密码/密钥）
sudo ./start.sh
```

服务运行后，控制台会输出运行信息：
```text
==================================================
🌟 CCNOW - Background Control Script 🌟
==================================================
[*] Using Node binary: /home/ubuntu/.nvm/versions/node/v26.4.0/bin/node
[*] Starting CCNOW in the background...
[✓] Started successfully! PID: 50533
[✓] Log file: server.log
--------------------------------------------------
🔗 URL:      https://outshine.cloud
🔑 Password: your_secure_password
--------------------------------------------------
To stop the server, run: ./stop.sh
```

### 停止服务
如需停止正在后台运行的服务器，请执行：
```bash
sudo ./stop.sh
```

> **权限与端口说明**：默认使用 `80` 和 `443`（如果配置了 HTTPS）等特权端口，因此通常需要使用 `sudo` 运行。如果未在 `.env` 中配置证书，系统会自动降级在 HTTP (端口 80) 下启动。


### 3. 打开网页

1. 访问浏览器：`http://localhost` 或 `http://<服务器IP>`（端口 80 可省略端口号）。
2. 页面会重定向到授权中心 `/login.html`。
3. 输入您的主访问密码（在 `.env` 中设置的 `PASSWORD` 值），点击 **AUTHENTICATE** 登录。
4. 授权成功后，即可进入控制大厅管理与连接您的 Tmux 终端，并启动 AI 编程智能体！

---

## 👥 多用户隔离模式 / Multi-User Mode

通过在 `.env` 中设置 `MULTI_USER_ENABLED=true` 可以开启多用户隔离模式。此模式专为团队协作或多 AI 代理实例独立运行设计：

### 1. 账号与邀请码机制 (Accounts & Invitation Codes)
* **默认管理员**：首次启用多用户模式时，系统会在首次运行迁移时，根据 `.env` 中的 `PASSWORD` 自动初始化 `admin`（管理员）账户。
* **邀请码注册**：非 admin 用户必须通过邀请码进行注册。`admin` 用户可以在网页控制台的 header 栏中点击 **INVITE CODES** 按钮打开管理面板，输入受邀者备注并生成一次性邀请码（形如 `INV-XXXXXX`），同时可以直接复制包含邀请码的注册链接。
* **密码存储**：采用安全的 PBKDF2 对用户密码进行加盐哈希存储（数据保存在 `data/users.json` 中）。

### 2. 沙盒隔离与目录防护 (Sandbox & File Isolation)
* **工作区隔离 (Workspace Sandbox)**：
  * 普通用户的工作区统一存放在 `workspaces/[username]/` 下。
  * 普通用户在新建工作区时，仅能使用相对路径在其名下了的隔离目录下创建，无法通过绝对路径或 `..` 越权浏览和读写服务器的其他文件。
  * 管理员 `admin` 依然保留全局根路径的完全访问与绝对路径工作区创建能力。
* **环境变量隔离 (Home Directory Isolation)**：
  * 普通用户的 Shell 会话运行在独立的虚拟 Home 目录中（路径为 `user_data/[username]/home`）。
  * 首次启动会话时，系统会自动在虚拟 Home 中创建只读符号链接，指向宿主机的 `.claude`、`.gemini`、`.agy` 等全局 AI 配置文件夹。
  * **优势**：各用户的 Shell 历史记录（如 `.bash_history`）和缓存完全独立；同时 AI 智能体可以读取所需的 API Key（防止重复配置），但用户无法通过工作区文件浏览器看到或修改这些隐藏敏感配置文件。

### 3. 数据迁移与兼容性 (Legacy Data Migration)
系统包含全自动迁移机制（在服务启动时自动执行）：
* **配置平滑迁移**：若检测到单用户模式下的 `workspaces.json` 存在，且 `admin` 用户的工作区文件尚未创建，系统会自动将原先的工作区配置复制到 `data/workspaces_admin.json` 中。
* **绑定与微信多实例升级**：老版本的 IM 机器人绑定数据（`im_bindings.json`）会被自动升级，为原有绑定的微信号和 Telegram 账号默认指派 `admin` Web 用户身份。同时，老版本全局唯一的微信 `wechatConfig` 会被自动迁移至具体用户配置内。现在，微信扫码（ClawBot）支持多用户独立登录，每个绑定的用户都拥有独立的前后台微信轮询实例，互不干扰。
* **会话重命名**：为避免命名冲突，原先命名的 Tmux 会话（如 `agy`、`claude`、`codex`）会在后台自动重命名为多用户规范格式（如 `u_admin_agy`、`u_admin_claude`、`u_admin_codex`）。

---

## 🤖 即时通讯机器人集成 (Telegram & 微信) / IM Bot Integration (Telegram & WeChat)

本项目集成了即时通讯控制通道，支持通过 Telegram 或微信 (WeChat ClawBot) 接收 AI 智能体通知、执行终端指令，甚至进行交互式操作审批。

---

### 📬 微信 AI 智能助理 (WeChat ClawBot)

微信通道基于腾讯官方的 **iLink AI 智能助理平台**（`https://ilinkai.weixin.qq.com`）实现，支持直接连接个人微信账号，**无需任何复杂的后台配置（如企业微信或公众号服务号）**。

#### 1. 账号绑定流程
1. 登录网页控制面板，点击控制栏右侧的 **IM BOT** 按钮，并选择 **WECHAT** 选项卡。
2. 点击 **LINK WECHAT ACCOUNT**，系统会自动连接 Weixin iLink 网关并渲染登录二维码（使用本地库离线生成，安全可靠）。
3. 使用微信扫描生成的二维码并在手机上确认登录：
   * *安全验证*：如果手机微信上弹出了 **两位数验证码**，请在网页弹出的提示框中输入该数字并确认。
4. 确认后，系统会自动将您的微信 ID 绑定为 `微信主账号`。绑定关系立刻生效，无需输入任何绑定 PIN 码！

#### 2. 支持的微信指令
在微信聊天框中直接发送以下指令即可控制终端（指令主要以中文为主，并兼容部分英文缩写）：
- `帮助` 或 `help` — 🤖 查看可用命令列表。
- `会话` 或 `list` — 🖥️ 列出服务器上当前所有的 Tmux 会话。
- `切换 <会话名>` 或 `switch <会话名>` — 🎯 切换当前的活动会话，接下来的键盘输入都会发送到该会话。
- `状态` 或 `status` — 📸 截取并查看当前活动会话屏幕的最后 20 行终端内容（系统会自动过滤输入框长划线和横向排版干扰线）。
- `直接发送文本` — 📥 任何非指令的文本消息都会直接作为键盘输入（自动附带 Enter）下发至当前活动会话中。

#### 3. 特性与优势
* **主动推送系统通知**：当有终端任务运行完毕，或者 AI 智能体触发主动提醒时，微信主账号会直接收到来自 Bot 的主动发信通知。
* **多实例自动释放**：当微信 Bot 在新服务器实例上重新登录绑定时，旧实例会自动收到 session 过期通知（`ret: -14`），优雅地停止长轮询以节省服务器 CPU 资源。

---

### ✈️ Telegram 机器人集成 (Telegram Bot)

本项目集成了一个 Telegram 机器人，提供双向命令控制与 AI 审批接口。

#### 1. 配置 Telegram Bot
在根目录下的 `.env` 文件中配置以下环境变量（Bot Token 可通过向 [@BotFather](https://t.me/BotFather) 申请获得）：

```env
# Telegram 机器人配置
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_BOT_USERNAME=your_telegram_bot_username # 可选，若不填写启动时会自动通过 API 获取
```

配置完成后，使用 `sudo ./restart.sh` 重启服务。

> [!NOTE]
> Telegram 机器人采用 **Webhook** 模式（API 接口为 `https://<你的域名>/api/im/telegram/webhook`），因此需要配置有效的 `SSL` 证书及公网可访问的 `DOMAIN_NAME` 域名。

#### 2. 账号绑定 (User Binding)
1. 登录网页控制面板，点击控制栏右侧的 **IM BOT** 按钮。
2. 页面会弹出绑定二维码及链接。
3. 点击链接或扫描二维码（链接格式如：`https://t.me/your_bot?start=xxxxxx`）跳转至 Telegram 并点击 **Start** 按钮。
4. 绑定成功后，机器人会向您发送欢迎消息，此时会话控制通道已开启。

#### 3. 支持的 IM 指令 (IM Commands)
在 Telegram 中，你可以使用以下指令来查询与控制你的 Tmux 会话：
- `/list` — 🖥️ 列出服务器上当前所有的 Tmux 会话以及它们的挂载状态。
- `/switch <会话名>` — 🎯 切换当前的活动会话，接下来的非指令消息都会发送到该会话。
- `/status` — 📸 截取并查看当前活动会话屏幕的最后 20 行终端内容。
- `/link` 或 `/login` — 🔗 获取一个 60 秒内单次有效的免密登录链接，点击可一键安全登录 Web 终端面板。
- `/help` — ❓ 查看支持的指令帮助。

#### 4. 远程键盘输入与终端监视 (Remote Input & Monitoring)
- **直接输入**：除指令外，你可以在 Telegram 中直接发送任何文本消息，Bot 会将其作为键盘输入（自动附带 Enter）下发至当前活动会话中。
- **状态监视**：发送输入后，Bot 会自动开启终端监视器（最长 5 分钟），并在命令执行结束（终端输出静止 3 秒或命令运行 12 秒无变化）时，将最后 20 行输出自动推送给您。

#### 5. 交互式动作审批 (Interactive Action Approval)
当运行在 Tmux 里的 AI 智能体 (Agy 或 Claude Code) 触发需要授权的动作（例如：运行指令、修改/查看文件等）时，Telegram 机器人会发出带有交互式按钮的通知：
- **操作按钮**：包含 `✅ 允许 (Approve)` 和 `❌ 拒绝 (Deny)` 两个内联按钮。
- **一键决策**：在 Telegram 中点击相应按钮即可立即将 `y` 或 `n` 发送至对应的 Tmux 终端，无需登录网页操作。
- **自动闭环**：做出决策后，机器人会自动移除按钮、记录决策结果并进入终端状态监视，命令执行完毕后自动把终端的最新输出推送给您。

---

## 📂 项目结构

- [server.js](file:///home/ubuntu/tmux-agent-deck/server.js) — 基于 Express + Socket.io + Node-PTY 的 Web 主进程
- [im-bot.js](file:///home/ubuntu/tmux-agent-deck/im-bot.js) — 即时通讯（Telegram）机器人后端核心，实现 Webhook 路由、指令解析与交互审批逻辑
- [bin/](file:///home/ubuntu/tmux-agent-deck/bin) — 命令行工具目录
  - [deck-notify](file:///home/ubuntu/tmux-agent-deck/bin/deck-notify) — 供系统和 AI 智能体调用的主动推送命令行通知工具
- [public/](file:///home/ubuntu/tmux-agent-deck/public) — 前端静态文件目录
  - [login.html](file:///home/ubuntu/tmux-agent-deck/public/login.html) — 赛博朋克风格身份登录认证页面
  - [index.html](file:///home/ubuntu/tmux-agent-deck/public/index.html) — 主控终端与会话看板控制页面
  - [css/style.css](file:///home/ubuntu/tmux-agent-deck/public/css/style.css) — 霓虹视觉系统与布局样式表
  - [js/app.js](file:///home/ubuntu/tmux-agent-deck/public/js/app.js) — 前端核心逻辑（Xterm.js 配置与 WebSocket 数据流）
  - [js/im-bot-client.js](file:///home/ubuntu/tmux-agent-deck/public/js/im-bot-client.js) — 前端 IM 绑定、状态查询与解绑核心逻辑
  - [sw.js](file:///home/ubuntu/tmux-agent-deck/public/sw.js) — 用于注册与接收通知的 PWA Service Worker
  - [manifest.json](file:///home/ubuntu/tmux-agent-deck/public/manifest.json) — 包含图标和主题设置的 Web 应用清单文件
  - [images/](file:///home/ubuntu/tmux-agent-deck/public/images) — 静态图片资源目录 (包含 PWA 图标 icon-192.png)
