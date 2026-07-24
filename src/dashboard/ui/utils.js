// ============================================================================
// utils.js — shared utility functions for Dashboard UI
// ============================================================================

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"<").replace(/>/g,">").replace(/"/g,"&quot;");
}

function md2html(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^### (.+)/gm, "<h4>$1</h4>")
    .replace(/^## (.+)/gm, "<h3>$1</h3>")
    .replace(/^# (.+)/gm, "<h2>$1</h2>")
    .replace(/^\- (.+)/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    .replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(/^> (.+)/gm, "<blockquote>$1</blockquote>")
    .replace(/^---$/gm, "<hr>")
    .replace(/!\[(.+?)\]\((.+?)\)/g, '<img src="$2" alt="$1" style="max-width:240px;max-height:360px;border-radius:8px;margin:4px 0">')
    .replace(/\n/g, "<br>");
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts.replace(" ", "T") + (ts.includes("Z")?"":"+08:00"));
  if (isNaN(d.getTime())) return ts;
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

function elapsed(ts) {
  if (!ts) return "";
  const d = new Date(ts.replace(" ", "T") + (ts.includes("Z")?"":"+08:00"));
  if (isNaN(d.getTime())) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  return `${Math.floor(diff/3600)}h${Math.floor((diff%3600)/60)}m`;
}

function previewAsset(filepath, type) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const box = document.createElement("div");
  box.className = "modal-box";
  const close = document.createElement("button");
  close.textContent = "✕"; close.className = "modal-close";
  close.onclick = () => overlay.remove();
  box.appendChild(close);
  if (type.startsWith("image")) {
    const img = document.createElement("img");
    img.src = "/api/file?path=" + encodeURIComponent(filepath);
    img.style.maxWidth = "240px"; img.style.maxHeight = "360px"; img.style.objectFit = "contain";
    box.appendChild(img);
  } else {
    fetch("/api/file?path=" + encodeURIComponent(filepath))
      .then(r => r.text()).then(txt => {
        const pre = document.createElement("pre");
        pre.style.maxHeight = "70vh"; pre.style.overflow = "auto";
        pre.style.whiteSpace = "pre-wrap"; pre.style.fontSize = "12px";
        pre.textContent = txt;
        box.appendChild(pre);
      });
  }
  overlay.appendChild(box); document.body.appendChild(overlay);
}
