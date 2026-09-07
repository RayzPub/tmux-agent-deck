# 📋 Deck 目标拆解规范与 Agent 协作指南 (Task Spec)

本文档定义了 **tmux-agent-deck** 项目总览中「目标拆解大盘」的数据协议规范（Spec）及 AI 编程智能体（Claude Code、Antigravity、Codex CLI、Kimi 等）协同推进项目的操作指引。

---

## 1. 协议核心理念：Spec-Driven & Zero-Lockin
- **无黑盒外部依赖**：工作区进度与子任务清单直接保存在当前代码仓库的 `.deck/tasks.json`。
- **透明可追溯**：可随 Git 提交进行版本追踪与协作评审。
- **Agent 自主读写**：任何具有文件读写权限的终端 Agent（Antigravity、Claude Code、Codex）均可直接读取、解析或更新此文件，前端看板自动实时响应刷新。

---

## 2. `.deck/tasks.json` 数据结构规范

文件路径：`<工作区根目录>/.deck/tasks.json`

```json
{
  "mission": "项目顶层核心目标（与 project.json 同步或作为拆解依据）",
  "updatedAt": "2026-09-07T12:00:00.000Z",
  "tasks": [
    {
      "id": "t-1",
      "title": "设计后端数据协议与路由扩展",
      "description": "详细实现说明、涉及文件或注意事项",
      "status": "done",
      "priority": "high",
      "assignee": "claude",
      "dependsOn": [],
      "updatedAt": "2026-09-07T12:00:00.000Z"
    },
    {
      "id": "t-2",
      "title": "实现 DAG 拓扑画布与连线渲染",
      "description": "前端计算拓扑层级并绘制贝塞尔连线与状态卡片",
      "status": "in_progress",
      "priority": "high",
      "assignee": "agy1",
      "dependsOn": ["t-1"],
      "updatedAt": "2026-09-07T12:10:00.000Z"
    },
    {
      "id": "t-3",
      "title": "编写端到端自动化测试验证路由",
      "description": "测试手机端收起和侧边栏遮罩交互",
      "status": "todo",
      "priority": "low",
      "assignee": "codex",
      "dependsOn": ["t-2"],
      "updatedAt": "2026-09-07T12:30:00.000Z"
    }
  ]
}
```

### 字段说明
| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `mission` | String | 否 | 项目总目标描述。 |
| `updatedAt` | String (ISO) | 是 | 最后更新时间戳。 |
| `tasks` | Array | 是 | 子任务对象数组。 |
| `task.id` | String | 是 | 唯一编号，如 `t-1`, `t-2` 或 UUID。 |
| `task.title` | String | 是 | 任务核心标题。 |
| `task.description`| String | 否 | 任务详细说明、相关文件路径或验收指标。 |
| `task.status` | Enum | 是 | 任务状态：`todo` (待办), `in_progress` (推进中), `done` (已完成)。 |
| `task.priority` | Enum | 否 | 优先级：`high`, `medium`, `low` (默认 `medium`)。 |
| `task.assignee` | String | 否 | 指派的工位会话名称（如 `agy1`, `claude`）或空（未认领）。 |
| `task.dependsOn`| Array<String> | 否 | 前置依赖的任务 ID 数组（如 `["t-1"]`），用于构建 DAG 拓扑图谱。 |

---

## 3. 指引 Agent 拆解任务的标准 Prompt 范式

当在看板中需要让某个 Agent（如 Antigravity 或 Claude Code）围绕当前项目目标进行智能拆解时，可直接在派发框中发送以下标准提示词：

```markdown
请阅读当前项目工作区的目录结构、Git 最近提交历史以及当前目标：
「{{MISSION}}」

请围绕此目标，分析代码现状并拆解出 3~6 个切实可行的子任务，并构建合理的 DAG 任务依赖网络（通过 dependsOn 标注前置任务）。
请严格遵循 Deck Task 规范，将拆解结果直接写入或更新到 `.deck/tasks.json` 文件中。
格式示例：
{
  "mission": "{{MISSION}}",
  "updatedAt": "...",
  "tasks": [
    {
      "id": "t-1",
      "title": "任务简述（无前置依赖项）",
      "description": "具体修改点与涉及文件",
      "status": "todo",
      "priority": "high",
      "assignee": "",
      "dependsOn": []
    },
    {
      "id": "t-2",
      "title": "依赖 t-1 的后续任务",
      "description": "具体修改点与涉及文件",
      "status": "todo",
      "priority": "medium",
      "assignee": "",
      "dependsOn": ["t-1"]
    }
  ]
}
注意：已有的未完成或已完成任务请合理保留或更新，避免误覆盖。
```

---

## 4. Agent 协作推进生命周期

1. **目标分解 (Decomposition)**:
   - 负责人或用户指派 Agent 对需求进行评估，生成初始 `.deck/tasks.json`。
2. **认领与派发 (Claim & Dispatch)**:
   - 看板大盘呈现各任务卡片。用户可一键将特定任务派发给空闲会话（如派发给 `claude`），同时标记 `assignee: "claude"` 和 `status: "in_progress"`。
3. **独立执行与防污染 (Context Clean)**:
   - 派发新任务时，可开启“清理上下文”开关。根据 Agent 类别自动发送 `/clear` (Claude/Agy) 或 `/new` (Codex)，确保 Agent 在纯净上下文下全速执行。
4. **完成与验收 (Review & Complete)**:
   - 任务完成后，Agent 可自行在终端修改 `.deck/tasks.json` 将其置为 `done`，或由用户在大盘中一键勾选完成。
