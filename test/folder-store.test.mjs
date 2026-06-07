// Folder Store facade 验收（L4 ③a）：status 态机（含 busy）+ dirty 透传。
import { describe, it, eq } from "./runner.mjs";
import { createFolderStore } from "../src/store/folder-store.js";

function mkCloud(dirty = false) {
  let d = dirty;
  return { isDirty: () => d, setDirty: (_name, v) => { d = !!v; } };   // 忽略 name（单 blob）
}

describe("folder-store · status 态机（busy > no-auth > offline > dirty > synced）", () => {
  it("优先级正确", () => {
    const s = createFolderStore({ cloud: mkCloud(false), name: "rack" });
    eq(s.status({ signedIn: true, online: true }), "synced");
    s.setDirty(true);
    eq(s.status({ signedIn: true, online: true }), "dirty");
    eq(s.status({ signedIn: true, online: false }), "offline");   // offline 盖 dirty
    eq(s.status({ signedIn: false, online: true }), "no-auth");   // no-auth 盖 dirty
    s.busy.set(true);
    eq(s.status({ signedIn: false, online: false }), "busy");     // busy 盖一切
    s.busy.set(false);
    eq(s.status({ signedIn: true, online: true }), "dirty");      // 清 busy → 回 dirty
  });
});

describe("folder-store · dirty 透传注入的 cloud", () => {
  it("setDirty/isDirty 走 cloud", () => {
    const s = createFolderStore({ cloud: mkCloud(false), name: "rack" });
    eq(s.isDirty(), false);
    s.setDirty(true);
    eq(s.isDirty(), true);
    s.setDirty(false);
    eq(s.isDirty(), false);
  });
});

function mkFlow() {
  const calls = [];
  return { calls, sync: async (folder) => { calls.push(folder); return { status: "synced", folder: { ...folder } }; } };
}

describe("folder-store · sync/flush/edit cadence（③b）", () => {
  it("sync：canSync 门 + snapshot + flow.sync + onResult；busy 自管 on→off", async () => {
    const flow = mkFlow(); let result = null; const busyLog = [];
    const s = createFolderStore({ cloud: mkCloud(), name: "rack", flow });
    s.configure({
      snapshot: () => ({ version: 2, items: [{ id: "a", uat: 1 }], trash: [], resetAt: 0 }),
      onResult: async (r) => { result = r; },
      canSync: () => true,
      onBusyChange: () => busyLog.push(s.busy.syncing()),
    });
    const res = await s.sync();
    eq(res.status, "synced");
    eq(flow.calls.length, 1);
    eq(result.status, "synced");
    eq(JSON.stringify(busyLog), JSON.stringify([true, false]));   // busy on→off，各刷一次 UI
  });
  it("sync：canSync false → skipped，不碰 flow", async () => {
    const flow = mkFlow();
    const s = createFolderStore({ cloud: mkCloud(), name: "rack", flow });
    s.configure({ snapshot: () => ({ version: 2, items: [], trash: [], resetAt: 0 }), canSync: () => false });
    eq((await s.sync()).status, "skipped");
    eq(flow.calls.length, 0);
  });
  it("flush：clean 不同步；dirty 同步", async () => {
    const flow = mkFlow();
    const s = createFolderStore({ cloud: mkCloud(), name: "rack", flow });
    s.configure({ snapshot: () => ({ version: 2, items: [], trash: [], resetAt: 0 }), canSync: () => true });
    await s.flush();
    eq(flow.calls.length, 0, "clean flush 不同步");
    s.setDirty(true);
    await s.flush();
    eq(flow.calls.length, 1, "dirty flush 同步");
  });
  it("edit：标脏 + 防抖后自动同步", async () => {
    const flow = mkFlow();
    const s = createFolderStore({ cloud: mkCloud(), name: "rack", flow, syncDelayMs: 1 });
    s.configure({ snapshot: () => ({ version: 2, items: [], trash: [], resetAt: 0 }), canSync: () => true });
    s.edit();
    eq(s.isDirty(), true, "edit 立即标脏");
    await new Promise((r) => setTimeout(r, 12));
    eq(flow.calls.length, 1, "防抖窗后自动同步一次");
  });
});
