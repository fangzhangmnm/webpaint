// 职责（单一）：settings 路由的**纯逻辑核**（无 store/DOM 依赖，可 node 测）。
//   一处注册表 SETTINGS 声明每个设置的 scope（local=设备本地 / synced=跨设备跟人）+ default + 旧键迁移。
//   路由：local → store.localSettings；synced → store.localSettings 镜像（同步可读、boot 安全）+ store.syncedSettings（跨设备权威）。
//
// 为什么 synced 也写 localSettings 镜像：theme/lang 在**模块 eval 期**就被读（brush-rack 等模块常量里 t() 已跑），
//   早于 store.syncedSettings.init()（异步拉云）。镜像 = 本设备「上次见到的值」，localStorage 同步秒读；
//   init 后把云端值折回镜像 + 通知（theme 重贴 / lang 下次 boot 生效）。跨设备权威仍是 syncedSettings。
//
// default 是唯一 SSoT（store 的 get 不给 default，见 store/settings.ts）。旧散键由 legacy() 读时兜底迁移（首次 get 落进新后端）。
// 详见 docs/20260713-settings-module.md。

// 注入后端（settings.ts 接真 store；测试注入 mock）。
export interface KvLike {
  get<V = unknown>(key: string): V | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
export interface SyncedLike extends KvLike {
  init(): Promise<void>;
  flush(): Promise<void>;
}
export interface LegacyLS { get(key: string): string | null; }

export interface SettingsBackends {
  local: KvLike;             // store.localSettings（同步 localStorage kv）
  synced?: SyncedLike;       // store.syncedSettings（跨设备；未配置 syncedSettingsFileName 则 undefined）
  ls: LegacyLS;              // 旧散键读取（safe-ls）——一次性迁移兜底
}

type Scope = "local" | "synced";
export interface SettingSpec {
  scope: Scope;
  def: unknown;
  // 旧 localStorage 值 → 新值（首次 get 兜底迁移）。返回 undefined = 无旧值。
  legacy?: (ls: LegacyLS) => unknown;
}

// 旧 webpaint.synced blob（syncable-prefs）里取 theme/lang。
function fromSyncedBlob(ls: LegacyLS, k: "theme" | "lang"): unknown {
  try { const o = JSON.parse(ls.get("webpaint.synced") || "{}"); return o?.[k]; } catch { return undefined; }
}
const bool01 = (ls: LegacyLS, key: string, onIfMissing: boolean): boolean | undefined => {
  const v = ls.get(key);
  if (v == null) return undefined;
  return onIfMissing ? v !== "0" : v === "1";
};
const num = (ls: LegacyLS, key: string): number | undefined => {
  const v = ls.get(key); if (v == null) return undefined;
  const n = parseFloat(v); return Number.isFinite(n) ? n : undefined;
};
const str = (ls: LegacyLS, key: string): string | undefined => ls.get(key) ?? undefined;
const json = (ls: LegacyLS, key: string): unknown => {
  const v = ls.get(key); if (v == null) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
};

// ── 注册表：所有设置在此声明 scope + default + 旧键迁移。加设置 = 加一条 ─────────────────
export const SETTINGS = {
  // 设备本地：手感/视图开关（跟设备不跟人）
  pressureToSize:    { scope: "local", def: true,        legacy: (ls) => bool01(ls, "webpaint.pToSize", true) },
  pressureToOpacity: { scope: "local", def: true,        legacy: (ls) => bool01(ls, "webpaint.pToOpacity", true) },
  longPressPick:     { scope: "local", def: false,       legacy: (ls) => bool01(ls, "webpaint.longPressPick", false) },
  singleFingerDraw:  { scope: "local", def: false,       legacy: (ls) => bool01(ls, "webpaint.singleFingerDraw", false) },
  pixelGrid:         { scope: "local", def: true,        legacy: (ls) => bool01(ls, "webpaint.pixelGrid", true) },
  fps:               { scope: "local", def: false,       legacy: (ls) => bool01(ls, "webpaint.fps", false) },
  pickMode:          { scope: "local", def: "composite", legacy: (ls) => str(ls, "webpaint.pickMode") },
  // 设备本地：上次用的 dial（记住粗细/透/色）
  lastSize:          { scope: "local", def: 12,          legacy: (ls) => num(ls, "webpaint.size") },
  lastOpacity:       { scope: "local", def: 1,           legacy: (ls) => num(ls, "webpaint.opacity") },
  lastColor:         { scope: "local", def: "#1b1b1b",   legacy: (ls) => str(ls, "webpaint.color") },
  // 设备本地：面板位置 / 图库上次夹（JSON / 字符串）
  colorPanelPos:     { scope: "local", def: null,        legacy: (ls) => json(ls, "webpaint.colorPanel.pos") },
  layersPanelPos:    { scope: "local", def: null,        legacy: (ls) => json(ls, "webpaint.layersPanel.pos") },
  galleryFolder:     { scope: "local", def: "",          legacy: (ls) => str(ls, "webpaint.galleryFolder") },
  // 设备本地：导出/导入格式记忆（JSON blob）
  exportProject:     { scope: "local", def: null,        legacy: (ls) => json(ls, "webpaint:exportProject:v1") },
  exportImage:       { scope: "local", def: null,        legacy: (ls) => json(ls, "webpaint:exportImage:v1") },
  importImage:       { scope: "local", def: null,        legacy: (ls) => json(ls, "webpaint:importImage:v1") },
  // 跨设备：跟人走的内容型偏好
  theme:             { scope: "synced", def: "auto",     legacy: (ls) => fromSyncedBlob(ls, "theme") ?? str(ls, "webpaint.theme") },
  lang:              { scope: "synced", def: null,       legacy: (ls) => fromSyncedBlob(ls, "lang") ?? str(ls, "webpaint.lang") },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

export interface Settings {
  get<V = unknown>(key: SettingKey): V;
  set(key: SettingKey, value: unknown): void;
  delete(key: SettingKey): void;
  // 拉 syncedSettings（init 后）→ 折回 local 镜像；返回值有变的 synced key（caller 据此重贴 theme 等）。
  initSynced(): Promise<SettingKey[]>;
  flushSynced(): Promise<void>;
}

export function createSettings(be: SettingsBackends): Settings {
  const spec = (key: SettingKey): SettingSpec => SETTINGS[key] as SettingSpec;

  function get<V = unknown>(key: SettingKey): V {
    const s = spec(key);
    let v = be.local.get(key);              // 镜像/本地值（synced 与 local 都从这里同步读，boot 安全）
    if (v === undefined && s.legacy) {      // 首次：旧散键兜底迁移 → 落进新后端
      const lv = s.legacy(be.ls);
      if (lv !== undefined && lv !== null) { be.local.set(key, lv); if (s.scope === "synced") be.synced?.set(key, lv); v = lv; }
    }
    return (v === undefined ? s.def : v) as V;
  }

  function set(key: SettingKey, value: unknown): void {
    be.local.set(key, value);                            // 本地镜像（同步秒读）
    if (spec(key).scope === "synced") be.synced?.set(key, value);   // 跨设备权威
  }

  function del(key: SettingKey): void {
    be.local.delete(key);
    if (spec(key).scope === "synced") be.synced?.delete(key);
  }

  async function initSynced(): Promise<SettingKey[]> {
    if (!be.synced) return [];
    await be.synced.init();
    const changed: SettingKey[] = [];
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      if (spec(key).scope !== "synced") continue;
      const cloud = be.synced.get(key);
      if (cloud === undefined) continue;                 // 云端没这项 → 保留本地镜像
      const local = be.local.get(key);
      if (JSON.stringify(cloud) !== JSON.stringify(local)) { be.local.set(key, cloud); changed.push(key); }
    }
    return changed;
  }

  async function flushSynced(): Promise<void> { await be.synced?.flush(); }

  return { get, set, delete: del, initSynced, flushSynced };
}
