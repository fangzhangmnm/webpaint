// 职责（单一）：两个 app-state collection（跨设备 / 设备本地）的**注入点 + DEFAULTS SSoT**。
//
// app-state = **跨文件持久态**（非 per-document、非 user-preference）：当前目录、当前文件、设备级集成端点 …
//   与 app-prefs 同构（注入点 + 直读面 + DEFAULTS），刻意不 import app-store（防成环，见 app-prefs 头注）。
//
// 现阶段字段少、非热路径 → 直读面即可。**下一轮**当窗口坐标等 innermost-loop 高频字段搬进来时，
//   本模块升级成「自持内存 struct + 自定义序列化 + 显式 upload()/refresh()」的热路径 hub（见设计文档）。
import type { Collection } from "./store/index.ts";

// ── DEFAULTS SSoT（唯一处）─────────────────────────────────────────────────────────────
export const APP_STATE_DEFAULTS = {
  // 跨设备（synced-app-state）：跟人的跨文件持久态
  "current-directory": "" as string,         // 上次所在图库文件夹
  "current-file": null as string | null,     // 上次打开的文档名（非 null → boot 自动 open）
  // 设备本地（local-app-state）：跟设备的持久态
  "blender-remote-url": "" as string,        // Blender 同步远端 URL（localhost/tailscale=设备级 endpoint，绝不跨设备）
  "last-session-signed-in": false as boolean, // 上次是否登录（控静默重认证；设备级 auth flag）
} as const;
export type AppStateKey = keyof typeof APP_STATE_DEFAULTS;

let _synced: Collection | undefined;
let _local: Collection | undefined;

// app-store 唯一调：接入 synced-app-state / local-app-state（后者走 {local:true}）。
export function wireAppState(synced: Collection, local: Collection): void { _synced = synced; _local = local; }
export function initAppState(): Promise<void> {
  return Promise.all([_synced?.init() ?? Promise.resolve(), _local?.init() ?? Promise.resolve()]).then(() => undefined);
}
export function refreshAppState(): Promise<void> {
  return Promise.all([_synced?.refresh() ?? Promise.resolve(), _local?.refresh() ?? Promise.resolve()]).then(() => undefined);
}

function face(get: () => Collection | undefined) {
  return {
    getItem<V = unknown>(id: AppStateKey, def: V): V { const c = get(); return c ? c.getItem<V>(id, def) as V : def; },
    setItem(id: AppStateKey, value: unknown): void { get()?.setItem(id, value); },
    onChange(cb: (changedIds: string[]) => void): () => void { return get()?.onChange(cb) ?? (() => undefined); },
  };
}
// 跨设备 app 态（current-directory / current-file）。
export const syncedAppState = face(() => _synced);
// 设备本地 app 态（blender-remote-url / last-session-signed-in）。
export const localAppState = face(() => _local);
