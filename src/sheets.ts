// 职责（单一）：in-app 模态对话框原语——确认 / 输入 / 锁屏 gate。
// 守红线「不用系统 alert/prompt/confirm」（iPad PWA 全屏体验烂）。纯 DOM，自持元素引用。
// sync 决策编排（gateCloudSyncOnOpen / checkCloudETag / 闲置锁屏）= store-coupled，留在 app，调本模块的 lockSyncGate。

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
function resolveAndClose(resolve: (v: any) => void, value: any, cleanup: () => void) {
  cleanup();
  closeSheet(g.sheet(), g.backdrop());
  resolve(value);
}

// 输入框对话框 → Promise<string|null>（取消 = null）。
export function openInputSheet(title: string, defaultValue = "", { placeholder = "" } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    g.title().textContent = title;
    g.message().classList.add("hidden");
    g.input().classList.remove("hidden");
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
      g.input().removeEventListener("keydown", onKey as any);
    };
    g.confirm().addEventListener("click", onConfirm);
    g.cancel().addEventListener("click", onCancel);
    g.backdrop().addEventListener("click", onCancel);
    g.input().addEventListener("keydown", onKey as any);
  });
}

// 确认对话框 → Promise<boolean>。
export function openConfirmSheet(title: string, message: string): Promise<boolean> {
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
const syncGate: any = {
  backdrop: $("syncGateBackdrop"),
  sheet: $("syncGateSheet"),
  title: $("syncGateTitle"),
  message: $("syncGateMessage"),
  spinner: $("syncGateSpinner"),
  actions: $("syncGateActions"),
  _pendingResolve: null,
};

export function lockSyncGate({ title, message, showSpinner, actions }: any): Promise<any> {
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
export function settleSyncGate(value: any) {
  if (syncGate._pendingResolve) {
    const r = syncGate._pendingResolve;
    unlockSyncGate();
    r(value);
  }
}
