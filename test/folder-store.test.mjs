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
