// 职责（单一）：app-state = **跨文件持久态**（非 per-document、非 user-preference）——当前目录 / 当前文件 /
//   Blender 端点 / 登录 flag …。两个 collection（跨设备 synced-app-state / 设备本地 local-app-state）的
//   **注入点 + DEFAULTS SSoT + struct 门面**。
//
// 用起来像 struct：`appState.currentDirectory = "x"`; `const d = appState.currentDirectory`。
//   **冷字段（当前全部）**：getter 直读 collection、setter 直写 collection——**不落 app-state RAM**
//     （与 app-prefs「直读」一致；collection 自带内存镜像 + 防抖持久化 + init 后台对齐云端）。
//   **热字段（本轮无）**：才持内存，`pushHotToPersistent()` 显式写 collection、`pullFromPersistent()` 云对齐后覆盖。
//   除各字段外，struct 只有 `pushHotToPersistent()` / `pullFromPersistent()` 两个方法（序列化持久化用），无任何应用逻辑。
//
// ⚠**刻意不 import app-store**（防成环，同 app-prefs）：collection 由 app-store 建好后惰性注入（wireAppState）；
//   注入前读返 DEFAULTS（boot 安全）。boot 门 `await initAppState()`（内部 hydrate 快、离线 OK）。
import type { Collection } from "./store/index.ts";

// ── DEFAULTS SSoT（唯一处；getItem 缺省从这里取，别处不 inline）───────────────────────────
export const APP_STATE_DEFAULTS = {
  // 跨设备（synced-app-state）：跟人/identity 走的跨文件持久态
  "current-directory": "" as string,          // 上次所在图库文件夹（Cold）
  "current-file": null as string | null,      // 上次打开的文档名（非 null → boot 自动 open）（Cold）
  "blender-panel-url": "" as string,          // Blender 同步远端 URL（2026-07-14 决策：全账号同步，tailscale 稳定端点）（Cold）
  // 设备本地（local-app-state）：跟设备走的持久态
  "last-session-signed-in": false as boolean, // 上次是否登录（控静默重认证；设备级 auth flag）（Cold）
} as const;
export type AppStateKey = keyof typeof APP_STATE_DEFAULTS;

// ── collection 注入 + boot 门 ────────────────────────────────────────────────────────────
let _synced: Collection | undefined;
let _local: Collection | undefined;

// app-store 唯一调：接入 synced-app-state / local-app-state（后者走 {local:true}）。
export function wireAppState(synced: Collection, local: Collection): void { _synced = synced; _local = local; }
// boot 门：hydrate 两个 collection（各自 init 内部先 hydrate 本地再后台对齐云端）。快、离线 OK。
export function initAppState(): Promise<void> {
  return Promise.all([_synced?.init() ?? Promise.resolve(), _local?.init() ?? Promise.resolve()]).then(() => undefined);
}

// 冷字段直读写助手：未注入前（boot 极早 / 测试）安全返 default / no-op。
const getC = <V>(c: Collection | undefined, k: AppStateKey): V =>
  (c ? c.getItem(k, APP_STATE_DEFAULTS[k]) : APP_STATE_DEFAULTS[k]) as V;
const setC = (c: Collection | undefined, k: AppStateKey, v: unknown): void => { c?.setItem(k, v); };

// ── struct 门面：各字段 + pushHotToPersistent() + pullFromPersistent()（除此无它）──────────────
export const appState = {
  // ── 跨设备（synced-app-state）冷字段 ──
  get currentDirectory(): string { return getC<string>(_synced, "current-directory"); },
  set currentDirectory(v: string) { setC(_synced, "current-directory", v); },
  get currentFile(): string | null { return getC<string | null>(_synced, "current-file"); },
  set currentFile(v: string | null) { setC(_synced, "current-file", v); },
  get blenderPanelUrl(): string { return getC<string>(_synced, "blender-panel-url"); },
  set blenderPanelUrl(v: string) { setC(_synced, "blender-panel-url", v); },
  // ── 设备本地（local-app-state）冷字段 ──
  get lastSessionSignedIn(): boolean { return getC<boolean>(_local, "last-session-signed-in") === true; },
  set lastSessionSignedIn(v: boolean) { setC(_local, "last-session-signed-in", !!v); },

  // ── 序列化持久化相关（除字段外仅此二法，无应用逻辑）──
  // 热变量写 collection。本轮无热字段：冷字段 setter 已直写 collection → no-op。
  pushHotToPersistent(): void { /* 无热字段 */ },
  // await 云端对齐后，热变量用云值覆盖。冷字段 getter 本就直读最新 collection，无需覆盖——只 await 对齐。
  async pullFromPersistent(): Promise<void> {
    await Promise.all([_synced?.pullAndReconcile() ?? Promise.resolve(), _local?.pullAndReconcile() ?? Promise.resolve()]);
  },
};
