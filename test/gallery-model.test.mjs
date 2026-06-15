// Gallery 路径代数 + 文件夹模型验收（A2）。纯数据。
import { describe, it, assert, eq } from "./runner.mjs";
import { pathFolder, pathBasename, pathJoin } from "../src/gallery-path.js";
import { mergeLocalCloud, sliceFolder, folderHasContents, itemTime, classifyCloudGone, copyTargetName } from "../src/gallery-model.js";

describe("gallery-path", () => {
  it("pathFolder", () => { eq(pathFolder("a"), ""); eq(pathFolder("f/a"), "f"); eq(pathFolder("f/g/a"), "f/g"); });
  it("pathBasename", () => { eq(pathBasename("a"), "a"); eq(pathBasename("f/g/a"), "a"); });
  it("pathJoin", () => { eq(pathJoin("", "a"), "a"); eq(pathJoin("f", "a"), "f/a"); eq(pathJoin("f", ""), "f"); });
});

describe("gallery-model · mergeLocalCloud", () => {
  it("同名 local+cloud 合一条（cloud 去 .ora）", () => {
    const m = mergeLocalCloud([{ name: "a", updatedAt: 5 }], [{ path: "a.ora", lastModifiedDateTime: "x" }]);
    eq(m.length, 1); eq(m[0].name, "a"); assert(m[0].local && m[0].cloud, "两端都在");
  });
  it("纯本地 / 纯云端各成条", () => {
    const m = mergeLocalCloud([{ name: "a" }], [{ path: "b.ora" }]);
    eq(m.length, 2);
    assert(m.find((e) => e.name === "b").local === null, "b 纯云");
  });
});

describe("gallery-model · sliceFolder", () => {
  // 排序按 name 倒序（yyyymmdd-xxxx，新日期在前）；updatedAt 故意逆着名字，验证不再看存盘时间。
  const items = mergeLocalCloud(
    [
      { name: "20260101-old", updatedAt: 30 },   // 名字旧、updatedAt 新
      { name: "20260615-new", updatedAt: 10 },   // 名字新、updatedAt 旧
      { name: "f1/20260301-a", updatedAt: 20 },
      { name: "f2/20260201-c", updatedAt: 5 },
    ],
    [],
  );
  it("根层：immediate 子夹（字母序）+ 直属文件（按名字倒序，不看 updatedAt）", () => {
    const { folderNames, files } = sliceFolder(items, [], "");
    eq(JSON.stringify(folderNames), JSON.stringify(["f1", "f2"]));
    eq(JSON.stringify(files.map((f) => f.name)), JSON.stringify(["20260615-new", "20260101-old"]));
  });
  it("进 f1：只剩 f1 直属文件、无子夹", () => {
    const { folderNames, files } = sliceFolder(items, [], "f1");
    eq(folderNames.length, 0);
    eq(JSON.stringify(files.map((f) => f.name)), JSON.stringify(["f1/20260301-a"]));
  });
  it("数字智能排序：副本10 排在副本2 后面（非字典序）", () => {
    const nums = mergeLocalCloud(
      [{ name: "猫 副本2" }, { name: "猫 副本10" }, { name: "猫 副本" }],
      [],
    );
    const { files } = sliceFolder(nums, [], "");
    eq(JSON.stringify(files.map((f) => f.name)), JSON.stringify(["猫 副本10", "猫 副本2", "猫 副本"]));
  });
  it("云端空文件夹也现身（单一真相源）", () => {
    const { folderNames } = sliceFolder(items, ["emptyDir", "f1/onlycloudsub"], "");
    assert(folderNames.includes("emptyDir"), "空云夹出现");
  });
  it("itemTime：本地 updatedAt 优先，否则云端时间", () => {
    eq(itemTime({ local: { updatedAt: 7 }, cloud: null }), 7);
    eq(itemTime({ local: null, cloud: { lastModifiedDateTime: "1970-01-01T00:00:00.010Z" } }), 10);
  });
});

describe("gallery-model · folderHasContents", () => {
  const items = mergeLocalCloud([{ name: "f1/a" }], []);
  it("有 item 以它为 prefix → 非空", () => assert(folderHasContents(items, [], "f1")));
  it("仅云端子夹以它为 prefix → 非空", () => assert(folderHasContents([], ["f2/sub"], "f2")));
  it("都没有 → 空", () => assert(!folderHasContents(items, [], "f9")));
});

describe("gallery-model · copyTargetName（复制项目目标名）", () => {
  it("首份「<名> 副本」（不带数字）", () => {
    eq(copyTargetName("猫", () => false), "猫 副本");
  });
  it("「副本」已占 → 「副本2」起递增", () => {
    const taken = new Set(["猫 副本", "猫 副本2"]);
    eq(copyTargetName("猫", (n) => taken.has(n)), "猫 副本3");
  });
  it("保持源同一文件夹（path 前缀不变）", () => {
    eq(copyTargetName("插画/猫", () => false), "插画/猫 副本");
    const taken = new Set(["插画/猫 副本"]);
    eq(copyTargetName("插画/猫", (n) => taken.has(n)), "插画/猫 副本2");
  });
  it("复制的复制：「猫 副本」→「猫 副本 副本」", () => {
    eq(copyTargetName("猫 副本", () => false), "猫 副本 副本");
  });
  it("taken 同时查本地⊕云端并集（任一占用都跳过）", () => {
    const local = new Set(["猫 副本"]);
    const cloud = new Set(["猫 副本2"]);
    eq(copyTargetName("猫", (n) => local.has(n) || cloud.has(n)), "猫 副本3");
  });
});

describe("classifyCloudGone（cloud-gone 收敛分类 · 数据安全护栏）", () => {
  // 便捷构造：etagSet=有 etag 的名、dirtySet=dirty 的名
  const mk = (etag, dirty) => ({
    hasEtag: (n) => etag.has(n),
    isDirty: (n) => dirty.has(n),
  });

  it("clean 孤儿（有 etag、云端没了、不 dirty）→ drop", () => {
    const r = classifyCloudGone(["foo"], new Set(["bar"]),
      { ...mk(new Set(["foo"]), new Set()), authoritative: true });
    eq(r.drop.join(), "foo"); eq(r.ghost.length, 0);
  });

  it("dirty 孤儿 → ghost（绝不 drop）", () => {
    const r = classifyCloudGone(["foo"], new Set(["bar"]),
      { ...mk(new Set(["foo"]), new Set(["foo"])), authoritative: true });
    eq(r.ghost.join(), "foo"); eq(r.drop.length, 0);
  });

  it("无 etag = 真本地文件 → 永不碰（既不 drop 也不 ghost）", () => {
    const r = classifyCloudGone(["foo"], new Set(["bar"]),
      { ...mk(new Set(), new Set()), authoritative: true });
    eq(r.drop.length, 0); eq(r.ghost.length, 0);
  });

  it("云端还在 → 不是孤儿", () => {
    const r = classifyCloudGone(["foo"], new Set(["foo"]),
      { ...mk(new Set(["foo"]), new Set()), authoritative: true });
    eq(r.drop.length, 0); eq(r.ghost.length, 0);
  });

  it("authoritative=false（列表不权威）→ 全空，绝不收敛（头号数据安全护栏）", () => {
    const r = classifyCloudGone(["foo", "baz"], new Set(),
      { ...mk(new Set(["foo", "baz"]), new Set()), authoritative: false });
    eq(r.drop.length, 0); eq(r.ghost.length, 0);
  });

  it("混合：clean→drop / dirty→ghost / 无etag→留 / 云端在→留", () => {
    const local = ["clean", "dirty", "pure", "kept"];
    const cloud = new Set(["kept"]);
    const r = classifyCloudGone(local, cloud,
      { hasEtag: (n) => n !== "pure", isDirty: (n) => n === "dirty", authoritative: true });
    eq(r.drop.join(), "clean");
    eq(r.ghost.join(), "dirty");
  });
});
