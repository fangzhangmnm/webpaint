// Gallery 展示派生测试（UI 深化 candidate 1 · gallery）。
import { describe, it, eq, assert } from "./runner.mjs";
import { tileFor, breadcrumb, trashTileFor, humanSize } from "../src/gallery/gallery-view-model.ts";

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
    assert(/moved or deleted/.test(t.badgeTitle), "标题说明 cloud-gone");
  });
  it("非 ghost → ghost 字段 false", () => {
    eq(tileFor({ name: "a", local, cloud: null }, { signedIn: true, activeName: null }).ghost, false);
  });
  it("pendingGone（cloud-gone clean 孤儿、grace 内）→ pendingGone badge，优先于 localOnly", () => {
    const t = tileFor({ name: "a", local, cloud: null, pendingGone: true }, { signedIn: true, activeName: null });
    eq(t.badge, "pendingGone");
    eq(t.pendingGone, true);
    assert(/gone|pending/.test(t.badgeTitle), "标题说明 cloud-gone + 待处理");
  });
  it("ghost 优先于 pendingGone（dirty cloud-gone 走 ghost，不会误标 pendingGone）", () => {
    const t = tileFor({ name: "a", local, cloud: null, ghost: true, pendingGone: true }, { signedIn: true, activeName: null });
    eq(t.badge, "ghost");
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

describe("gallery-view-model · trashTileFor", () => {
  it("来源标签", () => {
    eq(trashTileFor({ name: "a", local: {}, cloud: {} }).source, "Local+cloud");
    eq(trashTileFor({ name: "a", local: {}, cloud: null }).source, "Local");
    eq(trashTileFor({ name: "a", local: null, cloud: {} }).source, "Cloud");
  });
  // （旧 mergeTrash 锚已随函数被 store 库收编 → 真测试在 test/trash-merge.test.ts）
});

describe("gallery-view-model · humanSize（家规：1024 进制标二进制单位 KiB/MiB）", () => {
  it("null/0/字节档", () => {
    eq(humanSize(null), "?");
    eq(humanSize(undefined), "?");
    eq(humanSize(0), "0 B");
    eq(humanSize(1023), "1023 B");
  });
  it("KiB/MiB/GiB 档（1024 进制，单位名必须带 i）", () => {
    eq(humanSize(1024), "1 KiB");
    eq(humanSize(953 * 1024), "953 KiB");          // ≈0.93 MB 十进制——标 KB 就撒谎了
    eq(humanSize(1024 * 1024), "1.0 MiB");
    eq(humanSize(1.5 * 1024 * 1024 * 1024), "1.50 GiB");
  });
});
