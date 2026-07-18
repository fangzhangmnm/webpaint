// 职责（单一）：两个 user-preference collection（设备本地 / 跨设备）的**注入点 + DEFAULTS SSoT**。
//
// preference = 冷路径：app 各处**直读** collection——`syncedUserPreference.getItem("lang", PREF_DEFAULTS.lang)`。
//   collection 托底内存镜像（同步读写、防抖持久化、init 后台对齐云端）。不写第二份数据结构、无中央 registry，靠 grep。
//
// ⚠**刻意不 import app-store**：lang/theme 被极多 leaf 与 node 测在**模块 eval 期**读（i18n 的 t()、theme），
//   若拖进 app-store 就把整个 store/crypto/msal 栈塞进每个用 t() 的模块 + i18n↔store-ui 成环。
//   故 collection 由 app-store 建好 store 后**惰性注入**（wirePreferences）；注入前读返 DEFAULTS（boot 安全）。
//   boot：`initPreferences()` 返 promise（内部先 hydrate 本地、快、离线 OK），app.ts 存成 `prefsReady`。
//   v409 起**不再是 TLA 门**：lang/theme 走 localStorage boot 快照（src/boot-snapshot.ts）解决 eval 期/pre-paint,
//   其余消费方各自 await prefsReady（app.ts 的 fixup 相）。（历史注释说的 "dynamic import app-main" 那个模块从未存在。）
import type { Collection } from "./store/index.ts";

// ── DEFAULTS SSoT（唯一处；getItem 缺省从这里取，别处不 inline）───────────────────────────
export const PREF_DEFAULTS = {
  // 设备本地（local-user-preference）：跟设备环境/硬件走
  "color-theme": "auto" as string,          // auto / day / night（主题 = 跟设备的日夜/环境）
  // 跨设备（synced-user-preference）：跟人/identity 走
  "lang": null as string | null,            // 界面语言（null=跟系统）
  "long-press-pick": true as boolean,       // 长按吸色手势（spec 表默认 true）
  "single-finger-draw": false as boolean,   // 单指作画（默认关——保证不拦鼠标/误触）
  "show-fps": false as boolean,             // FPS 计叠层
  "pixel-grid": true as boolean,            // 像素栅格叠层
  "stylus-smooth-params": {} as Record<string, number>,   // 手写笔平滑调参（hidden debug；对象存 SMOOTH 覆盖，默认{}=全用 SMOOTH_DEFAULTS）
} as const;
export type PrefKey = keyof typeof PREF_DEFAULTS;

// ── collection 注入 + 直读面 ────────────────────────────────────────────────────────────
let _local: Collection | undefined;
let _synced: Collection | undefined;

// app-store 唯一调：建好 store 后把两个 collection 接进来（local-user-preference 走 {local:true}）。
export function wirePreferences(local: Collection, synced: Collection): void { _local = local; _synced = synced; }

// boot 门：hydrate 两个 collection（各自 init 内部先 hydrate 本地再后台对齐云端）。快、离线 OK。
//   **memoized**：init() 不可重入（seedInit / ready 翻转），而 preferencesReady() 需要同一个 promise。
let _ready: Promise<void> | undefined;
export function initPreferences(): Promise<void> {
  return (_ready ??= Promise.all([_local?.init() ?? Promise.resolve(), _synced?.init() ?? Promise.resolve()]).then(() => undefined));
}
// 冷路径写入方（setLang 等）用：collection 未 hydrate 时 setItem 会抛（collection.ts:253），
//   而设置菜单一 boot 就可点。await 这个再写。未 init（测试/极早）→ 立即 resolve，setItem 照常抛（是想要的）。
export function preferencesReady(): Promise<void> { return _ready ?? Promise.resolve(); }
// 导航前屏障（v417）：两个 preference collection 的内存 env 立即落本地缓存。
//   见下面 face().flushLocal 的注释——凡"写完就走"的路径都得先过这一关。
export function flushPreferences(): Promise<void> {
  return Promise.all([_local?.flushLocal() ?? Promise.resolve(), _synced?.flushLocal() ?? Promise.resolve()]).then(() => undefined);
}
// 事件驱动（focus/visible/online）重拉云端 + resolve（per-key LWW）。app 在既有 foreground/online 钩子调。
export function refreshPreferences(): Promise<void> {
  return Promise.all([_local?.reconcileWithRemote() ?? Promise.resolve(), _synced?.reconcileWithRemote() ?? Promise.resolve()]).then(() => undefined);
}

// 直读面：未注入前（boot 极早/测试）安全返 default / no-op。
function face(get: () => Collection | undefined) {
  return {
    getItem<V = unknown>(id: PrefKey, def: V): V { const c = get(); return c ? c.getItem<V>(id, def) as V : def; },
    setItem(id: PrefKey, value: unknown): void { get()?.setItem(id, value); },
    onChange(cb: (changedIds: string[]) => void): () => void { return get()?.onChange(cb) ?? (() => undefined); },
    // 导航前屏障：setItem 只改内存 + 排 400ms 防抖写（collection.ts:169-172）。
    //   凡"写完就 reload / 就关页"的调用方**必须** await 这个，否则定时器随页面一起死、字节从没进 IDB。
    //   （v417：语言切换无效的根因就是这个——setLang 写完立刻 location.reload()。theme 不 reload 所以没事。）
    flushLocal(): Promise<void> { return get()?.flushLocal() ?? Promise.resolve(); },
  };
}
// 设备本地偏好（color-theme）。
export const localUserPreference = face(() => _local);
// 跨设备偏好（lang / 手势 / fps / pixel-grid）。
export const syncedUserPreference = face(() => _synced);
