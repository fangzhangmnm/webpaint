// 笔架 view-model 验收（A3）。纯派生。
import { describe, it, assert, eq } from "./runner.mjs";
import { deriveRackCloudState, collectFolders, brushesInFolder } from "../src/brush-rack-view.js";

describe("brush-rack-view · deriveRackCloudState", () => {
  it("优先级：未登录 > 离线 > 脏 > 已同步", () => {
    eq(deriveRackCloudState({ signedIn: false, online: true, dirty: true }), "no-auth");
    eq(deriveRackCloudState({ signedIn: true, online: false, dirty: true }), "offline");
    eq(deriveRackCloudState({ signedIn: true, online: true, dirty: true }), "dirty");
    eq(deriveRackCloudState({ signedIn: true, online: true, dirty: false }), "synced");
  });
});

describe("brush-rack-view · collectFolders", () => {
  const D = "默认";
  it("去重 + 保首见序；无 folder 归默认夹", () => {
    eq(JSON.stringify(collectFolders([{ folder: "A" }, { folder: "A" }, { folder: "B" }, {}], D)),
      JSON.stringify(["A", "B", D]));
  });
  it("空列表 → 只有默认夹", () => eq(JSON.stringify(collectFolders([], D)), JSON.stringify([D])));
});

describe("brush-rack-view · brushesInFolder", () => {
  const D = "默认";
  const bs = [{ id: 1, folder: "A" }, { id: 2 }, { id: 3, folder: "A" }, { id: 4, folder: "B" }];
  it("按 folder 过滤；缺 folder 归默认夹", () => {
    eq(JSON.stringify(brushesInFolder(bs, "A", D).map((b) => b.id)), JSON.stringify([1, 3]));
    eq(JSON.stringify(brushesInFolder(bs, D, D).map((b) => b.id)), JSON.stringify([2]));
  });
});
