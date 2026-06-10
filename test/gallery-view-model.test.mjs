// Gallery 展示派生测试（UI 深化 candidate 1 · gallery）。
import { describe, it, eq, assert } from "./runner.mjs";
import { tileFor, breadcrumb, trashTileFor } from "../src/ui/gallery-view-model.ts";
import { mergeTrash } from "../src/gallery-model.js";

describe("gallery-view-model · tileFor 徽章 4 态", () => {
  const local = { name: "a", updatedAt: 100, size: 10, thumb: {} };
  const cloud = { id: "c1", size: 20, lastModifiedDateTime: "2026-01-01T00:00:00Z" };

  it("本地+云端·已同步", () => {
    const t = tileFor({ name: "a", local, cloud, dirty: false }, { signedIn: true, activeName: null });
    eq(t.badge, "syncedBoth");
    assert(t.hasLocalThumb);
    eq(t.cloud.id, "c1");
  });
  it("本地+云端·dirty（登录）→ dirtyBoth", () => {
    const t = tileFor({ name: "a", local, cloud, dirty: true }, { signedIn: true, activeName: null });
    eq(t.badge, "dirtyBoth");
  });
  it("dirty 但未登录 → syncedBoth（dirty 只在登录时有意义）", () => {
    const t = tileFor({ name: "a", local, cloud, dirty: true }, { signedIn: false, activeName: null });
    eq(t.badge, "syncedBoth");
  });
  it("纯云端 → cloudOnly", () => {
    const t = tileFor({ name: "a", local: null, cloud, dirty: false }, { signedIn: true, activeName: null });
    eq(t.badge, "cloudOnly");
    eq(t.hasLocalThumb, false);
  });
  it("纯本地 → localOnly", () => {
    const t = tileFor({ name: "a", local, cloud: null }, { signedIn: true, activeName: null });
    eq(t.badge, "localOnly");
    eq(t.cloud, null);
  });
  it("displayName = basename，time/size 取在", () => {
    const t = tileFor({ name: "f/sub/pic", local, cloud: null }, { signedIn: true, activeName: null });
    eq(t.displayName, "pic");
    eq(t.fullPath, "f/sub/pic");
    eq(t.time, 100);
    eq(t.size, 10);
  });
  it("isActive 配对当前活动名", () => {
    eq(tileFor({ name: "a", local }, { signedIn: true, activeName: "a" }).isActive, true);
    eq(tileFor({ name: "a", local }, { signedIn: true, activeName: "b" }).isActive, false);
  });
  it("ghost（cloud-gone dirty 孤儿）→ ghost badge，优先于 localOnly（顺带让推送按钮消失）", () => {
    const t = tileFor({ name: "a", local, cloud: null, ghost: true }, { signedIn: true, activeName: null });
    eq(t.badge, "ghost");
    eq(t.ghost, true);
    assert(/移动或删除/.test(t.badgeTitle), "标题说明 cloud-gone");
  });
  it("非 ghost → ghost 字段 false", () => {
    eq(tileFor({ name: "a", local, cloud: null }, { signedIn: true, activeName: null }).ghost, false);
  });
});

describe("gallery-view-model · breadcrumb", () => {
  it("根 = 仅根段·current", () => {
    const b = breadcrumb("");
    eq(b.length, 1);
    eq(b[0].path, "");
    assert(b[0].current);
  });
  it("嵌套累积路径，末段 current", () => {
    const b = breadcrumb("characters/side");
    eq(b.length, 3);
    eq(b[0].path, ""); eq(b[1].path, "characters"); eq(b[2].path, "characters/side");
    assert(!b[0].current); assert(!b[1].current); assert(b[2].current);
  });
});

describe("gallery-view-model · trashTileFor / mergeTrash", () => {
  it("来源标签", () => {
    eq(trashTileFor({ name: "a", local: {}, cloud: {} }).source, "本地+云端");
    eq(trashTileFor({ name: "a", local: {}, cloud: null }).source, "本地");
    eq(trashTileFor({ name: "a", local: null, cloud: {} }).source, "云端");
  });
  it("mergeTrash 配对 + 剥 .ora/[N] + 新→旧", () => {
    const local = [{ trashKey: "t1", originalName: "a", deletedAt: 200, thumb: {} }];
    const cloud = [
      { name: "a [2].ora", lastModifiedDateTime: "2026-01-01T00:00:00Z" },   // 撞名尾标 → 配 a
      { name: "b.ora", lastModifiedDateTime: "2026-02-01T00:00:00Z" },
    ];
    const m = mergeTrash(local, cloud);
    const a = m.find((x) => x.name === "a");
    eq(!!a.local && !!a.cloud, true, "a 本地云端配对");
    eq(m.some((x) => x.name === "b"), true, "b 仅云端");
    // 新→旧：deletedAt 降序
    for (let i = 1; i < m.length; i++) assert(m[i - 1].deletedAt >= m[i].deletedAt, "降序");
  });
});
