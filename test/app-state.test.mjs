// app-state struct 门面：冷字段直读写 collection（不落 RAM）+ 默认 + 类型强制 + push/pull。
import { test, eq, assert } from "./runner.mjs";
import { createStore } from "../src/store/create-store.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { wireAppState, initAppState, appState } from "../src/app-state.ts";

const dumpKv = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} };
const mkStore = () => createStore({ appId: "wp", provider: createMockProvider(), ui: UI, validateAdopt: () => true, kv: dumpKv(), local: createMockLocal(), fileName: (n) => n, isOnline: () => true, signedIn: () => true, skipMigration: true });

test("[app-state] struct 冷字段直读写 collection（不落 RAM）+ 默认 + 类型强制", async () => {
  const store = mkStore();
  const synced = store.collection("synced-app-state");
  const local = store.collection("local-app-state", { local: true });
  wireAppState(synced, local);
  await initAppState();

  // 默认（DEFAULTS SSoT）
  eq(appState.currentDirectory, "", "默认 current-directory=空串");
  eq(appState.currentFile, null, "默认 current-file=null");
  eq(appState.blenderPanelUrl, "", "默认 blenderPanelUrl=空串");

  // set/get 往返
  appState.currentDirectory = "folder/a";
  eq(appState.currentDirectory, "folder/a", "current-directory 往返");
  appState.currentFile = "x.ora";
  eq(appState.currentFile, "x.ora", "current-file 往返");
  appState.blenderPanelUrl = "http://ts.local:9999";
  eq(appState.blenderPanelUrl, "http://ts.local:9999", "blenderPanelUrl（synced）往返");

  // 冷字段直写 collection（不落 app-state RAM）：直读底层 collection 应见同值
  eq(synced.getItem("current-directory", "?"), "folder/a", "直写落 synced collection（无 RAM 缓存）");
  eq(appState.blenderPanelUrl === synced.getItem("blender-panel-url", "?"), true, "blenderPanelUrl 落 synced-app-state（非 local）");

  // ★ v438：current-file 迁到 **local**（它是「这台设备此刻打开着哪张画」，没有合并语义）。
  //   放 synced 里有真数据安全后果：store 拿它当 cloud-gone 防抖守卫，而 LWW 会让
  //   设备 B 打开的画翻掉设备 A 的守卫 → A 不再保护自己真正打开的那张。
  eq(local.getItem("current-file", "?"), "x.ora", "current-file 落 local-app-state");
  eq(synced.getItem("current-file", "MISSING"), "MISSING", "★ 不再写进 synced（跨设备不互相翻）");

  // local-app-state 从此有且仅有 current-file（v409 的「回归空」被 v438 有意打破，理由见上）。
  eq(local.keys().join(","), "current-file", "local-app-state 只有 current-file");
  eq(typeof appState.lastSessionSignedIn, "undefined", "lastSessionSignedIn 已删");

  // 除字段外仅两方法：pushHot no-op、pullFrom 不抛
  appState.pushHotToPersistent();
  await appState.pullFromPersistent();
  eq(appState.currentDirectory, "folder/a", "pull 后冷字段仍直读 collection 最新值");
});
