// FolderFlow 同步循环验收（mock cloud，桌面可测）：
//   offline / 伪在线(decode→null) / 首推 / 拉-合-推 / 跳推(本地无新) / 412 重试收敛。
import { describe, it, assert, eq } from "./runner.mjs";
import { createFolderFlow } from "../src/store/folder-flow.ts";
import { emptyFolder, normalizeFolder } from "../src/store/folder-merge.ts";

const blobOf = (s) => ({ text: async () => s });
const J = (f) => JSON.stringify(f);
const encode = (f) => blobOf(J(f));
// decode：合法 envelope（有 items 数组）才返；否则 null（伪在线防线）。
const decode = (t) => { try { const o = JSON.parse(t); return Array.isArray(o.items) ? o : null; } catch { return null; } };

function mockCloud({ text = null, etag = null } = {}) {
  let stored = text, et = etag, n = 0, pull412 = false, throwPull = false;
  return {
    pulls: 0, pushes: 0,
    pull: async function () { this.pulls++; if (throwPull) throw new Error("net"); return stored == null ? null : { blob: blobOf(stored), item: { eTag: et } }; },
    push: async function (name, blob, { baseEtag } = {}) {
      this.pushes++;
      if (pull412) { pull412 = false; throw Object.assign(new Error("412"), { name: "CloudConflictError" }); }
      stored = await blob.text(); et = "e" + (++n); return { item: { eTag: et } };
    },
    _stored: () => stored,
    _trigger412: () => { pull412 = true; },
    _setThrow: (v) => { throwPull = v; },
    _set: (t, e) => { stored = t; et = e; },
  };
}
const folder = (items, extra = {}) => ({ version: 1, items, trash: [], resetAt: 0, ...extra });
const it1 = (id, uat) => ({ id, uat, name: id });

describe("FolderFlow.sync", () => {
  it("offline（isOnline=false）→ 不碰云、留本地", async () => {
    const cloud = mockCloud();
    const ff = createFolderFlow({ cloud, name: "r", encode, decode, isOnline: () => false });
    const r = await ff.sync(folder([it1("a", 5)]));
    eq(r.status, "offline");
    eq(cloud.pulls, 0); eq(cloud.pushes, 0);
  });

  it("pull 抛错（离线/慢网）→ offline，本地不丢", async () => {
    const cloud = mockCloud(); cloud._setThrow(true);
    const ff = createFolderFlow({ cloud, name: "r", encode, decode, timeoutMs: 0 });
    const r = await ff.sync(folder([it1("a", 5)]));
    eq(r.status, "offline");
    eq(r.folder.items.length, 1);
  });

  it("伪在线：云端返非法字节（HTML）→ invalid，绝不 merge/push", async () => {
    const cloud = mockCloud({ text: "<html>login</html>", etag: "x" });
    const ff = createFolderFlow({ cloud, name: "r", encode, decode });
    const r = await ff.sync(folder([it1("a", 5)]));
    eq(r.status, "invalid");
    eq(cloud.pushes, 0);
    eq(cloud._stored(), "<html>login</html>", "脏字节不该被覆盖（没 push）");
  });

  it("首推：云端空 + 本地有 → push 本地", async () => {
    const cloud = mockCloud();
    const ff = createFolderFlow({ cloud, name: "r", encode, decode });
    const r = await ff.sync(folder([it1("a", 5)]));
    eq(r.status, "synced"); eq(r.pushed, true);
    eq(decode(cloud._stored()).items.length, 1);
  });

  it("拉-合-推：云端有别的 id → union 后推", async () => {
    const cloud = mockCloud({ text: J(folder([it1("cloudB", 9)])), etag: "e0" });
    const ff = createFolderFlow({ cloud, name: "r", encode, decode });
    const r = await ff.sync(folder([it1("localA", 5)]));
    eq(r.status, "synced"); eq(r.pushed, true);
    const ids = decode(cloud._stored()).items.map((b) => b.id).sort();
    eq(J(ids), J(["cloudB", "localA"]));
  });

  it("跳推：本地是云端子集（pull-before-edit 无新）→ 不 push", async () => {
    const cloudState = folder([it1("a", 5), it1("b", 6)]);
    const cloud = mockCloud({ text: J(cloudState), etag: "e0" });
    const ff = createFolderFlow({ cloud, name: "r", encode, decode });
    const r = await ff.sync(folder([it1("a", 5)]));          // 本地只有 a，且不比云端新
    eq(r.status, "synced"); eq(r.pushed, false);
    eq(cloud.pushes, 0, "本地无新贡献不该写云端");
    eq(normalizeFolder(r.folder), normalizeFolder(cloudState), "本地应采纳云端全集");
  });

  it("412：有人插队 → 重拉重 merge 重推，收敛", async () => {
    const cloud = mockCloud({ text: J(folder([it1("cloudB", 9)])), etag: "e0" });
    cloud._trigger412();                                      // 第一次 push 412
    const ff = createFolderFlow({ cloud, name: "r", encode, decode });
    const r = await ff.sync(folder([it1("localA", 5)]));
    eq(r.status, "synced"); eq(r.pushed, true);
    assert(cloud.pulls >= 2, "应重拉");
    const ids = decode(cloud._stored()).items.map((b) => b.id).sort();
    eq(J(ids), J(["cloudB", "localA"]), "两边都在");
  });
});
