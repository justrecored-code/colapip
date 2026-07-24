// ── WebSocket ──
const WS_URL = `ws://${location.host}/ws`;
let ws, logs = [], tasks = [];

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (e) => {
    try { const { event, data } = JSON.parse(e.data); handle(event, data); } catch {}
  };
  ws.onclose = () => setTimeout(connect, 3000);
}
connect();

// ── Event Handlers ──
function handle(event, data) {
  if (event === "log") { logs.unshift(data); if (logs.length > 1000) logs.length = 1000; renderLogs(); updateCounts(); }
  else if (event === "task.progress" || event === "task.state_change" || event === "task.completed" || event === "task.error") { refreshTasks(); }
  else if (event === "plugin.registered") { refreshPlugins(); refreshPluginTabs(); }
  else if (event === "plugin.output") {
    // Generic: plugin sends blocks, platform renders them
    if (data.blocks) addMsg("assistant", JSON.stringify(data.blocks));
    else if (data.text) addMsg("assistant", JSON.stringify([{type:"text",text: data.text}]));
  }
}

// ── Chat ──
async function submitText() {
  const inp = document.getElementById("cmd-input");
  const text = inp.value.trim(); if (!text) return;
  inp.value = "";
  addMsg("user", text);
  try {
    const r = await fetch("/api/tasks", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({text}) });
    const d = await r.json();
    if (d.type === "queued") { /* WebSocket will deliver reply */ }
    else if (d.type === "chat") addMsg("assistant", d.reply);
    else if (d.type === "task") addMsg("assistant", d.reply);
    else addMsg("assistant", d.error || "error");
  } catch(e) { addMsg("assistant", "请求失败: " + e.message); }
  refreshTasks();
}

function addMsg(role, text) {
  const body = document.getElementById("chat-body");
  const div = document.createElement("div");
  div.className = "chat-msg " + role;
  if (role === "assistant" && text.includes('"type"')) {
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("no json");
      const blocks = JSON.parse(jsonMatch[0]);
      let html = "";
      for (const b of blocks) {
        if (b.type === "thinking") {
          const t = esc(b.thinking || "");
          html += `<details class="think-details"><summary>💭 思考过程</summary><div class="thinking">${t}</div></details>`;
        }
        else if (b.type === "text") html += `<div class="md">${md2html(b.text)}</div>`;
        else if (b.type === "toolCall") html += `<div class="toolcall">🔧 ${b.name}(${JSON.stringify(b.arguments)})</div>`;
        else if (b.type === "image_url" && b.image_url) html += `<img src="${b.image_url.url}" style="max-width:240px;max-height:360px;border-radius:8px;margin:4px 0">`;
        else html += `<div>${esc(JSON.stringify(b))}</div>`;
      }
      div.innerHTML = html || esc(text);
    } catch { div.textContent = text; }
  } else {
    div.textContent = text;
  }
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

// ── Tasks ──
async function refreshTasks() {
  try {
    const r = await fetch("/api/tasks"); tasks = await r.json();
    renderTasks(); updateCounts();
  } catch {}
}

let taskFilter = "active";

function setTaskFilter(f) {
  taskFilter = f;
  document.querySelectorAll(".filter-pill").forEach(p => p.classList.toggle("active", p.dataset.filter === f));
  renderTasks();
}

function renderTasks() {
  TaskRenderer.renderTaskList(tasks, taskFilter);
}

// ── New Task Form ──
async function openNewTask() {
  document.getElementById("new-task-modal").style.display = "flex";
  document.getElementById("task-form-fields").innerHTML = "";
  document.getElementById("task-plugin-select").value = "";
  try {
    const r = await fetch("/api/plugins");
    const plugins = await r.json();
    const sel = document.getElementById("task-plugin-select");
    sel.innerHTML = '<option value="">选择插件...</option>' + plugins.map(p => `<option value="${p.name}">${p.name} — ${p.description}</option>`).join("");
  } catch {}
}

function closeNewTask() { document.getElementById("new-task-modal").style.display = "none"; }

async function renderTaskForm() {
  const name = document.getElementById("task-plugin-select").value;
  const fieldsEl = document.getElementById("task-form-fields");
  if (!name) { fieldsEl.innerHTML = ""; return; }
  try {
    const r = await fetch(`/api/plugins/${encodeURIComponent(name)}/input`);
    const params = await r.json();
    if (params.length === 0) { fieldsEl.innerHTML = '<div style="color:var(--text2);font-size:13px;padding:10px 0">此插件无需参数</div>'; return; }
    fieldsEl.innerHTML = params.map(p => `
      <div style="margin-bottom:10px">
        <label style="font-size:11px;color:var(--text2);display:block;margin-bottom:2px">${p.name} <span style="color:${p.required?'var(--red)':'var(--text2)'}">${p.required?'(必需)':'(可选)'}</span>${p.desc?' — '+p.desc:''}</label>
        <input name="${p.name}" placeholder="${p.type}" style="width:100%;background:var(--bg);border:1.5px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font:inherit;font-size:13px;outline:none">
      </div>
    `).join("");
  } catch { fieldsEl.innerHTML = '<div style="color:var(--red);font-size:12px">加载参数失败</div>'; }
}

async function submitNewTask() {
  const pluginName = document.getElementById("task-plugin-select").value;
  if (!pluginName) return;
  const params = {};
  document.querySelectorAll("#task-form-fields input").forEach(inp => {
    const val = inp.value.trim();
    if (val) {
      const num = Number(val);
      params[inp.name] = isNaN(num) || val.match(/[^0-9.]/) ? val : num;
    }
  });
  try {
    const r = await fetch("/api/tasks", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ pluginName, params }) });
    const d = await r.json();
    if (d.error) { alert("提交失败: " + d.error); return; }
    closeNewTask();
    refreshTasks();
  } catch(e) { alert("请求失败: " + e.message); }
}

// ── Logs ──
function renderLogs() {
  const level = document.getElementById("log-level").value;
  const search = (document.getElementById("log-search").value || "").toLowerCase();
  const levels = ["debug","info","warn","error"];
  const min = levels.indexOf(level);
  let filtered = logs.filter(l => levels.indexOf(l.level||"info") >= min);
  if (search) filtered = filtered.filter(l => (l.message||"").toLowerCase().includes(search) || (l.plugin||"").toLowerCase().includes(search));
  filtered = filtered.slice(0, 200);
  document.getElementById("log-count-label").textContent = `${filtered.length} / ${logs.length}`;
  if (filtered.length === 0) {
    document.getElementById("log-container").innerHTML = `<div class="log-empty">${logs.length === 0 ? '暂无日志。平台正常运行中。' : '无匹配日志'}</div>`;
    return;
  }
  document.getElementById("log-container").innerHTML = filtered.map(l =>
    `<div class="log-entry"><span class="ts">${l.timestamp||""}</span><span class="lvl ${l.level}">${l.level}</span><span class="src">${l.plugin||""}</span><span class="msg">${esc(l.message||"")}</span></div>`
  ).join("");
}

// ── Assets ──
async function renderAssets() {
  const type = document.getElementById("asset-type").value;
  const r = await fetch("/api/assets" + (type ? `?type=${encodeURIComponent(type)}` : ""));
  let assets = await r.json();
  if (type === "image") assets = assets.filter(a => a.type?.startsWith("image/"));
  document.getElementById("asset-count-label").textContent = `${assets.length} 个资产`;
  document.getElementById("asset-grid").innerHTML = assets.length === 0
    ? '<div class="empty">暂无资产</div>'
    : assets.map(a => `<div class="asset-card" data-path="${esc(a.path)}" data-type="${a.type}" onclick="previewAsset(this.dataset.path,this.dataset.type)">
        <div class="asset-preview">${a.type?.startsWith("image") ? `<img src="/api/file?path=${encodeURIComponent(a.path)}" onerror="this.parentElement.textContent='🖼';">` : a.type?.includes("json") ? "{ }" : a.type?.includes("markdown") ? "📝" : "📄"}</div>
        <div class="asset-info"><div class="asset-filename" title="${a.filename}">${a.filename}</div><div class="asset-meta">${a.type}</div></div>
      </div>`).join("");
}

// ── Health & Plugins ──
async function checkHealth() {
  try {
    const r = await fetch("/api/health"); const d = await r.json();
    const ok = d.llm === "online";
    document.getElementById("llm-dot").className = "dot " + (ok ? "online" : "offline");
    document.getElementById("llm-text").textContent = ok ? "LLM 在线" : "LLM 离线";
    document.getElementById("llm-ind").className = "indicator " + (ok ? "ok" : "off");
    document.getElementById("llm-label").textContent = ok ? "在线" : "离线";
    // Queue indicator
    const q = document.getElementById("queue-indicator");
    if (d.processing) q.textContent = `⚡ 处理中...${d.queue > 0 ? " 排队:" + d.queue : ""}`;
    else if (d.queue > 0) q.textContent = `⏳ 排队: ${d.queue}`;
    else q.textContent = "";
  } catch {}
}

async function refreshPlugins() {
  try {
    const r = await fetch("/api/plugins"); const plugins = await r.json();
    document.getElementById("plugin-summary").textContent = plugins.length + " 个插件";
    document.getElementById("plugin-tags").innerHTML = plugins.map(p =>
      `<span class="plugin-tag">${p.name} v${p.version}</span>`
    ).join("");
    // Track service-type plugins for task filtering
    window._servicePlugins = new Set(plugins.filter(p => p.type === "service").map(p => p.name));
  } catch {}
}

function updateCounts() {
  const active = tasks.filter(t => !["completed","cancelled"].includes(t.state)).length;
  document.getElementById("task-count").textContent = active > 0 ? active : "";
  document.getElementById("log-count").textContent = logs.length > 0 ? logs.length : "";
}

// ── Plugin UI Tabs ──
async function reloadPlugin(name) {
  try {
    const r = await fetch(`/api/plugins/${encodeURIComponent(name)}/reload`, { method: "POST" });
    const d = await r.json();
    if (d.ok) { refreshPluginTabs(); alert(name + " 重载成功"); }
    else alert("重载失败: " + d.error);
  } catch(e) { alert("重载失败: " + e.message); }
}

async function refreshPluginTabs() {
  try {
    const r = await fetch("/api/plugins");
    const plugins = await r.json();
    const tabBar = document.getElementById("tab-bar");
    const panelHost = document.getElementById("plugin-panels");
    // Remove old plugin tabs/panels
    tabBar.querySelectorAll(".plugin-tab-btn").forEach(b => b.remove());
    tabBar.querySelectorAll(".load-plugin-btn").forEach(b => b.remove());
    panelHost.querySelectorAll(".plugin-ui-panel").forEach(p => p.remove());
    // Add tabs for all registered plugins
    for (const p of plugins) {
      const uiSrc = p.hasUi ? `/plugins/${p.name}/ui` : `/plugin-log.html?name=${encodeURIComponent(p.name)}`;
      const tabBtn = document.createElement("button");
      tabBtn.className = "plugin-tab-btn";
      tabBtn.dataset.tab = `plugin-${p.name}`;
      tabBtn.innerHTML = `${p.name} <span onclick="event.stopPropagation();reloadPlugin('${p.name}')" title="重载插件" style="font-size:14px;margin-left:4px;cursor:pointer;opacity:0.6">↻</span>`;
      tabBtn.onclick = () => switchTab(`plugin-${p.name}`);
      tabBar.appendChild(tabBtn);
      const panel = document.createElement("div");
      panel.id = `plugin-${p.name}`;
      panel.className = "panel plugin-ui-panel";
      const iframe = document.createElement("iframe");
      iframe.className = "plugin-panel";
      iframe.src = uiSrc;
      panel.appendChild(iframe);
      panelHost.appendChild(panel);
    }
  } catch {}
}

// ── Tabs ──
function switchTab(id) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
  document.querySelector(".tabs button[data-tab='" + id + "']")?.classList.add("active");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  const panel = document.getElementById(id) || (id.startsWith("plugin-") ? document.getElementById(id) : document.getElementById(id === "logs" ? "logs-panel" : id));
  if (panel) {
    panel.classList.add("active");
    // Plugin panels are nested — also activate the container
    if (id.startsWith("plugin-")) document.getElementById("plugin-panels")?.classList.add("active");
  }
}

document.querySelectorAll(".tabs button").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ── Chat history ──
async function clearChat() {
  await fetch("/api/chat/history", { method: "DELETE" });
  document.getElementById("chat-body").innerHTML = "";
}
async function loadHistory() {
  try {
    const r = await fetch("/api/chat/history");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const hist = await r.json();
    for (const h of hist) addMsg(h.role, h.content);
  } catch(e) {
    console.error("loadHistory failed:", e);
    setTimeout(loadHistory, 2000);
  }
}

// ── Init ──
loadHistory();
checkHealth(); setInterval(checkHealth, 5000);
refreshPlugins(); refreshPluginTabs();
refreshTasks(); setInterval(refreshTasks, 5000);
