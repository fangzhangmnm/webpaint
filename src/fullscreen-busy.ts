// 职责（单一）：全屏 busy 遮罩 + withBusy 长操作包装——纯 DOM，无 app-state 依赖。
// 全屏 block overlay：拉云端时显示 spinner + 文字，防误操作
export function showFullscreenBusy(msg?: string): void {
  let el = document.getElementById("fullscreenBusy");
  if (!el) {
    el = document.createElement("div");
    el.id = "fullscreenBusy";
    el.className = "fullscreen-busy";
    el.innerHTML = '<div class="fullscreen-busy-spinner"></div><div class="fullscreen-busy-msg"></div>';
    document.body.appendChild(el);
  }
  const m = el.querySelector(".fullscreen-busy-msg");
  if (m) m.textContent = msg || "处理中…";
  el.classList.remove("hidden");
}
export function hideFullscreenBusy() {
  const el = document.getElementById("fullscreenBusy");
  if (el) el.classList.add("hidden");
}

// withBusy: 长 op 包装 → 全屏 spinner + 防误点 + 报状态。统一所有 trash/rename/卸载 等长操作。
// **可重入（ref-count）**：现在 Store 深模块内部对 rename/del 等用户态写也强制 withBusy，
//   会嵌在 app 调用方的 withBusy 之内。若不计数，内层 finally 会在外层还在跑时就 hide 遮罩
//   → 提前解锁。计数后只有最外层结束才 hide。
let _busyDepth = 0;
// 全屏 busy 遮罩当前是否激活（sheets 护栏用：busy 期间禁开 input/confirm sheet——会被盖住死锁）。
// **按遮罩 DOM 可见性判**，不只看 _busyDepth——showFullscreenBusy/hideFullscreenBusy（手动对，pull
//   等用）不走 withBusy 的计数，但同样拉起同一个 z-540 遮罩，也得算 busy。
export function isBusyActive() {
  const el = document.getElementById("fullscreenBusy");
  return !!el && !el.classList.contains("hidden");
}
export async function withBusy<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  _busyDepth++;
  showFullscreenBusy(label);
  try { return await fn(); }
  finally {
    _busyDepth--;
    if (_busyDepth <= 0) { _busyDepth = 0; hideFullscreenBusy(); }
  }
}
