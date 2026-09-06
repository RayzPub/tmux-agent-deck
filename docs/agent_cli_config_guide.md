# 🤖 AI 编程智能体 (Claude Code & Codex CLI) 环境变量与配置文件机制指南

本文档系统阐述 **Claude Code** 与 **OpenAI Codex CLI** 两大主流终端编程智能体的配置文件体系、环境变量解析顺序、鉴权请求头机制，以及 **tmux-agent-deck** 控制面板如何建立 **「用户配置 > 127 本地网关 > settings.json 磁盘文件」** 的终极优先级协同体系。

---

## 1. Claude Code CLI 机制与优先级双重性深度剖析

Claude Code 是 Anthropic 官方推出的智能体 CLI，其配置体系分为两个维度：**普通业务配置项** 与 **`env` 运行时环境注入块**。理解这两者的差异是排查各种 401 错位问题的关键。

### 1.1 配置文件定位
* **用户级环境与项目偏好**：`~/.claude/settings.json`
  * 主要维护全局默认参数（如 `theme`、`model`）及内部环境变量注入映射（`env` 字典）。
* **会话信任与自定义 Key 名单**：`~/.claude.json`
  * 主要维护项目工作区信任状态（`projects.<path>.hasTrustDialogAccepted`）及已批准的自定义密钥名单（`customApiKeyResponses`）。

### 1.2 官方配置优先级体系（普通业务配置）
对于普通业务配置属性（如 `model`, `theme`, `permissions`），Claude 官方遵循以下多层覆盖顺序（从高到低）：
1. **托管级（Managed Settings）**：企业 MDM 策略，全局强制最高优先级；
2. **CLI 启动参数**：如 `--model <name>`，本次执行临时覆盖；
3. **Shell 环境变量**：如 `ANTHROPIC_MODEL`；
4. **本地级配置**：`.claude/settings.local.json`（不进 Git）；
5. **项目级配置**：`.claude/settings.json`（团队共享）；
6. **用户级配置**：`~/.claude/settings.json`（个人全局默认）。

> **注意**：上述“环境变量（第 3 级）高于 settings.json（第 6 级）”的规则，**仅适用于普通的根属性配置（如 `settings.model`）**。

### 1.3 ⚠️ 核心特例：`"env": { ... }` 注入块的反向覆盖机制
`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY` 在 `settings.json` 中并不是根属性，而是包裹在专用的 `"env"` 字典中：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.lkeap.cloud.tencent.com/plan/anthropic"
  }
}
```

根据 Anthropic 官方规范：
> *“The `env` block in `settings.json` writes environment variables into the Claude Code process at runtime, **effectively replacing inherited shell variables** for those specific keys.”*  
> （`settings.json` 中的 `env` 代码块会在启动运行时向当前进程注入环境变量，**直接替换/冲刷掉从外部 Shell 继承的同名环境变量**。）

**代码级执行过程**：
```javascript
// Claude Code 启动初始化流程伪代码
// 1. 先继承外部 PTY / Bash 的环境变量：
let currentEnv = { ...process.env }; // 此时包含 ANTHROPIC_BASE_URL = "http://127.0.0.1"

// 2. 加载 settings.json：
const settings = readJson('~/.claude/settings.json');

// 3. ⚠️ 启动最后阶段：将 settings.env 暴力覆盖回 process.env！
if (settings.env) {
  Object.assign(currentEnv, settings.env); // 此时被改写回了外网腾讯云地址！
}
```

#### 🧪 实测验证证明
我们在本地搭建双端口（11111 代表 `settings.json.env`，22222 代表终端环境变量），发起真实 Claude 请求测试：
```text
终端传入环境变量: ANTHROPIC_BASE_URL = "http://127.0.0.1:22222"
settings.json写入: env.ANTHROPIC_BASE_URL = "http://127.0.0.1:11111"

🎯 运行捕获结果：命中了 11111 端口 -> settings.json.env 胜出！
```
**结论**：只要 `settings.json` 内部包含 `env.ANTHROPIC_BASE_URL`，它就会暴力剥夺外部 Shell 环境变量的决定权。

### 1.4 鉴权请求头：API_KEY vs AUTH_TOKEN
* 当设置 `ANTHROPIC_API_KEY` 时，Claude Code 发送 HTTP 头：`x-api-key: <key>`。
* 当设置 `ANTHROPIC_AUTH_TOKEN` 时，Claude Code 发送 HTTP 头：`Authorization: Bearer <token>`。
* 绝大多数 Anthropic 协议第三方代理中转站仅支持 `x-api-key`。若误设 `ANTHROPIC_AUTH_TOKEN`，会导致中转网关抛出 401。

---

## 2. OpenAI Codex CLI 机制深度解析

Codex CLI（OpenAI 官方终端智能体，基于 Rust 开发）采用严格的静态 Provider 映射。

### 2.1 配置文件：~/.codex/config.toml
Codex CLI 严格依靠 TOML 配置文件定义上游提供商与模型路由：
```toml
model_provider = "deck_gateway"
model = "glm-5.3-flash"

[model_providers.deck_gateway]
name = "deck_gateway"
base_url = "http://127.0.0.1/v1"
env_key = "OPENAI_API_KEY"
wire_api = "chat"

[projects."/home/ubuntu/tmux-agent-deck"]
trust_level = "trusted"
```

### 2.2 ⚠️ 核心特例：Codex 默认完全忽略 OPENAI_BASE_URL 环境变量
* **行为差异**：Codex CLI **默认不读取 `OPENAI_BASE_URL` 或 `OPENAI_API_BASE` 环境变量**！
* **决策逻辑**：Codex 启动时读取 `config.toml` 中的 `model_provider`，直接向该 provider 定义的 `base_url` 发起请求；它仅根据 `env_key = "OPENAI_API_KEY"` 去环境变量中提取对应的密钥字符串。
* **解决原则**：要让 Codex 走本地 127 网关，必须在 `~/.codex/config.toml` 中将 `base_url` 明确指向 `http://127.0.0.1/v1`，或在启动命令中通过 `-c` 参数覆盖。

---

## 3. 终极优先级体系：用户配置 > 127.0.0.1 本地网关 > settings.json

为了在“无缝支持 127 本地网关”的同时，**100% 确保用户自定义的 API Key 与 Base URL 拥有最高优先决定权**，`tmux-agent-deck` 建立了如下协同流转架构：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      第 1 优先级：用户自定义配置 (User Config)            │
│  - Web 界面【设置】面板保存 / 用户沙盒 ~/.api_keys / 终端临时 export       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (若用户未配置任何自定义参数，则向下 fallback)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    第 2 优先级：127.0.0.1 本地网关 (Local Gateway)        │
│  - 由 data/llm_gateway.json 提供集中式真实密钥池与多模型协议解耦路由       │
│  - 会话注入虚拟 Key: sk-deck-local，请求由 127.0.0.1 拦截并换取真 Key 转发 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (动态维护与清洗，消除历史干扰)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 第 3 优先级（受控载体）：磁盘配置文件 (settings.json / toml)│
│  - ~/.claude/settings.json / ~/.codex/config.toml                       │
│  - 仅作为底层 CLI 读取的载体，由系统服务端逻辑全自动动态对齐与清洗         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 机制一：为什么「用户自定义配置」永远是第 1 优先级？
系统通过 **三重防线** 确保用户自定义配置压倒一切：

1. **会话命令链末端执行（Shell 层压制）**：
   在 `routes/api.js` 中，启动 Tmux 会话的命令执行链为：
   ```bash
   export ANTHROPIC_BASE_URL='http://127.0.0.1' ... && [ -f ~/.api_keys ] && . ~/.api_keys
   ```
   * 后执行的 `.`（source）拥有最终决定权。如果用户配置了私有 `~/.api_keys`，用户的自定义 Key 和 URL 会在最后一步**无情覆盖前面的 127 网关参数**。
2. **PTY 启动前动态拦截（进程层压制）**：
   在 `sockets/terminal.js` 中，只要检测到用户在面板中填写了 `keys.claude` 或 `keys.codex`：
   * 立即用真实用户 Key 替换 `ptyEnv` 中的 `sk-deck-local`；
   * 用户若提供了自定义 Base URL，立刻覆盖 `127.0.0.1`；
   * 用户若未提供 Base URL，系统**主动从环境变量中删除 127 网关地址**，确保 CLI 直连官方服务。
3. **环境单一事实源（Single Source of Truth 规避策略）**：
   * 为了彻底解决 `settings.json.env` 反向覆盖环境变量的顽疾，Deck 平台采用**“纯净配置文件”**策略：
   * `~/.claude/settings.json` 永远只保留偏好配置（如 `theme: "dark"`），严禁任何 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY` 进入 `settings.json` 的 `env` 块；
   * 如此一来，Claude Code 在启动加载 `settings.env` 时，没有网络端点和凭据可以去覆盖当前环境；
   * 运行时环境（PTY `ptyEnv` 与 `~/.api_keys`）重新获得 **100% 绝对生效权**，无论是走 127 本地网关、用户自定义配置，还是在终端临时 `export`，均能稳定直接生效。

---

### 3.2 机制二：为什么「127 本地网关」优于「旧 settings.json 残留」？
当用户**没有**提供自定义参数时，系统目标是让所有会话自动走本地 127 网关：
1. **自动清理磁盘外网残留**：
   在 `services/fileService.js` 的 `ensureClaudeSettings` 中：
   * 系统启动和每次会话创建时，**无条件清空 `settings.json` 中的 `env.ANTHROPIC_BASE_URL` 与 `env.ANTHROPIC_API_KEY`**；
   * 彻底剥夺了磁盘旧配置对外部环境变量的反向覆盖能力。
2. **自动对齐 Codex toml**：
   在 `ensureCodexConfig` 中，系统自动将 `config.toml` 指向 `http://127.0.0.1/v1` 并绑定 `deck_gateway`。
3. **虚拟凭据闭环**：
   外部 Shell 注入的 `ANTHROPIC_BASE_URL="http://127.0.0.1"` 与 `ANTHROPIC_API_KEY="sk-deck-local"` 顺畅成为最终生效环境。

---

## 4. 故障速查与排查指南

| 现象 | 可能根因 | 排除命令 |
| :--- | :--- | :--- |
| **Claude 报 401 not authorized** | `settings.json` 中残留了外网 Base URL，导致假 Key 发往了真外网 | 运行 `sed -i '/ANTHROPIC_BASE_URL/d' ~/.claude/settings.json` |
| **Claude 报 401（上游报错）** | 真实 Key 配置有误或额度耗尽 | 运行 `curl -i -X POST http://127.0.0.1/v1/messages ...` 测试网关与上游连通性 |
| **Codex 启动报错 401** | `~/.codex/config.toml` 未指向本地 127 网关 | 检查 `cat ~/.codex/config.toml`，确保 `base_url` 包含 `127.0.0.1` |
| **环境变量未生效** | 连接了更新代码前已存在的旧 Tmux 会话 | 在终端执行 `exit` 或在面板销毁旧会话，重新新建会话 |
