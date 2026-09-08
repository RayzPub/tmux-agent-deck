/**
 * Project AGY & Terminal Dispatcher Integration Module
 * Bridges project progression actions (Decompose, Refine, Dispatch)
 * to the unified Dispatch Modal (`openDispatchModal`).
 * Completely consolidates the "Send to Terminal" interaction model.
 */

import { openDispatchModal } from './promptStaging.js';

let drawerSelectedTask = null;

export function updateDrawerSelectedTask(task) {
  drawerSelectedTask = task;
}

export function isAgyDrawerOpen() {
  return !!document.getElementById('promptStagingModalOverlay');
}

export function closeAgyDrawer() {
  const overlay = document.getElementById('promptStagingModalOverlay');
  if (overlay) {
    overlay.remove();
  }
}

/**
 * Open unified "发送到终端" modal
 */
export function openAgyDrawer(options = {}) {
  const {
    workspaceIdentifier,
    mission = '',
    tasks = [],
    sessions = [],
    selectedTask = null,
    stageRefine = false,
    stageDecompose = false,
    autoFillRefine = false,
    autoFillDecompose = false,
    onRefreshBoard
  } = options;

  const currentTask = selectedTask || drawerSelectedTask;
  const missionText = mission ? mission.trim() : '推进工作区核心功能落地';

  let defaultPrompt = '';
  let title = '发送到终端工位';
  let subtitle = '选择目标工位，微调指令后直接派发执行并切换到终端';
  let mode = 'custom';

  if (stageDecompose || autoFillDecompose) {
    mode = 'decompose';
    title = '🎯 全局目标拆解 · 发送到终端';
    subtitle = '呼叫智能体结合当前推进目标，自动生成任务拓扑写入 .deck/tasks.json';
    defaultPrompt = `请阅读当前工作区的目录结构、Git 最近提交历史以及当前推进目标「${missionText}」，围绕此目标分析代码现状并拆解出 3~6 个切实可行的子任务，构建合理的 DAG 任务依赖拓扑（通过 dependsOn 标注前置任务），严格遵循 .deck/deck_task_spec.md 规范直接更新写入到工作区的 .deck/tasks.json 文件中（已有任务请合理保留或更新，拆解完成后给出简要说明）。`;
  } else if ((stageRefine || autoFillRefine) && currentTask) {
    mode = 'refine';
    title = `🔍 细化任务 [${currentTask.id}: ${currentTask.title}] · 发送到终端`;
    subtitle = '针对此任务项深入技术剖析，将其拆分为 2~3 个更细维度的子任务';
    const deps = Array.isArray(currentTask.dependsOn) ? JSON.stringify(currentTask.dependsOn) : '[]';
    defaultPrompt = `请针对当前工作区的任务项 [${currentTask.id}: ${currentTask.title}] 进行更细维度的技术剖析，将其拆分为 2~3 个粒度更细的具体子任务，维护好与前置任务 (${deps}) 以及相互之间的前后依赖（dependsOn），并直接更新写入到 .deck/tasks.json 文件中。`;
  } else if (currentTask) {
    mode = 'dispatch';
    title = `⚡ 派发任务 [${currentTask.id}] · 发送到终端`;
    subtitle = '将该任务项具体要求派发给目标智能体或终端工位执行';
    defaultPrompt = currentTask.description
      ? `【任务】${currentTask.title}\n详细说明: ${currentTask.description}`
      : `【任务】${currentTask.title}`;
  } else {
    // Free Dispatch Mode
    title = '🚀 自由派发任务 · 发送到终端';
    subtitle = '选择目标工位，直接发送自定义开发或排查指令';
    defaultPrompt = '';
  }

  openDispatchModal({
    workspaceIdentifier,
    sessions,
    defaultPrompt,
    title,
    subtitle,
    mode,
    selectedTask: currentTask,
    onSuccess: () => {
      if (typeof onRefreshBoard === 'function') {
        setTimeout(onRefreshBoard, 800);
      }
    }
  });
}
