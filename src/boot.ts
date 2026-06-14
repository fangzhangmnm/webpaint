// boot.ts —— 应用启动编排（startup sequencing）。
//
// 从组合根 app.js 下沉的两段「业务式」异步启动流程（survey rec #3「让根只剩 import + new + initAll」）。
// 都是 fire-and-forget（不阻塞 UI 首帧），从冻结的 ctx 取依赖；纯 helper 自己 import。
//
// 红线：store 调用（_store.flow.load）verbatim 搬迁、一字未改——只 relocate，不碰同步机制。

import { defaultsPromise, mergeMissingDefaults, makeDefaultRack } from "./brushes.js";
import { session } from "./session-state.ts";
import { getCurrentSessionName } from "./session.js";
import { ensureUnlocked } from "./enc-thumbs.js";
import { decodeOraToDoc } from "./ora.js";

// 笔架 boot：异步加载 IDB 缓存 → toolStates 缺失字段从 rack 补齐 → 应用当前 tool 的 state。
// default-brushes.json 是 async fetch：回来后 retroactively merge 缺失默认笔。
export function initRackBoot(ctx: any) {
  const { rack, state, editMode, dialReactive, setStatus } = ctx;
  const backfillToolStates = () => {
    for (const t of Object.keys(state.toolStates)) {
      if (state.toolStates[t].activeBrushId == null) Object.assign(state.toolStates[t], rack.defaultToolStateFor(t));
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
      const merged = mergeMissingDefaults(cur);
      if (!merged) return;
      rack.setRack(merged);
      rack.persist().catch(() => {});
      backfillToolStates();
      rack.applyToolState(editMode.current());
      dialReactive.rackVersion++;
    });
  }).catch((e: any) => {
    console.warn("[brush-rack] init failed:", e);
    rack.setRack(makeDefaultRack());
    rack.applyToolState(editMode.current());
    dialReactive.rackVersion++;
    setStatus("笔架持久化失败（可能私密浏览）：本次 session 可用，重启会重置", true);
  });
}

// Gallery-first 启动：尝试加载上次的 session（异步，不阻塞 UI 显示）。
//   1) 无上次 session 名 → 停 gallery
//   2) 有 → load → 成功 adopt + 进画布；失败 → 停 gallery
//   3) 失败保留 currentSessionName 不清（用户下次冷启动还能 retry）
export async function bootRestoreSession(ctx: any) {
  const { store: _store, setGalleryOpen, updateSaveStatus, setStatus, gateCloudSyncOnOpen } = ctx;
  const wantedName = getCurrentSessionName();
  if (!wantedName) {
    session.setName(null);
    updateSaveStatus();
    await setGalleryOpen(true);
    return;
  }
  try {
    // boot load 走 store.flow.load（明文原样；加密容器需先解锁）。boot 不在 busy → 可弹密码框。
    let r = await _store.flow.load(wantedName);
    if (r.status === "locked") {
      if (await ensureUnlocked(wantedName)) r = await _store.flow.load(wantedName);
    }
    if (r.status !== "loaded") {
      // IDB 没了 / 加密未解锁（取消）→ 停 gallery
      session.setName(null);
      updateSaveStatus();
      await setGalleryOpen(true);
      setStatus(r.status === "locked"
        ? `「${wantedName}」是加密作品（已取消解锁）——从图库再打开`
        : `找不到上次画作 "${wantedName}"，先选一个或新建`);
      return;
    }
    const loaded = await decodeOraToDoc(r.blob);
    session.adopt(loaded, wantedName);
    setStatus(`已恢复：${wantedName} (${loaded.layers.length} 层)`);
    gateCloudSyncOnOpen(wantedName).catch((e: any) => console.warn("[sync-gate]", e));
  } catch (e: any) {
    console.warn("[session] load failed:", e);
    session.setName(null);
    updateSaveStatus();
    await setGalleryOpen(true);
    setStatus(`启动加载 "${wantedName}" 失败：${e && e.message || e}`, true);
  }
}
