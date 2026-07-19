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
  // ⚠ current-file **住 local-app-state，不是 synced**（v438 迁移）。它是「这台设备此刻打开着哪张画」，
  //   没有合并语义，也不该有。放在 synced 里有一条真数据安全后果：
  //     store 把它读回去当守卫（app-store.activeFileName → reconcile 的 skipName，K1 红线：
  //     cloud-gone 防抖绝不碰打开着的文件）。而 synced 是 LWW 跨设备的 ——
  //     **设备 B 打开 Y 会同步过来，把设备 A 的 activeFileName() 翻成 Y，
  //     于是设备 A 不再保护自己真正打开的 X。** 远端设备的选择在驾驶本机的驱逐守卫。
  //   键名保持 "current-file" 不变（两个 collection 各有独立命名空间，不冲突）。
  "current-file": null as string | null,      // 上次打开的文档名（非 null → boot 自动 open）（Cold，**device-local**）
  "blender-panel-url": "" as string,          // Blender 同步远端 URL（2026-07-14 决策：全账号同步，tailscale 稳定端点）（Cold）
  // 设备本地（local-app-state）：**当前为空**。
  //   v407 曾放过 "last-session-signed-in"（"控静默重认证"），但它零 consumer——只写不读，
  //   而真正的判定走 `!isSignedIn()`（app.ts 的 retrySilentSignIn）。v409 删：登录态的 SSoT 是
  //   auth provider（MSAL 自己的 localStorage cache），不该在这再存一份会漂移的影子。
  //   要加设备级字段时才往这写，别为"以后可能用得上"占位。
} as const;
export type AppStateKey = keyof typeof APP_STATE_DEFAULTS;

// ── collection 注入 + boot 门 ────────────────────────────────────────────────────────────
let _synced: Collection | undefined;
let _local: Collection | undefined;

// app-store 唯一调：接入 synced-app-state / local-app-state（后者走 {local:true}）。
export function wireAppState(synced: Collection, local: Collection): void { _synced = synced; _local = local; }
// boot 门：hydrate 两个 collection（各自 init 内部先 hydrate 本地再后台对齐云端）。快、离线 OK。
export function initAppState(): Promise<void> {
  return Promise.all([_synced?.init() ?? Promise.resolve(), _local?.init() ?? Promise.resolve()])
    .then(() => { _seedCurrentFileFromLegacy(); });
}

// current-file 从 synced 迁到 local 的**幂等播种**（v438）。
//   · 本地已有值（含用户显式清空）→ 一律不覆盖，所以重复跑无副作用。
//   · **不删**云端那个旧键：删跨设备数据的风险高于留一个死键；老版本的其它设备可能还在读它。
//     它从此只写不读地躺着，等所有设备都升上来之后再单独清理（那是另一次改动，要另外拍板）。
function _seedCurrentFileFromLegacy(): void {
  if (!_local || !_synced) return;
  if (_local.getEntry("current-file") !== undefined) return;      // 本地已有 → 不动
  const legacy = _synced.getItem<string | null>("current-file", null);
  if (legacy != null) _local.setItem("current-file", legacy);     // 只在有旧值时播种一次
}
// 导航前屏障（v417）：冷字段 setter 只改内存 + 排 400ms 防抖写（collection.ts:169-172）。
//   页面被关/reload 时定时器随页面死 → currentFile 等于没写 → 下次冷启动开不回上次那张画。
//   app.ts 在 pagehide / visibilitychange:hidden 调（那两个是移动端唯一可靠的"要走了"信号）。
export function flushAppState(): Promise<void> {
  return Promise.all([_synced?.flushLocal() ?? Promise.resolve(), _local?.flushLocal() ?? Promise.resolve()]).then(() => undefined);
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
  // **local**（v438 从 synced 迁出，见 APP_STATE_DEFAULTS 处的长注释）
  get currentFile(): string | null { return getC<string | null>(_local, "current-file"); },
  set currentFile(v: string | null) { setC(_local, "current-file", v); },
  get blenderPanelUrl(): string { return getC<string>(_synced, "blender-panel-url"); },
  set blenderPanelUrl(v: string) { setC(_synced, "blender-panel-url", v); },
  // ── 设备本地（local-app-state）冷字段：当前无（见 APP_STATE_DEFAULTS 注）──

  // ── 序列化持久化相关（除字段外仅此二法，无应用逻辑）──
  // 热变量写 collection。本轮无热字段：冷字段 setter 已直写 collection → no-op。
  pushHotToPersistent(): void { /* 无热字段 */ },
  // await 云端对齐后，热变量用云值覆盖。冷字段 getter 本就直读最新 collection，无需覆盖——只 await 对齐。
  async pullFromPersistent(): Promise<void> {
    await Promise.all([_synced?.reconcileWithRemote() ?? Promise.resolve(), _local?.reconcileWithRemote() ?? Promise.resolve()]);
  },
};
