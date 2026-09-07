/**
 * Project DAG Canvas Module
 * Renders an interactive topological graph (DAG) for project tasks and dependencies.
 */

let canvasState = {
  zoom: 1.0,
  panX: 20,
  panY: 20,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  selectedTaskId: null
};

/**
 * Compute DAG topological layered layout
 * Uses Sugiyama-style rank assignment based on dependsOn
 */
export function computeDagLayout(tasks = [], mission = '') {
  if (!tasks || tasks.length === 0) {
    return { nodes: [], links: [], width: 600, height: 400 };
  }

  const taskMap = new Map();
  tasks.forEach(t => {
    taskMap.set(String(t.id), {
      ...t,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : []
    });
  });

  // Calculate rank for each node (longest path from root)
  const ranks = new Map();
  const visiting = new Set();

  function getRank(id) {
    if (ranks.has(id)) return ranks.get(id);
    if (visiting.has(id)) {
      // Cycle detected, break cycle
      return 0;
    }
    visiting.add(id);

    const task = taskMap.get(id);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      ranks.set(id, 0);
      visiting.delete(id);
      return 0;
    }

    let maxParentRank = -1;
    for (const parentId of task.dependsOn) {
      if (taskMap.has(parentId)) {
        const pRank = getRank(parentId);
        if (pRank > maxParentRank) {
          maxParentRank = pRank;
        }
      }
    }

    const myRank = maxParentRank + 1;
    ranks.set(id, myRank);
    visiting.delete(id);
    return myRank;
  }

  tasks.forEach(t => getRank(String(t.id)));

  // Group nodes by rank
  const rankColumns = [];
  tasks.forEach(t => {
    const id = String(t.id);
    const r = ranks.get(id) || 0;
    while (rankColumns.length <= r) {
      rankColumns.push([]);
    }
    rankColumns[r].push(taskMap.get(id));
  });

  // Coordinate calculations
  const nodeWidth = 260;
  const nodeHeight = 118;
  const gapX = 75;
  const gapY = 24;
  const paddingX = 40;
  const paddingY = 40;

  // Find max column height to center shorter columns vertically
  let maxColCount = 0;
  rankColumns.forEach(col => {
    if (col.length > maxColCount) maxColCount = col.length;
  });
  const maxContentHeight = maxColCount * nodeHeight + Math.max(0, maxColCount - 1) * gapY;

  const nodes = [];
  const links = [];

  rankColumns.forEach((col, colIdx) => {
    const colHeight = col.length * nodeHeight + Math.max(0, col.length - 1) * gapY;
    const offsetY = paddingY + Math.max(0, (maxContentHeight - colHeight) / 2);

    col.forEach((task, rowIdx) => {
      const x = paddingX + colIdx * (nodeWidth + gapX);
      const y = offsetY + rowIdx * (nodeHeight + gapY);

      // Determine if blocked by unfinished dependencies
      let isBlocked = false;
      const unfinishedDeps = [];
      if (task.dependsOn && task.dependsOn.length > 0) {
        task.dependsOn.forEach(depId => {
          const parent = taskMap.get(depId);
          if (parent && parent.status !== 'done') {
            isBlocked = true;
            unfinishedDeps.push(parent.title || depId);
          }
        });
      }

      const nodeObj = {
        ...task,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        rank: colIdx,
        isBlocked: isBlocked && task.status !== 'done',
        unfinishedDeps
      };
      nodes.push(nodeObj);
    });
  });

  // Create node lookup by ID for link generation
  const nodeMap = new Map();
  nodes.forEach(n => nodeMap.set(String(n.id), n));

  // Generate links
  nodes.forEach(targetNode => {
    if (targetNode.dependsOn && targetNode.dependsOn.length > 0) {
      targetNode.dependsOn.forEach(sourceId => {
        const sourceNode = nodeMap.get(sourceId);
        if (sourceNode) {
          const sx = sourceNode.x + sourceNode.width;
          const sy = sourceNode.y + sourceNode.height / 2;
          const tx = targetNode.x;
          const ty = targetNode.y + targetNode.height / 2;

          const dx = Math.max(30, (tx - sx) * 0.5);
          const pathD = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;

          let linkStatus = 'pending';
          if (sourceNode.status === 'done') {
            linkStatus = targetNode.status === 'done' ? 'done' : 'active';
          } else if (sourceNode.status === 'in_progress') {
            linkStatus = 'in_progress';
          }

          links.push({
            id: `${sourceId}->${targetNode.id}`,
            sourceId,
            targetId: targetNode.id,
            pathD,
            status: linkStatus
          });
        }
      });
    }
  });

  const totalWidth = paddingX * 2 + rankColumns.length * nodeWidth + Math.max(0, rankColumns.length - 1) * gapX;
  const totalHeight = paddingY * 2 + maxContentHeight;

  return {
    nodes,
    links,
    width: Math.max(700, totalWidth),
    height: Math.max(360, totalHeight)
  };
}

/**
 * Render the DAG Canvas DOM structure and attach pan/zoom/click events
 */
export function renderDagCanvas(container, options = {}) {
  const {
    tasks = [],
    mission = '',
    onToggleTask,
    onRefineTask,
    onDispatchTask,
    onDeleteTask,
    onSelectTask
  } = options;

  if (!container) return;

  const layout = computeDagLayout(tasks, mission);

  // Shell structure
  container.innerHTML = `
    <div class="dag-canvas-shell" id="dagCanvasShell">
      <!-- Floating Canvas Toolbar -->
      <div class="dag-canvas-toolbar">
        <div class="dag-toolbar-group">
          <button id="dagZoomOutBtn" class="dag-toolbar-btn" title="缩小画布">
            <i data-lucide="minus" style="width: 13px; height: 13px;"></i>
          </button>
          <span class="dag-zoom-display" id="dagZoomDisplay">${Math.round(canvasState.zoom * 100)}%</span>
          <button id="dagZoomInBtn" class="dag-toolbar-btn" title="放大画布">
            <i data-lucide="plus" style="width: 13px; height: 13px;"></i>
          </button>
          <button id="dagFitBtn" class="dag-toolbar-btn" title="居中并适应视图">
            <i data-lucide="maximize-2" style="width: 13px; height: 13px;"></i>
            <span>适应</span>
          </button>
        </div>

        <div class="dag-legend-row">
          <span class="dag-legend-item done"><span class="legend-dot"></span>已完成</span>
          <span class="dag-legend-item in-progress"><span class="legend-dot"></span>推进中</span>
          <span class="dag-legend-item todo"><span class="legend-dot"></span>就绪待办</span>
          <span class="dag-legend-item blocked"><span class="legend-dot"></span>前置等待</span>
        </div>
      </div>

      <!-- Viewport & Drag Canvas Area -->
      <div class="dag-viewport" id="dagViewport">
        <div class="dag-transform-layer" id="dagTransformLayer" style="transform: translate(${canvasState.panX}px, ${canvasState.panY}px) scale(${canvasState.zoom}); transform-origin: 0 0;">
          
          <!-- SVG Links Layer -->
          <svg class="dag-svg-layer" width="${layout.width + 100}" height="${layout.height + 100}">
            <defs>
              <marker id="arrow-done" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--neon-green, #10b981)"/>
              </marker>
              <marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--neon-cyan, #00f0ff)"/>
              </marker>
              <marker id="arrow-pending" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--text-muted, #64748b)"/>
              </marker>
            </defs>

            ${layout.links.map(link => {
              const markerId = link.status === 'done' ? 'arrow-done' : (link.status === 'active' ? 'arrow-active' : 'arrow-pending');
              return `
                <path class="dag-link-path ${link.status}" d="${link.pathD}" marker-end="url(#${markerId})"></path>
              `;
            }).join('')}
          </svg>

          <!-- Nodes Layer -->
          <div class="dag-nodes-layer" style="width: ${layout.width}px; height: ${layout.height}px;">
            ${layout.nodes.map(node => {
              const isSelected = canvasState.selectedTaskId === String(node.id);
              const isDone = node.status === 'done';
              const isInProgress = node.status === 'in_progress';
              const isBlocked = node.isBlocked;

              let statusClass = 'todo';
              let statusLabel = '待办';
              let statusIcon = 'circle';

              if (isDone) {
                statusClass = 'done';
                statusLabel = '已完成';
                statusIcon = 'check-circle-2';
              } else if (isInProgress) {
                statusClass = 'in-progress';
                statusLabel = '推进中';
                statusIcon = 'play-circle';
              } else if (isBlocked) {
                statusClass = 'blocked';
                statusLabel = '前置等待';
                statusIcon = 'lock';
              }

              const priorityLabel = node.priority === 'high' ? '高优' : (node.priority === 'low' ? '低优' : '中优');
              const priorityClass = node.priority || 'medium';

              return `
                <div class="dag-node-card ${statusClass} ${isSelected ? 'selected' : ''}" 
                     id="dag-node-${escapeHtml(node.id)}"
                     data-task-id="${escapeHtml(node.id)}"
                     style="left: ${node.x}px; top: ${node.y}px; width: ${node.width}px;">
                  
                  <div class="dag-node-top">
                    <button class="dag-node-check-btn ${isDone ? 'checked' : ''}" data-task-id="${escapeHtml(node.id)}" title="${isDone ? '标记为未完成' : '标记为已完成'}">
                      <i data-lucide="${statusIcon}" style="width: 14px; height: 14px;"></i>
                    </button>
                    <span class="dag-node-id">${escapeHtml(node.id)}</span>
                    <span class="dag-node-status-tag ${statusClass}">${statusLabel}</span>
                    <span class="dag-node-priority-tag ${priorityClass}">${priorityLabel}</span>
                  </div>

                  <div class="dag-node-body">
                    <div class="dag-node-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</div>
                    ${node.description ? `<div class="dag-node-desc" title="${escapeHtml(node.description)}">${escapeHtml(node.description)}</div>` : ''}
                    ${isBlocked && node.unfinishedDeps.length > 0 ? `
                      <div class="dag-node-block-hint" title="依赖前置: ${escapeHtml(node.unfinishedDeps.join(', '))}"><i data-lucide="alert-circle" style="width: 10px; height: 10px;"></i> 等待: ${escapeHtml(node.unfinishedDeps.join(', '))}</div>
                    ` : ''}
                  </div>

                  <div class="dag-node-bottom">
                    <div class="dag-node-assignee">
                      ${node.assignee ? `<i data-lucide="bot" style="width: 11px; height: 11px;"></i><span>${escapeHtml(node.assignee)}</span>` : '<span class="unassigned">未指派</span>'}
                    </div>
                    <div class="dag-node-actions">
                      <button class="dag-btn-refine" data-task-id="${escapeHtml(node.id)}" title="让 AGY 进一步细化此任务节点">
                        <i data-lucide="sparkles" style="width: 11px; height: 11px;"></i>
                        <span>细化</span>
                      </button>
                      <button class="dag-btn-dispatch" data-task-id="${escapeHtml(node.id)}" title="填入派发输入框">
                        <i data-lucide="send" style="width: 11px; height: 11px;"></i>
                        <span>派发</span>
                      </button>
                      <button class="dag-btn-delete" data-task-id="${escapeHtml(node.id)}" title="删除此任务">
                        <i data-lucide="trash-2" style="width: 11px; height: 11px;"></i>
                      </button>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>

        </div>
      </div>
    </div>
  `;

  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Setup Pan & Zoom & Interactive Listeners
  setupCanvasInteractions(container, layout, {
    tasks,
    onToggleTask,
    onRefineTask,
    onDispatchTask,
    onDeleteTask,
    onSelectTask
  });
}

/**
 * Setup canvas pan, zoom and node action listeners
 */
function setupCanvasInteractions(container, layout, callbacks) {
  const viewport = container.querySelector('#dagViewport');
  const transformLayer = container.querySelector('#dagTransformLayer');
  const zoomDisplay = container.querySelector('#dagZoomDisplay');
  const zoomInBtn = container.querySelector('#dagZoomInBtn');
  const zoomOutBtn = container.querySelector('#dagZoomOutBtn');
  const fitBtn = container.querySelector('#dagFitBtn');

  if (!viewport || !transformLayer) return;

  const updateTransform = () => {
    transformLayer.style.transform = `translate(${canvasState.panX}px, ${canvasState.panY}px) scale(${canvasState.zoom})`;
    if (zoomDisplay) {
      zoomDisplay.textContent = `${Math.round(canvasState.zoom * 100)}%`;
    }
  };

  // Zoom buttons
  if (zoomInBtn) {
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      canvasState.zoom = Math.min(2.0, Math.round((canvasState.zoom + 0.15) * 100) / 100);
      updateTransform();
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      canvasState.zoom = Math.max(0.4, Math.round((canvasState.zoom - 0.15) * 100) / 100);
      updateTransform();
    });
  }

  if (fitBtn) {
    fitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fitCanvas(viewport, layout);
      updateTransform();
    });
  }

  // Wheel to zoom (with Ctrl/Cmd or Alt) or pan
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const newZoom = Math.min(2.0, Math.max(0.4, canvasState.zoom * zoomFactor));
      
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      canvasState.panX = mouseX - (mouseX - canvasState.panX) * (newZoom / canvasState.zoom);
      canvasState.panY = mouseY - (mouseY - canvasState.panY) * (newZoom / canvasState.zoom);
      canvasState.zoom = newZoom;
    } else {
      canvasState.panX -= e.deltaX;
      canvasState.panY -= e.deltaY;
    }
    updateTransform();
  }, { passive: false });

  // Pan with mouse drag on background
  viewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.dag-node-card') || e.target.closest('.dag-canvas-toolbar')) {
      return;
    }
    canvasState.isDragging = true;
    canvasState.dragStartX = e.clientX - canvasState.panX;
    canvasState.dragStartY = e.clientY - canvasState.panY;
    viewport.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!canvasState.isDragging) return;
    canvasState.panX = e.clientX - canvasState.dragStartX;
    canvasState.panY = e.clientY - canvasState.dragStartY;
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    if (canvasState.isDragging) {
      canvasState.isDragging = false;
      if (viewport) viewport.style.cursor = 'grab';
    }
  });

  // Node selection & actions
  const nodeCards = container.querySelectorAll('.dag-node-card');
  nodeCards.forEach(card => {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = card.getAttribute('data-task-id');
      canvasState.selectedTaskId = taskId;
      nodeCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');

      const taskObj = callbacks.tasks.find(t => String(t.id) === String(taskId));
      if (taskObj && typeof callbacks.onSelectTask === 'function') {
        callbacks.onSelectTask(taskObj);
      }
    });
  });

  // Check buttons
  const checkBtns = container.querySelectorAll('.dag-node-check-btn');
  checkBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      if (taskId && typeof callbacks.onToggleTask === 'function') {
        callbacks.onToggleTask(taskId);
      }
    });
  });

  // Refine buttons (细化)
  const refineBtns = container.querySelectorAll('.dag-btn-refine');
  refineBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      const taskObj = callbacks.tasks.find(t => String(t.id) === String(taskId));
      if (taskObj && typeof callbacks.onRefineTask === 'function') {
        canvasState.selectedTaskId = taskId;
        nodeCards.forEach(c => c.classList.remove('selected'));
        const card = container.querySelector(`#dag-node-${taskId}`);
        if (card) card.classList.add('selected');
        callbacks.onRefineTask(taskObj);
      }
    });
  });

  // Dispatch buttons (派发)
  const dispatchBtns = container.querySelectorAll('.dag-btn-dispatch');
  dispatchBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      const taskObj = callbacks.tasks.find(t => String(t.id) === String(taskId));
      if (taskObj && typeof callbacks.onDispatchTask === 'function') {
        callbacks.onDispatchTask(taskObj);
      }
    });
  });

  // Delete buttons
  const deleteBtns = container.querySelectorAll('.dag-btn-delete');
  deleteBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.getAttribute('data-task-id');
      if (taskId && typeof callbacks.onDeleteTask === 'function') {
        callbacks.onDeleteTask(taskId);
      }
    });
  });
}

/**
 * Auto-fit canvas inside viewport
 */
function fitCanvas(viewport, layout) {
  if (!viewport) return;
  const vw = viewport.clientWidth || 800;
  const vh = viewport.clientHeight || 450;
  const lw = layout.width + 80;
  const lh = layout.height + 80;

  const scaleX = vw / lw;
  const scaleY = vh / lh;
  const targetScale = Math.min(1.2, Math.max(0.45, Math.min(scaleX, scaleY)));

  canvasState.zoom = Math.round(targetScale * 100) / 100;
  canvasState.panX = Math.max(20, (vw - layout.width * canvasState.zoom) / 2);
  canvasState.panY = Math.max(20, (vh - layout.height * canvasState.zoom) / 2);
}

/**
 * Get current selected task ID
 */
export function getSelectedTaskId() {
  return canvasState.selectedTaskId;
}

/**
 * Set selected task ID programmatically
 */
export function setSelectedTaskId(id) {
  canvasState.selectedTaskId = id;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
