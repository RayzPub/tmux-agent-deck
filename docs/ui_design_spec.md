# UI 设计与交互物理规范 (UI Design & Interaction Specification)

本文档定义了 **tmux-agent-deck (CCNOW)** 的全局视觉体系、四层表面物理架构（参考 `open-claude-ui` / Claude Design System）、深浅双主题色彩映射以及 PC/移动端自适应交互工程规范。所有新增或迭代的前端页面（`index.html`、`login.html`、`register.html`、`welcome.html`）及模块化组件均须严格遵循本规范。

---

## 1. 双主题架构与四层表面体系 (4-Tier Surface Hierarchy)

系统采用 **「赛博霓虹深色 (默认 `:root`) + 靛蓝极简浅色 (`body.light-minimalist`)」** 双主题架构。所有界面通过 `Surface 0 ~ Surface 3` 四层海拔高度建立空间秩序，替代生硬的粗线条分割。

### 1.1 四层表面海拔对照表

| 表面层级 | CSS Token | 物理定位与适用场景 | 深色赛博 (`:root`) | 浅色极简 (`body.light-minimalist`) |
| :--- | :--- | :--- | :--- | :--- |
| **Surface 0** | `--surface-0` | **下沉底槽**：左侧侧拉栏 (`aside.sidebar`)、顶栏、PWA 顶窗融合、分段胶囊凹槽、内嵌输入框底槽 | `#0b0f19` | `#f4f5f8` / `#f1f5f9` |
| **Surface 1** | `--surface-1` | **主工作台画布**：主工作区 (`.terminal-workspace`)、Chat 消息流背景、Assistant 散文层 | `#111726` | `#fafbfc` / `#f8fafc` |
| **Surface 2** | `--surface-2` | **悬浮容器层**：会话卡片 (`.session-card`)、代码块、折叠面板、项目大盘卡片、登录卡片 | `#172033` / `rgba(22, 30, 49, 0.88)` | `#ffffff` |
| **Surface 3** | `--surface-3` | **高阶浮层与激活胶囊**：双环输入舱、分段控制器激活滑块、下拉菜单、斜杠指令浮层、弹窗 | `#1e2942` | `#ffffff` (配双环阴影) |

### 1.2 核心色彩语义映射标准

| 视觉要素 | 深色赛博 (`:root`) | 浅色极简 (`body.light-minimalist`) | 规范说明 |
| :--- | :--- | :--- | :--- |
| **主强调色 (Primary Accent)** | `--neon-cyan` (`#00f0ff`) | `--accent-indigo` (`#4f46e5`) | 浅色模式下严禁直接使用高亮青色文字，统一映射为优雅靛蓝 `#4f46e5` |
| **次强调色 (Secondary Accent)** | `--neon-pink` (`#ff007f`) | `#6366f1` / `#475569` | 危险/删除操作在浅色下映射为 `#ef4444` / `#dc2626` |
| **主文本 (Primary Text)** | `#f2f5fa` / `#ffffff` | `#0f172a` | 高对比度深墨灰，严禁浅色模式下残留内联 `#fff` 导致白底白字 |
| **次级文本 (Secondary Text)** | `#8b9bb4` | `#475569` | 用于副标题、路径标签、工具栏说明 |
| **弱化文本 (Muted Text)** | `#54627a` | `#64748b` / `#94a3b8` | 用于时间戳、占位符、快捷键提示 |
| **选中态填充 (Active Fill)** | `rgba(0, 240, 255, 0.08)` | `#eef2ff` | 配合 `#4f46e5` 或 `#c7d2fe` 细边框 |
| **状态徽章 (Badges & Pills)** | `rgba(0, 240, 255, 0.12)` 底 + `#00f0ff` 字 | `#eef2ff` 底 + `#4f46e5` 字 + `#c7d2fe` 边 | 统一采用 `999px` 满圆角胶囊 |

---

## 2. 边界、阴影与圆角物理法则 (Borders, Dual-Ring & Radii)

### 2.1 单边框法则 (Single-Border Rule)
* **禁止双重嵌套重边框**：当内部子元素已具备背景色差（如 `Surface 0` 凹槽内的 `Surface 3` 胶囊滑块）时，子元素仅使用柔和投影或 `0.5px` 微光环，禁止叠加多层 `1px/2px` 实线边框。
* **Chat 消息流非对称布局**：
  * **Assistant 消息 (`.chat-bubble-assistant`)**：**无外框、无底色卡片**，直接融合于 `Surface 1` 画布，仅对内嵌代码块、思考手风琴与工具调用卡片赋予 `Surface 2` 边界。
  * **User 消息 (`.chat-bubble-user`)**：右对齐 `18px` 大圆角染色胶囊（深色微青半透明 + `0.5px` 细环；浅色 `#eef2ff` 靛蓝微底 + `#1e1b4b` 深靛蓝字 + `#c7d2fe` 细环）。

### 2.2 Retina `0.5px` 极细边与 4 级双环阴影 (`Dual-Ring Shadows`)
所有卡片、浮层与输入框均使用 `0.5px` 极细边框配合多层环境阴影（定义于 `public/css/style.css`）：
* `--shadow-sm`：常规卡片（会话卡片、文件树工具条、分段滑块）静态微阴影。
* `--shadow-md`：卡片悬停态（`hover`）抬升阴影。
* `--shadow-lg`：模态框（`.modal-card`、`.auth-card`）高阶景深阴影。
* `--shadow-popover`：下拉菜单（`.deck-dropdown-menu`、`.chat-slash-popover`）浮层阴影。
* `--shadow-composer` / `--shadow-composer-focus`：**双环聚焦物理反馈**。输入框获得焦点时，内环收缩为 `1.5px` 主题色实环，外环扩散 `3px` 半透明柔光晕（深色 `rgba(0, 240, 255, 0.14)`，浅色 `rgba(79, 70, 229, 0.12)`）。

### 2.3 圆角阶梯规范 (Border-Radius Hierarchy)
严禁在按钮或卡片上使用锯齿切角（`clip-path: polygon(...)`），全局遵循以下圆角阶梯：
* `--radius-xs` (`6px`)：内联小按钮、快捷键键帽 `<kbd>`、路径标签。
* `--radius-sm` (`8px`)：标准按钮、顶栏控件、侧栏图标按钮、工作区 Tab 胶囊。
* `--radius-md` (`10px`)：会话卡片、代码块容器、折叠手风琴、表单输入框。
* `--radius-panel` (`12px`)：终端/编辑器主面板、下拉菜单浮层、决策卡片。
* `--radius-lg` (`18px`)：用户消息气泡。
* `--radius-xl` (`20px`)：底部悬浮输入舱（`.chat-input-row`）、模态弹窗（`.modal-card`）、登录注册卡片（`.auth-card`）。
* `--radius-pill` (`999px`)：分段控制器（`#deckModeSwitcher`、`.sidebar-tabs`、`.roadmap-view-switcher`）、状态徽章、回到顶部/底部悬浮按钮。

---

## 3. 排版光学补偿与动态数字约束 (Typography & Optical Physics)

1. **视网膜光渗补偿 (Retinal Irradiation Compensation)**：
   * 深色模式（`:root`）强制开启 `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;`，消除深黑背景上亮色文字的笔画发胖与光晕感。
   * 浅色模式（`body.light-minimalist`）切换为 `-webkit-font-smoothing: subpixel-antialiased;`，保持深色字体的锐利度。
2. **等宽数字对齐 (`tabular-nums`)**：
   * 所有动态变化的数字节点（`.session-count`、`.roadmap-count-pill`、`#qrcodeTimer`、`.chat-q-counter`、`.stat-num`、`.sys-stat .stat-val`）必须声明 `font-variant-numeric: tabular-nums;`，杜绝流式更新或倒计时引起的水平布局抖动。
3. **弹簧按压微反馈 (`Tactile Spring Press`)**：
   * 所有可点击按钮与卡片在 `:active:not(:disabled)` 状态下应用 `transform: scale(0.98)` 與 `70ms cubic-bezier(0.32, 0.72, 0, 1)` 物理回弹。

---

## 4. 核心交互组件工程规范 (Component Interaction Patterns)

### 4.1 `999px` 满圆角分段胶囊控制器 (Segmented Pill Switcher)
* **适用组件**：Chat/Terminal 视图切换器 (`#deckModeSwitcher`)、左侧栏导航切换 (`.sidebar-tabs`)、项目大盘视图切换 (`.roadmap-view-switcher`)、Welcome 页预览切换 (`.tabs-head`)。
* **结构规范**：外层轨道使用 `--surface-0` 凹陷底色 + `inset` 内阴影 + `3px` 内边距；内部激活项 `.active` 使用 `--surface-3` 悬浮底色 + `--shadow-sm` 双环微阴影。

### 4.2 CSS Grid `0fr -> 1fr` 手风琴与流式状态保活
* **适用组件**：AI 思考过程折叠框 (`.chat-thinking-accordion`)、工具调用折叠框 (`.chat-tool-card`)、Welcome 页 FAQ (`.faq-item`)。
* **动画实现**：严禁使用 `max-height` 估算动画。统一采用外层 `display: grid; grid-template-rows: 0fr -> 1fr; transition: grid-template-rows 0.22s cubic-bezier(0.22, 1, 0.36, 1);` 配合内层 `overflow: hidden; min-height: 0;`。
* **流式状态保活**：在 `chatMode.js` 中通过 `expandedAccordions` (`Set`) 记录用户手动展开的手风琴 ID，确保 WebSocket 流式重绘时不会重置用户的展开/折叠状态。
* **思考态相位脉冲**：思考进行中时，头部展示 3 颗 `160ms` 相位差的呼吸圆点（`cds-dot-pulse`）与文字微光扫过动画（`cds-shimmer-text-shine`）。

### 4.3 流式滚动锁止 (`Scroll Pinning`) 与 7 段非线性渐隐遮罩
* **7-Stop Non-Linear Alpha Mask**：`.agent-chat-messages` 使用 7 段非线性透明度遮罩（`--cds-scroll-fade-top` / `--cds-scroll-fade-bottom`），并根据滚动位置动态调整渐隐高度（处于顶部时 `top=0px`，处于底部时 `bottom=0px`）。
* **滚动锁止状态机**：
  * 默认锁定底部（`isPinnedToBottom = true`），流式输出时自动平滑跟随。
  * 当用户主动向上滚动且距离底部超过 `40px` 时，立即解除锁定（`isPinnedToBottom = false`），保持当前阅读视口稳定，并浮现 `.chat-jump-bottom-btn`（「回到底部」胶囊按钮）。

### 4.4 双环输入舱、`/` 斜杠指令与中文输入法守卫
* **中文 IME 输入法守卫（强制）**：所有监听 `Enter`、`ArrowUp`、`ArrowDown`、`Tab` 的输入框 `keydown` 事件，**必须**首先判断 `if (e.isComposing || e.keyCode === 229) return;`，严禁在中文拼音选词过程中误触发消息发送或指令上屏。
* **`/` 斜杠指令浮层 (`.chat-slash-popover`)**：输入 `/` 或点击输入舱底部 `/` 按钮时唤起指令列表，支持 `↑`/`↓` 方向键 Roving Focus 循环高亮与 `Enter`/`Tab` 确认。
* **代码块 `2500ms` 复制状态衰减**：Markdown 代码块顶栏包含语言标识与复制按钮，点击复制后按钮切换为绿色 `✓ Copied` 并在 `2500ms` 后自动衰减恢复。
* **PC 决策卡片单键响应**：当存在待审批的权限卡片或单选提问卡片且焦点不在输入框时，支持键盘直接按 `Y`/`1`（允许）、`3`（始终允许）、`N`/`4`/`Esc`（拒绝）快速响应。

---

## 5. PC 与移动端响应式防挤压规范 (Responsive & Mobile Viewport)

### 5.1 CSS `@container` 容器查询防挤压
面板容器（`.terminal-panel`、`.editor-panel`、`.project-overview-panel`）及其头部（`.editor-header`、`.terminal-header`）声明 `container-type: inline-size`。当分屏或窄视口导致容器宽度收缩时，按三级阈值自动降级：
* **Tier 1 (`> 520px`)**：完整显示图标、标题前缀与按钮文字。
* **Tier 2 (`<= 520px`)**：隐藏按钮说明文字（仅保留图标），收敛文件名最大宽度。
* **Tier 3 (`<= 360px`)**：极限压缩按钮间距与内边距，防止任何横向溢出或换行挤压。

### 5.2 移动端虚拟键盘零遮挡联动 (`visualViewport`)
* 在移动端虚拟键盘弹起时（`mobileInput.js` 的 `adjustForVirtualKeyboard`），Chat 模式通过动态设置 `#agentChatContainer` 的 `paddingBottom = ${keyboardOffset}px` 收缩可视容器高度，并在 `isPinnedToBottom` 时自动调用 `scrollToBottom()`，严禁仅使用 `transform: translateY` 上移输入框而遮挡底部最新消息。
* 顶部工作区标签栏（`.workspace-tabs`）、移动端辅助键盘栏（`.mobile-keyboard-bar`）及左侧会话/文件树列表均须配置 `mask-image` 边缘渐隐遮罩，提供清晰的滚动边界提示。
