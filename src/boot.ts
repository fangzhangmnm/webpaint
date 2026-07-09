// boot.ts —— 应用启动编排（startup sequencing）。
//
// 从组合根 app.js 下沉的两段「业务式」异步启动流程（survey rec #3「让根只剩 import + new + initAll」）。
// 都是 fire-and-forget（不阻塞 UI 首帧），从冻结的 ctx 取依赖；纯 helper 自己 import。
//
// 红线：store 调用（_store.flow.load）verbatim 搬迁、一字未改——只 relocate，不碰同步机制。

import { t } from "./i18n/index.ts";
import { defaultsPromise, mergeMissingDefaults, makeDefaultRack } from "./brushes.ts";
import { session } from "./session-state.ts";
import { getCurrentSessionName } from "./session.ts";
import type { AppContext } from "./app-context.ts";

// 笔架 boot：异步加载 IDB 缓存 → toolStates 缺失字段从 rack 补齐 → 应用当前 tool 的 state。
// default-brushes.json 是 async fetch：回来后 retroactively merge 缺失默认笔。
export function initRackBoot(ctx: AppContext) {
  const { rack, state, editMode, dialReactive, setStatus } = ctx;
  const backfillToolStates = () => {
    for (const tk of Object.keys(state.toolStates)) {
      if (state.toolStates[tk].activeBrushId == null) Object.assign(state.toolStates[tk], rack.defaultToolStateFor(tk));
    }
  };
  rack.load().then(() => {
    backfillToolStates();
    rack.applyToolState(editMode.current());
    dialReactive.rackVersion++;
    setTimeout(() => { rack.checkCloud().catch(() => {}); rack.refreshCloudState(); }, 2000);
    defaultsPromise().then(() => {
      const cur = rack.get();
      if (!cur) return;
      const merged = mergeMissingDefaults(cur as Parameters<typeof mergeMissingDefaults>[0]);
      if (!merged) return;
      rack.setRack(merged);
      rack.persist().catch(() => {});
      backfillToolStates();
      rack.applyToolState(editMode.current());
      dialReactive.rackVersion++;
    });
  }).catch((e: unknown) => {
    console.warn("[brush-rack] init failed:", e);
    rack.setRack(makeDefaultRack());
    rack.applyToolState(editMode.current());
    dialReactive.rackVersion++;
    setStatus(t("mi.rackPersistFailed"), true);
  });
}

// Gallery-first 启动：尝试加载上次的 session（异步，不阻塞 UI 显示）。
//   1) 无上次 session 名 → 停 gallery
//   2) 有 → load → 成功 adopt + 进画布；失败 → 停 gallery
//   3) 失败保留 currentSessionName 不清（用户下次冷启动还能 retry）
export async function bootRestoreSession(ctx: AppContext) {
  const { setGalleryOpen, updateSaveStatus, setStatus } = ctx;
  const wantedName = getCurrentSessionName();
  if (!wantedName) { session.setName(null); updateSaveStatus(); await setGalleryOpen(true); return; }
  // session.restore：es.open（store.file.open 内含本地/云端 + freshness + unseal）+ 设活动。失败=文件缺失/取消解锁。
  const ok = await session.restore(wantedName);
  if (ok) { setStatus(t("ss.opened", { name: wantedName })); return; }
  session.setName(null);
  updateSaveStatus();
  await setGalleryOpen(true);
  setStatus(t("mi.lastNotFound", { name: wantedName }));
}
