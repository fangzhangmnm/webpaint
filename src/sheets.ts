// 职责（单一）：in-app 模态对话框原语——确认 / 输入 / 锁屏 gate。
// 守红线「不用系统 alert/prompt/confirm」（iPad PWA 全屏体验烂）。纯 DOM，自持元素引用。
// sync 决策编排（gateCloudSyncOnOpen / checkCloudETag / 闲置锁屏）= store-coupled，留在 app，调本模块的 lockSyncGate。

import { isBusyActive } from "./fullscreen-busy.ts";

// **busy/sheet 互斥护栏（2026-06-12 死锁修复）**：fullscreen-busy 遮罩 z(540) 高于 input/confirm
//   sheet z(500)，busy 激活时弹输入框 = 框被盖住、用户点不到 → await 永不 resolve → 无限转圈。
//   这是**编程错误**（"我在忙" 与 "请输入" 自相矛盾）：交互输入必须在 withBusy 之外做。
//   → 这里**响亮 throw**，把静默转圈变成定位到调用栈的报错。（lockSyncGate 不受此限——它是 sync
//   冲突 gate，自带 spinner、设计上与 busy 协同，不走这条。）
function _assertNotBusy(kind: string) {
  if (isBusyActive()) {
    throw new Error(`不能在 withBusy 期间打开${kind}（会被全屏遮罩盖住→死锁）。把交互输入移到 withBusy 之外。`);
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const g = {
  sheet: () => $("genericSheet"),
  backdrop: () => $("genericBackdrop"),
  title: () => $("genericSheetTitle"),
  message: () => $("genericSheetMessage"),
  input: () => $("genericSheetInput") as HTMLInputElement,
  confirm: () => $("genericSheetConfirm"),
  cancel: () => $("genericSheetCancel"),
};

function openSheet(sheet: HTMLElement, backdrop: HTMLElement) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet: HTMLElement, backdrop: HTMLElement) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}
function resolveAndClose<T>(resolve: (v: T) => void, value: T, cleanup: () => void) {
  cleanup();
  closeSheet(g.sheet(), g.backdrop());
  resolve(value);
}

// 输入框对话框 → Promise<string|null>（取消 = null）。
// opts.password：输入框打码（type=password，关闭时还原）；opts.message：输入框上方说明行。
export function openInputSheet(title: string, defaultValue = "", { placeholder = "", password = false, message = "" } = {}): Promise<string | null> {
  _assertNotBusy("输入框");
  return new Promise((resolve) => {
    g.title().textContent = title;
    if (message) { g.message().classList.remove("hidden"); g.message().textContent = message; }
    else g.message().classList.add("hidden");
    g.input().classList.remove("hidden");
    // 密码态**不用** type=password —— 兄弟项目各 shared-file 各密码，浏览器「记住/更新密码」
    //   弹窗会把它们串味、误填。改用 type=text + -webkit-text-security 打码（Safari/Chrome/新版
    //   Firefox 都支持），绕开浏览器密码管理器的启发式探测，从根上不触发记密码弹窗。
    g.input().type = "text";
    g.input().style.setProperty("-webkit-text-security", password ? "disc" : "");
    g.input().autocomplete = "off";
    g.input().value = defaultValue;
    g.input().placeholder = placeholder;
    openSheet(g.sheet(), g.backdrop());
    setTimeout(() => { g.input().focus(); g.input().select(); }, 0);
    const onConfirm = () => resolveAndClose(resolve, g.input().value, cleanup);
    const onCancel = () => resolveAndClose(resolve, null, cleanup);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    const cleanup = () => {
      g.confirm().removeEventListener("click", onConfirm);
      g.cancel().removeEventListener("click", onCancel);
      g.backdrop().removeEventListener("click", onCancel);
      g.input().removeEventListener("keydown", onKey);
      g.input().type = "text";
      g.input().style.setProperty("-webkit-text-security", "");   // 打码态不残留到下一个输入框
      g.input().value = "";
    };
    g.confirm().addEventListener("click", onConfirm);
    g.cancel().addEventListener("click", onCancel);
    g.backdrop().addEventListener("click", onCancel);
    g.input().addEventListener("keydown", onKey);
  });
}

// 确认对话框 → Promise<boolean>。
export function openConfirmSheet(title: string, message: string): Promise<boolean> {
  _assertNotBusy("确认框");
  return new Promise((resolve) => {
    g.title().textContent = title;
    g.input().classList.add("hidden");
    g.message().classList.remove("hidden");
    g.message().textContent = message;
    openSheet(g.sheet(), g.backdrop());
    const onConfirm = () => resolveAndClose(resolve, true, cleanup);
    const onCancel = () => resolveAndClose(resolve, false, cleanup);
    const cleanup = () => {
      g.confirm().removeEventListener("click", onConfirm);
      g.cancel().removeEventListener("click", onCancel);
      g.backdrop().removeEventListener("click", onCancel);
    };
    g.confirm().addEventListener("click", onConfirm);
    g.cancel().addEventListener("click", onCancel);
    g.backdrop().addEventListener("click", onCancel);
  });
}

// ---- Sync gate（锁屏覆盖 + 动作按钮）：纯 DOM 原语。决策编排在 app。----
interface SyncGateAction { label: string; value: string; primary?: boolean; }
interface SyncGateOpts { title: string; message: string; showSpinner?: boolean; actions: SyncGateAction[]; }
const syncGate: {
  backdrop: HTMLElement; sheet: HTMLElement; title: HTMLElement; message: HTMLElement;
  spinner: HTMLElement; actions: HTMLElement; _pendingResolve: ((value: string) => void) | null;
} = {
  backdrop: $("syncGateBackdrop"),
  sheet: $("syncGateSheet"),
  title: $("syncGateTitle"),
  message: $("syncGateMessage"),
  spinner: $("syncGateSpinner"),
  actions: $("syncGateActions"),
  _pendingResolve: null,
};

export function lockSyncGate({ title, message, showSpinner, actions }: SyncGateOpts): Promise<string> {
  syncGate.title.textContent = title;
  syncGate.message.textContent = message;
  syncGate.spinner.classList.toggle("hidden", !showSpinner);
  syncGate.actions.innerHTML = "";
  return new Promise((resolve) => {
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label;
      if (a.primary) btn.classList.add("primary");
      btn.addEventListener("click", () => { unlockSyncGate(); resolve(a.value); });
      syncGate.actions.appendChild(btn);
    }
    syncGate.backdrop.classList.remove("hidden");
    syncGate.sheet.classList.remove("hidden");
    syncGate._pendingResolve = resolve;   // 让 fetch 完成时从外部 unlock 并返回
  });
}
export function unlockSyncGate() {
  syncGate.backdrop.classList.add("hidden");
  syncGate.sheet.classList.add("hidden");
  syncGate._pendingResolve = null;
}
export function settleSyncGate(value: string) {
  if (syncGate._pendingResolve) {
    const r = syncGate._pendingResolve;
    unlockSyncGate();
    r(value);
  }
}
