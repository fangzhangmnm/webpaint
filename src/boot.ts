// boot.ts —— 应用启动编排（startup sequencing）。
//
// 从组合根 app.js 下沉的两段「业务式」异步启动流程（survey rec #3「让根只剩 import + new + initAll」）。
// 都是 fire-and-forget（不阻塞 UI 首帧），从冻结的 ctx 取依赖；纯 helper 自己 import。
//
// 红线：store 调用（_store.flow.load）verbatim 搬迁、一字未改——只 relocate，不碰同步机制。

import { t } from "./i18n/index.ts";
import { reportError } from "./error-badge.ts";
import { session } from "./session-state.ts";
import { getCurrentSessionName } from "./session.ts";
import { restoreLastSession } from "./boot-restore.ts";
import type { AppContext } from "./app-context.ts";

// 笔架 boot：collection.init（本地缓存 hydrate → 后台 reconcile 云端 + 新库 seed）→
//   toolStates 缺失字段从 rack 补齐 → 应用当前 tool 的 state。云端 pull 由 collection.onChange
//   自动刷（controller 内订阅）；不再有 IDB 迁移 / defaults retro-merge / 云图标态机。
export function initRackBoot(ctx: AppContext) {
  const { rack, state, editMode, setStatus } = ctx;
  const backfillToolStates = () => {
    for (const tk of Object.keys(state.toolStates)) {
      if (state.toolStates[tk].activeBrushId == null) Object.assign(state.toolStates[tk], rack.defaultToolStateFor(tk));
    }
  };
  rack.load().then(() => {
    backfillToolStates();
    rack.applyToolState(editMode.current());
  }).catch((e: unknown) => {
    reportError(new Error("[brush-rack] init failed: " + String(e)), "log");
    setStatus(t("mi.rackPersistFailed"), true);
  });
}

// Gallery-first 启动：尝试加载上次的 session（异步，不阻塞 UI 显示）。
//   1) 无上次 session 名 → 停 gallery
//   2) 有 → load → 成功 adopt + 进画布；失败 → 停 gallery
//   3) **失败保留 currentFile 不清**（用户下次冷启动还能 retry）—— 见下面 `{ persist: false }`。
// ⚠ 调用方必须先 `await prefsReady`（app.ts）：currentFile 在 collection hydrate 前恒为 null，
//   早调 = 永远落图库、不再自动开上次的画。
export async function bootRestoreSession(ctx: AppContext) {
  const { setGalleryOpen, updateSaveStatus, setStatus } = ctx;
  // 编排本身在 boot-restore.ts（零 app 依赖 → 可测）。这里只接线。
  await restoreLastSession({
    getWantedName: getCurrentSessionName,
    restore: (name) => session.restore(name),
    setNameMemoryOnly: (name) => session.setName(name, { persist: false }),   // 幽灵路径纪律：不动持久的 currentFile
    openGallery: async () => { await setGalleryOpen(true); },
    updateSaveStatus,
    onOpened: (name) => setStatus(t("ss.opened", { name })),
    onNotFound: (name) => setStatus(t("mi.lastNotFound", { name })),
  });
}
