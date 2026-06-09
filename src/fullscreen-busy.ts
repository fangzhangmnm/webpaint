// 职责（单一）：全屏 busy 遮罩 + withBusy 长操作包装——纯 DOM，无 app-state 依赖。
// 全屏 block overlay：拉云端时显示 spinner + 文字，防误操作
export function showFullscreenBusy(msg) {
  let el = document.getElementById("fullscreenBusy");
  if (!el) {
    el = document.createElement("div");
    el.id = "fullscreenBusy";
    el.className = "fullscreen-busy";
    el.innerHTML = '<div class="fullscreen-busy-spinner"></div><div class="fullscreen-busy-msg"></div>';
    document.body.appendChild(el);
  }
  el.querySelector(".fullscreen-busy-msg").textContent = msg || "处理中…";
  el.classList.remove("hidden");
}
export function hideFullscreenBusy() {
  const el = document.getElementById("fullscreenBusy");
  if (el) el.classList.add("hidden");
}

// withBusy: 长 op 包装 → 全屏 spinner + 防误点 + 报状态。统一所有 trash/rename/卸载 等长操作。
export async function withBusy(label, fn) {
  showFullscreenBusy(label);
  try { return await fn(); }
  finally { hideFullscreenBusy(); }
}
