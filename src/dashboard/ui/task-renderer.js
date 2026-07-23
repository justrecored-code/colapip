// ============================================================================
// task-renderer.js — task card rendering for Dashboard UI
// ============================================================================

function renderTaskCard(t) {
  const pct = Math.round((t.progress || 0) * 100);
  const showError = t.state === "failed" && t.error;

  // Sub-progress bar: any plugin can use step "[N/M]" format to show batch progress
  let subBar = "";
  const batchMatch = t.step?.match(/\[(\d+)\/(\d+)\]/);
  if (batchMatch) {
    const subPct = Math.round((+batchMatch[1] / +batchMatch[2]) * 100);
    subBar = `<div class="progress-track sub"><div class="progress-fill sub" style="width:${subPct}%"></div></div>`;
  }

  const created = fmtTime(t.created_at);
  const running = t.state === "running" ? elapsed(t.created_at) : "";
  const cancelBtn = `<button class="danger" onclick="TaskRenderer.taskAction('${t.id}','cancel')">取消</button>`;
  const actions = [];
  if (t.state === "pending") actions.push(cancelBtn);
  if (t.state === "running") actions.push(`<button onclick="TaskRenderer.taskAction('${t.id}','pause')">暂停</button>`, cancelBtn);
  if (t.state === "paused") actions.push(`<button onclick="TaskRenderer.taskAction('${t.id}','retry')">恢复</button>`, cancelBtn);
  if (t.state === "failed") actions.push(`<button onclick="TaskRenderer.taskAction('${t.id}','retry')">重试</button>`, cancelBtn);

  return `<div class="task-card left-${t.state}">
    <div class="task-head"><span class="status-dot ${t.state}"></span><span class="task-name">${t.plugin_name}</span><span class="task-status ${t.state}">${t.state}</span></div>
    <div class="task-meta"><span class="id">${t.id}</span>${created ? '<span class="sep">·</span><span>'+created+'</span>' : ""}${running ? '<span class="sep">·</span><span style="color:var(--accent2)">⏱ '+running+'</span>' : ""}</div>
    ${t.step ? '<div class="task-step">↳ '+t.step+'</div>' : ""}
    <div class="task-progress"><div class="progress-track"><div class="progress-fill${t.state==='completed'?' done':''}${t.state==='running'?' running':''}" style="width:${pct}%"></div></div><span class="task-pct">${pct}%</span></div>
    ${subBar}
    ${showError ? '<div class="task-error">⚠ '+t.error.slice(0,120)+'</div>' : ""}
    <div class="task-foot">${actions.join("")}</div>
  </div>`;
}

function renderTaskList(tasks, filter) {
  const el = document.getElementById("task-list");
  let filtered;
  if (filter === "all") {
    filtered = tasks;
  } else if (filter === "services") {
    filtered = tasks.filter(t => window._servicePlugins?.has(t.plugin_name) && ["running","paused"].includes(t.state));
  } else {
    filtered = tasks.filter(t => !["completed","cancelled"].includes(t.state));
  }
  if (filtered.length === 0) {
    const labels = { all: "", active: "活跃", services: "服务" };
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text2)">暂无' + (labels[filter] || "") + '任务。通过对话面板提交任务。</div>';
    return;
  }
  el.innerHTML = filtered.map(t => renderTaskCard(t)).join("");
}

function taskAction(id, action) {
  fetch(`/api/tasks/${id}/${action}`, { method: "POST" }).then(() => refreshTasks());
}

// Public API
window.TaskRenderer = { renderTaskList, taskAction };
